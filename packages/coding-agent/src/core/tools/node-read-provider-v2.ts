import { once } from "node:events";
import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import { lstat, mkdtemp, opendir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
	type DirectoryReadEntry,
	type DirectoryReadPage,
	type DirectoryReadRequest,
	ExecutionEnvReadProvider,
	type ReadCapabilities,
	type ReadProvider,
	ReadProviderError,
	type TextRangeReadOptions,
	type TextRangeReadResult,
} from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { spawn } from "child_process";

const DEFAULT_SMALL_DIRECTORY_LIMIT = 10_000;
const DEFAULT_MAX_EXTERNAL_ENTRIES = 1_000_000;
const DEFAULT_MAX_EXTERNAL_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const MAX_SNAPSHOTS = 20;

type MemorySnapshot = {
	entries: DirectoryReadEntry[];
	generation: string;
	directory: string;
};

type ExternalSnapshot = {
	root: string;
	file: string;
	directory: string;
	byteOffset: number;
	generation: string;
	expiresAt: number;
};

export interface NodeReadProviderOptions {
	smallDirectoryLimit?: number;
	externalSort?: {
		enabled: boolean;
		maxEntries?: number;
		maxBytes?: number;
	};
}

function direntKind(entry: Dirent): DirectoryReadEntry["kind"] {
	if (entry.isFile()) return "file";
	if (entry.isDirectory()) return "directory";
	return "symlink";
}

