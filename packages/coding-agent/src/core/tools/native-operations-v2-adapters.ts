import path from "node:path";
import {
	type DirectoryReadPage,
	type DirectoryReadRequest,
	type EditPlan,
	type FileInfo,
	type MutationBackend,
	type MutationCapabilities,
	type MutationCommitResult,
	type ReadCapabilities,
	type ReadProvider,
	ReadProviderError,
	type SearchCapabilities,
	type SearchExecutionContext,
	type SearchHit,
	type SearchPage,
	type SearchProvider,
	SearchProviderError,
	type SearchRequest,
	type TextRangeReadOptions,
	type TextRangeReadResult,
	V2ToolError,
	validateEditPlan,
} from "@earendil-works/pi-agent-core";
import type { EditOperations } from "./edit.ts";
import type { FindOperations } from "./find.ts";
import type { LsOperations } from "./ls.ts";
import type { ReadOperations } from "./read.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });

async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type SearchSnapshot = { hits: SearchHit[]; generation: string; partial: boolean };

/** Glob-only compatibility adapter for legacy FindOperations. */
export class NativeFindOperationsSearchProvider implements SearchProvider {
	readonly id = "native-find-operations";
	readonly capabilities: SearchCapabilities = {
		textLiteral: false,
		textRegex: false,
		context: false,
		fuzzyFiles: false,
		glob: true,
		stableCursor: true,
		globalRanking: false,
	};
	private readonly operations: FindOperations;
	private readonly snapshots = new Map<string, SearchSnapshot>();
	private sequence = 0;

	constructor(operations: FindOperations) {
		this.operations = operations;
	}

	async search(request: SearchRequest, _context: SearchExecutionContext, signal?: AbortSignal): Promise<SearchPage> {
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Search aborted.");
		if (request.kind !== "glob") {
			throw new SearchProviderError(
				"unsupported",
				"Legacy FindOperations supports exact glob search only; text and fuzzy file search are unavailable.",
			);
		}
		if (request.cursor) {
			const snapshot = this.snapshots.get(request.cursor);
			if (!snapshot || snapshot.generation !== request.expectedGeneration) {
				throw new SearchProviderError("stale_cursor", "The native operations snapshot is unavailable.");
			}
			return this.page(snapshot.hits, request.limit, snapshot.generation, snapshot.partial);
		}
		if (!(await this.operations.exists(request.path))) {
			throw new SearchProviderError("unavailable", `Search path was not found: ${request.path}`);
		}
		const rawPaths = await this.operations.glob(request.query, request.path, {
			ignore: ["**/node_modules/**", "**/.git/**"],
			limit: 10_001,
		});
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Search aborted.");
		const partial = rawPaths.length > 10_000;
		const hits = rawPaths.slice(0, 10_000).map((rawPath): SearchHit => {
			const relative = path.isAbsolute(rawPath) ? path.relative(request.path, rawPath) : rawPath;
			return { kind: "file", path: relative.replaceAll("\\", "/"), exact: true };
		});
		hits.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
		return this.page(hits, request.limit, `native-find-${this.sequence++}`, partial);
	}

	private page(hits: SearchHit[], limit: number, generation: string, partial = false): SearchPage {
		const page = hits.slice(0, limit);
		const remaining = hits.slice(limit);
		let nextCursor: string | undefined;
		if (remaining.length > 0) {
			nextCursor = `native-find-cursor-${this.sequence++}`;
			this.snapshots.set(nextCursor, { hits: remaining, generation, partial });
			while (this.snapshots.size > 200) {
				const oldest = this.snapshots.keys().next().value;
				if (oldest === undefined) break;
				this.snapshots.delete(oldest);
			}
		}
		return { hits: page, nextCursor, complete: !partial, approximate: false, partial, generation };
	}

	async close(): Promise<void> {
		this.snapshots.clear();
	}
}

type ReadSnapshot = { names: string[]; generation: string; path: string };

