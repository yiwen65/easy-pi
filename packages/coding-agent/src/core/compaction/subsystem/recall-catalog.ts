/**
 * CCTX-031: Recall catalog and exact recall.
 *
 * Everything moved out of the active context gets a catalog entry with a
 * stable ID, preview, content hash, and provenance (event ids). recallExact()
 * resolves the ID, enforces the tenant boundary, and re-verifies the content
 * hash — any mismatch fails closed. Keyword search only returns stable refs,
 * never raw content.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ArtifactStore, getAgentMessageArtifact } from "./artifact-store.ts";
import { sha256Hex } from "./hashing.ts";
import type { RecallEntry } from "./types.ts";

export interface AddRecallInput {
	kind: RecallEntry["kind"];
	preview: string;
	/** Original content; stored content-addressed so recall is exact. */
	content: string | Uint8Array;
	eventIds: string[];
	tenant: string;
}

export interface AddArtifactRecallInput {
	kind: RecallEntry["kind"];
	preview: string;
	artifactRef: string;
	hash: string;
	eventIds: string[];
}

export interface RecallMetrics {
	recallAttempts: number;
	recallHits: number;
	recallFailures: number;
}

export const RECALL_SEARCH_MAX_RESULTS = 8;
export const RECALL_SEARCH_DEFAULT_RESULTS = 5;
export const RECALL_SEARCH_MAX_QUERY_CHARS = 200;
export const RECALL_SEARCH_MAX_PREVIEW_CHARS = 160;
export const RECALL_SEARCH_MAX_TOTAL_PREVIEW_CHARS = 800;

export interface RecallSearchOptions {
	kind?: RecallEntry["kind"];
	limit?: number;
	/** Production callers pass only refs published by the active branch snapshot. */
	allowedRefIds?: ReadonlySet<string>;
}

export interface RecallSearchHit {
	refId: string;
	kind: RecallEntry["kind"];
	preview: string;
}

/** Persistence for catalog entries, so restart keeps `rc-*` refs resolvable. */
export interface RecallPersister {
	append(entry: RecallEntry): void;
	remove(refId: string): void;
	load(): RecallEntry[];
}

/** JSONL persister: one entry per line, tolerant of a torn final line. */
export class JsonlRecallPersister implements RecallPersister {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	append(entry: RecallEntry): void {
		appendFileSync(this.filePath, `${JSON.stringify({ kind: "entry", entry })}\n`, "utf8");
	}

	remove(refId: string): void {
		appendFileSync(this.filePath, `${JSON.stringify({ kind: "remove", refId })}\n`, "utf8");
	}

	load(): RecallEntry[] {
		if (!existsSync(this.filePath)) return [];
		const entries = new Map<string, RecallEntry>();
		for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as
					| RecallEntry
					| { kind: "entry"; entry: RecallEntry }
					| { kind: "remove"; refId: string };
				if ("kind" in parsed && parsed.kind === "remove") {
					entries.delete(parsed.refId);
				} else {
					const entry = "kind" in parsed && parsed.kind === "entry" ? parsed.entry : parsed;
					entries.set(entry.refId, entry);
				}
			} catch {
				// Torn trailing line after a crash: ignore it; the entry is re-added on retry.
			}
		}
		return [...entries.values()];
	}
}

/** Stable, content-derived ref id: identical content yields the identical ref, across restarts. */
export function recallRefIdForHash(hash: string): string {
	return `rc-${hash.slice(0, 16)}`;
}

export class RecallCatalog {
	private store: ArtifactStore;
	private tenant: string;
	private persister: RecallPersister | undefined;
	private entriesByRef = new Map<string, RecallEntry>();
	private attempts = 0;
	private hits = 0;
	private failures = 0;

	constructor(options: { store: ArtifactStore; tenant: string; persister?: RecallPersister }) {
		this.store = options.store;
		this.tenant = options.tenant;
		this.persister = options.persister;
		if (this.persister) {
			for (const entry of this.persister.load()) {
				if (entry.tenant === this.tenant) {
					// JSONL updates are append-only; the newest record is authoritative.
					this.entriesByRef.set(entry.refId, entry);
				}
			}
		}
	}

	private register(entry: RecallEntry): RecallEntry {
		this.persister?.append(entry);
		this.entriesByRef.set(entry.refId, entry);
		return entry;
	}

