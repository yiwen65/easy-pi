import { createHash, randomUUID } from "node:crypto";
import {
	type BigIntStats,
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { getAgentDir } from "../config.ts";
import type { FileEntry, SessionInfo } from "./session-manager.ts";

/** Derived search/display data only. Never a recovery decoder or execution authority. */
export interface SessionSummaryProjection {
	id: string;
	cwd: string;
	parentSessionPath?: string;
	createdTime: number | null;
	name?: string;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	lastActivityTime: number | null;
	hasContent: boolean;
}

export class SessionSummaryBuilder {
	projection?: SessionSummaryProjection;
	private invalid = false;

	add(entry: FileEntry): void {
		try {
			if (this.invalid) return;
			if (!this.projection) {
				if (entry.type !== "session" || typeof entry.id !== "string") {
					this.invalid = true;
					return;
				}
				const createdTime = typeof entry.timestamp === "string" ? new Date(entry.timestamp).getTime() : NaN;
				this.projection = {
					id: entry.id,
					cwd: typeof entry.cwd === "string" ? entry.cwd : "",
					parentSessionPath: typeof entry.parentSession === "string" ? entry.parentSession : undefined,
					createdTime: Number.isFinite(createdTime) ? createdTime : null,
					messageCount: 0,
					firstMessage: "",
					allMessagesText: "",
					lastActivityTime: null,
					hasContent: false,
				};
				return;
			}
			appendToProjection(this.projection, entry);
		} catch {
			// Older readers accept some malformed message shapes. A disposable
			// projection must not add a new failure to authoritative load/write paths.
			this.projection = undefined;
			this.invalid = true;
		}
	}
}

function appendToProjection(projection: SessionSummaryProjection, entry: FileEntry): void {
	if (entry.type === "session_info") {
		projection.name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
	} else if (
		entry.type !== "model_change" &&
		entry.type !== "thinking_level_change" &&
		!(entry.type === "custom" && ["epi-session-cache-affinity", "codex-service-tier"].includes(entry.customType))
	) {
		// Inspect tags only: recovery data may be a large lazy getter.
		projection.hasContent = true;
	}
	if (entry.type !== "message") return;
	projection.messageCount++;
	const message = entry.message;
	if (!("content" in message) || (message.role !== "user" && message.role !== "assistant")) return;
	const timestamp = typeof message.timestamp === "number" ? message.timestamp : new Date(entry.timestamp).getTime();
	if (Number.isFinite(timestamp)) projection.lastActivityTime = Math.max(projection.lastActivityTime ?? 0, timestamp);
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((block) => block?.type === "text")
						.map((block) => block.text)
						.join(" ")
				: "";
	if (!text) return;
	projection.allMessagesText += `${projection.allMessagesText ? " " : ""}${text}`;
	if (!projection.firstMessage && message.role === "user") projection.firstMessage = text;
}

export function sessionInfoFromProjection(
	path: string,
	projection: SessionSummaryProjection,
	identity: BigIntStats,
): SessionInfo {
	// Numeric fs.Stats date getters round sub-millisecond mtime; bigint mtimeMs truncates.
	const mtime = Math.round(Number(identity.mtimeNs) / 1_000_000);
	return {
		path,
		id: projection.id,
		cwd: projection.cwd,
		name: projection.name,
		parentSessionPath: projection.parentSessionPath,
		created: new Date(projection.createdTime ?? NaN),
		modified: new Date(
			projection.lastActivityTime !== null && projection.lastActivityTime > 0
				? projection.lastActivityTime
				: (projection.createdTime ?? mtime),
		),
		messageCount: projection.messageCount,
		firstMessage: projection.firstMessage || "(no messages)",
		allMessagesText: projection.allMessagesText,
		isMetadataOnly: !projection.hasContent && !projection.name,
	};
}

type Fingerprint = [string, string, string, string, string];
interface CachedSummary {
	version: 1;
	source: string;
	fingerprint: Fingerprint;
	projection: SessionSummaryProjection;
}
interface MemorySummary {
	record: CachedSummary;
	weight: number;
	dirty: boolean;
	persist: boolean;
}

// Bound retained search text, not just the number of sessions. Oversized projections
// remain complete in list results but deliberately miss this disposable cache.
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const MAX_PROJECTION_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MEMORY_ENTRIES = 128;
const memory = new Map<string, MemorySummary>();
let memoryBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function fingerprint(identity: BigIntStats): Fingerprint {
	return [identity.dev, identity.ino, identity.size, identity.mtimeNs, identity.ctimeNs].map(String) as Fingerprint;
}
function matches(left: Fingerprint, right: Fingerprint): boolean {
	return left.every((field, index) => field === right[index]);
}
function cachePath(source: string): string {
	return join(getAgentDir(), "session-index", "v1", `${createHash("sha256").update(source).digest("hex")}.json`);
}
function weight(projection: SessionSummaryProjection): number {
	return (
		512 +
		2 *
			(projection.allMessagesText.length +
				projection.firstMessage.length +
				projection.cwd.length +
				projection.id.length +
				(projection.name?.length ?? 0) +
				(projection.parentSessionPath?.length ?? 0))
	);
}
function forget(key: string): void {
	const old = memory.get(key);
	if (old) memoryBytes -= old.weight;
	memory.delete(key);
}
function remember(key: string, record: CachedSummary, dirty: boolean, persist: boolean): void {
	forget(key);
	const bytes = weight(record.projection);
	if (bytes > MAX_PROJECTION_BYTES) return;
	while (memory.size && (memoryBytes + bytes > MAX_MEMORY_BYTES || memory.size >= MAX_MEMORY_ENTRIES)) {
		const oldest = memory.keys().next().value!;
		// A cold list can exceed the LRU. Persist before eviction, not only at list end.
		flushOne(oldest);
		forget(oldest);
	}
	memory.set(key, { record, weight: bytes, dirty, persist });
	memoryBytes += bytes;
}
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validProjection(value: unknown): value is SessionSummaryProjection {
	if (!isObject(value)) return false;
	const keys = [
		"id",
		"cwd",
		"parentSessionPath",
		"createdTime",
		"name",
		"messageCount",
		"firstMessage",
		"allMessagesText",
		"lastActivityTime",
		"hasContent",
	];
	return (
		Object.keys(value).every((key) => keys.includes(key)) &&
		typeof value.id === "string" &&
		typeof value.cwd === "string" &&
		(value.parentSessionPath === undefined || typeof value.parentSessionPath === "string") &&
		(value.name === undefined ||
			(typeof value.name === "string" && value.name === value.name.trim() && value.name.length > 0)) &&
		(value.createdTime === null || (typeof value.createdTime === "number" && Number.isFinite(value.createdTime))) &&
		(value.lastActivityTime === null ||
			(typeof value.lastActivityTime === "number" && Number.isFinite(value.lastActivityTime))) &&
		typeof value.messageCount === "number" &&
		Number.isSafeInteger(value.messageCount) &&
		value.messageCount >= 0 &&
		typeof value.firstMessage === "string" &&
		typeof value.allMessagesText === "string" &&
		typeof value.hasContent === "boolean"
	);
}

/** Identity is always obtained from the source, even for an in-process hit. */
export function getSessionSummary(path: string, identity: BigIntStats): SessionSummaryProjection | undefined {
	const source = resolve(path);
	const key = cachePath(source);
	const expected = fingerprint(identity);
	const cached = memory.get(key);
	if (cached && matches(cached.record.fingerprint, expected)) {
		memory.delete(key);
		memory.set(key, cached);
		if (!cached.persist) cached.dirty = true;
		cached.persist = true;
		return cached.record.projection;
	}
	forget(key);
	try {
		const info = lstatSync(key);
		if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CACHE_FILE_BYTES) return;
		const record: unknown = JSON.parse(readFileSync(key, "utf8"));
		if (
			!isObject(record) ||
			record.version !== 1 ||
			record.source !== source ||
			Object.keys(record).some((field) => !["version", "source", "fingerprint", "projection"].includes(field)) ||
			!Array.isArray(record.fingerprint) ||
			record.fingerprint.length !== 5 ||
			!record.fingerprint.every((field) => typeof field === "string") ||
			!matches(record.fingerprint as Fingerprint, expected) ||
			!validProjection(record.projection) ||
			weight(record.projection) > MAX_PROJECTION_BYTES ||
			!matches(fingerprint(statSync(source, { bigint: true })), expected)
		)
			return;
		remember(key, record as unknown as CachedSummary, false, true);
		return record.projection;
	} catch {
		// Missing, corrupt, inaccessible, or unknown caches always fall back to the source.
		return;
	}
}

