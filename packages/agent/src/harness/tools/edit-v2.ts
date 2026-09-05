import { type Static, type TSchema, Type } from "typebox";
import type { AgentHarnessTool, ExecutionEnv } from "../types.ts";
import {
	detectLineEnding,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import {
	DEFAULT_MUTATION_LIMITS,
	type EditPlan,
	type EditPlanOperation,
	ExecutionEnvMutationBackend,
	type FileObservation,
	type MutationBackend,
	type MutationCommitResult,
	type MutationLimits,
	observeMutationPath,
	validateEditPlan,
} from "./mutation-core.ts";
import type { ExecutionToolContext } from "./tool-context.ts";
import { resolveToolState, type ToolStateLedger, type ToolView } from "./tool-state.ts";
import { V2ToolError } from "./v2-errors.ts";
import { withV2MutationCoordinator } from "./v2-mutation-coordinator.ts";
import { resolveWorkspacePath } from "./workspace-policy.ts";

const lineRangeSchema = Type.Object({ startLine: Type.Number(), endLine: Type.Number() });
const viewBindingSchema = {
	viewId: Type.Optional(Type.String({ description: "Fresh view returned by read" })),
	expectedFileHash: Type.Optional(Type.String({ description: "file_hash returned by read" })),
	range: Type.Optional(lineRangeSchema),
	matchPolicy: Type.Optional(Type.Literal("exactly_one_in_range")),
	replaceAll: Type.Optional(Type.Literal(false)),
};
const createOperation = Type.Object({ kind: Type.Literal("create"), path: Type.String(), content: Type.String() });
const updateOperation = Type.Object({
	kind: Type.Literal("update"),
	path: Type.String(),
	oldText: Type.String(),
	newText: Type.String(),
	...viewBindingSchema,
});
const moveOperation = Type.Object({ kind: Type.Literal("move"), path: Type.String(), to: Type.String() });
const deleteOperation = Type.Object({ kind: Type.Literal("delete"), path: Type.String() });
const operationSchema = Type.Union([createOperation, updateOperation, moveOperation, deleteOperation]);
const editActionSchema = {
	action: Type.Optional(Type.Union([Type.Literal("apply"), Type.Literal("prepare")])),
	dryRun: Type.Optional(Type.Boolean({ description: "Compatibility alias for action=prepare" })),
};
const commitEditSchema = Type.Object({ action: Type.Literal("commit"), patchId: Type.String() });
const operationsEditSchema = Type.Union([
	Type.Object({ ...editActionSchema, operations: Type.Array(operationSchema, { minItems: 1 }) }),
	commitEditSchema,
]);
const replacementEditSchema = Type.Union([
	Type.Object({
		...editActionSchema,
		path: Type.String(),
		edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }),
		...viewBindingSchema,
	}),
	commitEditSchema,
]);
const patchEditSchema = Type.Union([
	Type.Object({
		...editActionSchema,
		patch: Type.String({
			description:
				'A Pi Edit Patch v1 string: header "*** Pi Edit Patch v1", one JSON operation per line, and footer "*** End Pi Edit Patch".',
		}),
	}),
	commitEditSchema,
]);

export type EditV2Operation = Static<typeof operationSchema>;
export type EditV2OperationsInput = Static<typeof operationsEditSchema>;
export type EditV2ReplacementInput = Static<typeof replacementEditSchema>;
export type EditV2PatchInput = Static<typeof patchEditSchema>;
export type EditV2Input = EditV2OperationsInput | EditV2ReplacementInput | EditV2PatchInput;
export type EditV2Dialect = "operations" | "replacement" | "patch";

export interface EditV2FileChange {
	path: string;
	status: "created" | "updated" | "deleted";
	patch: string;
	diff: string;
	firstChangedLine?: number;
}

export interface EditV2Details {
	status: "prepared" | "applied" | "pending_acceptance";
	dialect: EditV2Dialect;
	operations: Array<{ index: number; kind: EditPlanOperation["kind"]; path: string; to?: string }>;
	changedPaths: string[];
	files: EditV2FileChange[];
	patch: string;
	patchId?: string;
	pendingAcceptance?: { id: string; workspacePath: string };
}

export interface EditV2PartialCommitDetails {
	completedOperationIndexes: number[];
	failedOperationIndex: number;
	pendingOperationIndexes: number[];
	changedPaths: string[];
	createdDirectories: string[];
	unknownPaths: string[];
}

