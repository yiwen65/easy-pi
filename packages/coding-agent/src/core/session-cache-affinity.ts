import { existsSync } from "node:fs";
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

export interface SessionCacheAffinityHint {
	version: 1;
	/** Stable provider cache identity shared by one fork/clone lineage. */
	affinityId: string;
}

function isValidAffinityId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 8192;
}

/** Read the recorded hint of one session file; malformed or unknown-version records are ignored. */
export function readSessionCacheAffinityHint(sessionFile: string): SessionCacheAffinityHint | undefined {
	let entries: ReturnType<typeof loadEntriesFromFile>;
	try {
		entries = loadEntriesFromFile(sessionFile);
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SESSION_CACHE_AFFINITY_ENTRY) continue;
		const data = entry.data as { version?: unknown; affinityId?: unknown } | undefined;
		if (data?.version !== 1 || !isValidAffinityId(data.affinityId)) continue;
		return { version: 1, affinityId: data.affinityId };
	}
	return undefined;
}

function parentSessionFile(sessionFile: string): string | undefined {
	try {
		const header = loadEntriesFromFile(sessionFile).find((entry) => entry.type === "session");
		return header && header.type === "session" ? header.parentSession : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Cache lineage recorded by a fork lineage: this file's own record, else the nearest recorded
 * ancestor for branches saved before the record existed. No file is read twice and nothing is written.
 */
export function recordedCacheAffinityId(
	manager: Pick<SessionManager, "getSessionId" | "getSessionFile">,
): string | undefined {
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) return undefined;
	const recorded = readSessionCacheAffinityHint(sessionFile);
	if (recorded) return recorded.affinityId;
	let current: string | undefined = sessionFile;
	for (let hop = 0; hop < MAX_LINEAGE_WALK; hop++) {
		const parent = parentSessionFile(current);
		if (!parent) return undefined;
		const inherited = readSessionCacheAffinityHint(parent);
		if (inherited) return inherited.affinityId;
		current = parent;
	}
	return undefined;
}

/**
 * Resolve the cache lineage a new branch of this session must join.
 *
 * An already-recorded lineage wins, so repeated `/fork` keeps one lineage instead of decaying per
 * hop; a session that records nothing (memory-only, or a root that never forked) becomes the root
 * of its own lineage. No session file, history or metadata is written here.
 */
export function resolveSessionCacheAffinityId(
	manager: Pick<SessionManager, "getSessionId" | "getSessionFile">,
): string {
	return recordedCacheAffinityId(manager) ?? manager.getSessionId();
}

/**
 * Record the lineage on the branched session file so a later `/resume` or `/fork` keeps it.
 * The id is a cache-routing label, never a session, request or transport identity, and the call is
 * idempotent per branch.
 *
 * A branch whose file is not materialized yet stays unwritten: cloning an unsaved session keeps
 * failing on its existing preconditions instead of creating a file as a side effect, and that new
 * session simply keeps its own id as its cache identity.
 */
export function appendSessionCacheAffinity(manager: SessionManager, affinityId: string): boolean {
	const sessionFile = manager.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) return false;
	if (
		manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === SESSION_CACHE_AFFINITY_ENTRY)
	)
		return false;
	manager.appendCustomEntry(SESSION_CACHE_AFFINITY_ENTRY, {
		version: 1,
		affinityId,
	} satisfies SessionCacheAffinityHint);
	return true;
}
