import type { ExecutionEnv, FileError, Result } from "../types.ts";
import { V2ToolError } from "./v2-errors.ts";

export interface MutationCapabilities {
	atomicRenameSameFilesystem: boolean;
	fsyncFile: boolean;
	fsyncDirectory: boolean;
	preserveMode: boolean;
	detectCrossFilesystem: boolean;
	durableJournal: boolean;
}

export interface FileObservation {
	path: string;
	exists: boolean;
	identity?: string;
	contentHash?: string;
	size: number;
	mtimeMs?: number;
	mode?: number;
}

export interface MutationLimits {
	maxOperations: number;
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
}

export const DEFAULT_MUTATION_LIMITS: MutationLimits = {
	maxOperations: 100,
	maxFiles: 100,
	maxFileBytes: 5 * 1024 * 1024,
	maxTotalBytes: 20 * 1024 * 1024,
};

export type EditPlanOperation =
	| {
			kind: "create" | "update";
			path: string;
			content: string;
			parentDirectories?: string[];
	  }
	| {
			kind: "move";
			path: string;
			to: string;
			parentDirectories?: string[];
	  }
	| {
			kind: "delete";
			path: string;
	  };

export interface EditPlan {
	observations: FileObservation[];
	operations: EditPlanOperation[];
	limits: MutationLimits;
}

export interface MutationCommitResult {
	completedOperationIndexes: number[];
	changedPaths: string[];
	createdDirectories: string[];
}

export interface MutationBackend {
	readonly id: string;
	readonly capabilities: MutationCapabilities;
	commit(plan: EditPlan, signal?: AbortSignal): Promise<MutationCommitResult>;
	close(): Promise<void>;
}

export interface ObservedTextFile {
	observation: FileObservation;
	content: string;
}

const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function byteLength(content: string): number {
	return textEncoder.encode(content).byteLength;
}

function planTooLarge(message: string): V2ToolError {
	return new V2ToolError("EDIT_PLAN_TOO_LARGE", message, { recovery: { kind: "split_edit" } });
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fileFailure(error: FileError, path: string, action: string): V2ToolError {
	if (error.code === "aborted")
		return new V2ToolError("ABORTED", `${action} was aborted for ${path}.`, undefined, error);
	if (error.code === "not_found") return new V2ToolError("NOT_FOUND", `${path} does not exist.`, undefined, error);
	return new V2ToolError("PERMISSION_DENIED", `Could not ${action} ${path}: ${error.message}`, undefined, error);
}

export async function observeMutationPath(
	env: ExecutionEnv,
	path: string,
	maxFileBytes: number,
	signal?: AbortSignal,
): Promise<ObservedTextFile | { observation: FileObservation; content?: undefined }> {
	const info = await env.fileInfo(path, signal);
	if (!info.ok) {
		if (info.error.code === "not_found") {
			return { observation: { path, exists: false, size: 0 } };
		}
		throw fileFailure(info.error, path, "inspect");
	}
	if (info.value.kind !== "file") {
		throw new V2ToolError(
			"NOT_A_FILE",
			`${path} is not a regular file; symlink and special-file edits are unsupported.`,
		);
	}
	if (info.value.size > maxFileBytes) {
		throw planTooLarge(
			`${path} exceeds the per-file mutation limit of ${maxFileBytes} bytes. Split or narrow the edit.`,
		);
	}
	const binary = await env.readBinaryFile(path, signal);
	if (!binary.ok) throw fileFailure(binary.error, path, "read");
	if (binary.value.byteLength > maxFileBytes) {
		throw planTooLarge(
			`${path} exceeded the per-file mutation limit of ${maxFileBytes} bytes while it was being read. Retry or split the edit.`,
		);
	}
	let content: string;
	try {
		content = utf8Decoder.decode(binary.value);
	} catch {
		throw new V2ToolError("UNSUPPORTED_BINARY_FILE", `${path} is not valid UTF-8 text.`);
	}
	return {
		observation: {
			path,
			exists: true,
			identity: info.value.identity,
			contentHash: await hashBytes(binary.value),
			size: binary.value.byteLength,
			mtimeMs: info.value.mtimeMs,
			mode: info.value.mode,
		},
		content,
	};
}

export function validateEditPlan(plan: EditPlan): void {
	if (plan.operations.length === 0 || plan.operations.length > plan.limits.maxOperations) {
		throw planTooLarge(`Edit plan must contain 1-${plan.limits.maxOperations} operations. Split the edit.`);
	}
	const paths = new Set<string>();
	let totalBytes = 0;
	for (const operation of plan.operations) {
		paths.add(operation.path);
		if (operation.kind === "move") paths.add(operation.to);
		if (operation.kind === "create" || operation.kind === "update") {
			const size = byteLength(operation.content);
			if (size > plan.limits.maxFileBytes) {
				throw planTooLarge(
					`${operation.path} exceeds the per-file mutation limit of ${plan.limits.maxFileBytes} bytes.`,
				);
			}
			totalBytes += size;
		}
	}
	if (paths.size > plan.limits.maxFiles || totalBytes > plan.limits.maxTotalBytes) {
		throw planTooLarge(
			`Edit plan exceeds its ${plan.limits.maxFiles}-file or ${plan.limits.maxTotalBytes}-byte limit. Split the edit.`,
		);
	}
}

async function observationMatches(
	env: ExecutionEnv,
	expected: FileObservation,
	maxFileBytes: number,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const current = await observeMutationPath(env, expected.path, maxFileBytes, signal);
		const actual = current.observation;
		return (
			actual.exists === expected.exists &&
			actual.identity === expected.identity &&
			actual.contentHash === expected.contentHash &&
			actual.size === expected.size &&
			actual.mtimeMs === expected.mtimeMs &&
			actual.mode === expected.mode
		);
	} catch (error) {
		if (error instanceof V2ToolError && error.code === "ABORTED") throw error;
		if (error instanceof V2ToolError) return false;
		throw error;
	}
}