	/**
	 * Publish offload catalog entries around one synchronous snapshot CAS.
	 * Entries are invisible to model tools until the snapshot is active; a
	 * failed CAS restores catalog state and pin ownership, including on restart.
	 */
	activateWithOffloads<T>(
		records: readonly {
			eventId: string;
			eventIds?: string[];
			recallKind?: RecallEntry["kind"];
			artifactRef: string;
			preview: string;
			hash: string;
		}[],
		activate: () => T,
	): T {
		const refs = [...new Set(records.map((record) => recallRefIdForHash(record.hash)))];
		const previousEntries = new Map(refs.map((refId) => [refId, this.entriesByRef.get(refId)] as const));
		const previousPins = new Map(
			records.map((record) => [record.artifactRef, this.store.isPinned(record.artifactRef)] as const),
		);
		try {
			for (const record of records) {
				this.addArtifact({
					kind: record.recallKind ?? "tool_result",
					preview: record.preview,
					artifactRef: record.artifactRef,
					hash: record.hash,
					eventIds: record.eventIds ?? [record.eventId],
				});
			}
			return activate();
		} catch (error) {
			for (const refId of refs) {
				const previous = previousEntries.get(refId);
				if (previous) this.register(previous);
				else {
					this.persister?.remove(refId);
					this.entriesByRef.delete(refId);
				}
			}
			for (const [artifactRef, wasPinned] of previousPins) {
				if (wasPinned) this.store.pin(artifactRef);
				else this.store.unpin(artifactRef);
			}
			throw error;
		}
	}

	add(input: AddRecallInput): RecallEntry {
		const meta = this.store.put(input.content, {
			contentType: typeof input.content === "string" ? "text/plain" : "application/octet-stream",
			source: `recall:${input.eventIds[0] ?? "manual"}`,
			tenant: input.tenant,
		});
		// Content-addressed storage dedupes; reuse the existing entry when the
		// same content was already cataloged for this tenant.
		for (const entry of this.entriesByRef.values()) {
			if (entry.hash === meta.hash && entry.tenant === input.tenant) {
				const eventIds = [...new Set([...entry.eventIds, ...input.eventIds])];
				return eventIds.length === entry.eventIds.length ? entry : this.register({ ...entry, eventIds });
			}
		}
		const entry: RecallEntry = {
			refId: recallRefIdForHash(meta.hash),
			kind: input.kind,
			createdAt: new Date().toISOString(),
			preview: input.preview.slice(0, 200),
			artifactRef: meta.ref,
			eventIds: input.eventIds,
			hash: meta.hash,
			tenant: input.tenant,
		};
		if (this.entriesByRef.has(entry.refId)) return this.entriesByRef.get(entry.refId)!;
		const registered = this.register(entry);
		this.store.pin(meta.ref);
		return registered;
	}

	/** Catalog a verified existing artifact without copying its bytes. */
	addArtifact(input: AddArtifactRecallInput): RecallEntry {
		const artifact = this.store.get(input.artifactRef, this.tenant);
		if (!artifact) throw new Error(`Backing artifact missing for ${input.artifactRef}`);
		if (artifact.meta.hash !== input.hash || sha256Hex(artifact.data) !== input.hash) {
			throw new Error(`Recall content hash mismatch for ${input.artifactRef} (fail closed)`);
		}
		for (const entry of this.entriesByRef.values()) {
			if (entry.hash === input.hash && entry.tenant === this.tenant) {
				const eventIds = [...new Set([...entry.eventIds, ...input.eventIds])];
				return eventIds.length === entry.eventIds.length ? entry : this.register({ ...entry, eventIds });
			}
		}
		const entry: RecallEntry = {
			refId: recallRefIdForHash(input.hash),
			kind: input.kind,
			createdAt: new Date().toISOString(),
			preview: input.preview.slice(0, 200),
			artifactRef: input.artifactRef,
			eventIds: [...new Set(input.eventIds)],
			hash: input.hash,
			tenant: this.tenant,
		};
		const existing = this.entriesByRef.get(entry.refId);
		if (existing) {
			throw new Error(`Recall ref collision for ${entry.refId}`);
		}
		const registered = this.register(entry);
		this.store.pin(input.artifactRef);
		return registered;
	}

	/** Catalog an already-offloaded artifact (no re-put; content is content-addressed). */
	addFromOffload(
		record: { eventId: string; artifactRef: string; preview: string; hash: string },
		kind: RecallEntry["kind"],
	): RecallEntry {
		return this.addArtifact({
			kind,
			preview: record.preview,
			artifactRef: record.artifactRef,
			hash: record.hash,
			eventIds: [record.eventId],
		});
	}

