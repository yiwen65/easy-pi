import type { BackgroundTaskManager } from "@earendil-works/pi-agent-core/node";
import type { AgentSession } from "../core/agent-session.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { GrokTasksPanel } from "../modes/interactive-grok/components/grok-tasks-panel.ts";
import { getNativeSession } from "./native-session-binding.ts";

/** Footer status-bar key for the active background task indicator. */
const STATUS_KEY = "bg-tasks";
function formatIndicator(active: number, unreadFailures: number): string | undefined {
	const parts: string[] = [];
	if (active > 0) parts.push(`⚙ ${active} bg ${active === 1 ? "task" : "tasks"}`);
	if (unreadFailures > 0) parts.push(`✗ ${unreadFailures} failed`);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * TUI visibility for the shared background bash task manager: a status-bar indicator with the
 * active (non-terminal) task count plus unread failure badge, terminal-state toasts, and a
 * read-only /tasks panel, following the /agents precedent. Display-only: neither surface mutates
 * task state; lifecycle actions stay with the task tools (task_list/task_output/task_stop/wait_for).
 *
 * Toasts are suppressed for terminal results already consumed via wait_for (the model reported
 * them) and for deliberate stops; badges and toasts only appear in TUI mode.
 */
export function registerPiBackgroundTasks(pi: ExtensionAPI): void {
	const unsubscribes: Array<() => void> = [];
	let panelOpen = false;
	let unreadFailures = 0;

	const detach = (): void => {
		for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
	};

	/** The manager is created lazily with the built-in bash tool; SDK tool overrides may skip it. */
	const sessionFor = (ctx: ExtensionContext): AgentSession | undefined => {
		try {
			return getNativeSession(ctx.sessionManager);
		} catch {
			return undefined;
		}
	};

	const refreshIndicator = (ctx: ExtensionContext, manager: BackgroundTaskManager | undefined): void => {
		ctx.ui.setStatus(STATUS_KEY, formatIndicator(manager?.list().length ?? 0, unreadFailures));
	};

	pi.on("session_start", (_event, ctx) => {
		// Re-attach on reload: the manager survives runtime rebuilds, so rebind without doubling up.
		detach();
		unreadFailures = 0;
		const session = sessionFor(ctx);
		const manager = session?.backgroundTasks;
		if (manager && session) {
			const refresh = (): void => refreshIndicator(ctx, manager);
			unsubscribes.push(manager.onStart(refresh));
			unsubscribes.push(
				manager.onTerminal((record) => {
					// No per-task toasts: the folding transcript block is the single display surface.
					// Only the unread-failure badge tracks terminal failures the model did not report.
					if (
						(record.status === "failed" || record.status === "timed_out") &&
						!session.isBackgroundTaskNotificationConsumed(record.id)
					) {
						unreadFailures += 1;
					}
					refresh();
				}),
			);
		}
		refreshIndicator(ctx, manager);
	});

	pi.on("session_shutdown", () => detach());

	pi.registerCommand("tasks", {
		description: "Show background bash tasks in a read-only panel (state changes via task tools only)",
		handler: async (_args, ctx) => {
			const manager = sessionFor(ctx)?.backgroundTasks;
			if (ctx.mode !== "tui") {
				ctx.ui.notify(JSON.stringify(manager?.list({ activeOnly: false }) ?? []), "info");
				return;
			}
			if (!manager) {
				ctx.ui.notify("Background tasks unavailable: this session has no task manager.", "info");
				return;
			}
			if (panelOpen) return;
			panelOpen = true;
			unreadFailures = 0;
			refreshIndicator(ctx, manager);
			try {
				await ctx.ui.custom<void>(
					(tui, theme, keybindings, done) =>
						new GrokTasksPanel({
							manager,
							theme,
							keybindings,
							requestRender: () => tui.requestRender(),
							done: () => done(),
							height: () => Math.max(4, tui.terminal.rows),
							onCopyPath: (path) => {
								const existing = ctx.ui.getEditorText().trim();
								ctx.ui.setEditorText(existing ? `${existing}\n${path}` : path);
							},
						}),
					{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
				);
			} finally {
				panelOpen = false;
			}
		},
	});
}
