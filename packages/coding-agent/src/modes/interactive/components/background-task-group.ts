import type { BackgroundTaskManager, BackgroundTaskRecord } from "@earendil-works/pi-agent-core/node";
import { isTerminalTaskStatus } from "@earendil-works/pi-agent-core/node";
import { Container, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import {
	backgroundTaskStallHint,
	oneLineBackgroundTaskText as oneLine,
	BACKGROUND_TASK_STATUS_PRESENTATION as STATUS_PRESENTATION,
	safeBackgroundTaskText as safe,
	sortBackgroundTasks,
	backgroundTaskDuration as taskTime,
} from "./background-task-view.ts";
import { LiveLineScroller } from "./live-line-scroller.ts";

const TICK_MS = 1_000;
const OUTPUT_PREVIEW_BYTES = 8 * 1024;

/**
 * One folding transcript block for all background bash tasks. Collapsed: a single live line
 * ("⚙ N background tasks · latest command") refreshed once per second while tasks are active;
 * the command shows its head while tasks come and go and scrolls its truncated part into view
 * once the line sits idle.
 * Expanded: one line per task (icon, id, state, duration, command). Clicking a task row expands
 * just that task's detail (status, log path, output tail). Click the header again to fold back.
 * Display-only: the block never starts, stops, or otherwise mutates tasks.
 */
export class BackgroundTaskGroupComponent extends Container {
	private expanded = false;
	private expandedTaskId: string | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private readonly scroller: LiveLineScroller;
	private readonly unsubscribes: Array<() => void> = [];

	/** The manager this block renders; the TUI remounts when a session swap changes it. */
	readonly manager: BackgroundTaskManager;
	private readonly onRequestRender: () => void;

	constructor(manager: BackgroundTaskManager, onRequestRender: () => void) {
		super();
		this.manager = manager;
		this.onRequestRender = onRequestRender;
		this.scroller = new LiveLineScroller({ requestRender: onRequestRender });
		const refresh = (): void => this.requestRender();
		this.unsubscribes.push(manager.onStart(refresh), manager.onTerminal(refresh));
	}

	private requestRender(): void {
		this.syncTicker();
		this.onRequestRender();
	}

	private syncTicker(): void {
		// Keep ticking while tasks are active, expanded or not: the expanded rows show the same
		// live elapsed time, and stopping the ticker there froze it until an unrelated render.
		const active = this.manager.list().length > 0;
		if (active && !this.ticker) {
			this.ticker = setInterval(() => {
				if (this.manager.list().length === 0) {
					if (this.ticker) clearInterval(this.ticker);
					this.ticker = undefined;
				}
				this.onRequestRender();
			}, TICK_MS);
			(this.ticker as { unref?: () => void }).unref?.();
		}
	}

	/** Single snapshot per render: sorting and copying records once keeps big task lists cheap. */
	private tasks(): BackgroundTaskRecord[] {
		return sortBackgroundTasks(this.manager.list({ activeOnly: false }));
	}

	private collapsedLine(width: number, tasks: BackgroundTaskRecord[]): string {
		const active = tasks.filter((record) => !isTerminalTaskStatus(record.status));
		const terminalCount = tasks.length - active.length;
		const latest = active[active.length - 1];
		const count = `${active.length} running${terminalCount > 0 ? ` · ${terminalCount} finished` : ""}`;
		const fallback = tasks[0];
		const command = latest ? oneLine(latest.command) : fallback ? oneLine(fallback.command) : "";
		this.scroller.setText(command);
		const prefix = `⚙ background tasks · ${count}`;
		const gap = command ? " · " : "";
		const commandWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(gap));
		const suffix = this.scroller.window(commandWidth);
		return truncateToWidth(theme.fg("accent", prefix) + theme.fg("muted", gap + suffix), width);
	}

	private taskLine(record: BackgroundTaskRecord, width: number, now: number): string {
		const presentation = STATUS_PRESENTATION[record.status];
		const detail = record.id === this.expandedTaskId ? "▾" : "▸";
		const stall = backgroundTaskStallHint(record, now, this.manager.stallTimeoutMs);
		return truncateToWidth(
			`${theme.fg(presentation.color, `${presentation.icon} ${record.id} ${presentation.word}`)}` +
				theme.fg("muted", ` ${taskTime(record, now)}`) +
				(stall ? theme.fg("warning", ` ${stall}`) : "") +
				theme.fg("muted", ` ${detail} `) +
				theme.fg("dim", oneLine(record.command)),
			width,
		);
	}

	private taskDetail(record: BackgroundTaskRecord, width: number, now: number): string[] {
		const presentation = STATUS_PRESENTATION[record.status];
		const stall = backgroundTaskStallHint(record, now, this.manager.stallTimeoutMs);
		const lines = [
			truncateToWidth(
				theme.fg(presentation.color, `  ${record.status}`) +
					theme.fg(
						"muted",
						` · pid ${record.pid ?? "?"} · ${taskTime(record, now)}${record.promoted ? " · ↪ promoted" : ""}`,
					),
				width,
			),
		];
		if (stall) {
			lines.push(truncateToWidth(theme.fg("warning", `  ${stall} — still running; task_stop terminates it`), width));
		}
		lines.push(truncateToWidth(theme.fg("muted", `  log ${record.outputPath}`), width));
		const output = this.manager.readOutput(record.id, OUTPUT_PREVIEW_BYTES);
		if (output.ok && output.value.output.trim()) {
			const wrapped = wrapTextWithAnsi(safe(output.value.output.trim()), Math.max(1, width)).slice(-8);
			lines.push(...wrapped.map((line) => `  ${theme.fg("dim", line)}`));
		}
		return lines;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (!expanded) this.expandedTaskId = undefined;
		this.requestRender();
	}

	/** Transcript click at a block-local row: header toggles; task rows toggle that task's detail. */
	handleOverviewClick(localRow: number, width: number): boolean {
		if (!this.expanded) {
			if (localRow !== 0) return false;
			this.setExpanded(true);
			return true;
		}
		if (localRow === 0) {
			this.setExpanded(false);
			return true;
		}
		let cursor = 1;
		for (const record of this.tasks()) {
			const rowHeight =
				1 + (record.id === this.expandedTaskId ? this.taskDetail(record, width, Date.now()).length : 0);
			if (localRow >= cursor && localRow < cursor + rowHeight) {
				this.expandedTaskId = record.id === this.expandedTaskId ? undefined : record.id;
				this.requestRender();
				return true;
			}
			cursor += rowHeight;
		}
		return false;
	}

	override render(width: number): string[] {
		const now = Date.now();
		const tasks = this.tasks();
		const lines = [this.collapsedLine(width, tasks)];
		if (!this.expanded) return lines;
		for (const record of tasks) {
			lines.push(this.taskLine(record, width, now));
			if (record.id === this.expandedTaskId) lines.push(...this.taskDetail(record, width, now));
		}
		if (tasks.length === 0) lines.push(theme.fg("muted", "no tasks"));
		return lines;
	}

	/** Stop the ticker and the idle scroll when the block leaves the transcript. */
	dispose(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
		this.scroller.dispose();
		for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
	}
}
