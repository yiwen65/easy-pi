import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getOrThrow, ok } from "@earendil-works/pi-agent-core";
import { BackgroundTaskManager } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import {
	inspectToolOutputStorage,
	sweepToolOutputStorage,
	TOOL_OUTPUT_MARKER,
	ToolOutputStorage,
} from "../src/core/tool-output-storage.ts";
import { discoverToolOutputStorage } from "../src/core/tool-output-storage-discovery.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { OUTPUT_LOG_TRUNCATION_MARKER, OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

let root: string;
const storages: ToolOutputStorage[] = [];
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-managed-output-test-")));
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const storage of storages.splice(0)) storage.close();
	rmSync(root, { recursive: true, force: true });
});
function storageAt(parent = root, sessionId = randomUUID()) {
	mkdirSync(parent, { recursive: true });
	const storage = new ToolOutputStorage({ sessionId, sessionFile: join(parent, `${sessionId}.jsonl`) });
	storages.push(storage);
	return storage;
}
function writeLog(storage: ToolOutputStorage, text: string, mtimeMs = Date.now()) {
	const file = storage.createLogFile();
	writeFileSync(file.fd, text);
	closeSync(file.fd);
	file.release();
	utimesSync(file.path, mtimeMs / 1000, mtimeMs / 1000);
	return file.path;
}