export interface CreateEditV2ToolOptions {
	dialect?: EditV2Dialect;
	backend?: MutationBackend;
	limits?: Partial<MutationLimits>;
}

type VirtualFile = {
	content: string;
	initialContent?: string;
	exists: boolean;
	initialExists: boolean;
};

type Replacement = { oldText: string; newText: string };
type LineRange = { startLine: number; endLine: number };
type EditAction = "apply" | "prepare" | "commit";
type PreparedEditData = {
	dialect: EditV2Dialect;
	operations: Array<{ index: number; kind: EditPlanOperation["kind"]; path: string; to?: string }>;
	files: EditV2FileChange[];
};

const PATCH_HEADER = "*** Pi Edit Patch v1";
const PATCH_FOOTER = "*** End Pi Edit Patch";
const MAX_EDIT_FEEDBACK_BYTES = 32 * 1024;
const textEncoder = new TextEncoder();

function planTooLarge(message: string): V2ToolError {
	return new V2ToolError("EDIT_PLAN_TOO_LARGE", message, { recovery: { kind: "split_edit" } });
}

function countOccurrences(content: string, needle: string): number[] {
	const indexes: number[] = [];
	let offset = 0;
	while (true) {
		const index = content.indexOf(needle, offset);
		if (index < 0) return indexes;
		indexes.push(index);
		offset = index + needle.length;
	}
}

function applyRangeReplacements(
	content: string,
	replacements: Replacement[],
	path: string,
	range: LineRange,
	patchErrors = false,
	byteRange?: [number, number],
): string {
	const { bom, text } = stripBom(content);
	const withoutCrlf = text.replaceAll("\r\n", "");
	if ((text.includes("\r\n") && withoutCrlf.includes("\n")) || withoutCrlf.includes("\r")) {
		throw new V2ToolError("INVALID_INPUT", `${path} uses mixed or unsupported line endings.`);
	}
	const ending = detectLineEnding(text);
	const base = normalizeToLF(text);
	const lineStarts = [0];
	for (let index = 0; index < base.length; index++) {
		if (base[index] === "\n" && index + 1 < base.length) lineStarts.push(index + 1);
	}
	if (range.startLine > lineStarts.length || range.endLine > lineStarts.length) {
		throw new V2ToolError(
			"RANGE_MISMATCH",
			`Range ${range.startLine}-${range.endLine} is outside ${path}. Read the current range and retry.`,
			{ paths: [path], recovery: { kind: "read_again", paths: [path] } },
		);
	}
	let start = lineStarts[range.startLine - 1];
	const endLineStart = lineStarts[range.endLine - 1];
	const newline = base.indexOf("\n", endLineStart);
	let end = newline < 0 ? base.length : newline;
	if (byteRange) {
		// Read's bounds are raw UTF-8 offsets; matching uses BOM-free, LF-normalized
		// UTF-16 string indexes. Decode prefixes so CRLF and multibyte characters
		// cannot shift authorization onto an undisplayed suffix or another line.
		const bytes = textEncoder.encode(content);
		const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
		const offsets = byteRange.map(
			(offset) => normalizeToLF(stripBom(decoder.decode(bytes.subarray(0, offset))).text).length,
		);
		start = Math.max(start, offsets[0]);
		end = Math.max(start, Math.min(end, offsets[1]));
	}
	const segment = base.slice(start, end);
	const matches = replacements.map((replacement, index) => {
		const oldText = normalizeToLF(replacement.oldText);
		const newText = normalizeToLF(replacement.newText);
		if (oldText.length === 0) throw new V2ToolError("INVALID_INPUT", `Replacement ${index} for ${path} is empty.`);
		const indexes = countOccurrences(segment, oldText);
		if (indexes.length === 0) {
			throw new V2ToolError(
				patchErrors ? "PATCH_CONTEXT_NOT_FOUND" : "PREIMAGE_MISMATCH",
				`The expected text is not present in ${path} within lines ${range.startLine}-${range.endLine}. Read exactly that range again, copy the intended current file text without displayed line-number prefixes into oldText, and retry Edit directly without Search.`,
				{ paths: [path], recovery: { kind: "read_again", paths: [path] } },
			);
		}
		if (indexes.length > 1) {
			throw new V2ToolError(
				patchErrors ? "PATCH_AMBIGUOUS" : "AMBIGUOUS_MATCH",
				`The expected text occurs ${indexes.length} times in ${path} within the permitted range.`,
				{ paths: [path], matchCount: indexes.length, recovery: { kind: "read_again", paths: [path] } },
			);
		}
		return { index: indexes[0], length: oldText.length, newText, replacementIndex: index };
	});
	matches.sort((left, right) => left.index - right.index);
	for (let index = 1; index < matches.length; index++) {
		const previous = matches[index - 1];
		const current = matches[index];
		if (previous.index + previous.length > current.index) {
			throw new V2ToolError(
				"EDIT_CONFLICT",
				`Replacements ${previous.replacementIndex} and ${current.replacementIndex} overlap in ${path}.`,
			);
		}
	}
	let updatedSegment = segment;
	for (let index = matches.length - 1; index >= 0; index--) {
		const match = matches[index];
		updatedSegment =
			updatedSegment.slice(0, match.index) + match.newText + updatedSegment.slice(match.index + match.length);
	}
	const output = base.slice(0, start) + updatedSegment + base.slice(end);
	if (output === base) throw new V2ToolError("INVALID_INPUT", `The replacements make no changes to ${path}.`);
	return bom + restoreLineEndings(output, ending);
}

