import type {
	ExecutionEnv,
	ExecutionError,
	FileError,
	FileInfo,
	Result,
	ShellExecOptions,
	TextRangeReadOptions,
	TextRangeReadResult,
} from "@earendil-works/pi-agent-core";

/** Result-based operations implemented by an SSH client, RPC bridge, or test transport. */
export type SshOperations = Omit<ExecutionEnv, "cwd" | "cleanup" | "readTextRange"> & {
	readTextRange?: (path: string, options?: TextRangeReadOptions) => Promise<Result<TextRangeReadResult, FileError>>;
	close?: () => void | Promise<void>;
};

/**
 * Reference remote ExecutionEnv. It does not open sockets or read credentials; hosts supply an
 * authenticated transport and retain control over connection policy.
 */
export class SshExecutionEnv implements ExecutionEnv {
	cwd: string;
	readonly readTextRange?: (
		path: string,
		options?: TextRangeReadOptions,
	) => Promise<Result<TextRangeReadResult, FileError>>;
	private readonly operations: SshOperations;
	private closed = false;

	constructor(options: { cwd: string; operations: SshOperations }) {
		this.cwd = options.cwd;
		this.operations = options.operations;
		if (options.operations.readTextRange) {
			this.readTextRange = (path, rangeOptions) => options.operations.readTextRange!(path, rangeOptions);
		}
	}

	absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.operations.absolutePath(path, abortSignal);
	}

	joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.operations.joinPath(parts, abortSignal);
	}

	readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.operations.readTextFile(path, abortSignal);
	}

	readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>> {
		return this.operations.readTextLines(path, options);
	}

	readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
		return this.operations.readBinaryFile(path, abortSignal);
	}

	writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
		return this.operations.writeFile(path, content, abortSignal);
	}

	appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
		return this.operations.appendFile(path, content, abortSignal);
	}

	renameFile(
		sourcePath: string,
		destinationPath: string,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		return this.operations.renameFile(sourcePath, destinationPath, abortSignal);
	}

	fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
		return this.operations.fileInfo(path, abortSignal);
	}

	listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
		return this.operations.listDir(path, abortSignal);
	}

	canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.operations.canonicalPath(path, abortSignal);
	}

	exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
		return this.operations.exists(path, abortSignal);
	}

	createDir(
		path: string,
		options?: { recursive?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>> {
		return this.operations.createDir(path, options);
	}

	remove(
		path: string,
		options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>> {
		return this.operations.remove(path, options);
	}

	createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.operations.createTempDir(prefix, abortSignal);
	}

	createTempFile(options?: {
		prefix?: string;
		suffix?: string;
		abortSignal?: AbortSignal;
	}): Promise<Result<string, FileError>> {
		return this.operations.createTempFile(options);
	}

	exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		return this.operations.exec(command, options);
	}

	async cleanup(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.operations.close?.();
	}
}
