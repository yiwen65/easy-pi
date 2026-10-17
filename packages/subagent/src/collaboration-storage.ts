import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	opendirSync,
	openSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	COLLABORATION_HISTORY_LIMITS,
	CollaborationAdmissionError,
	CollaborationError,
} from "./collaboration-contract.ts";
import {
	assertCollaborationPathSafe,
	collaborationDeletionMarker,
	collaborationOwnerAlive,
} from "./collaboration-storage-guard.ts";
import {
	type CollaborationSnapshot,
	validateCollaborationSnapshot,
	validateCollaborationStoredTurn,
} from "./collaboration-store.ts";

export interface CollaborationStorageOptions {
	agentDir: string;
	rootSessionId: string;
	maxEntries?: number;
	maxScanMs?: number;
}
export interface CollaborationStorageStats {
	rootSessionId: string;
	directory: string;
	state: "present" | "missing" | "deleting" | "deleted" | "unknown";
	/** Lower bound when incomplete; never use it as a complete budget measurement. */
	bytes: number;
	files: number;
	lastModified: number | null;
	incomplete: boolean;
	owner: "live" | "inactive" | "unknown";
	agentCount: number | null;
	pendingMessages: number | null;
	unfinishedTurns: number | null;
	interruptedTurns: number | null;
	deletable: boolean;
	gcEligible: boolean;
	protectedReasons: string[];
}
export interface CollaborationStorageInventory {
	teams: CollaborationStorageStats[];
	bytes: number;
	incomplete: boolean;
	unknownEntries: string[];
}
export interface CollaborationStorageDeleteResult {
	rootSessionId: string;
	status: "planned" | "protected" | "deleted" | "already_deleted" | "missing";
	stats: CollaborationStorageStats;
}
export interface CollaborationStoragePolicy {
	now?: number;
	maxAgeMs?: number;
	maxTotalBytes?: number;
}
interface Entry {
	path: string;
	kind: "file" | "directory";
	dev: number;
	ino: number;
}
interface Marker {
	kind: "pi-team-deletion";
	version: 1;
	rootSessionId: string;
	directory: string;
	state: "deleting" | "deleted";
	entries: Entry[];
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

function locations(options: CollaborationStorageOptions) {
	if (
		typeof options.rootSessionId !== "string" ||
		typeof options.agentDir !== "string" ||
		!ID.test(options.rootSessionId) ||
		!isAbsolute(options.agentDir) ||
		resolve(options.agentDir) !== options.agentDir
	)
		throw new CollaborationError("invalid_arguments", "Invalid team storage identity");
	assertCollaborationPathSafe(options.agentDir);
	const teams = join(options.agentDir, "teams");
	assertCollaborationPathSafe(teams);
	const directory = join(teams, options.rootSessionId);
	return {
		teams,
		directory,
		marker: collaborationDeletionMarker(directory),
		quarantine: join(teams, `.${options.rootSessionId}.deleting`),
	};
}
function positiveLimit(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
		throw new CollaborationError("invalid_arguments", "Invalid storage scan limit");
	return value;
}
function absent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (absent(error)) return false;
		throw error;
	}
}
function jsonFile(path: string, retainedMarker = false): unknown {
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(!retainedMarker && stat.nlink !== 1) ||
		stat.size > MAX_METADATA_BYTES
	)
		throw new CollaborationError("forbidden", "Unsafe storage metadata");
	return JSON.parse(readFileSync(path, "utf8"));
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid metadata object");
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string): boolean {
	return Object.keys(value).sort().join(",") === expected;
}
function readMarker(options: CollaborationStorageOptions, budget?: ScanBudget): Marker | undefined {
	const paths = locations(options);
	let value: Record<string, unknown>;
	try {
		value = object(jsonFile(paths.marker, true));
	} catch (error) {
		if (absent(error)) return undefined;
		throw error;
	}
	if (
		!keys(value, "directory,entries,kind,rootSessionId,state,version") ||
		value.kind !== "pi-team-deletion" ||
		value.version !== 1 ||
		value.rootSessionId !== options.rootSessionId ||
		value.directory !== paths.directory ||
		!["deleting", "deleted"].includes(String(value.state)) ||
		!Array.isArray(value.entries) ||
		value.entries.length > MAX_ENTRIES
	)
		throw new Error("Invalid deletion marker");
	const seen = new Set<string>();
	for (const item of value.entries) {
		if (budget) consume(budget);
		const entry = object(item);
		if (
			!keys(entry, "dev,ino,kind,path") ||
			typeof entry.path !== "string" ||
			(entry.path !== "" &&
				(isAbsolute(entry.path) || entry.path.split(sep).some((part) => !part || part === "." || part === ".."))) ||
			!["file", "directory"].includes(String(entry.kind)) ||
			!Number.isSafeInteger(entry.dev) ||
			!Number.isSafeInteger(entry.ino) ||
			seen.has(entry.path)
		)
			throw new Error("Invalid deletion manifest");
		if (relative(paths.directory, resolve(paths.directory, entry.path)) !== entry.path)
			throw new Error("Noncanonical deletion path");
		seen.add(entry.path);
	}
	if (value.state === "deleting" && (!seen.has("") || value.entries.length === 0))
		throw new Error("Missing deletion manifest");
	return value as unknown as Marker;
}
function persistMarker(path: string, marker: Marker, replaceCompleted = false): void {
	// New intent never overwrites proof; completed intent replaces it atomically without a gap.
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		try {
			writeFileSync(fd, JSON.stringify(marker));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (replaceCompleted) renameSync(temporary, path);
		else linkSync(temporary, path);
	} finally {
		if (pathExists(temporary)) unlinkSync(temporary);
	}
	syncDirectory(dirname(path));
}

