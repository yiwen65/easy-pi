import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	linkSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../../src/harness/session/jsonl/repo.ts";

describe("JSONL durable writer ownership", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-jsonl-durable-"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	function repository(env = new NodeExecutionEnv({ cwd: root })): JsonlSessionRepo {
		return new JsonlSessionRepo({ fs: env, sessionsRoot: root });
	}

	it("rejects a second owner across repository instances until release", async () => {
		const first = await repository().create({ id: "session", cwd: root });
		const metadata = await first.getMetadata();
		await expect(repository().open(metadata)).rejects.toMatchObject({ code: "storage" });
		await first.release();
		const second = await repository().open(metadata);
		await second.appendCustomEntry("accepted");
		await expect(first.appendCustomEntry("closed")).rejects.toMatchObject({ code: "storage" });
		await second.release();
	});

	it("inspects an active writer's name without acquiring ownership or repairing its tail", async () => {
		const session = await repository().create({ id: "inspection", cwd: root });
		await session.setName("Active session");
		const metadata = await session.getMetadata();
		const ownerBefore = readFileSync(`${metadata.path}.writer.lock`, "utf8");
		appendFileSync(metadata.path, '{"kind":"fact"');
		const prefix = readFileSync(metadata.path, "utf8");
		expect(await repository().inspect(metadata)).toEqual({ name: "Active session" });
		expect(readFileSync(metadata.path, "utf8")).toBe(prefix);
		expect(readFileSync(`${metadata.path}.writer.lock`, "utf8")).toBe(ownerBefore);
		await session.release();
	});

	it("permits read-only inspection with no durability capability but validates the session identity", async () => {
		const session = await repository().create({ id: "inspection-no-capability", cwd: root });
		await session.setName("Readable");
		const metadata = await session.getMetadata();
		const env = new NodeExecutionEnv({ cwd: root });
		Object.defineProperty(env, "durableFiles", { value: undefined });
		expect(await repository(env).inspect(metadata)).toEqual({ name: "Readable" });
		await expect(repository(env).inspect({ ...metadata, id: "different" })).rejects.toMatchObject({
			code: "invalid_entry",
		});
		await session.release();
	});

	it("rejects interior corruption during inspection without changing the file", async () => {
		const session = await repository().create({ id: "inspection-corrupt", cwd: root });
		await session.setName("Validated prefix");
		const metadata = await session.getMetadata();
		appendFileSync(
			metadata.path,
			`not-json\n${JSON.stringify({ kind: "fact", fact: "name", seq: 2, name: "untrusted" })}\n`,
		);
		const damaged = readFileSync(metadata.path, "utf8");
		await expect(repository().inspect(metadata)).rejects.toMatchObject({ code: "invalid_entry" });
		expect(readFileSync(metadata.path, "utf8")).toBe(damaged);
		await session.release();
	});

	it("refuses persistent storage without an explicit durability capability", async () => {
		const env = new NodeExecutionEnv({ cwd: root });
		Object.defineProperty(env, "durableFiles", { value: undefined });
		await expect(repository(env).create({ id: "unsupported", cwd: root })).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining("require durable"),
		});
	});

	it("uses one writer claim for aliases addressing the same session file", async () => {
		const first = await repository().create({ id: "aliases", cwd: root });
		const metadata = await first.getMetadata();
		const alias = join(root, "alias.jsonl");
		symlinkSync(metadata.path, alias);
		await expect(repository().open({ ...metadata, path: alias })).rejects.toMatchObject({ code: "storage" });
		await first.release();
		const second = await repository().open({ ...metadata, path: alias });
		await second.appendCustomEntry("shared-file");
		await second.release();
		expect(readFileSync(alias, "utf8")).toBe(readFileSync(metadata.path, "utf8"));
		expect(readFileSync(metadata.path, "utf8")).toContain("shared-file");
	});

	it("rejects multiple hard links before claiming or mutating a persistent session", async () => {
		const session = await repository().create({ id: "hardlinks", cwd: root });
		const metadata = await session.getMetadata();
		const prefix = readFileSync(metadata.path, "utf8");
		const alias = join(root, "hardlink.jsonl");
		linkSync(metadata.path, alias);
		await expect(session.appendCustomEntry("must-not-write")).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining("multiple hard links"),
		});
		expect(await session.getLog()).toEqual([]);
		expect(readFileSync(metadata.path, "utf8")).toBe(prefix);
		await session.release();
		await expect(repository().open(metadata)).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining("multiple hard links"),
		});
		await expect(repository().open({ ...metadata, path: alias })).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining("multiple hard links"),
		});
	});

	it.each(["append", "replace"] as const)(
		"rejects a hard link created after claiming before %s",
		async (operation) => {
			const env = new NodeExecutionEnv({ cwd: root });
			const file = join(root, "claimed-file");
			const claim = await env.durableFiles.claim(file);
			if (!claim.ok) throw claim.error;
			expect((await claim.value.replace("accepted", { exclusive: true })).ok).toBe(true);
			linkSync(file, join(root, "hardlink-file"));
			await expect(claim.value[operation]("must-not-write")).resolves.toMatchObject({
				ok: false,
				error: { code: "not_supported" },
			});
			expect(readFileSync(file, "utf8")).toBe("accepted");
			expect((await claim.value.release()).ok).toBe(true);
		},
	);

	it("does not acknowledge or advance state before file sync completes", async () => {
		const env = new NodeExecutionEnv({ cwd: root });
		const session = await repository(env).create({ id: "sync", cwd: root });
		const metadata = await session.getMetadata();
		const handle = await open(metadata.path, "r");
		const prototype = Object.getPrototypeOf(handle) as FileHandle;
		const originalSync = prototype.sync;
		await handle.close();
		let allowSync: () => void = () => undefined;
		let syncEntered: () => void = () => undefined;
		const blocked = new Promise<void>((resolve) => {
			allowSync = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			syncEntered = resolve;
		});
		vi.spyOn(prototype, "sync").mockImplementationOnce(async function (this: FileHandle) {
			syncEntered();
			await blocked;
			await originalSync.call(this);
		});
		const commit = session.appendCustomEntry("checkpoint");
		await entered;
		expect(await session.getLog()).toEqual([]);
		const cleanup = env.cleanup();
		await expect(repository().open(metadata)).rejects.toMatchObject({ code: "storage" });
		allowSync();
		await commit;
		await cleanup;
		expect(await session.getLog()).toHaveLength(1);
		await session.release();
		const reopened = await repository().open(metadata);
		await reopened.release();
	});

	it("serializes creates of one logical session across independent repositories", async () => {
		const results = await Promise.allSettled([
			repository().create({ id: "same", cwd: root }),
			repository().create({ id: "same", cwd: root }),
		]);
		const successes = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
		expect(
			successes,
			results.map((result) => (result.status === "rejected" ? String(result.reason) : "created")).join("\n"),
		).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(await repository().list()).toHaveLength(1);
		await successes[0]!.release();
	});

	it("fails closed after a sync failure and releases ownership for recovery", async () => {
		const session = await repository().create({ id: "sync-failure", cwd: root });
		const metadata = await session.getMetadata();
		const handle = await open(metadata.path, "r");
		const prototype = Object.getPrototypeOf(handle) as FileHandle;
		await handle.close();
		vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("injected sync failure"));
		await expect(session.appendCustomEntry("unknown-commit")).rejects.toMatchObject({ code: "storage" });
		expect(await session.getLog()).toEqual([]);
		await expect(session.appendCustomEntry("must-not-continue")).rejects.toMatchObject({ code: "storage" });
		await session.release();
		const restored = await repository().open(metadata);
		expect((await restored.findEntries()).map((entry) => entry.type === "custom" && entry.customType)).toEqual([
			"unknown-commit",
		]);
		await restored.release();
	});

	it("reclaims a dead process owner and retains the accepted durable prefix", async () => {
		const script = join(root, "writer.mts");
		const envSource = new URL("../../../src/harness/env/nodejs.ts", import.meta.url).href;
		const repoSource = new URL("../../../src/harness/session/jsonl/repo.ts", import.meta.url).href;
		writeFileSync(
			script,
			[
				`import { NodeExecutionEnv } from ${JSON.stringify(envSource)};`,
				`import { JsonlSessionRepo } from ${JSON.stringify(repoSource)};`,
				`const env = new NodeExecutionEnv({ cwd: ${JSON.stringify(root)} });`,
				`const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: ${JSON.stringify(root)} });`,
				`const session = await repo.create({ id: "killed", cwd: ${JSON.stringify(root)} });`,
				'await session.appendCustomEntry("accepted-before-crash");',
				'process.kill(process.pid, "SIGKILL");',
			].join("\n"),
		);
		const child = spawnSync(process.execPath, [script], { encoding: "utf8" });
		expect(child.stderr).toBe("");
		expect(child.signal).toBe("SIGKILL");
		const repo = repository();
		const [metadata] = await repo.list();
		expect(metadata).toBeDefined();
		expect(existsSync(`${metadata!.path}.writer.lock`)).toBe(true);
		const restored = await repo.open(metadata!);
		expect(await restored.findEntries()).toHaveLength(1);
		await restored.appendCustomEntry("after-recovery");
		await restored.release();
		expect(readFileSync(metadata!.path, "utf8").trimEnd().split("\n")).toHaveLength(3);
		expect(readdirSync(join(metadata!.path, "..")).filter((name) => name.endsWith(".claim"))).toEqual([]);
	});
});