function observedHash(observation: FileObservation): string | undefined {
	return observation.contentHash ? `sha256:${observation.contentHash}` : undefined;
}

function validateViewBinding(
	operation: Extract<EditV2Operation, { kind: "update" }>,
	path: string,
	canonicalPath: string,
	observation: FileObservation,
	context: ExecutionToolContext,
): { range?: LineRange; view?: ToolView } {
	if (operation.replaceAll !== undefined && operation.replaceAll !== false) {
		throw new V2ToolError("INVALID_INPUT", "replaceAll must remain false; replace-all is never implicit.");
	}
	const scopeId = context.read?.scopeId ?? context.search?.scopeId ?? context.env.cwd;
	const view = operation.viewId ? resolveToolState(context).getView(operation.viewId, scopeId) : undefined;
	if (operation.viewId && !view) {
		throw new V2ToolError(
			"STALE_VIEW",
			"The view expired or belongs to another tool scope. Read the target range again.",
			{ recovery: { kind: "read_again" as const, paths: [operation.path] } },
		);
	}
	if (view && view.path !== path && view.path !== canonicalPath) {
		throw new V2ToolError("RANGE_MISMATCH", "The update path does not match the supplied view.");
	}
	if (view && (!view.editable || !view.fileHash || !view.byteRange)) {
		throw new V2ToolError("STALE_VIEW", "The supplied view has no safe full-file hash and cannot authorize editing.");
	}
	if (view && operation.expectedFileHash && operation.expectedFileHash !== view.fileHash) {
		throw new V2ToolError("STALE_VIEW", "expectedFileHash does not match the supplied view.");
	}
	if (!view && !operation.expectedFileHash) {
		throw new V2ToolError(
			"INVALID_INPUT",
			"Every update requires a fresh viewId or expectedFileHash plus an exact permitted range.",
			{ paths: [operation.path], recovery: { kind: "read_again" as const, paths: [operation.path] } },
		);
	}
	const expectedHash = operation.expectedFileHash ?? view?.fileHash;
	if (expectedHash && observedHash(observation) !== expectedHash) {
		throw new V2ToolError(
			"STALE_VIEW",
			"The file hash changed after read. Read the target range again before editing.",
			{ paths: [operation.path], recovery: { kind: "read_again" as const, paths: [operation.path] } },
		);
	}
	const range = operation.range ?? (view ? { startLine: view.range[0], endLine: view.range[1] } : undefined);
	if (!range) {
		throw new V2ToolError(
			"INVALID_INPUT",
			"Every update requires an exact range from a fresh view or an explicit hash-bound range.",
		);
	}
	if (view && (range.startLine < view.range[0] || range.endLine > view.range[1])) {
		throw new V2ToolError(
			"RANGE_MISMATCH",
			`The requested range ${range.startLine}-${range.endLine} is outside view ${view.range[0]}-${view.range[1]}.`,
		);
	}
	return { range, view };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLineRange(value: unknown, label: string): LineRange | undefined {
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		!Number.isSafeInteger(value.startLine) ||
		!Number.isSafeInteger(value.endLine) ||
		(value.startLine as number) <= 0 ||
		(value.endLine as number) < (value.startLine as number)
	) {
		throw new V2ToolError("INVALID_INPUT", `${label} must contain positive startLine/endLine values in order.`);
	}
	return { startLine: value.startLine as number, endLine: value.endLine as number };
}

