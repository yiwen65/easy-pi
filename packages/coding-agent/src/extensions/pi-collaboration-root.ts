import { isAbsolute, join } from "node:path";
import { CollaborationError } from "@easy-pi/subagent/collaboration-contract";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import type { ChildSessionPermissions } from "@easy-pi/subagent/session-host";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { GrokAgentsPanel } from "../modes/interactive-grok/components/grok-agents-panel.ts";
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
	const start = (ctx: ExtensionContext, recoverInterruptedOwner = false) => {
		if (controller || stopped) return;
		const session = getNativeSession(ctx.sessionManager);
		const identity = { rootSessionId: session.sessionId, agentPath: "/root" };
		const store = new CollaborationStore({
			path: session.sessionFile ? join(agentDir, "teams", session.sessionId, "registry.sqlite") : ":memory:",
			rootSessionId: session.sessionId,
			cwd: ctx.cwd,
			recoverInterruptedOwner,
		});
		try {
			const settings = session.settingsManager;
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
				getTools: () => session.getActiveToolNames(),
				observeSession: (child, native) => monitor!.attach(child, native),
				registerTools: (child, childPi, getSession) => {
					registerPiCollaborationTools({ pi: childPi, controller: controller!, identity: child, getSession });
				},
			});
			controller = new CollaborationController({ store, host, agentDir, getPermissions });
			monitor = new PiCollaborationMonitor(controller, session);
			registerPiCollaborationTools({ pi, controller, identity, getSession: () => session }).start(ctx);
			startupError = undefined;
		} catch (error) {
			monitor?.dispose();
			monitor = undefined;
			controller = undefined;
			store.close();
			throw error;
		}
	};
	pi.on("session_start", (_event, ctx) => {
		try {
			start(ctx);
		} catch (error) {
			startupError = error instanceof CollaborationError ? error.code : "storage_error";
			ctx.ui.notify(
				`Native agents unavailable: ${startupError}. Inspect retained team; /agents recover explicitly recovers a dead owner without replay.`,
				"warning",
			);
		}
	});
	pi.on("session_shutdown", async () => {
		stopped = true;
		monitor?.dispose();
		await controller?.shutdown();
	});
	pi.registerCommand("agents", {
		description:
			"Watch native agent sessions and explicitly message, follow up or interrupt; recover a dead owner with /agents recover",
		handler: async (args, ctx) => {
			if (stopped) return;
			if (args.trim() === "recover" && !controller) {
				try {
					start(ctx, true);
				} catch (error) {
					startupError = error instanceof CollaborationError ? error.code : "storage_error";
				}
			} else if (args.trim() && args.trim() !== "recover") {
				ctx.ui.notify("Usage: /agents or /agents recover. Recovery never resumes tasks.", "info");
				return;
			}
			if (!monitor) {
				ctx.ui.notify(`Native agents unavailable: ${startupError ?? "not started"}`, "error");
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
							height: () => Math.max(4, tui.terminal.rows - 2),
						}),
					{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
				);
			} finally {
				panelOpen = false;
			}
		},
	});
}
