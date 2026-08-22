/**
 * CCTX-031: Recall catalog and exact recall.
 *
 * Everything moved out of the active context gets a catalog entry with a
 * stable ID, preview, content hash, and provenance (event ids). recallExact()
 * resolves the ID, enforces the tenant boundary, and re-verifies the content
 * hash — any mismatch fails closed. Keyword search only returns stable refs,
 * never raw content.
 */

import type { ArtifactStore } from "./artifact-store.ts";
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

export interface RecallMetrics {
	recallAttempts: number;
	recallHits: number;
	recallFailures: number;
}

let recallCounter = 0;

export class RecallCatalog {
	private store: ArtifactStore;
	private tenant: string;
	private entriesByRef = new Map<string, RecallEntry>();
	private attempts = 0;
	private hits = 0;
	private failures = 0;

	constructor(options: { store: ArtifactStore; tenant: string }) {
		this.store = options.store;
		this.tenant = options.tenant;
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
				return entry;
			}
		}
		recallCounter += 1;
		const entry: RecallEntry = {
			refId: `rc-${recallCounter.toString(36)}-${meta.hash.slice(0, 12)}`,
			kind: input.kind,
			createdAt: new Date().toISOString(),
			preview: input.preview.slice(0, 200),
			artifactRef: meta.ref,
			eventIds: input.eventIds,
			hash: meta.hash,
			tenant: input.tenant,
		};
		this.entriesByRef.set(entry.refId, entry);
		this.store.pin(meta.ref);
		return entry;
	}

	/** Catalog an already-offloaded artifact (no re-put; content is content-addressed). */
	addFromOffload(
		record: { eventId: string; artifactRef: string; preview: string; hash: string },
		kind: RecallEntry["kind"],
	): RecallEntry {
		for (const entry of this.entriesByRef.values()) {
			if (entry.hash === record.hash && entry.tenant === this.tenant) {
				return entry;
			}
		}
		recallCounter += 1;
		const entry: RecallEntry = {
			refId: `rc-${recallCounter.toString(36)}-${record.hash.slice(0, 12)}`,
			kind,
			createdAt: new Date().toISOString(),
			preview: record.preview.slice(0, 200),
			artifactRef: record.artifactRef,
			eventIds: [record.eventId],
			hash: record.hash,
			tenant: this.tenant,
		};
		this.entriesByRef.set(entry.refId, entry);
		this.store.pin(record.artifactRef);
		return entry;
	}

	/**
	 * Exact recall by stable ID. Throws on unknown ID, tenant mismatch, or
	 * hash mismatch — never returns unverified content.
	 */
	recallExact(refId: string): { entry: RecallEntry; data: Uint8Array } {
		this.attempts += 1;
		try {
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
			this.hits += 1;
			return { entry, data: got.data };
		} catch (error) {
			this.failures += 1;
			throw error;
		}
	}

	/** Keyword search over previews; returns stable refs only. */
	search(query: string): RecallEntry[] {
		const needle = query.toLowerCase();
		return [...this.entriesByRef.values()].filter(
			(entry) => entry.tenant === this.tenant && entry.preview.toLowerCase().includes(needle),
		);
	}

	entries(): RecallEntry[] {
		return [...this.entriesByRef.values()];
	}

	metrics(): RecallMetrics {
		return { recallAttempts: this.attempts, recallHits: this.hits, recallFailures: this.failures };
	}
}
