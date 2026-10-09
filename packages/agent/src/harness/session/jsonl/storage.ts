import type { DurableFileWriter } from "../../types.ts";
import { type SessionMutation, SessionState } from "../state.ts";
import {
	type BranchBounds,
	type Entry,
	type EntryQuery,
	type ForkOptions,
	type LanePointer,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type NewRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	type RecordQuery,
	SessionError,
	type SessionStats,
	type SessionStorage,
} from "../types.ts";
import { encodeHeader, encodeMutation, metadataFromHeader, parseHeader, parseMutation } from "./codec.ts";
import { fileResult, invalidFile, JsonlDecodeError } from "./errors.ts";
import type { JsonlSessionMetadata, JsonlSessionRepoFileSystem, JsonlV4Header } from "./types.ts";

export async function claimJsonlWriter(fs: JsonlSessionRepoFileSystem, path: string): Promise<DurableFileWriter> {
	if (!fs.durableFiles)
		throw new SessionError("storage", "JSONL sessions require durable file writes and exclusive writer ownership");
	return fileResult(await fs.durableFiles.claim(path), `Failed to claim session writer ${path}`);
}

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly metadata: JsonlSessionMetadata;
	private readonly state = new SessionState();
	private tail: Promise<void> = Promise.resolve();
	private readonly writer: DurableFileWriter | undefined;
	private closing = false;
	private releasePromise: Promise<void> | undefined;
	private writeFailure: Error | undefined;

	constructor(fs: JsonlSessionRepoFileSystem, metadata: JsonlSessionMetadata, writer: DurableFileWriter | undefined) {
		this.fs = fs;
		this.metadata = structuredClone(metadata);
		this.writer = writer;
	}

	static async create(
		fs: JsonlSessionRepoFileSystem,
		path: string,
		header: JsonlV4Header,
	): Promise<JsonlSessionStorage> {
		const writer = await claimJsonlWriter(fs, path);
		try {
			fileResult(
				await writer.replace(encodeHeader(header), { exclusive: true }),
				`Failed to initialize session ${path}`,
			);
			const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
			return new JsonlSessionStorage(fs, metadataFromHeader(header, path, fileInfo.mtimeMs), writer);
		} catch (error) {
			await writer.release();
			throw error;
		}
	}

	static async load(fs: JsonlSessionRepoFileSystem, path: string): Promise<JsonlSessionStorage> {
		const writer = await claimJsonlWriter(fs, path);
		try {
			return await JsonlSessionStorage.loadOwned(fs, path, writer);
		} catch (error) {
			await writer.release();
			throw error;
		}
	}

	static async inspect(fs: JsonlSessionRepoFileSystem, path: string, expectedId: string): Promise<{ name?: string }> {
		const storage = await JsonlSessionStorage.loadOwned(fs, path, undefined);
		if ((await storage.getMetadata()).id !== expectedId) {
			throw new SessionError("invalid_entry", `Session id does not match header: ${expectedId}`);
		}
		return { name: await storage.getName() };
	}

	private static async loadOwned(
		fs: JsonlSessionRepoFileSystem,
		path: string,
		writer: DurableFileWriter | undefined,
	): Promise<JsonlSessionStorage> {
		const content = fileResult(await fs.readTextFile(path), `Failed to read session ${path}`);
		const physicalLines = content.split("\n");
		if (physicalLines.at(-1) === "") physicalLines.pop();
		if (physicalLines.length === 0 || !physicalLines[0]) {
			throw invalidFile(path, 1, new JsonlDecodeError("schema", "is missing a header"));
		}
		const headerResult = parseHeader(physicalLines[0]);
		if (!headerResult.ok) throw invalidFile(path, 1, headerResult.error);
		const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
		const storage = new JsonlSessionStorage(
			fs,
			metadataFromHeader(headerResult.value, path, fileInfo.mtimeMs),
			writer,
		);
		for (let index = 1; index < physicalLines.length; index++) {
			const line = physicalLines[index]!;
			const mutationResult = parseMutation(line);
			if (!mutationResult.ok) {
				const isTornTail = index === physicalLines.length - 1 && mutationResult.error.kind === "syntax";
				if (isTornTail) {
					// Drop the unacknowledged partial append by atomically publishing the valid prefix.
					const validPrefix = `${physicalLines.slice(0, index).join("\n")}\n`;
					if (writer) fileResult(await writer.replace(validPrefix), `Failed to repair torn tail ${path}`);
					return storage;
				}
				throw invalidFile(path, index + 1, mutationResult.error);
			}
			try {
				storage.applyMutation(mutationResult.value);
			} catch (error) {
				if (error instanceof SessionError && error.code === "invalid_entry") {
					throw invalidFile(path, index + 1, error);
				}
				throw error;
			}
		}
		if (writer && !content.endsWith("\n")) {
			fileResult(await writer.append("\n"), `Failed to repair unterminated session tail ${path}`);
		}
		return storage;
	}

	async fork(path: string, header: JsonlV4Header, options: ForkOptions): Promise<JsonlSessionStorage> {
		const mutations = this.state.createForkMutations(options);
		const writer = await claimJsonlWriter(this.fs, path);
		try {
			fileResult(
				await writer.replace(encodeHeader(header) + mutations.map(encodeMutation).join(""), { exclusive: true }),
				`Failed to publish fork ${path}`,
			);
			return await JsonlSessionStorage.loadOwned(this.fs, path, writer);
		} catch (error) {
			await writer.release();
			throw error;
		}
	}

	async drain(): Promise<void> {
		await this.tail;
	}

	async release(): Promise<void> {
		this.closing = true;
		this.releasePromise ??= this.tail.then(async () => {
			if (this.writer) fileResult(await this.writer.release(), `Failed to release session ${this.metadata.path}`);
		});
		await this.releasePromise;
	}

	isReleased(): boolean {
		return this.closing;
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLanes(): Promise<LanePointer[]> {
		return this.state.getLanes();
	}

	createLane(lane: string, at: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateNewLane(lane);
			this.state.validateTarget(at);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: at };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	moveLane(lane: string, to: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.requireLane(lane);
			this.state.validateTarget(to);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: to };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.enqueue(async () => {
			const parentId = this.state.requireLane(lane);
			this.state.validateUnusedId(newEntry.id);
			const entry = {
				...structuredClone(newEntry),
				parentId,
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TEntry;
			const mutation: SessionMutation = { kind: "entry", lane, entry };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(entry);
		});
	}

	appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
		return this.enqueue(async () => {
			this.state.requireLane(newRecord.lane);
			this.state.validateUnusedId(newRecord.id);
			const currentOpenOperationId = this.state.findOpenOperations(newRecord.lane, { limit: 1 })[0]?.id;
			if (newRecord.type === "operation_started" && currentOpenOperationId !== undefined) {
				throw new SessionError(
					"storage",
					`Lane ${newRecord.lane} already has an open operation ${currentOpenOperationId}`,
				);
			}
			const record = {
				...structuredClone(newRecord),
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TRecord;
			const mutation: SessionMutation = { kind: "record", record };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(record);
		});
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		const entry = this.state.getEntry(id);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		return structuredClone(this.state.findEntries(query));
	}

	async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		return structuredClone(this.state.findEntriesOnBranch(query));
	}

	async findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		return structuredClone(this.state.findRecords(query));
	}

	async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		return structuredClone(this.state.findOpenOperations(lane, options));
	}

	async getLog(options: LogOptions = {}): Promise<LogItem[]> {
		return structuredClone(this.state.getLog(options));
	}

	async getName(): Promise<string | undefined> {
		return this.state.getName();
	}

	setName(name: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			const mutation: SessionMutation = { kind: "fact", seq: this.state.nextSequence, fact: "name", name };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.state.getLabel(id);
	}

	setLabel(id: string, label: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateTarget(id);
			const mutation: SessionMutation = {
				kind: "fact",
				seq: this.state.nextSequence,
				fact: "label",
				targetId: id,
				label,
			};
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	async getStats(): Promise<SessionStats> {
		return structuredClone(this.state.getStats());
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (!this.writer) return Promise.reject(new SessionError("storage", "JSONL session is read-only"));
		if (this.closing) return Promise.reject(new SessionError("storage", "JSONL session writer is closed"));
		const result = this.tail.then(() => {
			if (this.writeFailure) throw this.writeFailure;
			return operation();
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async appendMutation(mutation: SessionMutation): Promise<void> {
		try {
			if (!this.writer) throw new SessionError("storage", "JSONL session is read-only");
			fileResult(
				await this.writer.append(encodeMutation(mutation)),
				`Failed to append session ${this.metadata.path}`,
			);
		} catch (error) {
			this.writeFailure =
				error instanceof Error ? error : new SessionError("storage", "Unknown durable append failure");
			throw this.writeFailure;
		}
	}

	private applyMutation(mutation: SessionMutation): void {
		this.state.applyMutation(mutation);
	}
}