describe("managed tool output storage", () => {
	it("places child logs beside their own session and retains them after close", () => {
		const childRoot = join(root, "teams", randomUUID(), randomUUID());
		const storage = storageAt(childRoot);
		const file = writeLog(storage, "retained");
		expect(dirname(storage.directory)).toBe(childRoot);
		expect(JSON.parse(readFileSync(join(storage.directory, TOOL_OUTPUT_MARKER), "utf8"))).toEqual({
			kind: "pi-tool-output",
			version: 1,
			sessionId: storage.directory.split("/").at(-1)!.slice(0, -5),
			directory: storage.directory,
		});
		expect(inspectToolOutputStorage(storage.directory).protectedReason).toContain("Active");
		storage.close();
		expect(inspectToolOutputStorage(storage.directory).protectedReason).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe("retained");
	});

	it("keeps memory sessions on explicitly managed independent disk directories", () => {
		const first = new ToolOutputStorage({ sessionId: "memory", tempRoot: root });
		const second = new ToolOutputStorage({ sessionId: "memory", tempRoot: root });
		storages.push(first, second);
		expect(first.directory).not.toBe(second.directory);
		expect(readFileSync(writeLog(first, "on disk"), "utf8")).toBe("on disk");
	});

	it("protects active writer leases after the session lease is released", () => {
		const storage = storageAt();
		const file = storage.createLogFile();
		writeFileSync(file.fd, "still writing");
		storage.close();
		expect(
			sweepToolOutputStorage([storage.directory], { maxAgeMs: 1, now: Date.now() + 10_000, dryRun: false }).deleted,
		).toEqual([]);
		closeSync(file.fd);
		file.release();
		expect(inspectToolOutputStorage(storage.directory).protectedReason).toBeUndefined();
		expect(
			sweepToolOutputStorage([storage.directory], { maxAgeMs: 1, now: Date.now() + 10_000, dryRun: false }).deleted,
		).toEqual([file.path]);
	});

	it("rechecks a newly admitted lease under the sweep lock before unlinking", () => {
		const storage = storageAt();
		const log = writeLog(storage, "keep", 1000);
		storage.close();
		writeFileSync(
			join(storage.directory, `lease-${randomUUID()}.json`),
			JSON.stringify({ kind: "writer", pid: 999999, startedAt: new Date().toISOString() }),
		);
		let admitted = false;
		const kill = process.kill.bind(process);
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid !== 999999) return kill(pid, signal);
			if (!admitted) {
				admitted = true;
				writeFileSync(
					join(storage.directory, `lease-${randomUUID()}.json`),
					JSON.stringify({ kind: "writer", pid: process.pid, startedAt: new Date().toISOString() }),
				);
			}
			throw Object.assign(new Error("dead"), { code: "ESRCH" });
		});
		const swept = sweepToolOutputStorage([storage.directory], { maxAgeMs: 1, now: 10_000, dryRun: false });
		expect(swept.candidates).toEqual([log]);
		expect(swept.deleted).toEqual([]);
		expect(swept.errors[0]).toContain("Active tool log session or writer lease");
		expect(readFileSync(log, "utf8")).toBe("keep");
	});

	it("defaults to no deletion, supports TTL, and leaves expired references as explicit ENOENT", () => {
		const storage = storageAt();
		const old = writeLog(storage, "old", 1000);
		const recent = writeLog(storage, "recent", 9000);
		storage.close();
		expect(sweepToolOutputStorage([storage.directory]).candidates).toEqual([]);
		const dry = sweepToolOutputStorage([storage.directory], { maxAgeMs: 5000, now: 10_000 });
		expect(dry.candidates).toEqual([old]);
		expect(dry.deleted).toEqual([]);
		expect(existsSync(old)).toBe(true);
		const swept = sweepToolOutputStorage([storage.directory], { maxAgeMs: 5000, now: 10_000, dryRun: false });
		expect(swept.deleted).toEqual([old]);
		expect(() => readFileSync(old)).toThrow(/ENOENT/);
		expect(readFileSync(recent, "utf8")).toBe("recent");
	});

	it("removes oldest cold logs to meet the discovered total budget, counting protected bytes", () => {
		const first = storageAt();
		const oldest = writeLog(first, "a".repeat(100), 1000);
		const newer = writeLog(first, "b".repeat(100), 2000);
		first.close();
		const active = storageAt();
		const protectedLog = writeLog(active, "c".repeat(100), 500);
		const total = [first, active].reduce(
			(sum, storage) => sum + inspectToolOutputStorage(storage.directory).bytes,
			0,
		);
		const swept = sweepToolOutputStorage([first.directory, active.directory], {
			maxTotalBytes: total - 100,
			dryRun: false,
		});
		expect(swept.deleted).toEqual([oldest]);
		expect(existsSync(newer)).toBe(true);
		expect(existsSync(protectedLog)).toBe(true);
	});

	it("conservatively protects PID reuse and unknown lease errors, but allows confirmed dead leases", () => {
		const storage = storageAt();
		const log = writeLog(storage, "old", 1000);
		storage.close();
		const lease = join(storage.directory, `lease-${randomUUID()}.json`);
		writeFileSync(lease, JSON.stringify({ kind: "writer", pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" }));
		expect(inspectToolOutputStorage(storage.directory).protectedReason).toContain("Active");
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("denied"), { code: "EPERM" });
		});
		expect(inspectToolOutputStorage(storage.directory).protectedReason).toContain("Active");
		kill.mockImplementation(() => {
			throw Object.assign(new Error("dead"), { code: "ESRCH" });
		});
		expect(sweepToolOutputStorage([storage.directory], { maxAgeMs: 1, now: 10_000, dryRun: false }).deleted).toEqual([
			log,
		]);
	});

	it.each(["symlink", "unknown", "hardlink", "marker-extra", "lease-extra", "busy"])(
		"refuses %s entries and does not delete unknown OS logs",
		(kind) => {
			const storage = storageAt();
			const file = writeLog(storage, "keep", 1000);
			const target = join(root, "pi-bash-unowned.log");
			writeFileSync(target, "never touch");
			storage.close();
			if (kind === "symlink") symlinkSync(target, join(storage.directory, `bash-${randomUUID()}.log`));
			if (kind === "unknown") writeFileSync(join(storage.directory, "artifact.txt"), "unknown");
			if (kind === "hardlink") linkSync(target, join(storage.directory, `bash-${randomUUID()}.log`));
			if (kind === "marker-extra") {
				const marker = join(storage.directory, TOOL_OUTPUT_MARKER);
				writeFileSync(marker, JSON.stringify({ ...JSON.parse(readFileSync(marker, "utf8")), extra: true }));
			}
			if (kind === "lease-extra")
				writeFileSync(
					join(storage.directory, `lease-${randomUUID()}.json`),
					JSON.stringify({ kind: "writer", pid: 999999, startedAt: new Date().toISOString(), extra: true }),
				);
			if (kind === "busy") mkdirSync(join(storage.directory, ".maintenance-lock"));
			const result = sweepToolOutputStorage([storage.directory], {
				maxAgeMs: 1,
				maxTotalBytes: 1,
				now: 10_000,
				dryRun: false,
			});
			expect(result.inspections[0].protectedReason).toBeTruthy();
			expect(result.deleted).toEqual([]);
			expect(result.errors).toContain(
				"Total log budget not applied: one or more directories could not be fully inspected",
			);
			expect(readFileSync(file, "utf8")).toBe("keep");
			expect(readFileSync(target, "utf8")).toBe("never touch");
		},
	);

	it("revalidates marker identity before admitting each writer", () => {
		const storage = storageAt();
		const marker = join(storage.directory, TOOL_OUTPUT_MARKER);
		const identity = JSON.parse(readFileSync(marker, "utf8"));
		writeFileSync(marker, JSON.stringify({ ...identity, sessionId: "different-session" }));
		expect(() => storage.createLogFile()).toThrow("identity mismatch");
		expect(readdirSync(storage.directory).filter((name) => name.startsWith("bash-"))).toEqual([]);
	});

	it("refuses directory symlinks, unknown ownership and malformed policies", () => {
		const storage = storageAt();
		storage.close();
		const linked = join(root, "linked");
		symlinkSync(storage.directory, linked);
		expect(inspectToolOutputStorage(linked).protectedReason).toContain("Unsafe");
		expect(() => new ToolOutputStorage({ sessionId: "bad/id", tempRoot: root })).toThrow("identity");
		const unknown = join(root, "unowned.logs");
		mkdirSync(unknown);
		expect(() => new ToolOutputStorage({ sessionId: "unowned", sessionFile: join(root, "unowned.jsonl") })).toThrow();
		for (const options of [{ now: Number.NaN }, { maxAgeMs: 0.5 }, { maxTotalBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
			expect(() => sweepToolOutputStorage([], options)).toThrow("retention policy");
		}
	});

	it("reports unknown named logs as incomplete and discovers legal dotted team identities", () => {
		const valid = storageAt(join(root, "teams", "root.with-dot", randomUUID()));
		valid.close();
		const missingMarker = join(root, "sessions", "--old--", "unowned.logs");
		mkdirSync(missingMarker, { recursive: true });
		const result = discoverToolOutputStorage({ agentDir: root, maxDurationMs: 1000 });
		expect(result.directories).toContain(valid.directory);
		expect(result.directories).not.toContain(missingMarker);
		expect(result.incomplete).toBe(true);
	});

	it("discovers only bounded known layouts, not symlink or artifact directories", () => {
		const ordinary = storageAt(join(root, "sessions", "--project--"));
		const child = storageAt(join(root, "teams", randomUUID(), randomUUID()));
		const custom = storageAt(join(root, "custom"));
		const unrelated = storageAt(join(root, "artifact", "nested"));
		for (const storage of [ordinary, child, custom, unrelated]) storage.close();
		symlinkSync(dirname(unrelated.directory), join(root, "sessions", "linked"));
		const result = discoverToolOutputStorage({
			agentDir: root,
			sessionFile: join(dirname(custom.directory), "custom.jsonl"),
			maxDurationMs: 1000,
		});
		expect(result.directories.sort()).toEqual([ordinary.directory, child.directory, custom.directory].sort());
		expect(result.incomplete).toBe(false);
		expect(discoverToolOutputStorage({ agentDir: root, maxEntries: 1 }).incomplete).toBe(true);
	});
});

