import { type Static, Type } from "typebox";
import type { AgentHarnessTool, ExecutionEnv, FileError, Result } from "../types.ts";
import { generateUnifiedPatch } from "./edit-diff.ts";
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
const editV2Schema = Type.Object({
	operations: Type.Array(Type.Union([createOperation, updateOperation, moveOperation, deleteOperation]), {
		minItems: 1,
	}),
});

export type EditV2Input = Static<typeof editV2Schema>;
export type EditV2Operation = EditV2Input["operations"][number];

export interface EditV2Details {
	operations: Array<{ index: number; kind: EditV2Operation["kind"]; path: string; to?: string }>;
	changedPaths: string[];
	patch: string;
}

export interface EditV2PartialCommitDetails {
	completedOperationIndexes: number[];
	failedOperationIndex: number;
	pendingOperationIndexes: number[];
	changedPaths: string[];
	createdDirectories: string[];
	unknownPaths: string[];
}

type VirtualFile = { content: string; initialContent?: string; exists: boolean; initialExists: boolean };
type PlannedOperation = EditV2Operation & { path: string; to?: string; content?: string };

function countOccurrences(content: string, needle: string): number {
	let count = 0;
	let offset = 0;
	while (true) {
		const index = content.indexOf(needle, offset);
		if (index < 0) return count;
		count++;
		offset = index + needle.length;
	}
}

async function pathExists(env: ExecutionEnv, path: string, signal?: AbortSignal): Promise<boolean> {
	const result = await env.exists(path, signal);
	if (!result.ok) throw new V2ToolError("PERMISSION_DENIED", `Could not inspect ${path}: ${result.error.message}`);
	return result.value;
}

async function loadFile(
	env: ExecutionEnv,
	files: Map<string, VirtualFile>,
	path: string,
	signal?: AbortSignal,
): Promise<VirtualFile> {
	const cached = files.get(path);
	if (cached) return cached;
	const info = await env.fileInfo(path, signal);
	if (!info.ok) {
		if (info.error.code === "not_found") throw new V2ToolError("NOT_FOUND", `${path} does not exist.`);
		throw new V2ToolError("PERMISSION_DENIED", `Could not inspect ${path}: ${info.error.message}`);
	}
	if (info.value.kind !== "file") throw new V2ToolError("NOT_A_FILE", `${path} is not a regular file.`);
	const read = await env.readTextFile(path, signal);
	if (!read.ok) throw new V2ToolError("PERMISSION_DENIED", `Could not read ${path}: ${read.error.message}`);
	const file = { content: read.value, initialContent: read.value, exists: true, initialExists: true };
	files.set(path, file);
	return file;
}

