import type { BackgroundTaskManager, BackgroundTaskRecord } from "@earendil-works/pi-agent-core/node";
import { isTerminalTaskStatus } from "@earendil-works/pi-agent-core/node";
import {
	Container,
	recordRenderedContentClickHandler,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatDisplayPath } from "../../../utils/display-path.ts";
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
 * One folding transcript block for a user turn's background bash tasks. Collapsed: a single live line
 * ("⚙ N · latest command") refreshed once per second while tasks are active;
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
	private readonly taskIds: Set<string>;
	private acceptingTasks = true;
	private disposed = false;

	/** The manager this block renders; the TUI remounts when a session swap changes it. */
	readonly manager: BackgroundTaskManager;
	private readonly onRequestRender: () => void;

	constructor(manager: BackgroundTaskManager, onRequestRender: () => void, taskIds?: readonly string[]) {
		super();
		this.manager = manager;
		this.onRequestRender = onRequestRender;
		this.taskIds = new Set(taskIds ?? manager.list({ activeOnly: false }).map((task) => task.id));
		this.scroller = new LiveLineScroller({ requestRender: onRequestRender });
		this.unsubscribes.push(
			manager.onStart((task) => {
				if (this.acceptingTasks) this.addTask(task.id);
			}),
			manager.onTerminal((task) => {
				if (this.taskIds.has(task.id)) this.requestRender();
			}),
		);
	}

	addTask(taskId: string): void {
		this.taskIds.add(taskId);
		this.requestRender();
	}

	/** Retain live status updates, but do not collect tasks from subsequent user turns. */
	completeTurn(): void {
		this.acceptingTasks = false;
		this.scroller.completeTurn();
	}

	private requestRender(): void {
		this.syncTicker();
		this.onRequestRender();
	}

	private syncTicker(): void {
		// Keep ticking while tasks are active, expanded or not: the expanded rows show the same
		// live elapsed time, and stopping the ticker there froze it until an unrelated render.
		const active = this.tasks().some((task) => !isTerminalTaskStatus(task.status));
		if (active && !this.ticker) {
			this.ticker = setInterval(() => {
				if (!this.tasks().some((task) => !isTerminalTaskStatus(task.status))) {
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
		return sortBackgroundTasks(this.manager.list({ activeOnly: false }).filter((task) => this.taskIds.has(task.id)));
	}

	private collapsedLine(width: number, tasks: BackgroundTaskRecord[]): string {
		const active = tasks.filter((record) => !isTerminalTaskStatus(record.status));
		const terminalCount = tasks.length - active.length;
		// Membership insertion order tracks starts, including equal timestamps and repeated registrations.
		const latestTaskId = [...this.taskIds].at(-1);
		const latest = tasks.find((task) => task.id === latestTaskId);
		const count = active.length > 0 ? `${active.length} running · ${tasks.length}` : `${terminalCount}`;
		const command = latest ? oneLine(latest.command) : "";
		this.scroller.setText(command);
		const prefix = `⚙ ${count}`;
		const gap = command ? " · " : "";
		const commandWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(gap));
		const suffix = this.scroller.window(commandWidth);
		return truncateToWidth(theme.fg("warning", prefix) + theme.fg("muted", gap + suffix), width, "");
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
		const pathLabel = truncateToWidth("  log ", width, "");
		lines.push(
			theme.fg("muted", pathLabel + formatDisplayPath(oneLine(record.outputPath), width - visibleWidth(pathLabel))),
		);
		const output = this.manager.readOutput(record.id, OUTPUT_PREVIEW_BYTES);
		if (output.ok && output.value.output.trim()) {
			const text = safe(output.value.output.trim());
			// Reserve indentation before wrapping. Extremely narrow screens omit indentation;
			// a two-cell grapheme cannot fit width1, so mark it rather than overflowing.
			// Its original text remains in the log and in the preview at feasible widths.
			const indent = width >= 4 ? "  " : "";
			const wrapped = wrapTextWithAnsi(text, Math.max(1, width - indent.length)).slice(-8);
			lines.push(
				...wrapped.map((line) => indent + theme.fg("dim", width === 1 ? truncateToWidth(line, 1, "…") : line)),
			);
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
		if (width <= 0) return [];
		const now = Date.now();
		const tasks = this.tasks();
		const lines = [this.collapsedLine(width, tasks)];
		const expanded = this.expanded;
		const expandedTaskId = this.expandedTaskId;
		const ranges: Array<{ id: string; start: number; end: number }> = [];
		if (expanded) {
			for (const record of tasks) {
				const start = lines.length;
				lines.push(this.taskLine(record, width, now));
				if (record.id === expandedTaskId) lines.push(...this.taskDetail(record, width, now));
				ranges.push({ id: record.id, start, end: lines.length });
			}
			if (tasks.length === 0) lines.push(truncateToWidth(theme.fg("muted", "No background tasks yet."), width, ""));
		}
		recordRenderedContentClickHandler(this, lines, (localRow) => {
			if (this.disposed || this.expanded !== expanded) return false;
			if (localRow === 0) {
				this.setExpanded(!expanded);
				return true;
			}
			const target = ranges.find((range) => localRow >= range.start && localRow < range.end);
			if (!target || !this.taskIds.has(target.id) || !this.tasks().some((task) => task.id === target.id))
				return false;
			this.expandedTaskId = target.id === expandedTaskId ? undefined : target.id;
			this.requestRender();
			return true;
		});
		return lines;
	}

	/** Stop the ticker and the idle scroll when the block leaves the transcript. */
	dispose(): void {
		this.disposed = true;
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
		this.scroller.dispose();
		for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
	}
}
