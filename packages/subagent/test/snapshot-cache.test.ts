import { describe, expect, it, vi } from "vitest";
import { SnapshotLeaseCache } from "../src/snapshot-cache.ts";
import type { SnapshotHandle } from "../src/types.ts";

function snapshot(path: string, cleanup: () => Promise<void>): SnapshotHandle {
	return {
		baseline: {
			repositoryRoot: `/repositories/${path}`,
			headCommit: path,
			snapshotId: `snapshot-${path}`,
			fileCount: 1,
			totalBytes: 10,
		},
		path: `/snapshots/${path}`,
		cleanup,
	};
}

describe("SnapshotLeaseCache", () => {
	it("materializes one snapshot for concurrent leases of the same repository and commit", async () => {
		const cache = new SnapshotLeaseCache();
		const underlyingCleanup = vi.fn(async () => undefined);
		let resolveMaterialization!: (handle: SnapshotHandle) => void;
		const materialization = new Promise<SnapshotHandle>((resolve) => {
			resolveMaterialization = resolve;
		});
		const materialize = vi.fn(() => materialization);
		const key = { repositoryRoot: "/repositories/one", baseCommit: "abc123" };

		const firstPromise = cache.acquire(key, materialize);
		const secondPromise = cache.acquire(key, materialize);
		await Promise.resolve();
		expect(materialize).toHaveBeenCalledTimes(1);
		resolveMaterialization(snapshot("shared", underlyingCleanup));
		const [first, second] = await Promise.all([firstPromise, secondPromise]);

		expect(first.path).toBe(second.path);
		expect(first.baseline).toEqual(second.baseline);
		expect(first.baseline).not.toBe(second.baseline);
		await first.cleanup();
		await first.cleanup();
		expect(underlyingCleanup).not.toHaveBeenCalled();
		await Promise.all([second.cleanup(), second.cleanup()]);
		expect(underlyingCleanup).toHaveBeenCalledTimes(1);
	});

	it("removes a failed materialization so a later acquire can retry", async () => {
		const cache = new SnapshotLeaseCache();
		const failure = new Error("materialization failed");
		const underlyingCleanup = vi.fn(async () => undefined);
		const materialize = vi
			.fn<() => Promise<SnapshotHandle>>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(snapshot("retry", underlyingCleanup));
		const key = { repositoryRoot: "/repositories/one", baseCommit: "abc123" };

		const results = await Promise.allSettled([cache.acquire(key, materialize), cache.acquire(key, materialize)]);
		expect(results).toEqual([
			{ status: "rejected", reason: failure },
			{ status: "rejected", reason: failure },
		]);
		expect(materialize).toHaveBeenCalledTimes(1);

		const lease = await cache.acquire(key, materialize);
		expect(materialize).toHaveBeenCalledTimes(2);
		await lease.cleanup();
		expect(underlyingCleanup).toHaveBeenCalledTimes(1);
	});

	it("keeps repositories and commits as separate cache identities", async () => {
		const cache = new SnapshotLeaseCache();
		const cleanups = [vi.fn(async () => undefined), vi.fn(async () => undefined), vi.fn(async () => undefined)];
		const materializers = cleanups.map((cleanup, index) => vi.fn(async () => snapshot(`separate-${index}`, cleanup)));

		const leases = await Promise.all([
			cache.acquire({ repositoryRoot: "/repositories/one", baseCommit: "same" }, materializers[0]!),
			cache.acquire({ repositoryRoot: "/repositories/two", baseCommit: "same" }, materializers[1]!),
			cache.acquire({ repositoryRoot: "/repositories/one", baseCommit: "different" }, materializers[2]!),
		]);

		expect(materializers.map((materialize) => materialize.mock.calls.length)).toEqual([1, 1, 1]);
		expect(new Set(leases.map((lease) => lease.path)).size).toBe(3);
		await Promise.all(leases.map((lease) => lease.cleanup()));
		expect(cleanups.map((cleanup) => cleanup.mock.calls.length)).toEqual([1, 1, 1]);
	});
});
