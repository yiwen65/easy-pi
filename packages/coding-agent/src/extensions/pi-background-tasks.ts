import { type BackgroundTaskManager, isBackgroundTaskStalled } from "@earendil-works/pi-agent-core/node";
import type { AgentSession } from "../core/agent-session.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { GrokTasksPanel } from "../modes/interactive-grok/components/grok-tasks-panel.ts";
import { getNativeSession } from "./native-session-binding.ts";

/** Footer status-bar key for the active background task indicator. */
const STATUS_KEY = "bg-tasks";
/** Stalled-state refresh cadence; stalls are time-based, so the badge needs its own tick. */
const STALL_REFRESH_MS = 30_000;
function formatIndicator(active: number, unreadFailures: number, stalled: number): string | undefined {
	const parts: string[] = [];
	if (active > 0) parts.push(`⚙ ${active} bg ${active === 1 ? "task" : "tasks"}`);
	if (stalled > 0) parts.push(`⏸ ${stalled} stalled`);
	if (unreadFailures > 0) parts.push(`✗ ${unreadFailures} failed`);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Count running tasks whose silence passed the manager's stall window. */
function countStalled(manager: BackgroundTaskManager): number {
	const now = Date.now();
	return manager.list().filter((record) => isBackgroundTaskStalled(record, now, manager.stallTimeoutMs)).length;
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
	let stallTimer: ReturnType<typeof setInterval> | undefined;

	const detach = (): void => {
		for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
		if (stallTimer) clearInterval(stallTimer);
		stallTimer = undefined;
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
		const active = manager?.list().length ?? 0;
		ctx.ui.setStatus(STATUS_KEY, formatIndicator(active, unreadFailures, manager ? countStalled(manager) : 0));
		// A stall badge appears with time, not with an event: tick while tasks are active, stop when idle.
		if (manager && active > 0 && !stallTimer) {
			stallTimer = setInterval(() => refreshIndicator(ctx, manager), STALL_REFRESH_MS);
			stallTimer.unref?.();
		} else if ((!manager || active === 0) && stallTimer) {
			clearInterval(stallTimer);
			stallTimer = undefined;
		}
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