/** Windows does not expose POSIX directory-fsync through Node; file intent is still synced. */
function syncDirectory(path: string): void {
	if (process.platform === "win32") return;
	const parent = openSync(path, "r");
	try {
		fsyncSync(parent);
	} finally {
		closeSync(parent);
	}
}

interface ScanBudget {
	remaining: number;
	deadline: number;
}
function scanBudget(options: Pick<CollaborationStorageOptions, "maxEntries" | "maxScanMs">): ScanBudget {
	return {
		remaining: positiveLimit(options.maxEntries, 10_000, MAX_ENTRIES),
		deadline: Date.now() + positiveLimit(options.maxScanMs, 2000, 60_000),
	};
}
function consume(budget: ScanBudget): void {
	if (Date.now() >= budget.deadline || budget.remaining-- <= 0) throw new Error("Storage inspection budget exhausted");
}

interface Metadata {
	snapshot: CollaborationSnapshot;
	owner: "live" | "inactive";
	pending: number;
	unfinished: number;
	interrupted: number;
	unknownHistory: boolean;
}
function metadata(database: DatabaseSync, options: CollaborationStorageOptions, budget: ScanBudget): Metadata {
	consume(budget);
	const length = database.prepare("SELECT length(CAST(snapshot AS BLOB)) AS n FROM team WHERE id=1").get()?.n;
	if (typeof length !== "number" || length > MAX_METADATA_BYTES) throw new Error("Invalid team metadata size");
	const row = database.prepare("SELECT snapshot, owner, pid, owner_started_at FROM team WHERE id=1").get();
	if (
		!row ||
		typeof row.snapshot !== "string" ||
		Buffer.byteLength(row.snapshot) > MAX_METADATA_BYTES ||
		Number(database.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM team LIMIT 2)").get()!.n) !== 1
	)
		throw new Error("Invalid team metadata");
	const snapshot = validateCollaborationSnapshot(JSON.parse(row.snapshot));
	if (snapshot.rootSessionId !== options.rootSessionId || resolve(snapshot.cwd) !== snapshot.cwd)
		throw new Error("Mismatched team identity");
	if (database.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view') LIMIT 1").get())
		throw new Error("Unknown database behavior");
	const columns = database
		.prepare("PRAGMA table_info(team)")
		.all()
		.map((item) => item.name);
	if (
		columns.some(
			(name) => !["id", "snapshot", "owner", "pid", "owner_started_at", "deletion_pending"].includes(String(name)),
		)
	)
		throw new Error("Unknown team schema");
	const names = database
		.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 4")
		.all()
		.map((item) => item.name);
	if (names.some((name) => !["team", "turns", "history"].includes(String(name))))
		throw new Error("Unknown database structure");
	for (const [table, expected] of [
		["turns", "record,result_message_id,sequence,target,task_message_id,turn_id"],
		["history", "coverage,id"],
	]) {
		const actual = database
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((item) => item.name)
			.sort()
			.join(",");
		if (actual !== expected) throw new Error("Unknown history schema");
	}
	const count = Number(
		database
			.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM turns LIMIT ?)")
			.get(COLLABORATION_HISTORY_LIMITS.maxRetainedTurns + 1)!.n,
	);
	if (!Number.isSafeInteger(count) || count < 0 || count > COLLABORATION_HISTORY_LIMITS.maxRetainedTurns)
		throw new Error("Invalid history size");
	let unfinished = 0;
	let interrupted = 0;
	const coverage = database.prepare("SELECT coverage FROM history WHERE id=1").get()?.coverage;
	if (
		(coverage !== "complete" && coverage !== "retained_only") ||
		Number(database.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM history LIMIT 2)").get()!.n) !== 1
	)
		throw new Error("Invalid history coverage");
	let unknownHistory = coverage !== "complete";
	const latest = new Set<string>();
	for (const item of database
		.prepare(
			"SELECT sequence,target,turn_id,task_message_id,result_message_id,CASE WHEN length(CAST(record AS BLOB))<=? THEN record ELSE NULL END AS record FROM turns LIMIT ?",
		)
		.iterate(MAX_METADATA_BYTES, COLLABORATION_HISTORY_LIMITS.maxRetainedTurns + 1)) {
		consume(budget);
		if (typeof item.record !== "string" || Buffer.byteLength(item.record) > MAX_METADATA_BYTES)
			throw new Error("Invalid history metadata");
		const turn = validateCollaborationStoredTurn(JSON.parse(item.record));
		latest.add(`${turn.target}:${turn.turn_id}`);
		if (
			turn.rootSessionId !== options.rootSessionId ||
			turn.target !== item.target ||
			turn.turn_id !== item.turn_id ||
			turn.sequence !== item.sequence ||
			turn.task_message_id !== item.task_message_id ||
			turn.result_message_id !== item.result_message_id ||
			!snapshot.agents.some((agent) => agent.path === turn.target) ||
			!["pending", "running", "completed", "failed", "interrupted", "unknown"].includes(String(turn.status))
		)
			throw new Error("Invalid history identity");
		if (turn.status === "pending" || turn.status === "running") unfinished++;
		if (turn.status === "interrupted") interrupted++;
		if (turn.status === "unknown" || turn.history_coverage !== "complete") unknownHistory = true;
		const delivery = object(turn.delivery);
		if (!["not_enqueued", "enqueued", "acknowledged", "unknown"].includes(String(delivery.state)))
			throw new Error("Invalid delivery metadata");
		if (delivery.state === "unknown" || delivery.state === "enqueued") unknownHistory = true;
	}
	if (snapshot.agents.some((agent) => !latest.has(`${agent.path}:${agent.turnId}`)))
		throw new Error("Missing latest turn history");
	unfinished = Math.max(
		unfinished,
		snapshot.agents.filter(
			(agent) => agent.status === "pending" || agent.status === "running" || agent.completionPending,
		).length,
	);
	interrupted = Math.max(interrupted, snapshot.agents.filter((agent) => agent.status === "interrupted").length);
	const owner = collaborationOwnerAlive({ owner: row.owner, pid: row.pid, owner_started_at: row.owner_started_at })
		? "live"
		: "inactive";
	consume(budget);
	return { snapshot, owner, pending: snapshot.messages?.length ?? 0, unfinished, interrupted, unknownHistory };
}

