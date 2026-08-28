import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeReadProviderV2 } from "../src/core/tools/node-read-provider-v2.ts";

function tempSnapshots(): Set<string> {
	return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("pi-read-v2-")));
}

describe("NodeReadProviderV2", () => {
	let cwd: string;
	let provider: NodeReadProviderV2;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-v2-read-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		provider = new NodeReadProviderV2(new NodeExecutionEnv({ cwd }));
	});

	afterEach(async () => {
		await provider.close();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("streams small directories into stable pages and stats only returned entries", async () => {
		for (const name of ["c.txt", "a.txt", "b.txt"]) writeFileSync(join(cwd, name), name);
		const first = await provider.readDirectory({ path: cwd, offset: 1, limit: 2 });
		expect(first.entries).toMatchObject([
			{ name: "a.txt", kind: "file", size: 5 },
			{ name: "b.txt", kind: "file", size: 5 },
		]);
		expect(first.nextCursor).toBeDefined();
		writeFileSync(join(cwd, "aa-new.txt"), "new");
		const second = await provider.readDirectory({
			path: cwd,
			offset: 1,
			limit: 2,
			cursor: first.nextCursor,
			expectedGeneration: first.generation,
		});
		expect(second.entries).toMatchObject([{ name: "c.txt", kind: "file" }]);
	});

	it("uses opt-in disk-backed Unix sorting with quotas and cleanup", async () => {
		await provider.close();
		provider = new NodeReadProviderV2(new NodeExecutionEnv({ cwd }), {
			smallDirectoryLimit: 2,
			externalSort: { enabled: true, maxEntries: 20, maxBytes: 10_000 },
		});
		for (const name of ["z.txt", "a.txt", "line\nbreak.txt", "héllo.txt", "m.txt"]) {
			writeFileSync(join(cwd, name), name);
		}
		const before = tempSnapshots();
		const first = await provider.readDirectory({ path: cwd, offset: 1, limit: 2 });
		expect(first.nextCursor).toBeDefined();
		expect(tempSnapshots().size).toBeGreaterThan(before.size);
		const second = await provider.readDirectory({
			path: cwd,
			offset: 1,
			limit: 10,
			cursor: first.nextCursor,
			expectedGeneration: first.generation,
		});
		const names = [...first.entries, ...second.entries].map((entry) => entry.name);
		expect(names).toEqual(["z.txt", "a.txt", "line\nbreak.txt", "héllo.txt", "m.txt"].sort());
		expect(tempSnapshots().size).toBeGreaterThan(before.size);
		const retried = await provider.readDirectory({
			path: cwd,
			offset: 1,
			limit: 10,
			cursor: first.nextCursor,
			expectedGeneration: first.generation,
		});
		expect(retried.entries).toEqual(second.entries);
		await provider.close();
		expect([...tempSnapshots()].filter((name) => !before.has(name))).toEqual([]);
	});

	it("removes a single-page external snapshot immediately", async () => {
		await provider.close();
		provider = new NodeReadProviderV2(new NodeExecutionEnv({ cwd }), {
			smallDirectoryLimit: 1,
			externalSort: { enabled: true, maxEntries: 20, maxBytes: 10_000 },
		});
		for (const name of ["b", "a"]) writeFileSync(join(cwd, name), name);
		const before = tempSnapshots();
		const page = await provider.readDirectory({ path: cwd, offset: 1, limit: 10 });
		expect(page.nextCursor).toBeUndefined();
		expect(page.entries.map((entry) => entry.name)).toEqual(["a", "b"]);
		expect(tempSnapshots()).toEqual(before);
	});

	it("fails before unbounded spooling when an external-sort quota is exceeded", async () => {
		await provider.close();
		provider = new NodeReadProviderV2(new NodeExecutionEnv({ cwd }), {
			smallDirectoryLimit: 1,
			externalSort: { enabled: true, maxEntries: 2, maxBytes: 10_000 },
		});
		for (const name of ["a", "b", "c"]) writeFileSync(join(cwd, name), name);
		const before = tempSnapshots();
		await expect(provider.readDirectory({ path: cwd, offset: 1, limit: 2 })).rejects.toMatchObject({
			code: "directory_too_large",
		});
		expect(tempSnapshots()).toEqual(before);
	});
});