function throwMutationFailure(error: FileError): never {
	if (error.code === "aborted") throw new V2ToolError("ABORTED", "Edit was aborted during commit.", undefined, error);
	throw error;
}

/** Compatibility backend with pre-commit observation checks and explicit partial-commit reporting. */
export class ExecutionEnvMutationBackend implements MutationBackend {
	readonly id = "execution-env-mutation";
	readonly capabilities: MutationCapabilities = {
		atomicRenameSameFilesystem: true,
		fsyncFile: false,
		fsyncDirectory: false,
		preserveMode: false,
		detectCrossFilesystem: false,
		durableJournal: false,
	};
	private readonly env: ExecutionEnv;

	constructor(env: ExecutionEnv) {
		this.env = env;
	}

	async commit(plan: EditPlan, signal?: AbortSignal): Promise<MutationCommitResult> {
		validateEditPlan(plan);
		for (const observation of plan.observations) {
			if (!(await observationMatches(this.env, observation, plan.limits.maxFileBytes, signal))) {
				throw new V2ToolError(
					"STALE_FILE",
					"A file changed after the edit was planned. Read it again and create a new edit plan. No files were changed by this call.",
					{ paths: [observation.path], recovery: { kind: "read_again", paths: [observation.path] } },
				);
			}
		}

		const completed: number[] = [];
		const changed = new Set<string>();
		const createdDirectories = new Set<string>();
		for (let index = 0; index < plan.operations.length; index++) {
			const operation = plan.operations[index];
			try {
				for (const directory of "parentDirectories" in operation ? (operation.parentDirectories ?? []) : []) {
					const exists = await this.env.exists(directory, signal);
					if (!exists.ok) throwMutationFailure(exists.error);
					if (exists.value) continue;
					const created = await this.env.createDir(directory, { recursive: false, abortSignal: signal });
					if (!created.ok) throwMutationFailure(created.error);
					createdDirectories.add(directory);
				}
				let result: Result<void, FileError>;
				switch (operation.kind) {
					case "create":
					case "update":
						result = await this.env.writeFile(operation.path, operation.content, signal);
						break;
					case "move":
						result = await this.env.renameFile(operation.path, operation.to, signal);
						break;
					case "delete":
						result = await this.env.remove(operation.path, { abortSignal: signal });
						break;
				}
				if (!result.ok) throwMutationFailure(result.error);
				changed.add(operation.path);
				if (operation.kind === "move") changed.add(operation.to);
				completed.push(index);
			} catch (error) {
				const endpoints = [operation.path, operation.kind === "move" ? operation.to : undefined].filter(
					(path): path is string => path !== undefined,
				);
				throw new V2ToolError(
					"EDIT_PARTIAL_COMMIT",
					"Commit failed. Read every changed or unknown path before recovery; do not replay blindly.",
					{
						completedOperationIndexes: completed,
						failedOperationIndex: index,
						pendingOperationIndexes: plan.operations.slice(index + 1).map((_, pending) => index + pending + 1),
						changedPaths: [...changed],
						createdDirectories: [...createdDirectories],
						unknownPaths: endpoints,
					},
					error instanceof Error ? error : undefined,
				);
			}
		}
		return {
			completedOperationIndexes: completed,
			changedPaths: [...changed],
			createdDirectories: [...createdDirectories],
		};
	}

	async close(): Promise<void> {}
}
