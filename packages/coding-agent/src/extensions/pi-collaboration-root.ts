import { isAbsolute, join } from "node:path";
import { CollaborationError } from "@easy-pi/subagent/collaboration-contract";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import type { ChildSessionPermissions } from "@easy-pi/subagent/session-host";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { GrokAgentsPanel } from "../modes/interactive-grok/components/grok-agents-panel.ts";
import { getNativeSession } from "./native-session-binding.ts";
import { createPiChildSessionHost } from "./pi-child-session-host.ts";
import { type AgentListRow, type AgentRowState, PiCollaborationMonitor } from "./pi-collaboration-monitor.ts";
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
	let toastCtx: ExtensionContext | undefined;
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	let toastQueue: AgentListRow[] = [];
	const settledStates = new Map<string, AgentRowState>();
	let settledSeeded = false;

	/** Toast child terminal transitions, but only while the operator is not already watching the panel. */
	const trackTerminalToasts = (): void => {
		if (!monitor) return;
		const rows = monitor.list().filter((row) => row.task_name !== "/root");
		if (!settledSeeded) {
			settledSeeded = true;
			for (const row of rows) settledStates.set(row.task_name, row.state);
			return;
		}
		for (const row of rows) {
			const previous = settledStates.get(row.task_name);
			settledStates.set(row.task_name, row.state);
			const terminal = row.state === "completed" || row.state === "failed" || row.state === "interrupted";
			const wasActive = previous === "running" || previous === "idle" || previous === "pending";
			if (!terminal || !wasActive) continue;
			toastQueue.push(row);
		}
		if (toastQueue.length > 0 && !toastTimer) {
			toastTimer = setTimeout(() => {
				toastTimer = undefined;
				const settled = toastQueue.splice(0);
				if (!toastCtx || toastCtx.mode !== "tui" || panelOpen) return;
				if (settled.length === 1) {
					const row = settled[0];
					const word = row.state === "completed" ? "done" : row.state;
					const level = row.state === "completed" ? "info" : row.state === "failed" ? "error" : "warning";
					toastCtx.ui.notify(`${row.task_name} ${word} — /agents to inspect`, level);
					return;
				}
				const failed = settled.filter((row) => row.state === "failed").length;
				toastCtx.ui.notify(
					`${settled.length} agents settled${failed > 0 ? `, ${failed} failed` : ""} — /agents to inspect`,
					failed > 0 ? "error" : "info",
				);
			}, 400);
		}
	};
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
			monitor.subscribe(trackTerminalToasts);
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
	pi.on("session_start", (_event, ctx) => {
		toastCtx = ctx;
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
		toastCtx = undefined;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = undefined;
		toastQueue = [];
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