/** Bounded compatibility adapter for legacy ReadOperations plus optional LsOperations. */
export class NativeReadOperationsProvider implements ReadProvider {
	readonly id = "native-read-operations";
	readonly capabilities: ReadCapabilities;
	private readonly readOperations: ReadOperations;
	private readonly listOperations: LsOperations | undefined;
	private readonly maxFileBytes: number;
	private readonly maxDirectoryEntries: number;
	private readonly snapshots = new Map<string, ReadSnapshot>();
	private sequence = 0;

	constructor(options: {
		read: ReadOperations;
		list?: LsOperations;
		maxFileBytes?: number;
		maxDirectoryEntries?: number;
	}) {
		this.readOperations = options.read;
		this.listOperations = options.list;
		this.maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
		this.maxDirectoryEntries = options.maxDirectoryEntries ?? 10_000;
		this.capabilities = {
			textRange: false,
			directoryPage: options.list !== undefined,
			stableDirectoryCursor: options.list !== undefined,
			binary: true,
		};
	}

	async stat(path: string, signal?: AbortSignal): Promise<FileInfo> {
		if (signal?.aborted) throw new ReadProviderError("unsupported", "Read aborted.");
		if (this.listOperations) {
			if (!(await this.listOperations.exists(path)))
				throw new ReadProviderError("not_found", `${path} was not found.`);
			const stat = await this.listOperations.stat(path);
			if (stat.isDirectory()) {
				return { name: pathModuleBasename(path), path, kind: "directory", size: 0, mtimeMs: 0 };
			}
		}
		try {
			await this.readOperations.access(path);
			const bytes = await this.readOperations.readFile(path);
			return { name: pathModuleBasename(path), path, kind: "file", size: bytes.byteLength, mtimeMs: 0 };
		} catch (error) {
			throw new ReadProviderError("not_found", error instanceof Error ? error.message : String(error));
		}
	}

	async readText(path: string, options: TextRangeReadOptions, signal?: AbortSignal): Promise<TextRangeReadResult> {
		if (signal?.aborted) throw new ReadProviderError("unsupported", "Read aborted.");
		if ((options.startLine ?? 1) !== 1 || options.startByte !== undefined) {
			throw new ReadProviderError("range_unsupported", "Legacy ReadOperations cannot perform bounded range reads.");
		}
		const bytes = await this.readOperations.readFile(path);
		if (bytes.byteLength > Math.min(this.maxFileBytes, options.maxBytes ?? this.maxFileBytes)) {
			throw new ReadProviderError(
				"range_unsupported",
				`File exceeds the ${this.maxFileBytes}-byte native adapter limit.`,
			);
		}
		let text: string;
		try {
			text = decoder.decode(bytes);
		} catch {
			throw new ReadProviderError("unsupported", `${path} is not valid UTF-8 text.`);
		}
		const lines = text.split(/\r?\n/);
		if (text.endsWith("\n")) lines.pop();
		if (lines.length > (options.maxLines ?? Number.MAX_SAFE_INTEGER)) {
			throw new ReadProviderError(
				"range_unsupported",
				"Legacy ReadOperations cannot return a bounded continuation for this file.",
			);
		}
		return { lines, startLine: 1, endLine: Math.max(1, lines.length), eof: true, partialLine: false };
	}

	async readDirectory(request: DirectoryReadRequest, signal?: AbortSignal): Promise<DirectoryReadPage> {
		if (!this.listOperations) throw new ReadProviderError("unsupported", "Directory reads are unavailable.");
		if (signal?.aborted) throw new ReadProviderError("unsupported", "Read aborted.");
		let names: string[];
		let generation: string;
		if (request.cursor) {
			const snapshot = this.snapshots.get(request.cursor);
			if (!snapshot || snapshot.generation !== request.expectedGeneration || snapshot.path !== request.path) {
				throw new ReadProviderError("stale_cursor", "The native directory snapshot is unavailable.");
			}
			names = snapshot.names;
			generation = snapshot.generation;
		} else {
			names = await this.listOperations.readdir(request.path);
			if (names.length > this.maxDirectoryEntries) {
				throw new ReadProviderError(
					"directory_too_large",
					`Directory exceeds the ${this.maxDirectoryEntries}-entry native adapter limit.`,
				);
			}
			names.sort();
			names = names.slice(request.offset - 1);
			generation = `native-read-${this.sequence++}`;
		}
		const visible = names.slice(0, request.limit);
		const entries = await Promise.all(
			visible.map(async (name) => {
				const stat = await this.listOperations!.stat(path.join(request.path, name));
				return { name, kind: stat.isDirectory() ? ("directory" as const) : ("file" as const) };
			}),
		);
		const remaining = names.slice(visible.length);
		let nextCursor: string | undefined;
		if (remaining.length > 0) {
			nextCursor = `native-read-cursor-${this.sequence++}`;
			this.snapshots.set(nextCursor, { names: remaining, generation, path: request.path });
			while (this.snapshots.size > 100) {
				const oldest = this.snapshots.keys().next().value;
				if (oldest === undefined) break;
				this.snapshots.delete(oldest);
			}
		}
		return { entries, nextCursor, generation, stable: true, partial: false };
	}

