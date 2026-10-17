import { randomUUID } from "node:crypto";
import type { WriteStream } from "node:fs";
import { type ManagedToolOutputFile, openToolOutputStream, ToolOutputStorage } from "../tool-output-storage.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	/** Raw output bytes retained on disk; 0 disables the cap. The one-time marker is additional. */
	maxPersistedBytes?: number;
	createLogFile?: () => ManagedToolOutputFile;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	/** The persisted log is incomplete, independently of the rolling preview truncation. */
	logTruncated?: boolean;
}

export const DEFAULT_MAX_PERSISTED_BYTES = 64 * 1024 * 1024;
export const OUTPUT_LOG_TRUNCATION_MARKER =
	"\n[pi] Full output log truncated at its byte budget; later output is kept only in the preview.\n";

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly maxPersistedBytes: number;
	private readonly createLogFile: (() => ManagedToolOutputFile) | undefined;
	private ownedStorage: ToolOutputStorage | undefined;
	private persistedBytes = 0;
	private logTruncated = false;
	private streamError: Error | undefined;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.maxPersistedBytes = options.maxPersistedBytes ?? DEFAULT_MAX_PERSISTED_BYTES;
		if (!Number.isSafeInteger(this.maxPersistedBytes) || this.maxPersistedBytes < 0) {
			throw new Error("maxPersistedBytes must be a non-negative safe integer");
		}
		this.createLogFile = options.createLogFile;
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.writePersisted(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFilePath,
			...(this.logTruncated ? { logTruncated: true } : {}),
		};
	}

	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			this.ownedStorage?.close();
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		try {
			if (!stream.closed) {
				await new Promise<void>((resolve) => {
					stream.once("close", resolve);
					stream.end();
				});
			}
			if (this.streamError) throw this.streamError;
		} finally {
			this.ownedStorage?.close();
		}
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) {
			return;
		}
		if (!this.createLogFile) this.ownedStorage = new ToolOutputStorage({ sessionId: randomUUID() });
		const file = this.createLogFile ? this.createLogFile() : this.ownedStorage!.createLogFile();
		this.tempFilePath = file.path;
		this.tempFileStream = openToolOutputStream(file);
		this.tempFileStream.on("error", (error: Error) => {
			this.streamError = error;
		});
		this.tempFileStream.once("close", () => {
			try {
				file.release();
			} catch (error) {
				this.streamError ??= error instanceof Error ? error : new Error(String(error));
			}
		});
		for (const chunk of this.rawChunks) this.writePersisted(chunk);
		this.rawChunks = [];
	}

	private writePersisted(data: Buffer): void {
		if (!this.tempFileStream || this.logTruncated || this.streamError) return;
		const remaining = this.maxPersistedBytes === 0 ? data.length : this.maxPersistedBytes - this.persistedBytes;
		const bytes = Math.min(data.length, remaining);
		if (bytes > 0) {
			this.tempFileStream.write(data.subarray(0, bytes));
			this.persistedBytes += bytes;
		}
		if (bytes < data.length) {
			this.logTruncated = true;
			this.tempFileStream.write(OUTPUT_LOG_TRUNCATION_MARKER);
		}
	}
}
