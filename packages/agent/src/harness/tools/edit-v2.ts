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
	type MutationLimits,
	observeMutationPath,
	validateEditPlan,
} from "./mutation-core.ts";
import type { ExecutionToolContext } from "./tool-context.ts";
import { V2ToolError } from "./v2-errors.ts";
import { withV2MutationCoordinator } from "./v2-mutation-coordinator.ts";
import { resolveWorkspacePath } from "./workspace-policy.ts";

const createOperation = Type.Object({ kind: Type.Literal("create"), path: Type.String(), content: Type.String() });
const updateOperation = Type.Object({
	kind: Type.Literal("update"),
	path: Type.String(),
	oldText: Type.String(),
	newText: Type.String(),
});
const moveOperation = Type.Object({ kind: Type.Literal("move"), path: Type.String(), to: Type.String() });
const deleteOperation = Type.Object({ kind: Type.Literal("delete"), path: Type.String() });
const operationSchema = Type.Union([createOperation, updateOperation, moveOperation, deleteOperation]);
const operationsEditSchema = Type.Object({ operations: Type.Array(operationSchema, { minItems: 1 }) });
const replacementEditSchema = Type.Object({
	path: Type.String(),
	edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }),
});
const patchEditSchema = Type.Object({
	patch: Type.String({
		description:
			'A Pi Edit Patch v1 string: header "*** Pi Edit Patch v1", one JSON operation per line, and footer "*** End Pi Edit Patch".',
	}),
});

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
	dialect: EditV2Dialect;
	operations: Array<{ index: number; kind: EditPlanOperation["kind"]; path: string; to?: string }>;
	changedPaths: string[];
	files: EditV2FileChange[];
	patch: string;
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

const PATCH_HEADER = "*** Pi Edit Patch v1";
const PATCH_FOOTER = "*** End Pi Edit Patch";
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

function applyExactReplacements(
	content: string,
	replacements: Replacement[],
	path: string,
	patchErrors = false,
): string {
	const { bom, text } = stripBom(content);
	const withoutCrlf = text.replaceAll("\r\n", "");
	if ((text.includes("\r\n") && withoutCrlf.includes("\n")) || withoutCrlf.includes("\r")) {
		throw new V2ToolError("INVALID_INPUT", `${path} uses mixed or unsupported line endings.`);
	}
	const ending = detectLineEnding(text);
	const base = normalizeToLF(text);
	const matches = replacements.map((replacement, index) => {
		const oldText = normalizeToLF(replacement.oldText);
		const newText = normalizeToLF(replacement.newText);
		if (oldText.length === 0) throw new V2ToolError("INVALID_INPUT", `Replacement ${index} for ${path} is empty.`);
		const indexes = countOccurrences(base, oldText);
		if (indexes.length === 0) {
			throw new V2ToolError(
				patchErrors ? "PATCH_CONTEXT_NOT_FOUND" : "EDIT_CONTEXT_NOT_FOUND",
				`Exact text was not found in ${path}. Read it and retry.`,
				{ paths: [path], recovery: { kind: "read_again", paths: [path] } },
			);
		}
		if (indexes.length > 1) {
			throw new V2ToolError(
				patchErrors ? "PATCH_AMBIGUOUS" : "EDIT_CONTEXT_AMBIGUOUS",
				`Exact text occurs ${indexes.length} times in ${path}. Add context.`,
				{ paths: [path], recovery: { kind: "read_again", paths: [path] } },
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
	let output = base;
	for (let index = matches.length - 1; index >= 0; index--) {
		const match = matches[index];
		output = output.slice(0, match.index) + match.newText + output.slice(match.index + match.length);
	}
	if (output === base) throw new V2ToolError("INVALID_INPUT", `The replacements make no changes to ${path}.`);
	return bom + restoreLineEndings(output, ending);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
				return { kind: "update", path: value.path, oldText: value.oldText, newText: value.newText };
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
		return input.operations as EditV2Operation[];
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
	return input.edits.map((edit): EditV2Operation => {
		if (!isRecord(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
			throw new V2ToolError("INVALID_INPUT", "Every replacement requires string oldText and newText fields.");
		}
		return { kind: "update", path, oldText: edit.oldText, newText: edit.newText };
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
	const planned: EditPlanOperation[] = [];
	const resolve = async (inputPath: string): Promise<string> => {
		const result = await resolveWorkspacePath(context.env, inputPath, "write", context.workspacePolicy, signal);
		const previous = identities.get(result.canonicalPath);
		if (previous && previous !== result.absolutePath) {
			throw new V2ToolError("EDIT_CONFLICT", `${inputPath} aliases another path in this edit batch.`);
		}
		identities.set(result.canonicalPath, result.absolutePath);
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
		file.content = applyExactReplacements(
			file.content,
			operations.map((operation) => {
				if (operation.kind !== "update")
					throw new V2ToolError("INVALID_INPUT", "Replacement dialect only updates files.");
				return { oldText: operation.oldText, newText: operation.newText };
			}),
			path,
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
					file.content = applyExactReplacements(
						file.content,
						[{ oldText: operation.oldText, newText: operation.newText }],
						path,
						dialect === "patch",
					);
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
				? "Edit one regular UTF-8 file with unique, non-overlapping exact replacements."
				: dialect === "patch"
					? "Apply a versioned Pi Edit Patch v1 containing create, update, move, or delete operations."
					: "Create, update, move, or delete regular UTF-8 files with one observed, prevalidated operations batch.",
		parameters,
		executionMode: "sequential",
		replay: "never",
		async execute(_toolCallId, input, signal, _onUpdate, context) {
			return withV2MutationCoordinator(context.env, async () => {
				const normalized = normalizeInput(input, dialect, limits);
				const { plan, files } = await buildEditPlan(normalized, dialect, context, limits, signal);
				const result = await getBackend(context).commit(plan, signal);
				const changes = changesFromFiles(files);
				const operations = plan.operations.map((operation, index) => ({
					index,
					kind: operation.kind,
					path: operation.path,
					to: operation.kind === "move" ? operation.to : undefined,
				}));
				const summary = operations
					.map((operation) => `${operation.kind}: ${operation.path}${operation.to ? ` -> ${operation.to}` : ""}`)
					.join("\n");
				const status = result.pendingAcceptance
					? `Prepared ${operations.length} file operation(s) in overlay ${result.pendingAcceptance.id}; the base workspace is unchanged until host acceptance.`
					: `Applied ${operations.length} file operation(s).`;
				return {
					content: [{ type: "text", text: `${status}\n\n${summary}` }],
					details: {
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
