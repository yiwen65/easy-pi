import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool, ok } from "@earendil-works/pi-agent-core";
import { BackgroundTaskManager, type BackgroundTaskManagerOptions } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { createBashTool } from "../../../src/core/tools/bash.ts";
import type { StatusIndicator } from "../../../src/modes/interactive/components/status-indicator.ts";
import { TurnTranscriptContainer } from "../../../src/modes/interactive/components/turn-transcript-container.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { GrokComponentFactory } from "../../../src/modes/interactive-grok/grok-component-factory.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

interface TimingHost {
	chatContainer: TurnTranscriptContainer;
	statusContainer: Container;
	activeStatusIndicator?: StatusIndicator;
	grokTurnStartedAt?: number;
	handleEvent(event: AgentSessionEvent): Promise<void>;
}

function createTimingHost(harness: Harness): TimingHost {
	return Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		chatContainer: new TurnTranscriptContainer(),
		statusContainer: new Container(),
		grokComponentFactory: new GrokComponentFactory(),
		workingVisible: true,
		defaultWorkingMessage: "Working...",
		workingIndicatorOptions: { frames: [] },
		outputPad: 1,
		options: { tuiMode: "fullscreen" },
		pendingTools: new Map(),
		isInitialized: true,
		shutdownRequested: false,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
	}) as TimingHost;
}

function durations(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "pi-turn-duration");
}

function forwardLifecycle(harness: Harness, host: TimingHost) {
	const endedDurationCounts: number[] = [];
	const pending: Promise<void>[] = [];
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type !== "agent_start" && event.type !== "agent_end" && event.type !== "agent_settled") return;
		pending.push(host.handleEvent(event));
		if (event.type === "agent_end") endedDurationCounts.push(durations(harness).length);
	});
	return { endedDurationCounts, pending, unsubscribe };
}

