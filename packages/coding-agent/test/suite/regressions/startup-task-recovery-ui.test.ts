import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { PromptTemplate } from "../../../src/core/prompt-templates.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { TaskRecoveryJournal } from "../../../src/core/task-recovery.ts";
import { createInteractiveTui, InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { stopThemeWatcher } from "../../../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness } from "../harness.ts";

// Cold init must never download managed tools or touch a real terminal/provider.
vi.mock("../../../src/utils/tools-manager.ts", () => ({
	ensureTool: vi.fn(async (name: string) => `/offline/${name}`),
}));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => {
	stopThemeWatcher();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("cold interactive startup task recovery", () => {
	it.each(["legacy", "grok"] as const)(
		"hydrates history and receives live recovery output before init finishes (%s)",
		async (tuiEngine) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-startup-recovery-ui-"));
			vi.stubEnv(ENV_AGENT_DIR, dir);
			const manager = SessionManager.create(dir, join(dir, "sessions"));
			manager.appendMessage({ role: "user", content: "prior-user-body", timestamp: 1 });
			manager.appendMessage(fauxAssistantMessage("prior-assistant-body"));
			manager.appendCustomMessageEntry("late-message", "unrendered-custom-body", true);
			manager.appendCustomEntry("late-entry", {});
			const journal = new TaskRecoveryJournal(manager);
			const prompt = { role: "user" as const, content: "resume-original-task", timestamp: 2 };
			journal.start([prompt]);
			manager.appendMessage(prompt, journal.state!.promptEntryIds[0]);

			const started = deferred();
			const release = deferred();
			const probe: AgentTool = {
				name: "startup_probe",
				label: "Startup probe",
				description: "Offline recovery fixture",
				parameters: Type.Object({}),
				execute: async (_id, _args, _signal, onUpdate) => {
					onUpdate?.({ content: [{ type: "text", text: "live-tool-body" }], details: {} });
					started.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "completed-tool-body" }], details: {} };
				},
			};
			const extensionsResult = await createTestExtensionsResult([
				(pi) => {
					pi.on("session_start", () => {
						pi.registerMessageRenderer("late-message", () => new Text("late-message-renderer", 0, 0));
						pi.registerEntryRenderer("late-entry", () => new Text("late-entry-renderer", 0, 0));
					});
					pi.on("resources_discover", () => ({ promptPaths: [join(dir, "discovered.md")] }));
				},
			]);
			const resourceLoader = createTestResourceLoader({ extensionsResult });
			const prompts: PromptTemplate[] = [];
			resourceLoader.getPrompts = () => ({ prompts, diagnostics: [] });
			resourceLoader.extendResources = vi.fn((paths) => {
				expect(paths.promptPaths?.[0]?.path).toBe(join(dir, "discovered.md"));
				prompts.push({
					name: "discovered-startup-prompt",
					description: "discovered before recovery",
					content: "offline",
					filePath: join(dir, "discovered.md"),
					sourceInfo: createSyntheticSourceInfo(join(dir, "discovered.md"), { source: "extension:fixture" }),
				});
			});
			const harness = await createHarness({
				sessionManager: SessionManager.open(manager.getSessionFile()!),
				tools: [probe],
				resourceLoader,
				hfCompaction: { mode: "off" },
				settings: { theme: "dark", quietStartup: false, retry: { enabled: false } },
			});
			harness.setResponses([
				fauxAssistantMessage(
					[
						{ type: "text", text: "live-assistant-body" },
						{ type: "toolCall", id: "probe-1", name: probe.name, arguments: {} },
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("recovered-done"),
			]);
			const subscribe = vi.spyOn(harness.session, "subscribe");
			const runtimeHost = {
				session: harness.session,
				setBeforeSessionInvalidate: vi.fn(),
				setRebindSession: vi.fn(),
			} as unknown as AgentSessionRuntime;
			const mode = new InteractiveMode(runtimeHost, { tuiEngine, tuiMode: "regular" });
			const terminal = new VirtualTerminal(160, 80);
			const renderer = createInteractiveTui({
				tuiEngine,
				tuiMode: "regular",
				showHardwareCursor: false,
				logDirectory: dir,
				terminal,
			});
			Reflect.set(mode, "renderer", renderer);
			Reflect.set(mode, "toolOutputExpanded", true);
			const hydration = vi.spyOn(mode, "renderInitialMessages");
			let initialized = false;
			const initialization = mode.init().then(() => {
				initialized = true;
			});
			try {
				await started.promise;
				await terminal.waitForRender();
				expect(initialized).toBe(false);
				expect(harness.session.isStreaming).toBe(true);
				expect(resourceLoader.extendResources).toHaveBeenCalledOnce();
				const duringRecovery = terminal.getScrollBuffer().join("\n");
				for (const body of [
					"prior-user-body",
					"prior-assistant-body",
					"resume-original-task",
					"late-message-renderer",
					"late-entry-renderer",
					"discovered-startup-prompt",
					"live-assistant-body",
					"live-tool-body",
				]) {
					expect(duringRecovery).toContain(body);
				}
				expect(duringRecovery).not.toContain("unrendered-custom-body");
				expect(duringRecovery).not.toContain("Unable to render");
				expect(hydration).toHaveBeenCalledOnce();
				expect(subscribe).toHaveBeenCalledOnce();
				release.resolve();
				await initialization;
				await terminal.waitForRender();
				expect(harness.session.taskRecovery?.status).toBe("completed");
				expect(hydration).toHaveBeenCalledOnce();
				expect(subscribe).toHaveBeenCalledOnce();
				const completed = terminal.getScrollBuffer().join("\n");
				expect(completed).toContain("recovered-done");
				expect(completed.match(/prior-user-body/g)).toHaveLength(1);
				expect(completed.match(/live-assistant-body/g)).toHaveLength(1);
			} finally {
				release.resolve();
				await initialization;
				mode.stop();
				await harness.session.shutdown();
				harness.cleanup();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
