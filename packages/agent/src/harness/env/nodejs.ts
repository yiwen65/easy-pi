import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	createReadStream,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	access,
	appendFile,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	type DurableFileSystem,
	type DurableFileWriter,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileKind,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextRangeReadOptions,
	type TextRangeReadResult,
	toError,
} from "../types.ts";
import { BackgroundTaskManager } from "./background-task-manager.ts";
import { killNodeProcessTree, NodeProcessExecutor } from "./node-process-executor.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	if (timeout === undefined) return ok(undefined);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
	}
	return ok(timeoutMs);
}

function resolvePath(cwd: string, path: string): string {
	let normalized = path;
	if (normalized === "~") {
		normalized = homedir();
	} else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
	} else if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// Keep malformed URLs as ordinary paths so filesystem methods preserve their non-throwing contract.
		}
	}
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

function fileKindFromStats(stats: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): FileKind | undefined {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	return undefined;
}

function fileInfoFromStats(
	path: string,
	stats: {
		isFile(): boolean;
		isDirectory(): boolean;
		isSymbolicLink(): boolean;
		size: number;
		mtimeMs: number;
		dev?: number;
		ino?: number;
		mode?: number;
	},
): Result<FileInfo, FileError> {
	const kind = fileKindFromStats(stats);
	if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: basename(path),
		path,
		kind,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		identity: stats.dev === undefined || stats.ino === undefined ? undefined : `${stats.dev}:${stats.ino}`,
		mode: stats.mode === undefined ? undefined : stats.mode & 0o7777,
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function toFileError(error: unknown, fallbackPath?: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	const nodeError = isNodeError(error) ? error : undefined;
	const path = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
	if (nodeError) {
		const message = nodeError.message;
		switch (nodeError.code) {
			case "ABORT_ERR":
				return new FileError("aborted", message, path, cause);
			case "ENOENT":
				return new FileError("not_found", message, path, cause);
			case "EACCES":
			case "EPERM":
				return new FileError("permission_denied", message, path, cause);
			case "ENOTDIR":
				return new FileError("not_directory", message, path, cause);
			case "EISDIR":
				return new FileError("is_directory", message, path, cause);
			case "EINVAL":
				return new FileError("invalid", message, path, cause);
		}
	}
	return new FileError("unknown", cause.message, path, cause);
}

function abortResult<TValue>(signal: AbortSignal | undefined, path?: string): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

function assertSingleLink(path: string): void {
	if (existsSync(path) && statSync(path).nlink > 1) {
		throw new FileError("not_supported", "Persistent files with multiple hard links are unsupported", path);
	}
}

function validatePositiveInteger(value: number | undefined, name: string): FileError | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value <= 0) {
		return new FileError("invalid", `${name} must be a positive safe integer`);
	}
	return undefined;
}

function decodeUtf8(bytes: Uint8Array, allowIncompleteTail: boolean): { length: number; text: string } | undefined {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const maxTrim = allowIncompleteTail ? Math.min(3, Math.max(0, bytes.length - 1)) : 0;
	for (let trim = 0; trim <= maxTrim; trim++) {
		const length = bytes.length - trim;
		try {
			return { length, text: decoder.decode(bytes.subarray(0, length)) };
		} catch {}
	}
	return undefined;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
	return await new Promise((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve({ stdout: "", status: null });
			return;
		}
		const timeout = setTimeout(() => {
			if (child.pid) killNodeProcessTree(child.pid);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve({ stdout: "", status: null });
		});
		child.on("close", (status) => {
			clearTimeout(timeout);
			resolve({ stdout, status });
		});
	});
}

async function findBashOnPath(): Promise<string | null> {
	const result =
		process.platform === "win32"
			? await runCommand("where", ["bash.exe"], 5000)
			: await runCommand("which", ["bash"], 5000);
	if (result.status !== 0 || !result.stdout) return null;
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null;
}

interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

async function getShellConfig(customShellPath?: string): Promise<Result<ShellConfig, ExecutionError>> {
	if (customShellPath) {
		if (await pathExists(customShellPath)) {
			return ok(getBashShellConfig(customShellPath));
		}
		return err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`));
	}
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (await pathExists(candidate)) {
				return ok(getBashShellConfig(candidate));
			}
		}
		const bashOnPath = await findBashOnPath();
		if (bashOnPath) {
			return ok(getBashShellConfig(bashOnPath));
		}
		return err(
			new ExecutionError(
				"shell_unavailable",
				`No bash shell found. Options:\n` +
					`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
					`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
					"  3. Configure an explicit shellPath\n\n" +
					`Searched Git Bash in:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
			),
		);
	}

	if (await pathExists("/bin/bash")) {
		return ok(getBashShellConfig("/bin/bash"));
	}
	const bashOnPath = await findBashOnPath();
	if (bashOnPath) {
		return ok(getBashShellConfig(bashOnPath));
	}
	return ok({ shell: "sh", args: ["-c"] });
}