function compareNames(left: DirectoryReadEntry, right: DirectoryReadEntry): number {
	return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function encodeEntry(entry: DirectoryReadEntry): string {
	let sortKey = "";
	for (let index = 0; index < entry.name.length; index++) {
		sortKey += entry.name.charCodeAt(index).toString(16).padStart(4, "0");
	}
	return `${sortKey}\t${JSON.stringify(entry.name)}\t${entry.kind}\n`;
}

function decodeEntry(line: string): DirectoryReadEntry {
	const firstSeparator = line.indexOf("\t");
	const lastSeparator = line.lastIndexOf("\t");
	if (firstSeparator < 0 || lastSeparator <= firstSeparator) {
		throw new ReadProviderError("stale_cursor", "Directory snapshot is corrupt.");
	}
	const name = JSON.parse(line.slice(firstSeparator + 1, lastSeparator)) as unknown;
	const kind = line.slice(lastSeparator + 1);
	if (typeof name !== "string" || (kind !== "file" && kind !== "directory" && kind !== "symlink")) {
		throw new ReadProviderError("stale_cursor", "Directory snapshot is corrupt.");
	}
	return { name, kind };
}

/** Node directory provider with streaming limits and opt-in disk-backed external sorting. */
export class NodeReadProviderV2 implements ReadProvider {
	readonly id = "node-read-v2";
	readonly capabilities: ReadCapabilities = {
		textRange: true,
		directoryPage: true,
		stableDirectoryCursor: true,
		binary: true,
	};
	private readonly env: NodeExecutionEnv;
	private readonly compatibility: ExecutionEnvReadProvider;
	private readonly smallDirectoryLimit: number;
	private readonly externalSort: { enabled: boolean; maxEntries: number; maxBytes: number };
	private readonly memorySnapshots = new Map<string, MemorySnapshot>();
	private readonly externalSnapshots = new Map<string, ExternalSnapshot>();
	private sequence = 0;

	constructor(env: NodeExecutionEnv, options: NodeReadProviderOptions = {}) {
		this.env = env;
		this.compatibility = new ExecutionEnvReadProvider(env);
		this.smallDirectoryLimit = options.smallDirectoryLimit ?? DEFAULT_SMALL_DIRECTORY_LIMIT;
		this.externalSort = {
			enabled: options.externalSort?.enabled ?? false,
			maxEntries: options.externalSort?.maxEntries ?? DEFAULT_MAX_EXTERNAL_ENTRIES,
			maxBytes: options.externalSort?.maxBytes ?? DEFAULT_MAX_EXTERNAL_BYTES,
		};
	}

	stat(path: string, signal?: AbortSignal) {
		return this.compatibility.stat(path, signal);
	}

	readText(path: string, options: TextRangeReadOptions, signal?: AbortSignal): Promise<TextRangeReadResult> {
		return this.compatibility.readText(path, options, signal);
	}

	readBinary(path: string, signal?: AbortSignal): Promise<Uint8Array> {
		return this.compatibility.readBinary(path, signal);
	}

	async readDirectory(request: DirectoryReadRequest, signal?: AbortSignal): Promise<DirectoryReadPage> {
		await this.pruneSnapshots();
		if (request.cursor) {
			const memory = this.memorySnapshots.get(request.cursor);
			if (memory && memory.generation === request.expectedGeneration) {
				return this.pageMemory(memory.entries, request.limit, memory.generation, memory.directory);
			}
			const external = this.externalSnapshots.get(request.cursor);
			if (external && external.generation === request.expectedGeneration) {
				return this.pageExternal(external, request.limit, signal, 0, true);
			}
			throw new ReadProviderError("stale_cursor", "The Node directory snapshot is no longer available.");
		}

		let count = 0;
		let bytes = 0;
		let spoolRoot: string | undefined;
		let spoolFile: string | undefined;
		let spool = undefined as ReturnType<typeof createWriteStream> | undefined;
		const buffered: DirectoryReadEntry[] = [];
		try {
			const directory = await opendir(request.path);
			for await (const dirent of directory) {
				if (signal?.aborted) throw new ReadProviderError("unsupported", "Directory read aborted.");
				const entry = { name: dirent.name, kind: direntKind(dirent) };
				count++;
				if (count > this.externalSort.maxEntries) {
					throw new ReadProviderError(
						"directory_too_large",
						`Directory exceeds the external-sort quota of ${this.externalSort.maxEntries} entries.`,
					);
				}
				if (!spool && buffered.length < this.smallDirectoryLimit + 1) buffered.push(entry);
				if (!spool && buffered.length > this.smallDirectoryLimit) {
					if (!this.externalSort.enabled || process.platform === "win32") {
						throw new ReadProviderError(
							"directory_too_large",
							`Directory exceeds ${this.smallDirectoryLimit} entries. Narrow the path or configure the opt-in Unix external-sort provider.`,
						);
					}
					const base = path.join(tmpdir(), "pi-read-v2-");
					spoolRoot = await mkdtemp(base);
					spoolFile = path.join(spoolRoot, "unsorted.jsonl");
					spool = createWriteStream(spoolFile, { encoding: "utf8", mode: 0o600 });
					for (const bufferedEntry of buffered) {
						bytes = await this.writeSpoolEntry(spool, bufferedEntry, bytes);
					}
					buffered.length = 0;
				} else if (spool) bytes = await this.writeSpoolEntry(spool, entry, bytes);
			}
			if (!spool) {
				buffered.sort(compareNames);
				return this.pageMemory(buffered.slice(request.offset - 1), request.limit, undefined, request.path);
			}
			spool.end();
			await once(spool, "finish");
			const sortedFile = path.join(spoolRoot ?? "", "sorted.jsonl");
			await this.sortFile(spoolFile ?? "", sortedFile, signal);
			await rm(spoolFile ?? "", { force: true });
			const snapshot: ExternalSnapshot = {
				root: spoolRoot ?? "",
				file: sortedFile,
				directory: request.path,
				byteOffset: 0,
				generation: `node-dir-${this.sequence++}`,
				expiresAt: Date.now() + SNAPSHOT_TTL_MS,
			};
			const page = await this.pageExternal(snapshot, request.limit, signal, request.offset - 1);
			return page;
		} catch (error) {
			spool?.destroy();
			if (spoolRoot) await rm(spoolRoot, { recursive: true, force: true });
			if (error instanceof ReadProviderError) throw error;
			throw new ReadProviderError("permission_denied", error instanceof Error ? error.message : String(error));
		}
	}

	private async writeSpoolEntry(
		spool: ReturnType<typeof createWriteStream>,
		entry: DirectoryReadEntry,
		currentBytes: number,
	): Promise<number> {
		const line = encodeEntry(entry);
		const nextBytes = currentBytes + Buffer.byteLength(line);
		if (nextBytes > this.externalSort.maxBytes) {
			throw new ReadProviderError(
				"directory_too_large",
				`Directory snapshot exceeds the ${this.externalSort.maxBytes}-byte external-sort quota.`,
			);
		}
		if (!spool.write(line)) await once(spool, "drain");
		return nextBytes;
	}

	private sortFile(input: string, output: string, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn("sort", [input, "-o", output], {
				stdio: ["ignore", "ignore", "pipe"],
				env: { ...process.env, LC_ALL: "C" },
			});
			let stderr = "";
			const abort = () => child.kill();
			signal?.addEventListener("abort", abort, { once: true });
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.on("error", (error) => reject(new ReadProviderError("unsupported", error.message)));
			child.on("close", (code) => {
				signal?.removeEventListener("abort", abort);
				if (signal?.aborted) reject(new ReadProviderError("unsupported", "Directory sort aborted."));
				else if (code === 0) resolve();
				else reject(new ReadProviderError("unsupported", stderr.trim() || `sort exited ${code}`));
			});
		});
	}

	private async addMetadata(directory: string, entries: DirectoryReadEntry[]): Promise<DirectoryReadEntry[]> {
		return Promise.all(
			entries.map(async (entry) => {
				try {
					const info = await lstat(path.join(directory, entry.name));
					return { ...entry, size: info.size, mtimeMs: info.mtimeMs };
				} catch {
					return entry;
				}
			}),
		);
	}

	private async pageMemory(
		entries: DirectoryReadEntry[],
		limit: number,
		generation = `node-memory-${this.sequence++}`,
		directory: string,
	): Promise<DirectoryReadPage> {
		const page = await this.addMetadata(directory, entries.slice(0, limit));
		const remaining = entries.slice(limit);
		let nextCursor: string | undefined;
		if (remaining.length > 0) {
			nextCursor = `node-memory-cursor-${this.sequence++}`;
			this.memorySnapshots.set(nextCursor, { entries: remaining, generation, directory });
			while (this.memorySnapshots.size > MAX_SNAPSHOTS) {
				const oldest = this.memorySnapshots.keys().next().value;
				if (oldest === undefined) break;
				this.memorySnapshots.delete(oldest);
			}
		}
		return { entries: page, nextCursor, generation, stable: true, partial: false };
	}

	private async pageExternal(
		snapshot: ExternalSnapshot,
		limit: number,
		signal?: AbortSignal,
		skip = 0,
		retainRoot = false,
	): Promise<DirectoryReadPage> {
		const stream = createReadStream(snapshot.file, { encoding: "utf8", start: snapshot.byteOffset });
		const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		const entries: DirectoryReadEntry[] = [];
		let consumedBytes = 0;
		let skipped = 0;
		let hasMore = false;
		try {
			for await (const line of lines) {
				if (signal?.aborted) throw new ReadProviderError("unsupported", "Directory read aborted.");
				const lineBytes = Buffer.byteLength(line) + 1;
				if (skipped < skip) {
					skipped++;
					consumedBytes += lineBytes;
					continue;
				}
				if (entries.length >= limit) {
					hasMore = true;
					break;
				}
				entries.push(decodeEntry(line));
				consumedBytes += lineBytes;
			}
		} finally {
			lines.close();
			stream.destroy();
		}
		let nextCursor: string | undefined;
		if (hasMore) {
			nextCursor = `node-external-cursor-${this.sequence++}`;
			this.externalSnapshots.set(nextCursor, {
				...snapshot,
				byteOffset: snapshot.byteOffset + consumedBytes,
				expiresAt: Date.now() + SNAPSHOT_TTL_MS,
			});
		} else if (!retainRoot) {
			await rm(snapshot.root, { recursive: true, force: true });
		}
		const withMetadata = await this.addMetadata(snapshot.directory, entries);
		return {
			entries: withMetadata,
			nextCursor,
			generation: snapshot.generation,
			stable: true,
			partial: false,
		};
	}

	private async pruneSnapshots(): Promise<void> {
		const now = Date.now();
		const roots = new Set<string>();
		for (const [cursor, snapshot] of this.externalSnapshots) {
			if (snapshot.expiresAt <= now) {
				this.externalSnapshots.delete(cursor);
				roots.add(snapshot.root);
			}
		}
		while (this.externalSnapshots.size > MAX_SNAPSHOTS) {
			const oldest = this.externalSnapshots.keys().next().value;
			if (oldest === undefined) break;
			const snapshot = this.externalSnapshots.get(oldest);
			this.externalSnapshots.delete(oldest);
			if (snapshot) roots.add(snapshot.root);
		}
		for (const root of roots) {
			if (![...this.externalSnapshots.values()].some((snapshot) => snapshot.root === root)) {
				await rm(root, { recursive: true, force: true });
			}
		}
	}

	async close(): Promise<void> {
		const roots = new Set([...this.externalSnapshots.values()].map((snapshot) => snapshot.root));
		this.externalSnapshots.clear();
		this.memorySnapshots.clear();
		for (const root of roots) await rm(root, { recursive: true, force: true });
		await this.compatibility.close();
	}
}