async function planEdit(
	input: EditV2Input,
	context: ExecutionToolContext,
	signal?: AbortSignal,
): Promise<{ planned: PlannedOperation[]; files: Map<string, VirtualFile> }> {
	if (!Array.isArray(input.operations) || input.operations.length === 0) {
		throw new V2ToolError("INVALID_INPUT", "operations must contain at least one file operation.");
	}
	const files = new Map<string, VirtualFile>();
	const identities = new Map<string, string>();
	const planned: PlannedOperation[] = [];
	const resolve = async (path: string): Promise<string> => {
		const result = await resolveWorkspacePath(context.env, path, "write", context.workspacePolicy, signal);
		const previous = identities.get(result.canonicalPath);
		if (previous && previous !== result.absolutePath) {
			throw new V2ToolError("EDIT_CONFLICT", `${path} aliases another path in this edit batch.`);
		}
		identities.set(result.canonicalPath, result.absolutePath);
		return result.absolutePath;
	};

	for (const operation of input.operations) {
		if (signal?.aborted) throw new V2ToolError("ABORTED", "Edit was aborted before commit.");
		const path = await resolve(operation.path);
		switch (operation.kind) {
			case "create": {
				const virtual = files.get(path);
				if ((virtual?.exists ?? false) || (!virtual && (await pathExists(context.env, path, signal)))) {
					throw new V2ToolError("EDIT_CONFLICT", `${operation.path} already exists; create never overwrites.`);
				}
				files.set(path, { content: operation.content, exists: true, initialExists: false });
				planned.push({ ...operation, path, content: operation.content });
				break;
			}
			case "update": {
				if (operation.oldText.length === 0)
					throw new V2ToolError("INVALID_INPUT", "update.oldText must not be empty.");
				const file = await loadFile(context.env, files, path, signal);
				if (!file.exists)
					throw new V2ToolError("NOT_FOUND", `${operation.path} was deleted earlier in this batch.`);
				const matches = countOccurrences(file.content, operation.oldText);
				if (matches === 0)
					throw new V2ToolError(
						"EDIT_CONTEXT_NOT_FOUND",
						`Exact text was not found in ${operation.path}. Read it and retry.`,
					);
				if (matches > 1)
					throw new V2ToolError(
						"EDIT_CONTEXT_AMBIGUOUS",
						`Exact text occurs ${matches} times in ${operation.path}. Add context.`,
					);
				file.content = file.content.replace(operation.oldText, operation.newText);
				planned.push({ ...operation, path, content: file.content });
				break;
			}
			case "move": {
				const to = await resolve(operation.to);
				const source = await loadFile(context.env, files, path, signal);
				if (!source.exists) throw new V2ToolError("NOT_FOUND", `${operation.path} is unavailable.`);
				const destination = files.get(to);
				if ((destination?.exists ?? false) || (!destination && (await pathExists(context.env, to, signal)))) {
					throw new V2ToolError("EDIT_CONFLICT", `${operation.to} already exists; move never overwrites.`);
				}
				source.exists = false;
				files.set(to, { ...source, exists: true, initialExists: false });
				planned.push({ ...operation, path, to });
				break;
			}
			case "delete": {
				const file = await loadFile(context.env, files, path, signal);
				if (!file.exists) throw new V2ToolError("NOT_FOUND", `${operation.path} is unavailable.`);
				file.exists = false;
				planned.push({ ...operation, path });
				break;
			}
		}
	}
	return { planned, files };
}

export function createEditV2Tool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof editV2Schema,
	EditV2Details
> {
	return {
		name: "edit",
		label: "edit",
		description: "Create, update, move, or delete regular files with one prevalidated operations batch.",
		parameters: editV2Schema,
		executionMode: "sequential",
		async execute(_toolCallId, input, signal, _onUpdate, context) {
			return withV2MutationCoordinator(context.env, async () => {
				const { planned, files } = await planEdit(input, context, signal);
				const completed: number[] = [];
				const changed = new Set<string>();
				for (let index = 0; index < planned.length; index++) {
					const operation = planned[index];
					try {
						let result: Result<void, FileError>;
						switch (operation.kind) {
							case "create":
							case "update":
								result = await context.env.writeFile(operation.path, operation.content ?? "", signal);
								break;
							case "move":
								result = await context.env.renameFile(operation.path, operation.to ?? "", signal);
								break;
							case "delete":
								result = await context.env.remove(operation.path, { abortSignal: signal });
								break;
						}
						if (!result.ok) throw result.error;
						changed.add(operation.path);
						if (operation.to) changed.add(operation.to);
						completed.push(index);
					} catch (error) {
						const endpoints = [operation.path, operation.to].filter((path): path is string => !!path);
						const details: EditV2PartialCommitDetails = {
							completedOperationIndexes: completed,
							failedOperationIndex: index,
							pendingOperationIndexes: planned.slice(index + 1).map((_, pending) => index + pending + 1),
							changedPaths: [...changed],
							createdDirectories: [],
							unknownPaths: endpoints,
						};
						throw new V2ToolError(
							"EDIT_PARTIAL_COMMIT",
							"Commit failed. Read every changed or unknown path before recovery; do not replay blindly.",
							details,
							error instanceof Error ? error : undefined,
						);
					}
				}
				const patches: string[] = [];
				for (const [path, file] of files) {
					const before = file.initialContent ?? "";
					const after = file.exists ? file.content : "";
					if (before !== after || file.initialExists !== file.exists)
						patches.push(generateUnifiedPatch(path, before, after));
				}
				const operations = planned.map((operation, index) => ({
					index,
					kind: operation.kind,
					path: operation.path,
					to: operation.to,
				}));
				const summary = operations
					.map((operation) => `${operation.kind}: ${operation.path}${operation.to ? ` -> ${operation.to}` : ""}`)
					.join("\n");
				return {
					content: [{ type: "text", text: `Applied ${operations.length} file operation(s).\n\n${summary}` }],
					details: { operations, changedPaths: [...changed], patch: patches.join("\n") },
				};
			});
		},
	};
}