/** Log ownership format is intentionally checked here without a coding-agent runtime dependency. */
function logLease(path: string, kind: "session" | "writer" | "maintenance"): boolean {
	const lease = object(jsonFile(path));
	if (
		!keys(lease, "kind,pid,startedAt") ||
		lease.kind !== kind ||
		!Number.isSafeInteger(lease.pid) ||
		Number(lease.pid) <= 0 ||
		typeof lease.startedAt !== "string" ||
		!Number.isFinite(Date.parse(lease.startedAt))
	)
		throw new Error("Invalid log lease");
	try {
		process.kill(Number(lease.pid), 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Native task ownership is distinct from the team owner and must protect directly opened child sessions. */
function taskLock(path: string): boolean {
	const owner = object(jsonFile(path));
	if (
		!keys(owner, "pid,token") ||
		!Number.isSafeInteger(owner.pid) ||
		Number(owner.pid) <= 0 ||
		typeof owner.token !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner.token)
	)
		throw new Error("Invalid task writer lock");
	try {
		process.kill(Number(owner.pid), 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function scan(
	options: CollaborationStorageOptions,
	budget = scanBudget(options),
): { stats: CollaborationStorageStats; entries: Entry[]; metadata?: Metadata } {
	const paths = locations(options);
	const stats: CollaborationStorageStats = {
		rootSessionId: options.rootSessionId,
		directory: paths.directory,
		state: "present",
		bytes: 0,
		files: 0,
		lastModified: null,
		incomplete: false,
		owner: "unknown",
		agentCount: null,
		pendingMessages: null,
		unfinishedTurns: null,
		interruptedTurns: null,
		deletable: false,
		gcEligible: false,
		protectedReasons: [],
	};
	const entries: Entry[] = [];
	let proof: Metadata | undefined;
	try {
		const marker = readMarker(options, budget);
		if (marker) {
			const remaining = pathExists(paths.directory) || pathExists(paths.quarantine);
			stats.state = remaining ? "deleting" : "deleted";
			stats.bytes = lstatSync(paths.marker).size;
			stats.incomplete = remaining;
			stats.protectedReasons.push("deletion_marked");
			return { stats, entries };
		}
		if (pathExists(paths.quarantine)) throw new Error("Quarantine lacks a valid deletion marker");
		const stat = lstatSync(paths.directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe team directory");
		const dbPath = join(paths.directory, "registry.sqlite");
		const dbStat = lstatSync(dbPath);
		if (!dbStat.isFile() || dbStat.isSymbolicLink() || dbStat.nlink !== 1) throw new Error("Unsafe team database");
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			proof = metadata(db, options, budget);
		} finally {
			db.close();
		}
		stats.owner = proof.owner;
		stats.agentCount = proof.snapshot.agents.length;
		stats.pendingMessages = proof.pending;
		stats.unfinishedTurns = proof.unfinished;
		stats.interruptedTurns = proof.interrupted;
		const children = new Map(proof.snapshot.agents.map((agent) => [agent.id, agent]));
		const visit = (path: string): void => {
			consume(budget);
			const info = lstatSync(path);
			if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1))
				throw new Error("Unsafe team entry");
			const local = relative(paths.directory, path);
			entries.push({ path: local, kind: info.isDirectory() ? "directory" : "file", dev: info.dev, ino: info.ino });
			stats.lastModified = Math.max(stats.lastModified ?? 0, info.mtimeMs);
			if (info.isFile()) {
				stats.bytes += info.size;
				stats.files++;
				return;
			}
			const dir = opendirSync(path);
			try {
				for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
					if (budget.remaining <= 0 || Date.now() >= budget.deadline) {
						stats.incomplete = true;
						break;
					}
					const next = join(path, entry.name);
					const parts = local ? local.split(sep) : [];
					if (parts.length === 0) {
						if (
							!(entry.isFile() && /^registry\.sqlite(?:-wal|-shm|-journal)?$/.test(entry.name)) &&
							!(entry.isDirectory() && children.has(entry.name))
						)
							throw new Error("Unknown team entry");
					} else if (parts.length === 1) {
						const child = children.get(parts[0]);
						if (child?.sessionFile && entry.isFile() && entry.name === `${child.sessionFile}.task.lock`) {
							if (taskLock(next)) stats.protectedReasons.push("live_task_writer");
						} else if (
							child?.sessionFile &&
							entry.isDirectory() &&
							entry.name === `${child.sessionFile}.task.lock.claim`
						) {
							// Claim directories have no owner receipt: a stale or in-flight claim is uncertain.
							stats.incomplete = true;
							stats.protectedReasons.push("task_ownership_claim");
						} else if (
							!child ||
							(!(entry.isFile() && entry.name === child.sessionFile) &&
								!(entry.isDirectory() && /^[A-Za-z0-9._-]+\.logs$/.test(entry.name)))
						)
							throw new Error("Unknown child entry");
					} else if (parts.length === 2 && parts[1].endsWith(".logs")) {
						if (entry.name === ".pi-tool-logs.json") {
							const marker = object(jsonFile(next));
							if (
								!keys(marker, "directory,kind,sessionId,version") ||
								marker.kind !== "pi-tool-output" ||
								marker.version !== 1 ||
								marker.sessionId !== parts[1].slice(0, -5) ||
								marker.directory !== path
							)
								throw new Error("Invalid log ownership");
						} else if (/^lease-[0-9a-f-]{36}\.json$/.test(entry.name)) {
							const lease = object(jsonFile(next));
							if (lease.kind !== "session" && lease.kind !== "writer") throw new Error("Invalid log lease");
							if (logLease(next, lease.kind)) stats.protectedReasons.push("live_log_writer");
						} else if (entry.name === ".maintenance-lock" && entry.isDirectory()) {
							if (logLease(join(next, "owner.json"), "maintenance"))
								stats.protectedReasons.push("live_log_maintenance");
						} else if (!entry.isFile() || !/^bash-[0-9a-f-]{36}\.log$/.test(entry.name))
							throw new Error("Unknown log entry");
					} else if (
						!(
							parts.length === 3 &&
							parts[2] === ".maintenance-lock" &&
							entry.name === "owner.json" &&
							entry.isFile()
						)
					)
						throw new Error("Unknown storage structure");
					if (entry.isDirectory() && entry.name.endsWith(".logs") && !existsSync(join(next, ".pi-tool-logs.json")))
						throw new Error("Missing log ownership");
					visit(next);
				}
			} finally {
				dir.closeSync();
			}
		};
		visit(paths.directory);
		if (stats.owner === "live") stats.protectedReasons.push("live_owner");
		if (stats.incomplete) stats.protectedReasons.push("scan_incomplete");
		stats.deletable = stats.protectedReasons.length === 0;
		stats.gcEligible =
			stats.deletable && !proof.pending && !proof.unfinished && !proof.interrupted && !proof.unknownHistory;
		if (proof.pending) stats.protectedReasons.push("pending_mail");
		if (proof.unfinished) stats.protectedReasons.push("unfinished_work");
		if (proof.interrupted) stats.protectedReasons.push("interrupted_work");
		if (proof.unknownHistory) stats.protectedReasons.push("unknown_or_unconsumed_history");
	} catch (error) {
		if (absent(error) && !existsSync(paths.directory) && !existsSync(paths.marker)) {
			stats.state = "missing";
			stats.owner = "inactive";
		} else {
			stats.state = "unknown";
			stats.incomplete = true;
			stats.protectedReasons.push("unknown_or_unsafe_structure");
			stats.deletable = false;
			stats.gcEligible = false;
		}
	}
	return { stats, entries, metadata: proof };
}

export function inspectCollaborationStorage(options: CollaborationStorageOptions): CollaborationStorageStats {
	return scan(options).stats;
}

export function listCollaborationStorage(
	options: Omit<CollaborationStorageOptions, "rootSessionId"> & { maxTeams?: number },
): CollaborationStorageInventory {
	const paths = locations({ ...options, rootSessionId: "probe" });
	const maxTeams = positiveLimit(options.maxTeams, 1000, 10_000);
	const result: CollaborationStorageInventory = { teams: [], bytes: 0, incomplete: false, unknownEntries: [] };
	let directory: ReturnType<typeof opendirSync>;
	try {
		directory = opendirSync(paths.teams);
	} catch (error) {
		if (absent(error)) return result;
		throw error;
	}
	const ids = new Set<string>();
	let seen = 0;
	const budget = scanBudget(options);
	try {
		for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
			if (Date.now() >= budget.deadline || budget.remaining-- <= 0) {
				result.incomplete = true;
				break;
			}
			if (++seen > maxTeams * 3) {
				result.incomplete = true;
				break;
			}
			let id = entry.name;
			const marked = /^\.(.+)\.(?:deleted\.json|deleting)$/.exec(id);
			if (marked) id = marked[1];
			if (!ID.test(id) || (!marked && !entry.isDirectory())) {
				result.unknownEntries.push(entry.name);
				result.incomplete = true;
				continue;
			}
			if (ids.has(id)) continue;
			if (ids.size >= maxTeams) {
				result.incomplete = true;
				break;
			}
			ids.add(id);
			const stats = scan({ ...options, rootSessionId: id }, budget).stats;
			result.teams.push(stats);
			result.bytes += stats.bytes;
			result.incomplete ||= stats.incomplete;
		}
	} finally {
		directory.closeSync();
	}
	return result;
}

function verifyManifest(directory: string, marker: Marker): void {
	const manifest = new Map(marker.entries.map((entry) => [entry.path, entry]));
	const visit = (path: string): void => {
		const local = relative(directory, path);
		const expected = manifest.get(local);
		const actual = lstatSync(path);
		if (
			!expected ||
			actual.isSymbolicLink() ||
			actual.dev !== expected.dev ||
			actual.ino !== expected.ino ||
			(expected.kind === "directory" ? !actual.isDirectory() : !actual.isFile() || actual.nlink !== 1)
		)
			throw new Error("Quarantine no longer matches deletion proof");
		if (actual.isFile() && basename(path).endsWith(".jsonl.task.lock") && taskLock(path)) {
			throw new CollaborationError("busy", "A live or unknown task writer protects deletion retry");
		}
		if (actual.isDirectory() && basename(path).endsWith(".jsonl.task.lock.claim")) {
			throw new CollaborationError("busy", "An uncertain task claim protects deletion retry");
		}
		if (actual.isFile() && /^lease-[0-9a-f-]{36}\.json$/.test(basename(path))) {
			const lease = object(jsonFile(path));
			if ((lease.kind !== "session" && lease.kind !== "writer") || logLease(path, lease.kind)) {
				throw new CollaborationError("busy", "A live or unknown log lease protects deletion retry");
			}
		}
		if (
			actual.isFile() &&
			basename(path) === "owner.json" &&
			basename(dirname(path)) === ".maintenance-lock" &&
			logLease(path, "maintenance")
		) {
			throw new CollaborationError("busy", "Live log maintenance protects deletion retry");
		}
		if (actual.isDirectory()) {
			const dir = opendirSync(path);
			try {
				for (let item = dir.readSync(); item !== null; item = dir.readSync()) visit(join(path, item.name));
			} finally {
				dir.closeSync();
			}
		}
	};
	visit(directory);
}
function finishDeletion(options: CollaborationStorageOptions, marker: Marker): void {
	const paths = locations(options);
	if (pathExists(paths.directory)) {
		if (pathExists(paths.quarantine)) throw new Error("Both team and quarantine exist; operator inspection required");
		verifyManifest(paths.directory, marker);
		renameSync(paths.directory, paths.quarantine);
		syncDirectory(paths.teams);
	}
	if (pathExists(paths.quarantine)) {
		verifyManifest(paths.quarantine, marker);
		for (const entry of [...marker.entries].sort(
			(a, b) => b.path.split(sep).length - a.path.split(sep).length || b.path.length - a.path.length,
		)) {
			const path = join(paths.quarantine, entry.path);
			try {
				const info = lstatSync(path);
				if (info.isSymbolicLink() || info.dev !== entry.dev || info.ino !== entry.ino)
					throw new Error("Deletion entry changed");
				if (entry.kind === "directory") rmdirSync(path);
				else unlinkSync(path);
			} catch (error) {
				if (!absent(error)) throw error;
			}
		}
	}
	if (pathExists(paths.directory) || pathExists(paths.quarantine)) throw new Error("Team deletion is incomplete");
	// Preserve the complete retry manifest until all physical content is gone. Never truncate in place.
	persistMarker(paths.marker, { ...marker, state: "deleted", entries: [] }, true);
}

/** Manual deletion may include unread/interrupted history; the UI must confirm that impact first.
 * automatic=true adds the stricter GC gate. dryRun defaults true and never writes markers.
 */
export function deleteCollaborationStorage(
	options: CollaborationStorageOptions & CollaborationStoragePolicy & { dryRun?: boolean; automatic?: boolean },
): CollaborationStorageDeleteResult {
	const paths = locations(options);
	const stats = inspectCollaborationStorage(options);
	let marker: Marker | undefined;
	try {
		marker = readMarker(options);
	} catch {
		return { rootSessionId: options.rootSessionId, status: "protected", stats };
	}
	if (marker) {
		if (!pathExists(paths.directory) && !pathExists(paths.quarantine)) {
			if (options.dryRun === false && (marker.state !== "deleted" || marker.entries.length > 0)) {
				finishDeletion(options, marker);
				return {
					rootSessionId: options.rootSessionId,
					status: "already_deleted",
					stats: inspectCollaborationStorage(options),
				};
			}
			return {
				rootSessionId: options.rootSessionId,
				status: "already_deleted",
				stats: { ...stats, state: "deleted" },
			};
		}
		if (options.automatic) return { rootSessionId: options.rootSessionId, status: "protected", stats };
		if (options.dryRun !== false) return { rootSessionId: options.rootSessionId, status: "planned", stats };
		finishDeletion(options, marker);
		return { rootSessionId: options.rootSessionId, status: "deleted", stats: { ...stats, state: "deleted" } };
	}
	if (stats.state === "missing") return { rootSessionId: options.rootSessionId, status: "missing", stats };
	if (!stats.deletable || (options.automatic && (!stats.gcEligible || !cold(stats, options))))
		return { rootSessionId: options.rootSessionId, status: "protected", stats };
	if (options.dryRun !== false) return { rootSessionId: options.rootSessionId, status: "planned", stats };
	const db = new DatabaseSync(join(paths.directory, "registry.sqlite"));
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			// Acquisition and deletion serialize on this transaction. Recheck both owner and policy.
			const current = metadata(db, options, scanBudget(options));
			if (current.owner === "live") throw new CollaborationError("busy", "Team acquired by a live controller");
			if (
				options.automatic &&
				(current.pending || current.unfinished || current.interrupted || current.unknownHistory)
			)
				throw new CollaborationError("busy", "Team is no longer eligible for GC");
			const checked = scan(options);
			if (
				!checked.stats.deletable ||
				(options.automatic && (!checked.stats.gcEligible || !cold(checked.stats, options)))
			)
				throw new CollaborationError("forbidden", "Team storage changed before deletion");
			const columns = db
				.prepare("PRAGMA table_info(team)")
				.all()
				.map((column) => column.name);
			if (!columns.includes("deletion_pending")) db.exec("ALTER TABLE team ADD COLUMN deletion_pending TEXT");
			db.prepare("UPDATE team SET deletion_pending=? WHERE id=1").run(options.rootSessionId);
			marker = {
				kind: "pi-team-deletion",
				version: 1,
				rootSessionId: options.rootSessionId,
				directory: paths.directory,
				state: "deleting",
				entries: checked.entries,
			};
			persistMarker(paths.marker, marker);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	} finally {
		db.close();
	}
	finishDeletion(options, marker!);
	return { rootSessionId: options.rootSessionId, status: "deleted", stats: { ...stats, state: "deleted" } };
}