/** Publish only a projection of bytes whose source identity still matches. */
export function recordSessionSummary(
	path: string,
	identity: BigIntStats,
	projection: SessionSummaryProjection,
	persist = false,
): void {
	try {
		const source = resolve(path);
		if (!matches(fingerprint(statSync(source, { bigint: true })), fingerprint(identity))) return;
		const key = cachePath(source);
		const previous = memory.get(key);
		let enabled = persist || (previous?.persist ?? false);
		if (!enabled && !previous) {
			try {
				// Listing interest survives process restarts. A full source load already
				// rebuilt this projection; cache bytes never supply its content or identity.
				const existing = lstatSync(key);
				enabled = existing.isFile() && !existing.isSymbolicLink();
			} catch {
				/* Never-listed sources still remain memory-only. */
			}
		}
		remember(key, { version: 1, source, fingerprint: fingerprint(identity), projection }, true, enabled);
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			flushSessionSummaries();
		}, 100);
		flushTimer.unref();
	} catch {
		// Indexing must never turn a successful source commit into an error.
	}
}

/** Only a known, successful writer may advance from the exact committed predecessor. */
export function advanceSessionSummary(path: string, previous: BigIntStats, next: BigIntStats, entry: FileEntry): void {
	try {
		const key = cachePath(resolve(path));
		const old = memory.get(key);
		if (!old || !matches(old.record.fingerprint, fingerprint(previous))) {
			forget(key);
			return;
		}
		const projection = { ...old.record.projection };
		appendToProjection(projection, entry);
		recordSessionSummary(path, next, projection);
	} catch {
		// Best effort, and never scan history from the writer.
	}
}