	async readBinary(path: string, signal?: AbortSignal): Promise<Uint8Array> {
		if (signal?.aborted) throw new ReadProviderError("unsupported", "Read aborted.");
		const bytes = await this.readOperations.readFile(path);
		if (bytes.byteLength > this.maxFileBytes) {
			throw new ReadProviderError("unsupported", `File exceeds the ${this.maxFileBytes}-byte native adapter limit.`);
		}
		return bytes;
	}

	async close(): Promise<void> {
		this.snapshots.clear();
	}
}

function pathModuleBasename(value: string): string {
	return path.basename(value) || value;
}

/** Update-only compatibility backend for legacy EditOperations. */
export class NativeEditOperationsMutationBackend implements MutationBackend {
	readonly id = "native-edit-operations";
	readonly capabilities: MutationCapabilities = {
		atomicRenameSameFilesystem: false,
		fsyncFile: false,
		fsyncDirectory: false,
		preserveMode: false,
		detectCrossFilesystem: false,
		durableJournal: false,
	};
	private readonly operations: EditOperations;

	constructor(operations: EditOperations) {
		this.operations = operations;
	}

	async commit(plan: EditPlan, signal?: AbortSignal): Promise<MutationCommitResult> {
		validateEditPlan(plan);
		if (plan.operations.some((operation) => operation.kind !== "update")) {
			throw new V2ToolError(
				"EDIT_ROLLED_BACK",
				"Legacy EditOperations supports update operations only. No files were changed.",
			);
		}
		for (const observation of plan.observations) {
			if (signal?.aborted) throw new V2ToolError("ABORTED", "Edit was aborted before commit.");
			try {
				await this.operations.access(observation.path);
				const bytes = await this.operations.readFile(observation.path);
				if (
					!observation.exists ||
					bytes.byteLength !== observation.size ||
					(await hashBytes(bytes)) !== observation.contentHash
				) {
					throw new Error("stale");
				}
			} catch {
				throw new V2ToolError(
					"STALE_FILE",
					"A file changed after the edit was planned. No files were changed by this call.",
					{ paths: [observation.path], recovery: { kind: "read_again", paths: [observation.path] } },
				);
			}
		}
		const completedOperationIndexes: number[] = [];
		const changedPaths: string[] = [];
		for (let index = 0; index < plan.operations.length; index++) {
			const operation = plan.operations[index];
			if (operation.kind !== "update") continue;
			try {
				if (signal?.aborted) throw new Error("aborted");
				await this.operations.writeFile(operation.path, operation.content);
				completedOperationIndexes.push(index);
				changedPaths.push(operation.path);
			} catch (error) {
				throw new V2ToolError(
					"EDIT_PARTIAL_COMMIT",
					"Legacy edit commit failed. Read every changed or unknown path before recovery.",
					{
						completedOperationIndexes,
						failedOperationIndex: index,
						pendingOperationIndexes: plan.operations.slice(index + 1).map((_, offset) => index + offset + 1),
						changedPaths,
						createdDirectories: [],
						unknownPaths: [operation.path],
					},
					error instanceof Error ? error : undefined,
				);
			}
		}
		return { completedOperationIndexes, changedPaths, createdDirectories: [] };
	}

	async close(): Promise<void> {}
}