	/** Register a cold AgentMessage manifest for search and later exact recall. */
	addFromColdMessage(record: { eventId: string; artifactRef: string; preview: string; hash: string }): RecallEntry {
		return this.addArtifact({
			kind: "message",
			preview: record.preview,
			artifactRef: record.artifactRef,
			hash: record.hash,
			eventIds: [record.eventId],
		});
	}

	private resolveExact(refId: string): { entry: RecallEntry; data: Uint8Array } {
		const entry = this.entriesByRef.get(refId);
		if (!entry) {
			throw new Error(`Unknown recall ref: ${refId}`);
		}
		if (entry.tenant !== this.tenant) {
			throw new Error(`Recall ref ${refId} belongs to a different tenant`);
		}
		if (!entry.artifactRef) {
			throw new Error(`Recall ref ${refId} has no backing artifact`);
		}
		const got = this.store.get(entry.artifactRef, this.tenant);
		if (!got) {
			throw new Error(`Backing artifact missing for ${refId}`);
		}
		if (sha256Hex(got.data) !== entry.hash) {
			throw new Error(`Recall content hash mismatch for ${refId} (fail closed)`);
		}
		return { entry, data: got.data };
	}

	/**
	 * Exact recall by stable ID. Throws on unknown ID, tenant mismatch, or
	 * hash mismatch — never returns unverified content.
	 */
	recallExact(refId: string): { entry: RecallEntry; data: Uint8Array } {
		this.attempts += 1;
		try {
			const recalled = this.resolveExact(refId);
			this.hits += 1;
			return recalled;
		} catch (error) {
			this.failures += 1;
			throw error;
		}
	}

	/** Resolve a cataloged cold message, including all image blocks. */
	recallAgentMessage(refId: string): { entry: RecallEntry; message: AgentMessage } {
		this.attempts += 1;
		try {
			const recalled = this.resolveExact(refId);
			if (!recalled.entry.artifactRef) {
				throw new Error(`Recall ref ${refId} has no backing artifact`);
			}
			const result = {
				entry: recalled.entry,
				message: getAgentMessageArtifact(this.store, recalled.entry.artifactRef, this.tenant),
			};
			this.hits += 1;
			return result;
		} catch (error) {
			this.failures += 1;
			throw error;
		}
	}

	/**
	 * Bounded keyword search over previews. Returns discovery metadata only:
	 * stable refs, kind, and a clipped preview; never raw content or artifact ids.
	 */
	search(query: string, options: RecallSearchOptions = {}): RecallSearchHit[] {
		const needle = query.slice(0, RECALL_SEARCH_MAX_QUERY_CHARS).trim().toLowerCase();
		const requestedLimit = options.limit ?? RECALL_SEARCH_DEFAULT_RESULTS;
		const limit = Math.min(
			RECALL_SEARCH_MAX_RESULTS,
			Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : RECALL_SEARCH_DEFAULT_RESULTS),
		);
		const candidates = [...this.entriesByRef.values()]
			.filter(
				(entry) =>
					entry.tenant === this.tenant &&
					(options.kind === undefined || entry.kind === options.kind) &&
					(options.allowedRefIds === undefined || options.allowedRefIds.has(entry.refId)) &&
					(needle.length === 0 || entry.preview.toLowerCase().includes(needle)),
			)
			.sort((left, right) => {
				const leftIndex = needle.length === 0 ? 0 : left.preview.toLowerCase().indexOf(needle);
				const rightIndex = needle.length === 0 ? 0 : right.preview.toLowerCase().indexOf(needle);
				return (
					leftIndex - rightIndex ||
					right.createdAt.localeCompare(left.createdAt) ||
					left.refId.localeCompare(right.refId)
				);
			});
		const hits: RecallSearchHit[] = [];
		let previewCharsRemaining = RECALL_SEARCH_MAX_TOTAL_PREVIEW_CHARS;
		for (const entry of candidates) {
			if (hits.length >= limit || previewCharsRemaining <= 0) break;
			const normalizedPreview = entry.preview.replace(/\s+/g, " ").trim();
			const preview = normalizedPreview.slice(0, Math.min(RECALL_SEARCH_MAX_PREVIEW_CHARS, previewCharsRemaining));
			hits.push({ refId: entry.refId, kind: entry.kind, preview });
			previewCharsRemaining -= preview.length;
		}
		return hits;
	}

	entries(): RecallEntry[] {
		return [...this.entriesByRef.values()];
	}

	metrics(): RecallMetrics {
		return { recallAttempts: this.attempts, recallHits: this.hits, recallFailures: this.failures };
	}
}
