import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentSession, SessionShutdownReport } from "../src/core/agent-session.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const sessions: AgentSession[] = [];
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.allSettled(sessions.splice(0).map((session) => session.shutdown()));
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function fixture(extension?: ExtensionFactory): Promise<AgentSession> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-owned-shutdown-"));
	directories.push(cwd);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({ provider: "owned-shutdown-test", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const extensionsResult = await createTestExtensionsResult(extension ? [extension] : [], cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime,
		model: faux.getModel(),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		tools: ["read"],
	});
	sessions.push(session);
	return session;
}

test("parent shutdown awaits owned cleanup before shutdown hooks and concurrent callers complete", async () => {
	const started = deferred();
	const release = deferred();
	let cleaned = false;
	const hookObservations: boolean[] = [];
	const hook = vi.fn(() => {
		hookObservations.push(cleaned);
	});
	const session = await fixture((pi) => pi.on("session_shutdown", hook));
	const cleanup = vi.fn(async () => {
		started.resolve();
		await release.promise;
		cleaned = true;
	});
	session.registerShutdownResource("side-conversation", cleanup);
	let settled = false;
	const first = session.shutdown().then((report) => {
		settled = true;
		return report;
	});
	const second = session.shutdown();
	await started.promise;
	expect(settled).toBe(false);
	expect(hook).not.toHaveBeenCalled();
	release.resolve();
	const report = await first;
	expect(report).toEqual({ complete: true, failedResources: [], timedOutResources: [], remainingResources: [] });
	expect(await second).toBe(report);
	expect(cleanup).toHaveBeenCalledTimes(1);
	expect(hook).toHaveBeenCalledTimes(1);
	expect(hookObservations).toEqual([true]);
});

test("owned cleanup failures aggregate stable labels without stopping other resource or parent cleanup", async () => {
	const hook = vi.fn();
	const session = await fixture((pi) => pi.on("session_shutdown", hook));
	const background = vi.spyOn(session.backgroundTasks!, "shutdown");
	const context = session.extensionRunner.createContext();
	const secretError = "synthetic-secret-must-not-appear";
	const failing = vi.fn(async () => {
		throw new Error(secretError);
	});
	const successful = vi.fn(async () => {});
	session.registerShutdownResource("side-conversation", failing);
	session.registerShutdownResource("other-child", () => {
		throw new Error(secretError);
	});
	session.registerShutdownResource("healthy-child", successful);
	const report = await session.shutdown();
	expect(report).toEqual({
		complete: false,
		failedResources: ["side-conversation", "other-child"],
		timedOutResources: [],
		remainingResources: [],
	});
	expect(JSON.stringify(report)).not.toContain(secretError);
	expect(successful).toHaveBeenCalledTimes(1);
	expect(background).toHaveBeenCalledTimes(1);
	expect(hook).toHaveBeenCalledTimes(1);
	expect(() => context.isIdle()).toThrow(/stale after session replacement or reload/);
	expect(await session.shutdown()).toBe(report);
	expect(failing).toHaveBeenCalledTimes(1);
	expect(background).toHaveBeenCalledTimes(1);
});

test("resource disposers are idempotent and do not remove another registration sharing a label", async () => {
	const session = await fixture();
	const released = vi.fn(async () => {});
	const retained = vi.fn(async () => {});
	const unregister = session.registerShutdownResource("side-conversation", released);
	session.registerShutdownResource("side-conversation", retained);
	unregister();
	unregister();
	expect((await session.shutdown()).complete).toBe(true);
	unregister();
	await session.shutdown();
	expect(released).not.toHaveBeenCalled();
	expect(retained).toHaveBeenCalledTimes(1);
});

test("registration is rejected synchronously as soon as shutdown begins and after it settles", async () => {
	const session = await fixture();
	const late = vi.fn(async () => {});
	session.registerShutdownResource("existing", async () => {
		expect(() => session.registerShutdownResource("from-cleanup", late)).toThrow(/shutdown has started/);
	});
	const shutdown = session.shutdown();
	expect(() => session.registerShutdownResource("too-late", late)).toThrow(/shutdown has started/);
	expect((await shutdown).complete).toBe(true);
	expect(() => session.registerShutdownResource("after-drain", late)).toThrow(/shutdown has started/);
	expect(late).not.toHaveBeenCalled();
});

test.each([false, true])(
	"shutdown hook reentry does not await its own drain (external emission: %s)",
	async (external) => {
		let session!: AgentSession;
		let nested: SessionShutdownReport | undefined;
		session = await fixture((pi) => {
			pi.on("session_shutdown", async () => {
				nested = await session.shutdown();
			});
		});
		const cleanup = vi.fn(async () => {});
		session.registerShutdownResource("side-conversation", cleanup);
		if (external) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const report = await session.shutdown();
		expect(nested).toEqual({
			complete: false,
			failedResources: [],
			timedOutResources: [],
			remainingResources: ["extensions"],
		});
		expect(report.complete).toBe(true);
		expect(cleanup).toHaveBeenCalledTimes(1);
	},
);

test("owned failures preserve the background manager's incomplete shutdown report", async () => {
	const session = await fixture();
	vi.spyOn(session.backgroundTasks!, "shutdown").mockResolvedValue({
		complete: false,
		completed: [],
		failed: ["background-failed"],
		timedOut: ["background-timed-out"],
		remaining: ["background-remaining"],
	});
	session.registerShutdownResource("side-conversation", async () => {
		throw new Error("cleanup rejected");
	});
	expect(await session.shutdown()).toEqual({
		complete: false,
		failedResources: ["background-failed", "side-conversation"],
		timedOutResources: ["background-timed-out"],
		remainingResources: ["background-remaining"],
	});
});

test("an abort rejection still rejects shutdown after owned and parent cleanup", async () => {
	const session = await fixture();
	const error = new Error("abort failed");
	vi.spyOn(session, "abort").mockRejectedValue(error);
	const background = vi.spyOn(session.backgroundTasks!, "shutdown");
	const cleanup = vi.fn(async () => {});
	session.registerShutdownResource("side-conversation", cleanup);
	await expect(session.shutdown()).rejects.toBe(error);
	expect(cleanup).toHaveBeenCalledTimes(1);
	expect(background).toHaveBeenCalledTimes(1);
});