function cold(stats: CollaborationStorageStats, options: CollaborationStoragePolicy): boolean {
	const now = options.now ?? Date.now();
	const age = options.maxAgeMs || 86_400_000;
	if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(age) || age < 0)
		throw new CollaborationError("invalid_arguments", "Invalid cold-team policy");
	return stats.lastModified !== null && now - stats.lastModified >= age;
}

/** Disabled/read-only by default. Capacity never overrides ownership, mailbox, work or coldness protection. */
export function sweepCollaborationStorage(
	options: Omit<CollaborationStorageOptions, "rootSessionId"> &
		CollaborationStoragePolicy & { enabled?: boolean; dryRun?: boolean; maxTeams?: number },
) {
	const now = options.now ?? Date.now();
	for (const value of [now, options.maxAgeMs ?? 0, options.maxTotalBytes ?? 0])
		if (!Number.isSafeInteger(value) || value < 0)
			throw new CollaborationError("invalid_arguments", "Invalid storage retention policy");
	const inventory = listCollaborationStorage(options);
	let remaining = inventory.bytes;
	const candidates: string[] = [];
	for (const team of [...inventory.teams].sort((a, b) => (a.lastModified ?? now) - (b.lastModified ?? now))) {
		// With only a capacity setting, at least 24h idle is required; a configured age is the cold boundary.
		const isCold = cold(team, options);
		const aged = Boolean(options.maxAgeMs && isCold);
		const overBudget = !inventory.incomplete && Boolean(options.maxTotalBytes && remaining > options.maxTotalBytes);
		if (team.gcEligible && isCold && (aged || overBudget)) {
			candidates.push(team.rootSessionId);
			remaining -= team.bytes;
		}
	}
	const results =
		options.enabled === true && options.dryRun === false
			? candidates.map((rootSessionId) =>
					deleteCollaborationStorage({ ...options, rootSessionId, automatic: true, dryRun: false }),
				)
			: [];
	return { inventory, candidates, results, dryRun: options.enabled !== true || options.dryRun !== false };
}

/** A bounded/incomplete measurement is not evidence of free capacity. Only new admission calls this. */
export function checkCollaborationStorageAdmission(
	options: CollaborationStorageOptions & { maxTeamBytes?: number; maxTotalBytes?: number },
): void {
	for (const value of [options.maxTeamBytes ?? 0, options.maxTotalBytes ?? 0])
		if (!Number.isSafeInteger(value) || value < 0)
			throw new CollaborationError("invalid_arguments", "Invalid storage budget");
	if (options.maxTeamBytes) {
		const team = inspectCollaborationStorage(options);
		if (team.incomplete) throw new CollaborationError("storage_error", "Team storage cannot be measured safely");
		if (team.bytes >= options.maxTeamBytes)
			throw new CollaborationAdmissionError("limit_reached", "Team storage budget is full", "storage_budget_full");
	}
	if (options.maxTotalBytes) {
		const inventory = listCollaborationStorage(options);
		if (inventory.incomplete)
			throw new CollaborationError("storage_error", "Team inventory cannot be measured safely");
		if (inventory.bytes >= options.maxTotalBytes)
			throw new CollaborationAdmissionError(
				"limit_reached",
				"Total team storage budget is full",
				"storage_budget_full",
			);
	}
}