describe("bounded foreground and background writers", () => {
	it("writes only its byte allowance plus one marker, while snapshots retain newest UTF-8 output", async () => {
		const storage = storageAt();
		const output = new OutputAccumulator({
			maxBytes: 16,
			maxLines: 4,
			maxPersistedBytes: 32,
			createLogFile: () => storage.createLogFile(),
		});
		output.append(Buffer.from("a".repeat(24)));
		output.append(Buffer.from("b".repeat(24)));
		output.append(Buffer.from("\n最新TAIL\n"));
		output.finish();
		await output.closeTempFile();
		const snapshot = output.snapshot();
		expect(snapshot.content).toContain("最新TAIL");
		expect(snapshot.logTruncated).toBe(true);
		const persisted = readFileSync(snapshot.fullOutputPath!);
		expect(persisted.length).toBe(32 + Buffer.byteLength(OUTPUT_LOG_TRUNCATION_MARKER));
		expect(persisted.toString()).toBe("a".repeat(24) + "b".repeat(8) + OUTPUT_LOG_TRUNCATION_MARKER);
		expect(readdirSync(storage.directory).filter((name) => name.startsWith("lease-"))).toHaveLength(1);
	});

	it("announces incomplete logs for successful and failed tool results and user_bash", async () => {
		const storage = storageAt();
		for (const exitCode of [0, 2]) {
			const tool = createBashTool(root, {
				maxPersistedBytes: 32,
				createLogFile: () => storage.createLogFile(),
				operations: {
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from("x".repeat(60_000)));
						onData(Buffer.from("\nLATEST\n"));
						return { exitCode };
					},
				},
			});
			if (exitCode === 0) {
				const result = await tool.execute("budget", { command: "synthetic output" });
				expect(result.details).toMatchObject({ logTruncated: true });
				expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Full output log truncated") });
				expect(result.content[0]).toMatchObject({ text: expect.stringContaining("LATEST") });
			} else {
				await expect(tool.execute("budget-fail", { command: "synthetic failure" })).rejects.toMatchObject({
					details: { logTruncated: true },
					message: expect.stringContaining("Full output log truncated"),
				});
			}
		}
		const result = await executeBashWithOperations(
			"synthetic",
			root,
			{
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from(`\x1b[31m${"x".repeat(60_000)}\x1b[0m\nUSER-TAIL\n`));
					return { exitCode: 0 };
				},
			},
			{ createLogFile: () => storage.createLogFile(), maxPersistedBytes: 32 },
		);
		expect(result.logTruncated).toBe(true);
		expect(result.output).toContain("USER-TAIL");
		expect(result.output).not.toContain("\x1b");
		expect(statSync(result.fullOutputPath!).size).toBe(32 + Buffer.byteLength(OUTPUT_LOG_TRUNCATION_MARKER));
	});

	it("keeps a background writer leased through shutdown even after storage.close", async () => {
		const storage = storageAt();
		const manager = new BackgroundTaskManager({
			shell: async () => ok({ shell: process.execPath, args: ["-e"] }),
			createLogFile: () => storage.createLogFile(),
			stallTimeoutMs: 0,
			maxLogBytes: 32,
		});
		try {
			const task = getOrThrow(
				await manager.start("process.stdout.write('x'.repeat(10000));process.stdout.write('TAIL');", { cwd: root }),
			);
			expect(dirname(task.outputPath)).toBe(storage.directory);
			storage.close();
			expect(inspectToolOutputStorage(storage.directory).protectedReason).toContain("Active");
			getOrThrow(await manager.wait(task.id, 10_000));
			await manager.shutdown();
			expect(inspectToolOutputStorage(storage.directory).protectedReason).toBeUndefined();
			expect(manager.get(task.id)?.logTruncated).toBe(true);
			expect(getOrThrow(manager.readOutput(task.id)).output).toContain("TAIL");
			expect(readFileSync(task.outputPath, "utf8")).toContain("byte budget");
		} finally {
			await manager.shutdown();
		}
	});

	it("refuses a failed background managed-log admission before spawning", async () => {
		const manager = new BackgroundTaskManager({
			shell: async () => ok({ shell: process.execPath, args: ["-e"] }),
			createLogFile: () => {
				throw new Error("busy storage");
			},
			stallTimeoutMs: 0,
		});
		const result = await manager.start("throw new Error('should not run')", { cwd: root });
		expect(result).toMatchObject({
			ok: false,
			error: { executionOutcome: "not_started", message: expect.stringContaining("busy storage") },
		});
		expect(manager.list({ activeOnly: false })).toEqual([]);
		await manager.shutdown();
	});
});