function flushOne(key: string): void {
	const item = memory.get(key);
	if (!item?.dirty || !item.persist) return;
	const { record } = item;
	let temporary: string | undefined;
	try {
		if (!matches(fingerprint(statSync(record.source, { bigint: true })), record.fingerprint)) return;
		// The key binds the originating agentDir even if a test/host changes its env later.
		const directory = dirname(key);
		const root = dirname(directory);
		for (const path of [root, directory]) {
			mkdirSync(path, { recursive: true, mode: 0o700 });
			const info = lstatSync(path);
			if (!info.isDirectory() || info.isSymbolicLink()) return;
			// Tighten group/other access without overriding an owner's read-only choice.
			if (info.mode & 0o077) chmodSync(path, info.mode & 0o700);
		}
		temporary = `${key}.${randomUUID()}.tmp`;
		writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
		// A late publisher may overwrite a newer cache, but retains its OLD fingerprint:
		// the worst possible outcome is a miss, never stale data under a new identity.
		if (!matches(fingerprint(statSync(record.source, { bigint: true })), record.fingerprint)) return;
		renameSync(temporary, key);
		temporary = undefined;
		item.dirty = false;
	} catch {
		// Atomic but intentionally not fsynced: this is disposable derived data.
	} finally {
		if (temporary) {
			try {
				unlinkSync(temporary);
			} catch {
				/* Best-effort cleanup of our temporary only. */
			}
		}
	}
}

function isIndexDirectory(directory: string): boolean {
	try {
		for (const path of [dirname(dirname(directory)), dirname(directory), directory]) {
			const info = lstatSync(path);
			if (!info.isDirectory() || info.isSymbolicLink()) return false;
		}
		return true;
	} catch {
		return false;
	}
}

