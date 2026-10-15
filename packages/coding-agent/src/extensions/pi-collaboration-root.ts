import { isAbsolute, join } from "node:path";
import { CollaborationError } from "@easy-pi/subagent/collaboration-contract";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import type { ChildSessionPermissions } from "@easy-pi/subagent/session-host";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { mcpNamespace } from "../core/mcp-servers.ts";
import { GrokAgentsPanel } from "../modes/interactive-grok/components/grok-agents-panel.ts";
import { getSessionMcpConfig } from "./mcp/index.ts";
import { getNativeSession } from "./native-session-binding.ts";
import { createPiChildSessionHost } from "./pi-child-session-host.ts";
import { PiCollaborationMonitor } from "./pi-collaboration-monitor.ts";
import { registerPiCollaborationTools } from "./pi-collaboration-tools.ts";

/** Product root only. Factory discovery opens no resources; session_start owns the team. */
export function registerPiCollaborationRoot(
	pi: ExtensionAPI,
	agentDir: string,
	getPermissions: () => ChildSessionPermissions,
): void {
	let controller: CollaborationController | undefined;
	let monitor: PiCollaborationMonitor | undefined;
	let startupError: string | undefined;
	let panelOpen = false;
	let stopped = false;
	const start = (ctx: ExtensionContext) => {
		if (controller || stopped) return;
		const session = getNativeSession(ctx.sessionManager);
		const identity = { rootSessionId: session.sessionId, agentPath: "/root" };
		const store = new CollaborationStore({
			path: session.sessionFile ? join(agentDir, "teams", session.sessionId, "registry.sqlite") : ":memory:",
			rootSessionId: session.sessionId,
			cwd: ctx.cwd,
			// A verified dead owner needs reconciliation, not a manual availability gate.
			// Store acquisition still rejects live owners and never replays interrupted work.
			recoverInterruptedOwner: true,
		});
		try {
			const settings = session.settingsManager;
			// Share a live root getter, not the child SettingsManager's creation-time snapshot.
			const getDefaults = () => ({
				subagentModel: settings.getSubagentModel(),
				subagentThinkingLevel: settings.getSubagentThinkingLevel(),
			});
			const host = createPiChildSessionHost({
				modelRuntime: session.modelRuntime,
				noExtensions: true,
				additionalExtensionPaths: session.resourceLoader
					.getExtensions()
					.extensions.map((extension) => extension.path)
					.filter(isAbsolute),
				settings: {
					...settings.getGlobalSettings(),
					...settings.getProjectSettings(),
					codemode: settings.getSettings().codemode,
					compaction: settings.getCompactionSettings(),
					retry: { ...settings.getRetrySettings(), provider: settings.getProviderRetrySettings() },
					transport: settings.getTransport(),
					thinkingBudgets: settings.getThinkingBudgets(),
					httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
					websocketConnectTimeoutMs: settings.getWebSocketConnectTimeoutMs(),
					images: { blockImages: settings.getBlockImages(), autoResize: settings.getImageAutoResize() },
					shellPath: settings.getShellPath(),
					shellCommandPrefix: settings.getShellCommandPrefix(),
				},
				getCodexServiceTier: () => settings.getCodexServiceTier(),
				getTools: () => session.getDelegatableToolNames(),
				getMcpConfig: (toolNames) => {
					// Only the root's built-in MCP integration can supply its approved configuration.
					if (
						!session.resourceLoader
							.getExtensions()
							.extensions.some((extension) => extension.path === "<inline:mcp>")
					)
						return { servers: [], errors: [] };
					const namespaces = new Set(
						session
							.getAllTools()
							.filter((tool) => toolNames.includes(tool.name) && tool.name.startsWith("mcp__"))
							.map((tool) => tool.namespace?.name),
					);
					const loaded = getSessionMcpConfig(ctx.sessionManager);
					return {
						...(loaded?.autoEnableCodemode === undefined
							? {}
							: { autoEnableCodemode: loaded.autoEnableCodemode }),
						servers: (loaded?.servers ?? []).filter((entry) => namespaces.has(mcpNamespace(entry.name))),
						errors: [],
					};
				},
				observeSession: (child, native) => monitor!.attach(child, native),
				registerTools: (child, childPi, getSession) => {
					registerPiCollaborationTools({
						pi: childPi,
						controller: controller!,
						identity: child,
						getSession,
						getDefaults,
					});
				},
			});
			controller = new CollaborationController({ store, host, agentDir, getPermissions });
			monitor = new PiCollaborationMonitor(controller, session);
			registerPiCollaborationTools({ pi, controller, identity, getSession: () => session, getDefaults }).start(ctx);
			startupError = undefined;
		} catch (error) {
			monitor?.dispose();
			monitor = undefined;
			controller = undefined;
			store.close();
			throw error;
		}
	};
	const tryStart = (ctx: ExtensionContext) => {
		try {
			start(ctx);
		} catch (error) {
			startupError = error instanceof CollaborationError ? error.code : "storage_error";
		}
	};
	pi.on("session_start", (_event, ctx) => {
		tryStart(ctx);
		if (startupError) {
			ctx.ui.notify(
				`Native agents unavailable: ${startupError}. ${startupError === "busy" ? "Another live process owns this team; it will be retried before your next turn or /agents." : "Inspect retained team; /agents retries initialization without replay."}`,
				"warning",
			);
		}
	});
	pi.on("before_agent_start", (_event, ctx) => {
		// The process which blocked startup may have exited since this root was opened.
		if (!controller && startupError === "busy") tryStart(ctx);
	});
	pi.on("session_shutdown", async () => {
		stopped = true;
		monitor?.dispose();
		await controller?.shutdown();
	});
	pi.registerCommand("agents", {
		description:
			"Inspect native sessions, progress and retained turns before interrupting; explicitly message or follow up; retry team initialization without replay",
		handler: async (args, ctx) => {
			if (stopped) return;
			if (args.trim() && args.trim() !== "recover") {
				ctx.ui.notify("Usage: /agents or /agents recover. Recovery never resumes tasks.", "info");
				return;
			}
			if (!controller) tryStart(ctx);
			if (!monitor) {
				const remedy =
					startupError === "interrupted"
						? " Run /agents recover to adopt the interrupted team (recovery never resumes tasks)."
						: startupError === "busy"
							? " Another live process owns this team; close it or use that session."
							: "";
				ctx.ui.notify(`Native agents unavailable: ${startupError ?? "not started"}.${remedy}`, "error");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(JSON.stringify(monitor.list()), "info");
				return;
			}
			if (panelOpen) return;
			panelOpen = true;
			try {
				const current = monitor;
				await ctx.ui.custom<void>(
					(tui, theme, keybindings, done) =>
						new GrokAgentsPanel({
							monitor: current,
							theme,
							keybindings,
							requestRender: () => tui.requestRender(),
							done: () => done(),
							height: () => Math.max(4, tui.terminal.rows),
						}),
					{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
				);
			} finally {
				panelOpen = false;
			}
		},
	});
}