function updateBinding(value: Record<string, unknown>, label: string) {
	if (value.viewId !== undefined && typeof value.viewId !== "string") {
		throw new V2ToolError("INVALID_INPUT", `${label}.viewId must be a string.`);
	}
	if (value.expectedFileHash !== undefined && typeof value.expectedFileHash !== "string") {
		throw new V2ToolError("INVALID_INPUT", `${label}.expectedFileHash must be a string.`);
	}
	if (value.matchPolicy !== undefined && value.matchPolicy !== "exactly_one_in_range") {
		throw new V2ToolError("INVALID_INPUT", `${label}.matchPolicy is unsupported.`);
	}
	if (value.replaceAll !== undefined && value.replaceAll !== false) {
		throw new V2ToolError("INVALID_INPUT", `${label}.replaceAll must remain false; replace-all is not implicit.`);
	}
	return {
		viewId: value.viewId as string | undefined,
		expectedFileHash: value.expectedFileHash as string | undefined,
		range: parseLineRange(value.range, `${label}.range`),
		matchPolicy: value.matchPolicy as "exactly_one_in_range" | undefined,
		replaceAll: value.replaceAll as false | undefined,
	};
}

function editAction(input: unknown): { action: EditAction; patchId?: string } {
	if (!isRecord(input)) throw new V2ToolError("INVALID_INPUT", "Edit input must be an object.");
	if (input.action === "commit") {
		if (typeof input.patchId !== "string" || input.patchId.length === 0) {
			throw new V2ToolError("INVALID_INPUT", "action=commit requires patchId.");
		}
		if (
			input.operations !== undefined ||
			input.path !== undefined ||
			input.edits !== undefined ||
			input.patch !== undefined ||
			input.dryRun !== undefined
		) {
			throw new V2ToolError("INVALID_INPUT", "action=commit accepts only patchId.");
		}
		return { action: "commit", patchId: input.patchId };
	}
	if (input.patchId !== undefined) throw new V2ToolError("INVALID_INPUT", "patchId is only valid with action=commit.");
	if (input.action !== undefined && input.action !== "apply" && input.action !== "prepare") {
		throw new V2ToolError("INVALID_INPUT", "action must be apply, prepare, or commit.");
	}
	if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") {
		throw new V2ToolError("INVALID_INPUT", "dryRun must be boolean.");
	}
	if (input.action === "apply" && input.dryRun === true) {
		throw new V2ToolError("INVALID_INPUT", "action=apply conflicts with dryRun=true.");
	}
	return { action: input.action === "prepare" || input.dryRun === true ? "prepare" : "apply" };
}

function parseOperation(value: unknown, line: number): EditV2Operation {
	if (!isRecord(value) || typeof value.kind !== "string" || typeof value.path !== "string") {
		throw new V2ToolError("PATCH_PARSE_ERROR", `Patch line ${line} is not a valid operation object.`);
	}
	switch (value.kind) {
		case "create":
			if (typeof value.content === "string") return { kind: "create", path: value.path, content: value.content };
			break;
		case "update":
			if (typeof value.oldText === "string" && typeof value.newText === "string") {
				return {
					kind: "update",
					path: value.path,
					oldText: value.oldText,
					newText: value.newText,
					...updateBinding(value, `Patch line ${line}`),
				};
			}
			break;
		case "move":
			if (typeof value.to === "string") return { kind: "move", path: value.path, to: value.to };
			break;
		case "delete":
			return { kind: "delete", path: value.path };
	}
	throw new V2ToolError("PATCH_PARSE_ERROR", `Patch line ${line} has invalid fields for ${value.kind}.`);
}

export function parseEditPatch(patch: string, limits: MutationLimits = DEFAULT_MUTATION_LIMITS): EditV2Operation[] {
	if (textEncoder.encode(patch).byteLength > limits.maxTotalBytes) {
		throw planTooLarge("Patch input exceeds the total mutation byte limit. Split the edit.");
	}
	const lines = normalizeToLF(patch).split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines[0] !== PATCH_HEADER || lines.at(-1) !== PATCH_FOOTER) {
		throw new V2ToolError(
			"PATCH_PARSE_ERROR",
			`Patch must start with "${PATCH_HEADER}" and end with "${PATCH_FOOTER}".`,
		);
	}
	const body = lines.slice(1, -1);
	if (body.length === 0 || body.length > limits.maxOperations) {
		throw planTooLarge(`Patch must contain 1-${limits.maxOperations} JSON operations. Split the edit.`);
	}
	return body.map((line, index) => {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new V2ToolError("PATCH_PARSE_ERROR", `Patch line ${index + 2} is not valid JSON.`);
		}
		return parseOperation(value, index + 2);
	});
}

