import { posix } from "node:path";
import {
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	ok,
	type Result,
	type ShellExecOptions,
	type TextRangeReadOptions,
	type TextRangeReadResult,
} from "@earendil-works/pi-agent-core";

type MemoryNode =
	| { kind: "directory"; identity: string; mtimeMs: number; mode: number }
	| { kind: "file"; bytes: Uint8Array; identity: string; mtimeMs: number; mode: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function cloneBytes(bytes: Uint8Array): Uint8Array {
	return bytes.slice();
}

/** Small deterministic ExecutionEnv reference for tests, embedders, and non-filesystem hosts. */
export class MemoryExecutionEnv implements ExecutionEnv {
	cwd: string;
	private readonly nodes = new Map<string, MemoryNode>();
	private sequence = 0;
	private cleaned = false;

	constructor(options: { cwd?: string; files?: Record<string, string | Uint8Array> } = {}) {
		this.cwd = posix.resolve("/", options.cwd ?? "/workspace");
		this.ensureDirectory(this.cwd);
		for (const [path, content] of Object.entries(options.files ?? {})) {
			const absolute = this.resolve(path);
			this.ensureDirectory(posix.dirname(absolute));
			this.nodes.set(absolute, this.fileNode(typeof content === "string" ? encoder.encode(content) : content));
		}
	}

	private resolve(path: string): string {
		return posix.resolve(this.cwd, path);
	}

	private nextIdentity(): string {
		return `memory-${this.sequence++}`;
	}

	private fileNode(bytes: Uint8Array, mode = 0o644): MemoryNode & { kind: "file" } {
		return { kind: "file", bytes: cloneBytes(bytes), identity: this.nextIdentity(), mtimeMs: Date.now(), mode };
	}

	private ensureDirectory(path: string): void {
		const absolute = posix.resolve("/", path);
		if (absolute !== "/") this.ensureDirectory(posix.dirname(absolute));
		const existing = this.nodes.get(absolute);
		if (existing?.kind === "file") throw new FileError("not_directory", `${absolute} is not a directory`, absolute);
		if (!existing) {
			this.nodes.set(absolute, {
				kind: "directory",
				identity: this.nextIdentity(),
				mtimeMs: Date.now(),
				mode: 0o755,
			});
		}
	}

	private abort<T>(signal: AbortSignal | undefined, path?: string): Result<T, FileError> | undefined {
		return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
	}

	private requireNode(path: string): Result<{ path: string; node: MemoryNode }, FileError> {
		const absolute = this.resolve(path);
		const node = this.nodes.get(absolute);
		return node
			? ok({ path: absolute, node })
			: err(new FileError("not_found", `${absolute} was not found`, absolute));
	}

	private info(path: string, node: MemoryNode): FileInfo {
		return {
			name: posix.basename(path),
			path,
			kind: node.kind,
			size: node.kind === "file" ? node.bytes.byteLength : 0,
			mtimeMs: node.mtimeMs,
			identity: node.identity,
			mode: node.mode,
		};
	}

	async absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.abort(abortSignal, path) ?? ok(this.resolve(path));
	}

	async joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.abort(abortSignal) ?? ok(posix.join(...parts));
	}

	async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		const aborted = this.abort<string>(abortSignal, path);
		if (aborted) return aborted;
		const result = this.requireNode(path);
		if (!result.ok) return result;
		if (result.value.node.kind !== "file")
			return err(new FileError("is_directory", `${result.value.path} is a directory`, result.value.path));
		try {
			return ok(decoder.decode(result.value.node.bytes));
		} catch (error) {
			return err(new FileError("invalid", "File is not valid UTF-8", result.value.path, error as Error));
		}
	}

	async readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path, options?.abortSignal);
		if (!result.ok) return result;
		const lines = result.value.split(/\r?\n/);
		if (result.value.endsWith("\n")) lines.pop();
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, Math.max(0, options.maxLines)));
	}

	async readTextRange(
		path: string,
		options: TextRangeReadOptions = {},
	): Promise<Result<TextRangeReadResult, FileError>> {
		const aborted = this.abort<TextRangeReadResult>(options.abortSignal, path);
		if (aborted) return aborted;
		const result = this.requireNode(path);
		if (!result.ok) return result;
		if (result.value.node.kind !== "file")
			return err(new FileError("is_directory", `${result.value.path} is a directory`, result.value.path));
		const startLine = options.startLine ?? 1;
		const maxLines = options.maxLines ?? Number.MAX_SAFE_INTEGER;
		const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
		if (!Number.isSafeInteger(startLine) || startLine <= 0 || !Number.isSafeInteger(maxLines) || maxLines <= 0) {
			return err(
				new FileError("invalid", "startLine and maxLines must be positive safe integers", result.value.path),
			);
		}
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
			return err(new FileError("invalid", "maxBytes must be a safe integer of at least 4", result.value.path));
		}
		if (options.startByte !== undefined && (!Number.isSafeInteger(options.startByte) || options.startByte < 0)) {
			return err(new FileError("invalid", "startByte must be a non-negative safe integer", result.value.path));
		}

		const bytes = result.value.node.bytes;
		let start = options.startByte ?? 0;
		if (options.startByte === undefined) {
			let remaining = startLine - 1;
			while (remaining > 0 && start < bytes.byteLength) {
				if (bytes[start++] === 0x0a) remaining--;
			}
			if (remaining > 0) {
				return err(new FileError("invalid", `startLine ${startLine} is beyond end of file`, result.value.path));
			}
		}
		let end = start;
		let lineBreaks = 0;
		while (end < bytes.byteLength && end - start < maxBytes && lineBreaks < maxLines) {
			if (bytes[end++] === 0x0a) lineBreaks++;
		}
		let text: string | undefined;
		let acceptedEnd = end;
		while (acceptedEnd >= start) {
			try {
				text = decoder.decode(bytes.subarray(start, acceptedEnd));
				break;
			} catch {
				acceptedEnd--;
			}
		}
		if (text === undefined) return err(new FileError("invalid", "File is not valid UTF-8", result.value.path));
		let lines = text.split(/\r?\n/);
		if (text.endsWith("\n")) lines.pop();
		if (text.length === 0) lines = [];
		const eof = acceptedEnd >= bytes.byteLength;
		const truncatedByLines = !eof && lineBreaks >= maxLines;
		const truncatedByBytes = !eof && !truncatedByLines;
		return ok({
			lines,
			startLine,
			endLine: lines.length > 0 ? startLine + lines.length - 1 : startLine,
			eof,
			partialLine: truncatedByBytes && !text.endsWith("\n"),
			...(truncatedByLines ? { nextLine: startLine + lines.length } : {}),
			...(truncatedByBytes ? { nextByte: acceptedEnd } : {}),
		});
	}

	async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
		const aborted = this.abort<Uint8Array>(abortSignal, path);
		if (aborted) return aborted;
		const result = this.requireNode(path);
		if (!result.ok) return result;
		return result.value.node.kind === "file"
			? ok(cloneBytes(result.value.node.bytes))
			: err(new FileError("is_directory", `${result.value.path} is a directory`, result.value.path));
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const absolute = this.resolve(path);
		const aborted = this.abort<void>(abortSignal, absolute);
		if (aborted) return aborted;
		try {
			this.ensureDirectory(posix.dirname(absolute));
			const existing = this.nodes.get(absolute);
			const mode = existing?.kind === "file" ? existing.mode : 0o644;
			this.nodes.set(absolute, this.fileNode(typeof content === "string" ? encoder.encode(content) : content, mode));
			return ok(undefined);
		} catch (error) {
			return err(error instanceof FileError ? error : new FileError("unknown", String(error), absolute));
		}
	}

	async appendFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const existing = await this.readBinaryFile(path, abortSignal);
		const suffix = typeof content === "string" ? encoder.encode(content) : content;
		if (!existing.ok) {
			if (existing.error.code !== "not_found") return existing;
			return this.writeFile(path, suffix, abortSignal);
		}
		const combined = new Uint8Array(existing.value.byteLength + suffix.byteLength);
		combined.set(existing.value);
		combined.set(suffix, existing.value.byteLength);
		return this.writeFile(path, combined, abortSignal);
	}

	async renameFile(
		sourcePath: string,
		destinationPath: string,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const source = this.resolve(sourcePath);
		const destination = this.resolve(destinationPath);
		const aborted = this.abort<void>(abortSignal, source);
		if (aborted) return aborted;
		const node = this.nodes.get(source);
		if (!node) return err(new FileError("not_found", `${source} was not found`, source));
		if (this.nodes.has(destination))
			return err(new FileError("invalid", `${destination} already exists`, destination));
		try {
			this.ensureDirectory(posix.dirname(destination));
			this.nodes.set(destination, node);
			this.nodes.delete(source);
			return ok(undefined);
		} catch (error) {
			return err(error instanceof FileError ? error : new FileError("unknown", String(error), destination));
		}
	}

	async fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
		const aborted = this.abort<FileInfo>(abortSignal, path);
		if (aborted) return aborted;
		const result = this.requireNode(path);
		return result.ok ? ok(this.info(result.value.path, result.value.node)) : result;
	}

	async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
		const aborted = this.abort<FileInfo[]>(abortSignal, path);
		if (aborted) return aborted;
		const result = this.requireNode(path);
		if (!result.ok) return result;
		if (result.value.node.kind !== "directory")
			return err(new FileError("not_directory", `${result.value.path} is not a directory`, result.value.path));
		const prefix = result.value.path === "/" ? "/" : `${result.value.path}/`;
		const infos: FileInfo[] = [];
		for (const [candidatePath, node] of this.nodes) {
			if (!candidatePath.startsWith(prefix)) continue;
			const suffix = candidatePath.slice(prefix.length);
			if (!suffix || suffix.includes("/")) continue;
			infos.push(this.info(candidatePath, node));
		}
		return ok(infos);
	}

	async canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		const aborted = this.abort<string>(abortSignal, path);
		if (aborted) return aborted;
		const result = this.requireNode(path);
		return result.ok ? ok(result.value.path) : result;
	}

	async exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
		const aborted = this.abort<boolean>(abortSignal, path);
		return aborted ?? ok(this.nodes.has(this.resolve(path)));
	}

	async createDir(
		path: string,
		options?: { recursive?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>> {
		const absolute = this.resolve(path);
		const aborted = this.abort<void>(options?.abortSignal, absolute);
		if (aborted) return aborted;
		if (options?.recursive === false && !this.nodes.has(posix.dirname(absolute))) {
			return err(new FileError("not_found", `Parent directory was not found`, posix.dirname(absolute)));
		}
		try {
			this.ensureDirectory(absolute);
			return ok(undefined);
		} catch (error) {
			return err(error instanceof FileError ? error : new FileError("unknown", String(error), absolute));
		}
	}

	async remove(
		path: string,
		options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>> {
		const absolute = this.resolve(path);
		const aborted = this.abort<void>(options?.abortSignal, absolute);
		if (aborted) return aborted;
		if (!this.nodes.has(absolute)) {
			return options?.force ? ok(undefined) : err(new FileError("not_found", `${absolute} was not found`, absolute));
		}
		const descendants = [...this.nodes.keys()].filter((candidate) => candidate.startsWith(`${absolute}/`));
		if (descendants.length > 0 && !options?.recursive) {
			return err(new FileError("invalid", `${absolute} is not empty`, absolute));
		}
		for (const descendant of descendants) this.nodes.delete(descendant);
		this.nodes.delete(absolute);
		return ok(undefined);
	}

	async createTempDir(prefix = "tmp-", abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		const path = posix.join(this.cwd, `${prefix}${this.nextIdentity()}`);
		const created = await this.createDir(path, { abortSignal });
		return created.ok ? ok(path) : created;
	}

	async createTempFile(options?: {
		prefix?: string;
		suffix?: string;
		abortSignal?: AbortSignal;
	}): Promise<Result<string, FileError>> {
		const path = posix.join(this.cwd, `${options?.prefix ?? ""}${this.nextIdentity()}${options?.suffix ?? ""}`);
		const written = await this.writeFile(path, "", options?.abortSignal);
		return written.ok ? ok(path) : written;
	}

	async exec(
		_command: string,
		_options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		return err(new ExecutionError("shell_unavailable", "MemoryExecutionEnv does not provide a shell."));
	}

	async cleanup(): Promise<void> {
		this.cleaned = true;
	}

	get isCleanedUp(): boolean {
		return this.cleaned;
	}
}
