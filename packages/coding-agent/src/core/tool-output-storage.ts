import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	createWriteStream,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	opendirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	unlinkSync,
	type WriteStream,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

export const TOOL_OUTPUT_MARKER = ".pi-tool-logs.json";
/** Keep aligned with SessionManager.assertValidSessionId. */
export const TOOL_OUTPUT_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const LOCK = ".maintenance-lock";
const ACTIVE_LEASE = "Active tool log session or writer lease";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LOG_NAME = new RegExp(`^bash-${UUID}\\.log$`);
const LEASE_NAME = new RegExp(`^lease-${UUID}\\.json$`);

interface StorageMarker {
	kind: "pi-tool-output";
	version: 1;
	sessionId: string;
	directory: string;
}

interface Lease {
	kind: "session" | "writer" | "maintenance";
	pid: number;
	startedAt: string;
}

export interface ManagedToolOutputFile {
	path: string;
	/** Already exclusively opened; the consumer owns closing this descriptor. */
	fd: number;
	/** Call only after the descriptor has closed (including failed writes). */
	release: () => void;
}

/** Failed stream construction must not leave a host descriptor or live writer lease behind. */
export function openToolOutputStream(file: ManagedToolOutputFile): WriteStream {
	try {
		return createWriteStream(file.path, { fd: file.fd, autoClose: true });
	} catch (error) {
		try {
			closeSync(file.fd);
		} catch {
			// Construction may already have closed the descriptor.
		}
		try {
			file.release();
		} catch {
			// A failed lease release remains conservative protection.
		}
		throw error;
	}
}

export interface ToolOutputStorageInspection {
	directory: string;
	sessionId?: string;
	bytes: number;
	files: Array<{ path: string; bytes: number; mtimeMs: number }>;
	protectedReason?: string;
}