function getShellEnv(
	baseEnv?: NodeJS.ProcessEnv,
	extraEnv?: Record<string, string>,
	inheritEnv = true,
): NodeJS.ProcessEnv {
	if (!inheritEnv) return { ...extraEnv };
	return {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
}

export interface NodeExecutionEnvOptions {
	cwd: string;
	shellPath?: string;
	shellEnv?: NodeJS.ProcessEnv;
	onProcessStart?: (pid: number) => void;
	onProcessEnd?: (pid: number) => void;
	/** Background task runtime bound in milliseconds. Defaults to 0 (no cap); 0 disables the timeout. */
	backgroundTaskTimeoutMs?: number;
	/** Stall window in milliseconds; a silent running task emits an onStall notice. Defaults to 30 minutes. */
	backgroundTaskStallTimeoutMs?: number;
	/** Concurrency cap for background tasks. Defaults to 8; 0 disables the cap. */
	backgroundTaskMaxTasks?: number;
	/** Per-task output log budget in bytes. Defaults to 64MB; 0 disables the budget. */
	backgroundTaskMaxLogBytes?: number;
	/** Directory for background task output logs. Defaults to the OS temp directory. */
	backgroundTaskLogDir?: string;
	/** Shared background task manager instance. Default: a new manager owned by this environment. */
	backgroundTasks?: BackgroundTaskManager;
}

export class NodeExecutionEnv implements ExecutionEnv {
	cwd: string;
	readonly durableFiles: DurableFileSystem = { claim: (path) => this.claimDurableFile(path) };
	private readonly durableWriters = new Set<DurableFileWriter>();
	private shellPath?: string;
	private shellEnv?: NodeJS.ProcessEnv;
	private readonly processExecutor: NodeProcessExecutor;
	readonly backgroundTasks: BackgroundTaskManager;

	constructor(options: NodeExecutionEnvOptions) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
		this.processExecutor = new NodeProcessExecutor({
			onProcessStart: options.onProcessStart,
			onProcessEnd: options.onProcessEnd,
		});
		this.backgroundTasks =
			options.backgroundTasks ??
			new BackgroundTaskManager({
				shell: async () => {
					const config = await getShellConfig(this.shellPath);
					return config.ok ? ok({ ...config.value }) : config;
				},
				resolveEnv: (env, inheritEnv) => getShellEnv(this.shellEnv, env, inheritEnv),
				defaultTimeoutMs: options.backgroundTaskTimeoutMs,
				stallTimeoutMs: options.backgroundTaskStallTimeoutMs,
				maxTasks: options.backgroundTaskMaxTasks,
				maxLogBytes: options.backgroundTaskMaxLogBytes,
				logDir: options.backgroundTaskLogDir,
			});
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(resolvePath(this.cwd, path));
	}

	private async claimDurableFile(path: string): Promise<Result<DurableFileWriter, FileError>> {
		let resolved = resolvePath(this.cwd, path);
		let lockPath: string;
		const token = randomUUID();
		try {
			await mkdir(dirname(resolved), { recursive: true });
			const canonical = existsSync(resolved)
				? realpathSync(resolved)
				: join(realpathSync(dirname(resolved)), basename(resolved));
			resolved = canonical;
			assertSingleLink(resolved);
			lockPath = `${canonical}.writer.lock`;
			// Serialize stale-owner reclamation with all new claims. An interrupted
			// claim guard remains fail-closed rather than risking two live owners.
			const guardPath = `${lockPath}.claim`;
			const guard = openSync(guardPath, "wx", 0o600);
			try {
				if (existsSync(lockPath)) {
					const owner: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
					if (
						typeof owner !== "object" ||
						owner === null ||
						!("pid" in owner) ||
						typeof owner.pid !== "number" ||
						!Number.isSafeInteger(owner.pid) ||
						owner.pid <= 0
					) {
						throw new FileError("invalid", "Invalid durable writer owner", lockPath);
					}
					let alive = true;
					try {
						process.kill(owner.pid, 0);
					} catch (error) {
						if (!isNodeError(error) || error.code !== "ESRCH") throw error;
						alive = false;
					}
					if (alive) throw new FileError("permission_denied", "Session already has an active writer", resolved);
					unlinkSync(lockPath);
				}
				const ownerFd = openSync(lockPath, "wx", 0o600);
				try {
					writeFileSync(ownerFd, JSON.stringify({ pid: process.pid, token }));
					fsyncSync(ownerFd);
				} finally {
					closeSync(ownerFd);
				}
			} finally {
				closeSync(guard);
				unlinkSync(guardPath);
			}
		} catch (error) {
			return err(toFileError(error, resolved));
		}
		let closed = false;
		let faulted = false;
		let closing = false;
		let tail: Promise<void> = Promise.resolve();
		let releasePromise: Promise<Result<void, FileError>> | undefined;
		const enqueue = (operation: () => Promise<Result<void, FileError>>): Promise<Result<void, FileError>> => {
			if (closing) return Promise.resolve(err(new FileError("invalid", "Durable writer is closing", resolved)));
			const result = tail.then(operation);
			tail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		};
		const verifyOwner = (): void => {
			if (closed || faulted) throw new FileError("invalid", "Durable writer is closed or faulted", resolved);
			assertSingleLink(resolved);
			const owner: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
			if (typeof owner !== "object" || owner === null || !("token" in owner) || owner.token !== token)
				throw new FileError("permission_denied", "Durable writer claim was lost", resolved);
		};
		const writer: DurableFileWriter = {
			append: (content) =>
				enqueue(async () => {
					try {
						verifyOwner();
						const result = await this.appendFile(resolved, content);
						if (!result.ok) {
							faulted = true;
							return result;
						}
						const handle = await open(resolved, "r+");
						try {
							await handle.sync();
							assertSingleLink(resolved);
						} finally {
							await handle.close();
						}
						return ok(undefined);
					} catch (error) {
						faulted = true;
						return err(toFileError(error, resolved));
					}
				}),
			replace: (content, options) =>
				enqueue(async () => {
					const temporaryPath = `${resolved}.${token}.tmp`;
					try {
						verifyOwner();
						if (options?.exclusive && (await pathExists(resolved)))
							throw new FileError("invalid", "Durable destination already exists", resolved);
						const staged = await this.writeFile(temporaryPath, content);
						if (!staged.ok) {
							faulted = true;
							return staged;
						}
						const handle = await open(temporaryPath, "r+");
						try {
							await handle.sync();
						} finally {
							await handle.close();
						}
						verifyOwner();
						const published = await this.renameFile(temporaryPath, resolved);
						if (!published.ok) {
							faulted = true;
							return published;
						}
						const directory = await open(dirname(resolved), "r");
						try {
							await directory.sync();
						} finally {
							await directory.close();
						}
						return ok(undefined);
					} catch (error) {
						faulted = true;
						return err(toFileError(error, resolved));
					} finally {
						await rm(temporaryPath, { force: true }).catch(() => undefined);
					}
				}),
			release: () => {
				closing = true;
				releasePromise ??= (async () => {
					await tail;
					if (closed) return ok(undefined);
					try {
						const owner: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
						if (typeof owner !== "object" || owner === null || !("token" in owner) || owner.token !== token)
							throw new FileError("permission_denied", "Durable writer claim was lost", resolved);
						unlinkSync(lockPath);
						closed = true;
						this.durableWriters.delete(writer);
						return ok(undefined);
					} catch (error) {
						return err(toFileError(error, resolved));
					}
				})();
				return releasePromise;
			},
		};
		this.durableWriters.add(writer);
		return ok(writer);
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	async exec(command: string, options?: ShellExecOptions): Promise<Result<ShellExecResult, ExecutionError>> {
		if (options?.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		const shellConfig = await getShellConfig(this.shellPath);
		if (!shellConfig.ok) return shellConfig;
		try {
			await access(cwd, constants.F_OK);
		} catch (error) {
			const cause = toError(error);
			return err(
				new ExecutionError(
					"spawn_error",
					`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
					cause,
				),
			);
		}

		const captureOutput = options?.captureOutput !== false;
		const stdoutDecoder = new TextDecoder();
		const stderrDecoder = new TextDecoder();
		let stdout = "";
		let stderr = "";
		const forwardStdout = (bytes: Uint8Array): void => {
			const chunk = stdoutDecoder.decode(bytes, { stream: true });
			if (captureOutput) stdout += chunk;
			if (chunk) options?.onStdout?.(chunk);
		};
		const forwardStderr = (bytes: Uint8Array): void => {
			const chunk = stderrDecoder.decode(bytes, { stream: true });
			if (captureOutput) stderr += chunk;
			if (chunk) options?.onStderr?.(chunk);
		};

		const execution = await this.processExecutor.execute(command, {
			shell: shellConfig.value,
			cwd,
			env: getShellEnv(this.shellEnv, options?.env, options?.inheritEnv),
			timeoutMs: timeoutMsResult.value,
			abortSignal: options?.abortSignal,
			onStdout: forwardStdout,
			onStderr: forwardStderr,
			promoteOnTimeout: options?.promoteOnTimeout
				? { adopt: (handle) => this.backgroundTasks.adopt(handle, { command, cwd }) }
				: undefined,
		});
		try {
			const stdoutTail = stdoutDecoder.decode();
			const stderrTail = stderrDecoder.decode();
			if (captureOutput) {
				stdout += stdoutTail;
				stderr += stderrTail;
			}
			if (stdoutTail) options?.onStdout?.(stdoutTail);
			if (stderrTail) options?.onStderr?.(stderrTail);
		} catch (error) {
			const cause = toError(error);
			return err(new ExecutionError("callback_error", cause.message, cause));
		}
		if (!execution.ok) {
			if (execution.error.code === "timeout") {
				return err(new ExecutionError("timeout", `timeout:${options?.timeout}`, execution.error));
			}
			return execution;
		}
		if (execution.value.promotedTaskId !== undefined) {
			return ok({
				stdout,
				stderr,
				exitCode: -1,
				promotedTaskId: execution.value.promotedTaskId,
			});
		}
		return ok({
			stdout,
			stderr,
			exitCode: execution.value.exitCode ?? 0,
			...(execution.value.signal ? { signal: execution.value.signal } : {}),
		});
	}

	async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { encoding: "utf8", signal: abortSignal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string[]>(options?.abortSignal, resolved);
		if (aborted) return aborted;
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		let stream: ReturnType<typeof createReadStream> | undefined;
		let lineReader: ReturnType<typeof createInterface> | undefined;
		try {
			stream = createReadStream(resolved, { encoding: "utf8", signal: options?.abortSignal });
			lineReader = createInterface({ input: stream, crlfDelay: Infinity });
			const lines: string[] = [];
			for await (const line of lineReader) {
				const loopAbort = abortResult<string[]>(options?.abortSignal, resolved);
				if (loopAbort) return loopAbort;
				lines.push(line);
				if (options?.maxLines !== undefined && lines.length >= options.maxLines) break;
			}
			const afterReadAbort = abortResult<string[]>(options?.abortSignal, resolved);
			if (afterReadAbort) return afterReadAbort;
			return ok(lines);
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			lineReader?.close();
			stream?.destroy();
		}
	}

	async readTextRange(
		path: string,
		options: TextRangeReadOptions = {},
	): Promise<Result<TextRangeReadResult, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<TextRangeReadResult>(options.abortSignal, resolved);
		if (aborted) return aborted;
		const startLineError = validatePositiveInteger(options.startLine, "startLine");
		if (startLineError) return err(startLineError);
		const maxLinesError = validatePositiveInteger(options.maxLines, "maxLines");
		if (maxLinesError) return err(maxLinesError);
		const maxBytesError = validatePositiveInteger(options.maxBytes, "maxBytes");
		if (maxBytesError) return err(maxBytesError);
		if (options.maxBytes !== undefined && options.maxBytes < 4) {
			return err(new FileError("invalid", "maxBytes must be at least 4 to preserve UTF-8 code points", resolved));
		}
		if (options.startByte !== undefined && (!Number.isSafeInteger(options.startByte) || options.startByte < 0)) {
			return err(new FileError("invalid", "startByte must be a non-negative safe integer", resolved));
		}

		const requestedStartLine = options.startLine ?? 1;
		const requestedStartByte = options.startByte;
		const maxLines = options.maxLines ?? Number.MAX_SAFE_INTEGER;
		const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
		let stream: ReturnType<typeof createReadStream> | undefined;
		try {
			stream = createReadStream(resolved, {
				signal: options.abortSignal,
			});
			let absoluteOffset = 0;
			let byteStartLine = 1;
			let linesToSkip = requestedStartByte === undefined ? requestedStartLine - 1 : 0;
			let outputStartByte = absoluteOffset;
			let outputLineBreaks = 0;
			let truncatedByLines = false;
			let truncatedByBytes = false;
			let reachedEof = true;
			const output: number[] = [];

			outer: for await (const rawChunk of stream) {
				const loopAbort = abortResult<TextRangeReadResult>(options.abortSignal, resolved);
				if (loopAbort) return loopAbort;
				const chunk = rawChunk as Buffer;
				for (const byte of chunk) {
					// Count line breaks while skipping to the byte position; a supplied
					// startLine is not evidence of the fragment's actual line number.
					if (requestedStartByte !== undefined && absoluteOffset < requestedStartByte) {
						absoluteOffset++;
						if (byte === 0x0a) byteStartLine++;
						outputStartByte = absoluteOffset;
						continue;
					}
					if (linesToSkip > 0) {
						absoluteOffset++;
						if (byte === 0x0a) {
							linesToSkip--;
							outputStartByte = absoluteOffset;
						}
						continue;
					}
					if (output.length >= maxBytes) {
						truncatedByBytes = true;
						reachedEof = false;
						break outer;
					}
					output.push(byte);
					absoluteOffset++;
					if (byte === 0x0a) {
						outputLineBreaks++;
						if (outputLineBreaks >= maxLines) {
							truncatedByLines = true;
							reachedEof = false;
							break outer;
						}
					}
				}
			}

			if (linesToSkip > 0) {
				return err(new FileError("invalid", `startLine ${requestedStartLine} is beyond end of file`, resolved));
			}
			const prefix = decodeUtf8(Uint8Array.from(output), truncatedByBytes);
			if (!prefix) return err(new FileError("invalid", "File is not valid UTF-8", resolved));
			const acceptedEndByte = outputStartByte + prefix.length;
			if (prefix.length < output.length) truncatedByBytes = true;
			let lines = prefix.text.split(/\r?\n/);
			if (prefix.text.endsWith("\n")) lines.pop();
			if (prefix.text.length === 0) lines = [];
			const startLine = requestedStartByte === undefined ? requestedStartLine : byteStartLine;
			const endLine = lines.length > 0 ? startLine + lines.length - 1 : startLine;
			const partialLine = truncatedByBytes && !prefix.text.endsWith("\n");
			return ok({
				lines,
				startLine,
				endLine,
				eof: reachedEof && !truncatedByBytes && !truncatedByLines,
				partialLine,
				...(truncatedByLines ? { nextLine: startLine + lines.length } : {}),
				...(truncatedByBytes ? { nextByte: acceptedEndByte } : {}),
			});
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			stream?.destroy();
		}
	}

	async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<Uint8Array>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { signal: abortSignal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(abortSignal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await writeFile(resolved, content, { signal: abortSignal });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			await appendFile(resolved, content);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async renameFile(
		sourcePath: string,
		destinationPath: string,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const source = resolvePath(this.cwd, sourcePath);
		const destination = resolvePath(this.cwd, destinationPath);
		const aborted = abortResult<void>(abortSignal, destination);
		if (aborted) return aborted;
		try {
			await rename(source, destination);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, source));
		}
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return fileInfoFromStats(resolved, await lstat(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<FileInfo[]>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const loopAbort = abortResult<FileInfo[]>(abortSignal, resolved);
				if (loopAbort) return loopAbort;
				const entryPath = resolve(resolved, entry.name);
				try {
					const info = fileInfoFromStats(entryPath, await lstat(entryPath));
					if (info.ok) infos.push(info.value);
				} catch (error) {
					// Lock guards and staged files can disappear between readdir and lstat.
					if (isNodeError(error) && error.code === "ENOENT") continue;
					return err(toFileError(error, entryPath));
				}
			}
			return ok(infos);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return ok(await realpath(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await mkdir(resolved, { recursive: options?.recursive ?? true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async createTempDir(prefix: string = "tmp-"): Promise<Result<string, FileError>> {
		try {
			return ok(await mkdtemp(join(tmpdir(), prefix)));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-");
		if (!dir.ok) return dir;
		const filePath = join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await writeFile(filePath, "");
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	async cleanup(): Promise<void> {
		for (const writer of this.durableWriters) await writer.release();
		await this.backgroundTasks.cleanup();
		await this.processExecutor.cleanup();
	}
}
