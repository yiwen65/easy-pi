import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExecutionEnv, FileInfo, TextRangeReadOptions, TextRangeReadResult } from "../types.ts";
import { DEFAULT_MAX_BYTES } from "../utils/truncate.ts";

export interface ReadCapabilities {
	textRange: boolean;
	directoryPage: boolean;
	stableDirectoryCursor: boolean;
	binary: boolean;
}

export interface DirectoryReadEntry {
	name: string;
	kind: FileInfo["kind"];
	size?: number;
	mtimeMs?: number;
}

export interface DirectoryReadRequest {
	path: string;
	offset: number;
	limit: number;
	cursor?: string;
	expectedGeneration?: string | number;
}

export interface DirectoryReadPage {
	entries: DirectoryReadEntry[];
	nextCursor?: string;
	generation?: string | number;
	stable: boolean;
	partial: boolean;
}

export type ReadProviderErrorCode =
	| "not_found"
	| "permission_denied"
	| "invalid"
	| "range_unsupported"
	| "directory_too_large"
	| "stale_cursor"
	| "unsupported";

export class ReadProviderError extends Error {
	readonly code: ReadProviderErrorCode;

	constructor(code: ReadProviderErrorCode, message: string) {
		super(message);
		this.name = "ReadProviderError";
		this.code = code;
	}
}

export interface ReadProvider {
	readonly id: string;
	readonly capabilities: ReadCapabilities;
	stat(path: string, signal?: AbortSignal): Promise<FileInfo>;
	readText(path: string, options: TextRangeReadOptions, signal?: AbortSignal): Promise<TextRangeReadResult>;
	readDirectory(request: DirectoryReadRequest, signal?: AbortSignal): Promise<DirectoryReadPage>;
	readBinary(path: string, signal?: AbortSignal): Promise<Uint8Array>;
	close(): Promise<void>;
}

export type SymbolReadMode = "symbol_body" | "ast_node";

export interface SymbolReadRequest {
	path: string;
	mode: SymbolReadMode;
	symbol?: string;
	nodeId?: string;
}

export interface SymbolReadTarget {
	path: string;
	startLine: number;
	endLine: number;
	startByte?: number;
	endByte?: number;
	symbol?: string;
	nodeKind?: string;
	generation?: string | number;
}

/** Optional language-aware range resolver used by the model-visible read tool. */
export interface SymbolReadProvider {
	readonly id: string;
	readonly languages: string[];
	resolve(request: SymbolReadRequest, signal?: AbortSignal): Promise<SymbolReadTarget>;
	close(): Promise<void>;
}

export interface ResourceReadResult {
	content: Array<TextContent | ImageContent>;
	mediaType?: string;
	size?: number;
}

export interface ResourceReader {
	readonly id: string;
	canRead(resource: string): boolean;
	read(resource: string, signal?: AbortSignal): Promise<ResourceReadResult>;
	close(): Promise<void>;
}

const DEFAULT_DIRECTORY_LIMIT = 10_000;
const MAX_SNAPSHOTS = 100;

type DirectorySnapshot = {
	entries: FileInfo[];
	generation: string;
};