function normalizeInput(input: unknown, dialect: EditV2Dialect, limits: MutationLimits): EditV2Operation[] {
	if (dialect === "operations") {
		if (!isRecord(input) || !Array.isArray(input.operations)) {
			throw new V2ToolError("INVALID_INPUT", "operations must contain at least one file operation.");
		}
		return input.operations.map((operation, index) => parseOperation(operation, index + 1));
	}
	if (dialect === "patch") {
		if (!isRecord(input) || typeof input.patch !== "string") {
			throw new V2ToolError("PATCH_PARSE_ERROR", "patch must be a Pi Edit Patch v1 string.");
		}
		return parseEditPatch(input.patch, limits);
	}
	if (!isRecord(input) || typeof input.path !== "string" || !Array.isArray(input.edits) || input.edits.length === 0) {
		throw new V2ToolError("INVALID_INPUT", "replacement input requires path and at least one edit.");
	}
	const path = input.path;
	const binding = updateBinding(input, "replacement");
	return input.edits.map((edit): EditV2Operation => {
		if (!isRecord(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
			throw new V2ToolError("INVALID_INPUT", "Every replacement requires string oldText and newText fields.");
		}
		return { kind: "update", path, oldText: edit.oldText, newText: edit.newText, ...binding };
	});
}

async function missingParentDirectories(env: ExecutionEnv, path: string, signal?: AbortSignal): Promise<string[]> {
	const initialParent = await env.joinPath([path, ".."], signal);
	if (!initialParent.ok) throw new V2ToolError("PERMISSION_DENIED", `Could not resolve the parent of ${path}.`);
	const missing: string[] = [];
	let parent = initialParent.value;
	while (true) {
		const info = await env.fileInfo(parent, signal);
		if (info.ok) {
			if (info.value.kind === "directory") return missing.reverse();
			throw new V2ToolError("NOT_A_DIRECTORY", `${parent} is not a directory.`);
		}
		if (info.error.code !== "not_found") {
			throw new V2ToolError("PERMISSION_DENIED", `Could not inspect ${parent}: ${info.error.message}`);
		}
		missing.push(parent);
		const next = await env.joinPath([parent, ".."], signal);
		if (!next.ok || next.value === parent) {
			throw new V2ToolError("NOT_FOUND", `No existing parent directory could be found for ${path}.`);
		}
		parent = next.value;
	}
}

async function buildEditPlan(
	operations: EditV2Operation[],
	dialect: EditV2Dialect,
	context: ExecutionToolContext,
	limits: MutationLimits,
	signal?: AbortSignal,
): Promise<{ plan: EditPlan; files: Map<string, VirtualFile> }> {
	if (operations.length === 0 || operations.length > limits.maxOperations) {
		throw planTooLarge(`Edit input must contain 1-${limits.maxOperations} operations. Split the edit.`);
	}
	const files = new Map<string, VirtualFile>();
	const observations = new Map<string, FileObservation>();
	const identities = new Map<string, string>();
	const canonicalPaths = new Map<string, string>();
	const planned: EditPlanOperation[] = [];
	const boundUpdatePaths = new Set<string>();
	const resolve = async (inputPath: string): Promise<string> => {
		const result = await resolveWorkspacePath(context.env, inputPath, "write", context.workspacePolicy, signal);
		const previous = identities.get(result.canonicalPath);
		if (previous && previous !== result.absolutePath) {
			throw new V2ToolError("EDIT_CONFLICT", `${inputPath} aliases another path in this edit batch.`);
		}
		identities.set(result.canonicalPath, result.absolutePath);
		canonicalPaths.set(result.absolutePath, result.canonicalPath);
		return result.absolutePath;
	};
	const observe = async (path: string) => {
		const existing = observations.get(path);
		if (existing) return { observation: existing, content: files.get(path)?.content };
		const observed = await observeMutationPath(context.env, path, limits.maxFileBytes, signal);
		observations.set(path, observed.observation);
		return observed;
	};
	const loadFile = async (path: string): Promise<VirtualFile> => {
		const cached = files.get(path);
		if (cached) return cached;
		const observed = await observe(path);
		if (!observed.observation.exists || observed.content === undefined) {
			throw new V2ToolError("NOT_FOUND", `${path} does not exist.`);
		}
		const file = {
			content: observed.content,
			initialContent: observed.content,
			exists: true,
			initialExists: true,
		};
		files.set(path, file);
		return file;
	};

	if (dialect === "replacement") {
		const path = await resolve(operations[0].path);
		const file = await loadFile(path);
		const updates = operations.map((operation) => {
			if (operation.kind !== "update")
				throw new V2ToolError("INVALID_INPUT", "Replacement dialect only updates files.");
			return operation;
		});
		const binding = validateViewBinding(
			updates[0],
			path,
			canonicalPaths.get(path) ?? path,
			observations.get(path)!,
			context,
		);
		file.content = applyRangeReplacements(
			file.content,
			updates,
			path,
			binding.range!,
			false,
			binding.view?.byteRange,
		);
		planned.push({ kind: "update", path, content: file.content });
	} else {
		for (const operation of operations) {
			if (signal?.aborted) throw new V2ToolError("ABORTED", "Edit was aborted before commit.");
			const path = await resolve(operation.path);
			switch (operation.kind) {
				case "create": {
					const virtual = files.get(path);
					const observed = virtual ? undefined : await observe(path);
					if ((virtual?.exists ?? false) || observed?.observation.exists) {
						throw new V2ToolError("EDIT_CONFLICT", `${operation.path} already exists; create never overwrites.`);
					}
					files.set(path, { content: operation.content, exists: true, initialExists: false });
					planned.push({
						kind: "create",
						path,
						content: operation.content,
						parentDirectories: await missingParentDirectories(context.env, path, signal),
					});
					break;
				}
				case "update": {
					const file = await loadFile(path);
					if (!file.exists)
						throw new V2ToolError("NOT_FOUND", `${operation.path} was deleted earlier in this batch.`);
					const bound =
						operation.viewId !== undefined ||
						operation.expectedFileHash !== undefined ||
						operation.range !== undefined ||
						operation.matchPolicy !== undefined;
					if (bound && boundUpdatePaths.has(path)) {
						throw new V2ToolError(
							"EDIT_CONFLICT",
							`Only one view-bound update is allowed for ${operation.path}.`,
						);
					}
					const binding = validateViewBinding(
						operation,
						path,
						canonicalPaths.get(path) ?? path,
						observations.get(path)!,
						context,
					);
					file.content = applyRangeReplacements(
						file.content,
						[{ oldText: operation.oldText, newText: operation.newText }],
						path,
						binding.range!,
						dialect === "patch",
						binding.view?.byteRange,
					);
					if (bound) boundUpdatePaths.add(path);
					planned.push({ kind: "update", path, content: file.content });
					break;
				}
				case "move": {
					const to = await resolve(operation.to);
					const source = await loadFile(path);
					if (!source.exists) throw new V2ToolError("NOT_FOUND", `${operation.path} is unavailable.`);
					const destination = files.get(to);
					const observedDestination = destination ? undefined : await observe(to);
					if ((destination?.exists ?? false) || observedDestination?.observation.exists) {
						throw new V2ToolError("EDIT_CONFLICT", `${operation.to} already exists; move never overwrites.`);
					}
					source.exists = false;
					files.set(to, { content: source.content, exists: true, initialExists: false });
					planned.push({
						kind: "move",
						path,
						to,
						parentDirectories: await missingParentDirectories(context.env, to, signal),
					});
					break;
				}
				case "delete": {
					const file = await loadFile(path);
					if (!file.exists) throw new V2ToolError("NOT_FOUND", `${operation.path} is unavailable.`);
					file.exists = false;
					planned.push({ kind: "delete", path });
					break;
				}
			}
		}
	}

	const observedBytes = [...observations.values()].reduce(
		(total, observation) => total + (observation.exists ? observation.size : 0),
		0,
	);
	if (observations.size > limits.maxFiles || observedBytes > limits.maxTotalBytes) {
		throw planTooLarge(
			`Edit observations exceed the ${limits.maxFiles}-file or ${limits.maxTotalBytes}-byte limit. Split the edit.`,
		);
	}
	const plan = { observations: [...observations.values()], operations: planned, limits };
	validateEditPlan(plan);
	return { plan, files };
}

function changesFromFiles(files: Map<string, VirtualFile>): EditV2FileChange[] {
	const changes: EditV2FileChange[] = [];
	for (const [path, file] of files) {
		const before = file.initialExists ? (file.initialContent ?? "") : "";
		const after = file.exists ? file.content : "";
		if (before === after && file.initialExists === file.exists) continue;
		const display = generateDiffString(normalizeToLF(before), normalizeToLF(after));
		changes.push({
			path,
			status: !file.initialExists ? "created" : !file.exists ? "deleted" : "updated",
			patch: generateUnifiedPatch(path, before, after),
			diff: display.diff,
			firstChangedLine: display.firstChangedLine,
		});
	}
	return changes;
}

function planOperations(plan: EditPlan): PreparedEditData["operations"] {
	return plan.operations.map((operation, index) => ({
		index,
		kind: operation.kind,
		path: operation.path,
		to: operation.kind === "move" ? operation.to : undefined,
	}));
}

function preparedData(value: unknown): PreparedEditData | undefined {
	if (!isRecord(value) || !Array.isArray(value.operations) || !Array.isArray(value.files)) return undefined;
	if (value.dialect !== "operations" && value.dialect !== "replacement" && value.dialect !== "patch") return undefined;
	return value as unknown as PreparedEditData;
}

function operationSummary(operations: PreparedEditData["operations"]): string {
	return operations
		.map((operation) => `${operation.kind}: ${operation.path}${operation.to ? ` -> ${operation.to}` : ""}`)
		.join("\n");
}

function invalidateCommittedEvidence(ledger: ToolStateLedger, plan: EditPlan, result: MutationCommitResult): void {
	if (result.pendingAcceptance) return;
	const changedPaths = new Set(result.changedPaths);
	const identities = plan.observations.flatMap((observation) =>
		changedPaths.has(observation.path) && observation.identity ? [observation.identity] : [],
	);
	ledger.invalidatePaths(result.changedPaths, identities);
}

function boundedEditFeedback(output: string): string {
	if (textEncoder.encode(output).byteLength <= MAX_EDIT_FEEDBACK_BYTES) return output;
	const suffix = "\n[Diff feedback truncated to 32 KiB.]";
	const availableBytes = MAX_EDIT_FEEDBACK_BYTES - textEncoder.encode(suffix).byteLength;
	let low = 0;
	let high = output.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (textEncoder.encode(output.slice(0, middle)).byteLength <= availableBytes) low = middle;
		else high = middle - 1;
	}
	if (
		low > 0 &&
		low < output.length &&
		output.charCodeAt(low - 1) >= 0xd800 &&
		output.charCodeAt(low - 1) <= 0xdbff &&
		output.charCodeAt(low) >= 0xdc00 &&
		output.charCodeAt(low) <= 0xdfff
	) {
		low--;
	}
	return `${output.slice(0, low)}${suffix}`;
}

