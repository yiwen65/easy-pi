import type { SnapshotHandle } from "./types.ts";

export interface SnapshotCacheKey {
	repositoryRoot: string;
	baseCommit: string;
}

interface SnapshotCacheEntry {
	materialization: Promise<SnapshotHandle>;
	leaseCount: number;
}

export class SnapshotLeaseCache {
	private readonly entries = new Map<string, SnapshotCacheEntry>();

	async acquire(key: SnapshotCacheKey, materialize: () => Promise<SnapshotHandle>): Promise<SnapshotHandle> {
		const identity = JSON.stringify([key.repositoryRoot, key.baseCommit]);
		let entry = this.entries.get(identity);
		if (!entry) {
			entry = {
				materialization: Promise.resolve().then(materialize),
				leaseCount: 0,
			};
			this.entries.set(identity, entry);
			const created = entry;
			void created.materialization.catch(() => {
				if (this.entries.get(identity) === created) this.entries.delete(identity);
			});
		}

		entry.leaseCount++;
		let snapshot: SnapshotHandle;
		try {
			snapshot = await entry.materialization;
		} catch (error) {
			entry.leaseCount--;
			throw error;
		}

		const acquiredEntry = entry;
		let cleanupPromise: Promise<void> | undefined;
		return {
			baseline: structuredClone(snapshot.baseline),
			path: snapshot.path,
			cleanup: () => {
				cleanupPromise ??= this.release(identity, acquiredEntry, snapshot);
				return cleanupPromise;
			},
		};
	}

	private async release(identity: string, entry: SnapshotCacheEntry, snapshot: SnapshotHandle): Promise<void> {
		entry.leaseCount--;
		if (entry.leaseCount > 0) return;
		if (this.entries.get(identity) === entry) this.entries.delete(identity);
		await snapshot.cleanup();
	}
}
