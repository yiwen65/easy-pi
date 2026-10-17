/** Bash execution with streaming sanitization for interactive and RPC user_bash. */
import { randomUUID } from "node:crypto";
import type { WriteStream } from "node:fs";
import { splitIncompleteAnsiSuffix, stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import { type ManagedToolOutputFile, openToolOutputStream, ToolOutputStorage } from "./tool-output-storage.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_PERSISTED_BYTES, OUTPUT_LOG_TRUNCATION_MARKER } from "./tools/output-accumulator.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized). */
	onChunk?: (chunk: string) => void;
	signal?: AbortSignal;
	createLogFile?: () => ManagedToolOutputFile;
	/** 64MiB default; 0 disables the persisted output cap. */
	maxPersistedBytes?: number;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	logTruncated?: boolean;
}

/** Execute local or custom remote operations without changing user_bash sanitization. */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;
	let persistedBytes = 0;
	let logTruncated = false;
	let ownedStorage: ToolOutputStorage | undefined;
	let streamError: Error | undefined;
	const maxPersistedBytes = options?.maxPersistedBytes ?? DEFAULT_MAX_PERSISTED_BYTES;
	if (!Number.isSafeInteger(maxPersistedBytes) || maxPersistedBytes < 0) {
		throw new Error("Invalid persisted output byte budget");
	}

	const writeTempFile = (text: string) => {
		if (!tempFileStream || logTruncated || streamError) return;
		const data = Buffer.from(text);
		const bytes = Math.min(data.length, maxPersistedBytes === 0 ? data.length : maxPersistedBytes - persistedBytes);
		if (bytes > 0) {
			tempFileStream.write(data.subarray(0, bytes));
			persistedBytes += bytes;
		}
		if (bytes < data.length) {
			logTruncated = true;
			tempFileStream.write(OUTPUT_LOG_TRUNCATION_MARKER);
		}
	};

	const ensureTempFile = () => {
		if (tempFilePath) return;
		if (!options?.createLogFile) ownedStorage = new ToolOutputStorage({ sessionId: randomUUID() });
		const file = options?.createLogFile ? options.createLogFile() : ownedStorage!.createLogFile();
		tempFilePath = file.path;
		tempFileStream = openToolOutputStream(file);
		tempFileStream.on("error", (error: Error) => {
			streamError = error;
		});
		tempFileStream.once("close", () => {
			try {
				file.release();
			} catch (error) {
				streamError ??= error instanceof Error ? error : new Error(String(error));
			}
		});
		for (const chunk of outputChunks) writeTempFile(chunk);
	};

	const decoder = new TextDecoder();
	let pendingAnsi = "";
	const appendText = (rawText: string) => {
		const text = sanitizeBinaryOutput(stripAnsi(rawText)).replace(/\r/g, "");
		// Preserve the raw-byte tempfile threshold, even when the chunk contains only ANSI.
		if (totalBytes > DEFAULT_MAX_BYTES) ensureTempFile();
		if (!text) return;
		writeTempFile(text);
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}
		options?.onChunk?.(text);
	};

	const onData = (data: Buffer) => {
		totalBytes += data.length;
		const { complete, pending } = splitIncompleteAnsiSuffix(pendingAnsi + decoder.decode(data, { stream: true }));
		pendingAnsi = pending;
		appendText(complete);
	};
	const flushOutput = () => {
		const rest = pendingAnsi + decoder.decode();
		pendingAnsi = "";
		appendText(rest);
	};
	const result = (exitCode: number | undefined, cancelled: boolean): BashResult => {
		flushOutput();
		const fullOutput = outputChunks.join("");
		const truncation = truncateTail(fullOutput);
		if (truncation.truncated) ensureTempFile();
		return {
			output:
				(truncation.truncated ? truncation.content : fullOutput) +
				(logTruncated
					? "\n\n[Full output log truncated at its byte budget; preview continues with newest output.]"
					: ""),
			exitCode,
			cancelled,
			truncated: truncation.truncated,
			fullOutputPath: tempFilePath,
			...(logTruncated ? { logTruncated: true } : {}),
		};
	};

	const closeOutput = async () => {
		try {
			if (tempFileStream && !tempFileStream.closed) {
				await new Promise<void>((resolve) => {
					tempFileStream!.once("close", resolve);
					tempFileStream!.end();
				});
			}
			if (streamError) throw streamError;
		} finally {
			ownedStorage?.close();
		}
	};

	try {
		const execution = await operations.exec(command, cwd, { onData, signal: options?.signal });
		const cancelled = options?.signal?.aborted ?? false;
		return result(cancelled ? undefined : (execution.exitCode ?? undefined), cancelled);
	} catch (error) {
		if (options?.signal?.aborted) return result(undefined, true);
		throw error;
	} finally {
		await closeOutput();
	}
}