describe("session b824062c: Bash certainty and user-task timing", () => {
	const harnesses: Harness[] = [];
	const hosts: TimingHost[] = [];
	const managers: BackgroundTaskManager[] = [];
	const directories: string[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(async () => {
		for (const host of hosts.splice(0)) host.activeStatusIndicator?.dispose();
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
		for (const manager of managers.splice(0)) await manager.shutdown();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("keeps a missing background cwd as a failed result in one timed task, without recovery", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-b824-start-"));
		directories.push(directory);
		const missing = join(directory, "node22");
		const shell = vi.fn<BackgroundTaskManagerOptions["shell"]>(async () => ok({ shell: "/bin/bash", args: ["-c"] }));
		const manager = new BackgroundTaskManager({ shell, stallTimeoutMs: 0 });
		managers.push(manager);
		const harness = await createHarness({
			tools: [createBashTool(directory, { backgroundTasks: manager, exposeSessionEnvironment: false })],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		const host = createTimingHost(harness);
		hosts.push(host);
		const lifecycle = forwardLifecycle(harness, host);
		let elapsed = 0;
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: `mkdir '${missing}'`, cwd: missing, run_in_background: true }),
				{ stopReason: "toolUse" },
			),
			() => {
				elapsed = 1000;
				return fauxAssistantMessage("The command did not start; continue safely.");
			},
		]);
		await harness.session.prompt("prepare toolchain");
		await Promise.all(lifecycle.pending);
		lifecycle.unsubscribe();
		expect(shell).not.toHaveBeenCalled();
		expect(manager.list({ activeOnly: false })).toEqual([]);
		expect(existsSync(missing)).toBe(false);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.suspendedTaskRecovery).toEqual([]);
		expect(harness.session.taskRecovery?.status).toBe("completed");
		expect(lifecycle.endedDurationCounts).toEqual([0]);
		expect(durations(harness)).toHaveLength(1);
		expect(durations(harness)[0]).toMatchObject({ data: { durationMs: 1000 } });
		expect(host.activeStatusIndicator).toBeUndefined();
		expect(stripAnsi(host.chatContainer.render(100).join("\n"))).toContain("worked 1.0s");
	});

	it("preserves genuinely unknown effects but times their internal recovery as one user task", async () => {
		let elapsed = 0;
		const effect: AgentTool = {
			name: "effect",
			label: "Effect",
			description: "An offline effect whose dispatch result is uncertain",
			parameters: Type.Object({}),
			execute: async () => {
				elapsed = 1_162_000;
				throw new Error("ECONNRESET after dispatch");
			},
		};
		const harness = await createHarness({
			tools: [effect],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		const host = createTimingHost(harness);
		hosts.push(host);
		const owner = host.chatContainer.currentTurn;
		const lifecycle = forwardLifecycle(harness, host);
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		vi.spyOn(Date, "now").mockImplementation(() => 1_700_000_000_000 + elapsed);
		let liveTranscript = "";
		let liveStatus = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }),
			() => {
				elapsed += 812_000;
				host.activeStatusIndicator?.setMessage("Working...");
				liveTranscript = stripAnsi(host.chatContainer.render(100).join("\n"));
				liveStatus = stripAnsi(host.statusContainer.render(100).join("\n"));
				return fauxAssistantMessage("Inspect the unknown effect before retrying it.");
			},
		]);
		await harness.session.prompt("original task");
		await Promise.all(lifecycle.pending);
		lifecycle.unsubscribe();
		expect(getUserTexts(harness)).toEqual(["original task"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.suspendedTaskRecovery).toHaveLength(1);
		expect(harness.session.suspendedTaskRecovery[0].state.status).toBe("needs_reconciliation");
		expect(lifecycle.endedDurationCounts).toEqual([0, 0]);
		expect(liveTranscript).not.toContain("worked");
		expect(liveStatus).toContain("Working... 32m 54s");
		expect(durations(harness)).toHaveLength(1);
		expect(durations(harness)[0]).toMatchObject({ data: { durationMs: 1_974_000 } });
		expect(host.chatContainer.currentTurn).toBe(owner);
		expect(stripAnsi(host.chatContainer.render(100).join("\n"))).toContain("worked 32m 54s");
		expect(host.activeStatusIndicator).toBeUndefined();
	});

	it("settles the original task before a settlement hook starts another live run", async () => {
		let elapsed = 0;
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let woke = false;
		const hold: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Keep the second offline run alive until released",
			parameters: Type.Object({}),
			execute: async () => {
				elapsed = 20_000;
				markStarted();
				await gate;
				elapsed = 25_000;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [hold],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						if (woke) return;
						woke = true;
						elapsed = 15_000;
						pi.sendMessage(
							{ customType: "reentrant-task", content: "start a second task", display: false },
							{ triggerTurn: true },
						);
						await started;
					});
				},
			],
		});
		harnesses.push(harness);
		const host = createTimingHost(harness);
		hosts.push(host);
		const lifecycle = forwardLifecycle(harness, host);
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		vi.spyOn(Date, "now").mockImplementation(() => 1_700_000_000_000 + elapsed);
		harness.setResponses([
			() => {
				elapsed = 10_000;
				return fauxAssistantMessage("first task completed");
			},
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("second task completed"),
		]);
		try {
			await harness.session.prompt("first task");
			await started;
			await Promise.all(lifecycle.pending);
			expect(harness.session.isStreaming).toBe(true);
			expect(harness.session.isIdle).toBe(false);
			expect(host.activeStatusIndicator?.kind).toBe("working");
			expect(host.grokTurnStartedAt).toBe(15_000);
			expect(durations(harness)).toHaveLength(1);
			expect(durations(harness)[0]).toMatchObject({ data: { durationMs: 10_000 } });
			host.activeStatusIndicator?.setMessage("Working...");
			expect(stripAnsi(host.statusContainer.render(100).join("\n"))).toContain("Working... 5s");
		} finally {
			release();
			await harness.session.waitForIdle();
			await Promise.all(lifecycle.pending);
			lifecycle.unsubscribe();
		}
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
		expect(durations(harness)).toHaveLength(2);
		expect(durations(harness)[1]).toMatchObject({ data: { durationMs: 10_000 } });
		expect(host.activeStatusIndicator).toBeUndefined();
	});

	it("still invokes settlement extensions and releases idle waiting when a subscriber throws", async () => {
		const extensionSettled = vi.fn();
		const harness = await createHarness({
			hfCompaction: { mode: "off" },
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", extensionSettled);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed")]);
		let idleWait: Promise<void> | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "agent_start") idleWait = harness.session.waitForIdle();
			if (event.type === "agent_settled") throw new Error("settlement subscriber failed");
		});
		try {
			await expect(harness.session.prompt("task")).rejects.toThrow("settlement subscriber failed");
			expect(extensionSettled).toHaveBeenCalledOnce();
			expect(harness.session.isIdle).toBe(true);
			expect(idleWait).toBeDefined();
			await expect(idleWait).resolves.toBeUndefined();
		} finally {
			unsubscribe();
		}
	});
});
