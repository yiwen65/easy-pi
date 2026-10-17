import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getOrThrow } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { inspectToolOutputStorage } from "../../src/core/tool-output-storage.ts";
import { createHarness, type Harness } from "./harness.ts";

let root: string;
const harnesses: Harness[] = [];
const memoryDirectories: string[] = [];
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-session-tool-logs-")));
});
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.shutdown();
		harness.cleanup();
	}
	for (const directory of memoryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

describe("session-owned built-in bash logs", () => {
	it("routes foreground/user_bash/background logs into the child session root and releases leases on shutdown", async () => {
		const sessionManager = SessionManager.create(root, join(root, "teams", "parent", "child"));
		const harness = await createHarness({ sessionManager, hfCompaction: { mode: "off" } });
		harnesses.push(harness);
		const directory = join(dirname(sessionManager.getSessionFile()!), `${sessionManager.getSessionId()}.logs`);
		const bash = harness.session.agent.state.tools.find((tool) => tool.name === "bash")!;
		const foreground = await bash.execute("foreground", { command: "printf '%60000s' x" });
		const foregroundPath = (foreground.details as { fullOutputPath: string }).fullOutputPath;
		expect(dirname(foregroundPath)).toBe(directory);
		const user = await harness.session.executeBash("synthetic", undefined, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("u".repeat(60_000)));
					return { exitCode: 0 };
				},
			},
		});
		expect(dirname(user.fullOutputPath!)).toBe(directory);
		const background = await bash.execute("background", { command: "printf background", run_in_background: true });
		const backgroundId = (background.details as { backgroundTaskId: string }).backgroundTaskId;
		const manager = harness.session.backgroundTasks!;
		getOrThrow(await manager.wait(backgroundId, 10_000));
		expect(dirname(manager.get(backgroundId)!.outputPath)).toBe(directory);
		expect(inspectToolOutputStorage(directory).protectedReason).toContain("Active");
		await harness.session.shutdown();
		expect(inspectToolOutputStorage(directory).protectedReason).toBeUndefined();
		expect(readFileSync(user.fullOutputPath!, "utf8")).toBe("u".repeat(60_000));
		expect(existsSync(foregroundPath)).toBe(true);
	});

	it("rotates storage identity on SessionManager.newSession before the next writer", async () => {
		const sessionManager = SessionManager.create(root, root);
		const harness = await createHarness({ sessionManager, hfCompaction: { mode: "off" } });
		harnesses.push(harness);
		const emit = () =>
			harness.session.executeBash("synthetic", undefined, {
				operations: {
					exec: async (_command, _cwd, { onData }) => {
						onData(Buffer.from("s".repeat(60_000)));
						return { exitCode: 0 };
					},
				},
			});
		const first = await emit();
		sessionManager.newSession();
		const second = await emit();
		expect(dirname(second.fullOutputPath!)).not.toBe(dirname(first.fullOutputPath!));
		expect(inspectToolOutputStorage(dirname(first.fullOutputPath!)).protectedReason).toBeUndefined();
		expect(inspectToolOutputStorage(dirname(second.fullOutputPath!)).protectedReason).toContain("Active");
	});

	it("uses managed disk storage, not a no-disk claim, for an in-memory session", async () => {
		const harness = await createHarness({ hfCompaction: { mode: "off" } });
		harnesses.push(harness);
		const result = await harness.session.executeBash("synthetic", undefined, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("m".repeat(60_000)));
					return { exitCode: 0 };
				},
			},
		});
		const directory = dirname(result.fullOutputPath!);
		memoryDirectories.push(directory);
		expect(inspectToolOutputStorage(directory)).toMatchObject({
			sessionId: harness.session.sessionId,
			protectedReason: expect.stringContaining("Active"),
		});
		expect(existsSync(result.fullOutputPath!)).toBe(true);
	});
});