function assertSafeDirectory(directory: string): void {
	let current = parse(directory).root;
	for (const part of directory.slice(current.length).split(/[\\/]/).filter(Boolean)) {
		current = join(current, part);
		const info = lstatSync(current);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe tool log directory: ${current}`);
	}
}

function readJson(path: string): unknown {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.nlink !== 1 || info.size > 4096) throw new Error("Unsafe tool log metadata file");
		return JSON.parse(readFileSync(fd, "utf8"));
	} finally {
		closeSync(fd);
	}
}

function isLease(value: unknown): value is Lease {
	if (!value || typeof value !== "object") return false;
	const lease = value as Partial<Lease>;
	return (
		Object.keys(value).sort().join(",") === "kind,pid,startedAt" &&
		["session", "writer"].includes(lease.kind ?? "") &&
		Number.isSafeInteger(lease.pid) &&
		(lease.pid ?? 0) > 0 &&
		typeof lease.startedAt === "string" &&
		Number.isFinite(Date.parse(lease.startedAt))
	);
}

function livePid(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Permission failures and PID reuse are protected, not evidence of a dead writer.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function createLease(directory: string, kind: Lease["kind"]): string {
	const path = join(directory, `lease-${randomUUID()}.json`);
	writeFileSync(path, JSON.stringify({ kind, pid: process.pid, startedAt: new Date().toISOString() }), {
		flag: "wx",
		mode: 0o600,
	});
	return path;
}

/** Short, synchronous exclusion shared by writer admission and sweeping; no heartbeat timers. */
function withLock<T>(directory: string, action: () => T, relocatedDirectory?: string): T {
	assertSafeDirectory(directory);
	const lock = join(directory, LOCK);
	mkdirSync(lock, { mode: 0o700 });
	const identity = lstatSync(lock);
	const releaseLock = () => {
		for (const parent of [directory, relocatedDirectory]) {
			if (!parent) continue;
			const candidate = join(parent, LOCK);
			try {
				assertSafeDirectory(candidate);
				const info = lstatSync(candidate);
				if (info.dev !== identity.dev || info.ino !== identity.ino)
					throw new Error("Tool log lock identity changed");
				try {
					unlinkSync(join(candidate, "owner.json"));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				rmdirSync(candidate);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	};
	let result: T;
	try {
		writeFileSync(
			join(lock, "owner.json"),
			JSON.stringify({ kind: "maintenance", pid: process.pid, startedAt: new Date().toISOString() }),
			{ flag: "wx", mode: 0o600 },
		);
		result = action();
	} catch (error) {
		try {
			releaseLock();
		} catch {
			/* Keep the original failure; retain an unverified lock conservatively. */
		}
		throw error;
	}
	releaseLock();
	return result;
}

function inspect(directory: string, ownsLock = false): ToolOutputStorageInspection {
	const result: ToolOutputStorageInspection = { directory: resolve(directory), bytes: 0, files: [] };
	try {
		assertSafeDirectory(result.directory);
		const value = readJson(join(result.directory, TOOL_OUTPUT_MARKER)) as Partial<StorageMarker> | null;
		if (
			!value ||
			Object.keys(value).sort().join(",") !== "directory,kind,sessionId,version" ||
			value.kind !== "pi-tool-output" ||
			value.version !== 1 ||
			typeof value.sessionId !== "string" ||
			!value.sessionId ||
			value.directory !== result.directory
		) {
			throw new Error("Unrecognized tool log ownership marker");
		}
		result.sessionId = value.sessionId;
		const names: string[] = [];
		const handle = opendirSync(result.directory);
		try {
			for (;;) {
				const entry = handle.readSync();
				if (!entry) break;
				if (names.length >= 10_000) throw new Error("Tool log directory exceeds inspection entry limit");
				names.push(entry.name);
			}
		} finally {
			handle.closeSync();
		}
		for (const name of names) {
			if (ownsLock && name === LOCK) continue;
			const path = join(result.directory, name);
			const info = lstatSync(path);
			if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
				throw new Error(`Unsafe or busy tool log entry: ${name}`);
			}
			result.bytes += info.size;
			if (name === TOOL_OUTPUT_MARKER) continue;
			if (LOG_NAME.test(name)) {
				result.files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
			} else if (LEASE_NAME.test(name)) {
				const lease = readJson(path);
				if (!isLease(lease)) throw new Error(`Unrecognized tool log lease: ${name}`);
				if (livePid(lease.pid)) result.protectedReason = ACTIVE_LEASE;
			} else {
				throw new Error(`Unrecognized tool log entry: ${name}`);
			}
		}
	} catch (error) {
		result.protectedReason = error instanceof Error ? error.message : String(error);
	}
	return result;
}

/** Never scans OS temporary pi-bash files or follows artifact paths. */
export function inspectToolOutputStorage(directory: string): ToolOutputStorageInspection {
	return inspect(directory);
}

/** Session lease protects retained logs until close; writer leases survive session close until fd closure. */
export class ToolOutputStorage {
	readonly directory: string;
	private sessionLease: string | undefined;
	private readonly sessionId: string;
	private readonly created: boolean;
	private readonly directoryIdentity: { dev: number; ino: number };
	private readonly relocatedDirectory: string | undefined;

	constructor(options: { sessionId: string; sessionFile?: string; tempRoot?: string; relocatedDirectory?: string }) {
		if (!TOOL_OUTPUT_SESSION_ID.test(options.sessionId)) throw new Error("Invalid tool log session identity");
		this.relocatedDirectory = options.relocatedDirectory;
		this.sessionId = options.sessionId;
		if (options.sessionFile) {
			const parent = resolve(dirname(options.sessionFile));
			assertSafeDirectory(parent);
			this.directory = join(parent, `${options.sessionId}.logs`);
		} else {
			const root = options.tempRoot ? resolve(options.tempRoot) : realpathSync(tmpdir());
			assertSafeDirectory(root);
			this.directory = mkdtempSync(join(root, "pi-tool-logs-"));
		}
		let created = !options.sessionFile;
		try {
			if (!created) {
				mkdirSync(this.directory, { mode: 0o700 });
				created = true;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (created) {
			writeFileSync(
				join(this.directory, TOOL_OUTPUT_MARKER),
				JSON.stringify({
					kind: "pi-tool-output",
					version: 1,
					sessionId: options.sessionId,
					directory: this.directory,
				}),
				{ flag: "wx", mode: 0o600 },
			);
		}
		this.created = created;
		this.directoryIdentity = lstatSync(this.directory);
		try {
			withLock(
				this.directory,
				() => {
					const inspection = inspect(this.directory, true);
					if (inspection.protectedReason && inspection.protectedReason !== ACTIVE_LEASE) {
						throw new Error(inspection.protectedReason);
					}
					if (inspection.sessionId !== options.sessionId) throw new Error("Tool log session identity mismatch");
					this.sessionLease = createLease(this.directory, "session");
				},
				this.relocatedDirectory,
			);
		} catch (error) {
			try {
				this.close({ discardEmpty: true });
			} catch {
				/* Preserve admission failure; never remove unverified data. */
			}
			throw error;
		}
	}

	createLogFile(): ManagedToolOutputFile {
		if (!this.sessionLease) throw new Error("Tool log storage is closed");
		return withLock(this.directory, () => {
			const inspection = inspect(this.directory, true);
			if (inspection.protectedReason && inspection.protectedReason !== ACTIVE_LEASE) {
				throw new Error(inspection.protectedReason);
			}
			if (inspection.sessionId !== this.sessionId) throw new Error("Tool log session identity mismatch");
			const lease = createLease(this.directory, "writer");
			try {
				const path = join(this.directory, `bash-${randomUUID()}.log`);
				const fd = openSync(
					path,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					0o600,
				);
				let released = false;
				return {
					path,
					fd,
					release: () => {
						if (released) return;
						assertSafeDirectory(this.directory);
						unlinkSync(lease);
						released = true;
					},
				};
			} catch (error) {
				unlinkSync(lease);
				throw error;
			}
		});
	}

	close(options: { discardEmpty?: boolean } = {}): void {
		if (!this.sessionLease && !options.discardEmpty) return;
		let directory: string | undefined;
		let unsafe: unknown;
		for (const candidate of [this.directory, this.relocatedDirectory]) {
			if (!candidate) continue;
			try {
				assertSafeDirectory(candidate);
				const info = lstatSync(candidate);
				if (info.dev !== this.directoryIdentity.dev || info.ino !== this.directoryIdentity.ino)
					throw new Error("Tool log directory identity changed");
				directory = candidate;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") unsafe = error;
			}
		}
		if (!directory) {
			if (unsafe) throw unsafe;
			this.sessionLease = undefined;
			return;
		}
		if (this.sessionLease) {
			try {
				unlinkSync(join(directory, basename(this.sessionLease)));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			this.sessionLease = undefined;
		}
		if (options.discardEmpty && this.created) {
			const removed = withLock(directory, () => {
				const handle = opendirSync(directory!);
				try {
					for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
						if (entry.name !== TOOL_OUTPUT_MARKER && entry.name !== LOCK) return false;
					}
				} finally {
					handle.closeSync();
				}
				const marker = readJson(join(directory!, TOOL_OUTPUT_MARKER)) as Partial<StorageMarker> | null;
				if (
					!marker ||
					Object.keys(marker).sort().join(",") !== "directory,kind,sessionId,version" ||
					marker.kind !== "pi-tool-output" ||
					marker.version !== 1 ||
					marker.directory !== this.directory ||
					marker.sessionId !== this.sessionId
				)
					throw new Error("Tool log ownership changed during failed admission cleanup");
				unlinkSync(join(directory!, TOOL_OUTPUT_MARKER));
				return true;
			});
			if (removed) rmdirSync(directory);
		}
	}
}

export interface ToolOutputSweepOptions {
	/** 0/undefined disables this criterion. */
	maxAgeMs?: number;
	/** 0/undefined disables this criterion; protected bytes still count towards the budget. */
	maxTotalBytes?: number;
	/** Defaults to true. Only explicit false permits deletion. */
	dryRun?: boolean;
	now?: number;
}

export function sweepToolOutputStorage(directories: string[], options: ToolOutputSweepOptions = {}) {
	for (const value of [options.maxAgeMs, options.maxTotalBytes, options.now]) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
			throw new Error("Invalid tool log retention policy");
	}
	const inspections = [...new Set(directories.map((directory) => resolve(directory)))].map(inspectToolOutputStorage);
	const candidates: string[] = [];
	const deleted: string[] = [];
	const errors: string[] = [];
	const budgetIncomplete = inspections.some(
		(entry) => entry.protectedReason && entry.protectedReason !== ACTIVE_LEASE,
	);
	if (budgetIncomplete && (options.maxTotalBytes ?? 0) > 0)
		errors.push("Total log budget not applied: one or more directories could not be fully inspected");
	let bytes = inspections.reduce((sum, entry) => sum + entry.bytes, 0);
	const now = options.now ?? Date.now();
	const files = inspections
		.filter((entry) => !entry.protectedReason)
		.flatMap((entry) => entry.files.map((file) => ({ ...file, directory: entry.directory })))
		.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
	for (const file of files) {
		const expired = (options.maxAgeMs ?? 0) > 0 && now - file.mtimeMs >= options.maxAgeMs!;
		if (!expired && !(!budgetIncomplete && (options.maxTotalBytes ?? 0) > 0 && bytes > options.maxTotalBytes!))
			continue;
		candidates.push(file.path);
		if (options.dryRun !== false) {
			bytes -= file.bytes;
			continue;
		}
		try {
			withLock(file.directory, () => {
				const fresh = inspect(file.directory, true);
				if (fresh.protectedReason) throw new Error(fresh.protectedReason);
				const current = fresh.files.find((entry) => entry.path === file.path);
				if (!current || current.bytes !== file.bytes || current.mtimeMs !== file.mtimeMs) {
					throw new Error("Tool log changed during sweep");
				}
				unlinkSync(file.path);
				deleted.push(file.path);
				bytes -= file.bytes;
			});
		} catch (error) {
			errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!budgetIncomplete && (options.maxTotalBytes ?? 0) > 0 && bytes > options.maxTotalBytes!) {
		errors.push(`Total log budget cannot be met: protected logs or managed metadata remain (${bytes} bytes)`);
	}
	return { inspections, candidates, deleted, errors };
}
