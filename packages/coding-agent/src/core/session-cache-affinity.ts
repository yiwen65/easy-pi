import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { loadEntriesFromFile, type SessionManager } from "./session-manager.ts";

/**
 * Session-file entry that records which provider cache lineage a session belongs to.
 *
 * `/clone` and `/fork` duplicate the parent's message prefix but create a new session id.
 * Providers route or partition prompt caches by that id, so without an explicit lineage the
 * first request of the new session cannot reuse the parent's cached prefix. The entry stores
 * the stable lineage id only; authentication, native identity and history stay with each session.
 */
export const SESSION_CACHE_AFFINITY_ENTRY = "epi-session-cache-affinity";

/** A fork never chains deeper than this when searching for an unrecorded ancestor lineage. */
const MAX_LINEAGE_WALK = 64;
/** A header is the first JSONL record; anything longer is not a header we should parse. */
const MAX_HEADER_BYTES = 1024 * 1024;

export interface SessionCacheAffinityModel {
	provider: string;
	id: string;
}

export interface SessionCacheAffinityHint {
	version: 1;
	/** Stable provider cache identity shared by one fork/clone lineage. */
	affinityId: string;
	/** Model the cached prefix belongs to. A record without it applies to any model. */
	boundModel?: SessionCacheAffinityModel;
}

function isValidAffinityId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 8192;
}

function readBoundModel(value: unknown): SessionCacheAffinityModel | undefined | false {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const provider = record.provider;
	const id = record.id;
	if (typeof provider !== "string" || provider.length === 0 || typeof id !== "string" || id.length === 0) return false;
	return { provider, id };
}

/** Parse one recorded hint; malformed or unknown-version records are ignored. */
function parseHint(entry: { data?: unknown }): SessionCacheAffinityHint | undefined {
	const data = entry.data as { version?: unknown; affinityId?: unknown; boundModel?: unknown } | undefined;
	if (data?.version !== 1 || !isValidAffinityId(data.affinityId)) return undefined;
	const boundModel = readBoundModel(data.boundModel);
	if (boundModel === false) return undefined;
	return { version: 1, affinityId: data.affinityId, ...(boundModel ? { boundModel } : {}) };
}

function forModel(hint: SessionCacheAffinityHint, model?: SessionCacheAffinityModel): boolean {
	if (!model || !hint.boundModel) return true;
	return hint.boundModel.provider === model.provider && hint.boundModel.id === model.id;
}

/**
 * Read the recorded hint of one session file. A hint bound to a different model is skipped, so a
 * session that switched models falls back to its own identity instead of another model's partition.
 */
export function readSessionCacheAffinityHint(
	sessionFile: string,
	model?: SessionCacheAffinityModel,
): SessionCacheAffinityHint | undefined {
	let entries: ReturnType<typeof loadEntriesFromFile>;
	try {
		entries = loadEntriesFromFile(sessionFile);
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SESSION_CACHE_AFFINITY_ENTRY) continue;
		const hint = parseHint(entry);
		if (hint && forModel(hint, model)) return hint;
	}
	return undefined;
}

/**
 * Header of one session file, reading only its first record so a long ancestor history stays off
 * the fork/resume path. Unknown or unreadable files yield no header.
 */
function readSessionHeader(sessionFile: string): { parentSession?: string } | undefined {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(sessionFile, "r");
		const size = fstatSync(descriptor).size;
		if (size === 0) return undefined;
		const buffer = Buffer.allocUnsafe(Math.min(size, MAX_HEADER_BYTES));
		const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
		const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
		const entry = JSON.parse(firstLine) as { type?: unknown; parentSession?: unknown };
		if (entry.type !== "session" || typeof entry.parentSession !== "string" || entry.parentSession.length === 0)
			return undefined;
		return { parentSession: entry.parentSession };
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/** One ancestor in the chain: its recorded lineage for this model and the link to its parent. */
function lookupSession(sessionFile: string, model?: SessionCacheAffinityModel) {
	return {
		affinityId: readSessionCacheAffinityHint(sessionFile, model)?.affinityId,
		parent: readSessionHeader(sessionFile)?.parentSession,
	};
}

/**
 * Cache lineage recorded by a fork lineage: this file's own record for the given model, else the
 * nearest recorded ancestor for branches saved before the record existed. Each file is read once
 * per hop and nothing is written.
 */
export function recordedCacheAffinityId(
	manager: Pick<SessionManager, "getSessionId" | "getSessionFile">,
	model?: SessionCacheAffinityModel,
): string | undefined {
	let current = manager.getSessionFile();
	for (let hop = 0; hop < MAX_LINEAGE_WALK && current; hop++) {
		const { affinityId, parent } = lookupSession(current, model);
		if (affinityId) return affinityId;
		current = parent;
	}
	return undefined;
}

/**
 * Resolve the cache lineage a new branch of this session must join.
 *
 * An already-recorded lineage for the same model wins, so repeated `/fork` keeps one lineage instead
 * of decaying per hop; a session that records nothing (memory-only, a root that never forked, or a
 * lineage bound to another model) becomes the root of its own lineage. Nothing is written here.
 */
export function resolveSessionCacheAffinityId(
	manager: Pick<SessionManager, "getSessionId" | "getSessionFile">,
	model?: SessionCacheAffinityModel,
): string {
	return recordedCacheAffinityId(manager, model) ?? manager.getSessionId();
}

/**
 * Record the lineage on the branched session file so a later `/resume` or `/fork` keeps it.
 * The id is a cache-routing label, never a session, request or transport identity, and the call is
 * idempotent per branch.
 *
 * Returns false when there is nothing to write: a branch whose file is gone is not recreated
 * (its conversation precondition is owned by the runtime), and an already-recorded branch is left
 * untouched. That branch then keeps its own id as its cache identity.
 */
export function appendSessionCacheAffinity(
	manager: SessionManager,
	affinityId: string,
	boundModel?: SessionCacheAffinityModel,
): boolean {
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) return false;
	if (
		manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_CACHE_AFFINITY_ENTRY)
	)
		return false;
	try {
		if (statSync(sessionFile).size === 0) return false;
	} catch {
		return false;
	}
	manager.appendCustomEntry(SESSION_CACHE_AFFINITY_ENTRY, {
		version: 1,
		affinityId,
		...(boundModel ? { boundModel } : {}),
	} satisfies SessionCacheAffinityHint);
	return true;
}