function compareEntries(left: FileInfo, right: FileInfo): number {
	return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function mapFileError(code: string, message: string): ReadProviderError {
	return new ReadProviderError(
		code === "not_found"
			? "not_found"
			: code === "permission_denied"
				? "permission_denied"
				: code === "invalid"
					? "invalid"
					: "unsupported",
		message,
	);
}

/** Bounded compatibility provider for custom ExecutionEnv implementations. */
export class ExecutionEnvReadProvider implements ReadProvider {
	readonly id = "execution-env-read";
	readonly capabilities: ReadCapabilities;
	private readonly env: ExecutionEnv;
	private readonly maxDirectoryEntries: number;
	private readonly snapshots = new Map<string, DirectorySnapshot>();
	private sequence = 0;

	constructor(env: ExecutionEnv, options: { maxDirectoryEntries?: number } = {}) {
		this.env = env;
		this.maxDirectoryEntries = options.maxDirectoryEntries ?? DEFAULT_DIRECTORY_LIMIT;
		this.capabilities = {
			textRange: env.readTextRange !== undefined,
			directoryPage: true,
			stableDirectoryCursor: true,
			binary: true,
		};
	}

	async stat(path: string, signal?: AbortSignal): Promise<FileInfo> {
		const result = await this.env.fileInfo(path, signal);
		if (!result.ok) throw mapFileError(result.error.code, result.error.message);
		return result.value;
	}

	async readText(path: string, options: TextRangeReadOptions, signal?: AbortSignal): Promise<TextRangeReadResult> {
		if (this.env.readTextRange) {
			const result = await this.env.readTextRange(path, { ...options, abortSignal: signal });
			if (!result.ok) {
				if (result.error.code === "invalid" && result.error.message.includes("not valid UTF-8")) {
					throw new ReadProviderError("unsupported", result.error.message);
				}
				throw mapFileError(result.error.code, result.error.message);
			}
			return result.value;
		}
		if ((options.startLine ?? 1) !== 1 || options.startByte !== undefined) {
			throw new ReadProviderError(
				"range_unsupported",
				"This backend cannot read the requested range without loading an oversized file.",
			);
		}
		const info = await this.stat(path, signal);
		if (info.size > (options.maxBytes ?? DEFAULT_MAX_BYTES)) {
			throw new ReadProviderError(
				"range_unsupported",
				"This backend cannot safely read this file without a bounded range capability.",
			);
		}
		const result = await this.env.readTextLines(path, { maxLines: options.maxLines, abortSignal: signal });
		if (!result.ok) throw mapFileError(result.error.code, result.error.message);
		return {
			lines: result.value,
			startLine: 1,
			endLine: result.value.length,
			eof: true,
			partialLine: false,
		};
	}

	async readDirectory(request: DirectoryReadRequest, signal?: AbortSignal): Promise<DirectoryReadPage> {
		if (request.cursor) return this.continueSnapshot(request);
		const result = await this.env.listDir(request.path, signal);
		if (!result.ok) throw mapFileError(result.error.code, result.error.message);
		if (result.value.length > this.maxDirectoryEntries) {
			throw new ReadProviderError(
				"directory_too_large",
				`Directory exceeds the compatibility limit of ${this.maxDirectoryEntries} entries. Narrow the path or configure a streaming provider.`,
			);
		}
		const entries = result.value.sort(compareEntries);
		return this.page(entries, request.offset - 1, request.limit);
	}

	private page(
		entries: FileInfo[],
		start: number,
		limit: number,
		generation = `env-dir-${this.sequence++}`,
	): DirectoryReadPage {
		const pageEntries = entries.slice(start, start + limit);
		const remaining = entries.slice(start + pageEntries.length);
		let nextCursor: string | undefined;
		if (remaining.length > 0) {
			nextCursor = `env-read-cursor-${this.sequence++}`;
			this.snapshots.set(nextCursor, { entries: remaining, generation });
			while (this.snapshots.size > MAX_SNAPSHOTS) {
				const oldest = this.snapshots.keys().next().value;
				if (oldest === undefined) break;
				this.snapshots.delete(oldest);
			}
		}
		return {
			entries: pageEntries.map((entry) => ({
				name: entry.name,
				kind: entry.kind,
				size: entry.size,
				mtimeMs: entry.mtimeMs,
			})),
			nextCursor,
			generation,
			stable: true,
			partial: false,
		};
	}

	private continueSnapshot(request: DirectoryReadRequest): DirectoryReadPage {
		const snapshot = this.snapshots.get(request.cursor ?? "");
		if (!snapshot || snapshot.generation !== request.expectedGeneration) {
			throw new ReadProviderError("stale_cursor", "The directory snapshot is no longer available.");
		}
		return this.page(snapshot.entries, 0, request.limit, snapshot.generation);
	}

	async readBinary(path: string, signal?: AbortSignal): Promise<Uint8Array> {
		const result = await this.env.readBinaryFile(path, signal);
		if (!result.ok) throw mapFileError(result.error.code, result.error.message);
		return result.value;
	}

	async close(): Promise<void> {
		this.snapshots.clear();
	}
}