function successFeedback(
	message: string,
	operations: PreparedEditData["operations"],
	files: EditV2FileChange[],
): string {
	const provenance =
		"The diff below is derived from the validated edit plan; it is not an independent post-edit re-read or verification.";
	const diffs = files.map((file) => `${file.status}: ${file.path}\n${file.diff}`).join("\n");
	return boundedEditFeedback(
		`${message}\n${provenance}\n\n${operationSummary(operations)}${diffs ? `\n\n${diffs}` : ""}`,
	);
}

export function createEditV2Tool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	options: CreateEditV2ToolOptions = {},
): AgentHarnessTool<TContext, TSchema, EditV2Details> {
	const dialect = options.dialect ?? "operations";
	const parameters =
		dialect === "replacement" ? replacementEditSchema : dialect === "patch" ? patchEditSchema : operationsEditSchema;
	const limits = { ...DEFAULT_MUTATION_LIMITS, ...options.limits };
	const fallbackBackends = new WeakMap<ExecutionEnv, ExecutionEnvMutationBackend>();
	const getBackend = (context: ExecutionToolContext): MutationBackend => {
		if (context.mutationBackend) return context.mutationBackend;
		if (options.backend) return options.backend;
		let backend = fallbackBackends.get(context.env);
		if (!backend) {
			backend = new ExecutionEnvMutationBackend(context.env);
			fallbackBackends.set(context.env, backend);
		}
		return backend;
	};

	return {
		name: "edit",
		label: "edit",
		description:
			dialect === "replacement"
				? "Apply one-file exact replacements by default, or prepare them for review. Bind updates to a fresh view/hash/range; commit prepared patch IDs only after reviewing the diff."
				: dialect === "patch"
					? "Apply a versioned Pi Edit Patch v1 by default, or prepare it for review; commit prepared patch IDs only after reviewing the diff."
					: "Apply observed file operations by default, or prepare them for review. Bind updates to a fresh view/hash/range; commit prepared patch IDs only after reviewing the diff.",
		parameters,
		executionMode: "sequential",
		replay: "never",
		async execute(_toolCallId, input, signal, _onUpdate, context) {
			return withV2MutationCoordinator(context.env, async () => {
				const requested = editAction(input);
				const scopeId = context.read?.scopeId ?? context.search?.scopeId ?? context.env.cwd;
				const ledger = resolveToolState(context);
				if (requested.action === "commit") {
					const prepared = ledger.takePatch(requested.patchId ?? "", scopeId);
					const data = preparedData(prepared?.data);
					if (!prepared || !data || data.dialect !== dialect) {
						throw new V2ToolError(
							"STALE_PATCH",
							"The prepared patch expired, was already consumed, or belongs to another tool scope. Prepare it again.",
							{ recovery: { kind: "prepare_edit" as const } },
						);
					}
					let result: MutationCommitResult;
					try {
						result = await getBackend(context).commit(prepared.plan, signal);
					} catch (error) {
						if (error instanceof V2ToolError && error.code === "STALE_FILE") {
							throw new V2ToolError(
								"STALE_PATCH",
								"A prepared preimage changed before commit. No files were changed by this commit; read and prepare again.",
								{
									recovery: {
										kind: "read_again" as const,
										paths: prepared.plan.observations.map((item) => item.path),
									},
								},
								error,
							);
						}
						throw error;
					}
					invalidateCommittedEvidence(ledger, prepared.plan, result);
					const status = result.pendingAcceptance ? "pending_acceptance" : "applied";
					const message = result.pendingAcceptance
						? `Applied prepared patch ${prepared.id} to pending_acceptance overlay ${result.pendingAcceptance.id}; the base workspace is unchanged until host acceptance.`
						: `Applied prepared patch ${prepared.id} to the base workspace.`;
					return {
						content: [{ type: "text", text: successFeedback(message, data.operations, data.files) }],
						details: {
							status,
							dialect,
							operations: data.operations,
							changedPaths: result.changedPaths,
							files: data.files,
							patch: data.files.map((change) => change.patch).join("\n"),
							patchId: prepared.id,
							pendingAcceptance: result.pendingAcceptance,
						},
					};
				}

				const normalized = normalizeInput(input, dialect, limits);
				const { plan, files } = await buildEditPlan(normalized, dialect, context, limits, signal);
				const changes = changesFromFiles(files);
				const operations = planOperations(plan);
				if (requested.action === "prepare") {
					const prepared = ledger.addPatch({
						scopeId,
						plan,
						data: { dialect, operations, files: changes } satisfies PreparedEditData,
					});
					return {
						content: [
							{
								type: "text",
								text: successFeedback(
									`Prepared ${operations.length} file operation(s). patch_id=${prepared.id} The base workspace is unchanged.`,
									operations,
									changes,
								),
							},
						],
						details: {
							status: "prepared",
							dialect,
							operations,
							changedPaths: changes.map((change) => change.path),
							files: changes,
							patch: changes.map((change) => change.patch).join("\n"),
							patchId: prepared.id,
						},
					};
				}

				const result = await getBackend(context).commit(plan, signal);
				invalidateCommittedEvidence(ledger, plan, result);
				const status = result.pendingAcceptance ? "pending_acceptance" : "applied";
				const message = result.pendingAcceptance
					? `Applied ${operations.length} file operation(s) to pending_acceptance overlay ${result.pendingAcceptance.id}; the base workspace is unchanged until host acceptance.`
					: `Applied ${operations.length} file operation(s) to the base workspace.`;
				return {
					content: [{ type: "text", text: successFeedback(message, operations, changes) }],
					details: {
						status,
						dialect,
						operations,
						changedPaths: result.changedPaths,
						files: changes,
						patch: changes.map((change) => change.patch).join("\n"),
						pendingAcceptance: result.pendingAcceptance,
					},
				};
			});
		},
	};
}