interface DeletionCandidate {
	key: string;
	dev: string;
	ino: string;
	identity: BigIntStats;
}

/** Inspect cache metadata only; its source string is never opened or unlinked. */
function readDeletionCandidate(key: string): DeletionCandidate | undefined {
	let fd: number | undefined;
	try {
		const info = lstatSync(key, { bigint: true });
		if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(MAX_CACHE_FILE_BYTES)) return;
		fd = openSync(key, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const identity = fstatSync(fd, { bigint: true });
		if (identity.dev !== info.dev || identity.ino !== info.ino || identity.size > BigInt(MAX_CACHE_FILE_BYTES))
			return;
		const record: unknown = JSON.parse(readFileSync(fd, "utf8"));
		if (
			!isObject(record) ||
			record.version !== 1 ||
			typeof record.source !== "string" ||
			resolve(record.source) !== record.source ||
			cachePath(record.source) !== key ||
			Object.keys(record).some((field) => !["version", "source", "fingerprint", "projection"].includes(field)) ||
			!Array.isArray(record.fingerprint) ||
			record.fingerprint.length !== 5 ||
			!record.fingerprint.every(
				(field, index) => typeof field === "string" && (index < 3 ? /^\d+$/ : /^-?\d+$/).test(field),
			) ||
			!validProjection(record.projection)
		)
			return;
		return { key, dev: record.fingerprint[0], ino: record.fingerprint[1], identity };
	} catch {
		return;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Remove private text for every path alias of a deleted inode, in this agentDir only. */
export function forgetSessionSummary(path: string, identity?: { dev: number | bigint; ino: number | bigint }): void {
	try {
		const key = cachePath(resolve(path));
		const directory = dirname(key);
		let target: readonly string[] | undefined;
		if (
			identity &&
			[identity.dev, identity.ino].every((value) =>
				typeof value === "bigint" ? value >= 0n : Number.isSafeInteger(value) && value >= 0,
			)
		) {
			target = [String(identity.dev), String(identity.ino)];
		}
		if (!target) {
			try {
				const source = statSync(path, { bigint: true });
				target = [String(source.dev), String(source.ino)];
			} catch {
				// Old callers often invoke this after unlink; the direct record still identifies aliases.
				target = memory.get(key)?.record.fingerprint.slice(0, 2);
			}
		}
		forget(key);
		const candidates: DeletionCandidate[] = [];
		try {
			if (isIndexDirectory(directory)) {
				for (const name of readdirSync(directory)) {
					if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
					const candidate = readDeletionCandidate(join(directory, name));
					if (!candidate) continue;
					candidates.push(candidate);
					if (!target && candidate.key === key) target = [candidate.dev, candidate.ino];
				}
			}
		} catch {
			// Inaccessible disk caches must not prevent clearing matching in-memory aliases.
		}
		for (const [alias, item] of memory) {
			if (
				dirname(alias) === directory &&
				target &&
				item.record.fingerprint[0] === target[0] &&
				item.record.fingerprint[1] === target[1]
			)
				forget(alias);
		}
		for (const candidate of candidates) {
			if (candidate.key !== key && (!target || candidate.dev !== target[0] || candidate.ino !== target[1])) continue;
			try {
				if (!isIndexDirectory(directory)) continue;
				const current = lstatSync(candidate.key, { bigint: true });
				if (
					current.isFile() &&
					!current.isSymbolicLink() &&
					current.dev === candidate.identity.dev &&
					current.ino === candidate.identity.ino
				)
					unlinkSync(candidate.key);
			} catch {
				/* Missing/replaced/unwritable cache files are best effort. */
			}
		}
	} catch {
		/* Cache failures cannot undo a source deletion. */
	}
}

/** Lists call this before returning so a fresh process can reuse generated projections. */
export function flushSessionSummaries(): void {
	if (flushTimer) clearTimeout(flushTimer);
	flushTimer = undefined;
	for (const key of memory.keys()) flushOne(key);
}
