import type { AgentSession } from "../core/agent-session.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { GrokTasksPanel } from "../modes/interactive-grok/components/grok-tasks-panel.ts";
import { getNativeSession } from "./native-session-binding.ts";

/**
 * `/tasks` panel for the shared background bash task manager, following the /agents precedent.
 *
 * The panel is the only TUI surface for task state: the footer under the editor carries no task
 * indicator (neither running counts nor unread-failure badges), and terminal results raise no
 * transcript toasts — the folding task block in the transcript shows per-task rows while tasks
 * are tracked. Display-only: the panel never mutates task state; lifecycle actions stay with the
 * task tools (task_list/task_output/task_stop/wait_for).
 */
export function registerPiBackgroundTasks(pi: ExtensionAPI): void {
	let panelOpen = false;

	/** The manager is created lazily with the built-in bash tool; SDK tool overrides may skip it. */
	const sessionFor = (ctx: ExtensionContext): AgentSession | undefined => {
		try {
			return getNativeSession(ctx.sessionManager);
		} catch {
			return undefined;
		}
	};

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
							// Insert into the main draft after closing the panel; this is not a clipboard action.
							onInsertPath: (path) => {
								const existing = ctx.ui.getEditorText();
								const separator = existing && !existing.endsWith("\n") ? "\n" : "";
								ctx.ui.setEditorText(`${existing}${separator}${path}`);
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
