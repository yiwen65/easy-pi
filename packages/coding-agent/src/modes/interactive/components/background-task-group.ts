import { stripVTControlCharacters } from "node:util";
import type {
	BackgroundTaskManager,
	BackgroundTaskRecord,
	BackgroundTaskStatus,
} from "@earendil-works/pi-agent-core/node";
import { isTerminalTaskStatus } from "@earendil-works/pi-agent-core/node";
import { Container, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const safe = (text: string) =>
	stripVTControlCharacters(text)
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.replace(/\t/g, "    ");
const oneLine = (text: string) => safe(text).replace(/\s+/g, " ");

const TICK_MS = 1_000;
const OUTPUT_PREVIEW_BYTES = 8 * 1024;

const STATUS_PRESENTATION: Record<
	BackgroundTaskStatus,
	{ icon: string; word: string; color: "success" | "warning" | "error" | "muted" | "dim" }
> = {
	running: { icon: "●", word: "Running", color: "success" },
	stopping: { icon: "◌", word: "Stopping", color: "warning" },
	succeeded: { icon: "✓", word: "Done", color: "dim" },
	failed: { icon: "✗", word: "Failed", color: "error" },
	timed_out: { icon: "⏱", word: "Timed out", color: "error" },
	stopped: { icon: "■", word: "Stopped", color: "muted" },
};

function durationText(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function taskTime(record: BackgroundTaskRecord, now: number): string {
	return isTerminalTaskStatus(record.status)
		? `${durationText(now - (record.endedAt ?? now))} ago`
		: durationText(now - record.startedAt);
}

/**
 * One folding transcript block for all background bash tasks. Collapsed: a single live line
 * ("⚙ N background tasks · latest command") refreshed once per second while tasks are active.
 * Expanded: one line per task (icon, id, state, elapsed, command). Clicking a task row expands
 * just that task's detail (status, log path, output tail). Click the header again to fold back.
 * Display-only: the block never starts, stops, or otherwise mutates tasks.
 */
export class BackgroundTaskGroupComponent extends Container {
	private expanded = false;
	private expandedTaskId: string | undefined;
	private tick = 0;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private readonly unsubscribes: Array<() => void> = [];

	private readonly manager: BackgroundTaskManager;
	private readonly onRequestRender: () => void;

	constructor(manager: BackgroundTaskManager, onRequestRender: () => void) {
		super();
		this.manager = manager;
		this.onRequestRender = onRequestRender;
		const refresh = (): void => this.requestRender();
		this.unsubscribes.push(manager.onStart(refresh), manager.onTerminal(refresh));
	}

	private tasks(): BackgroundTaskRecord[] {
		const all = this.manager.list({ activeOnly: false });
		const active = all.filter((record) => !isTerminalTaskStatus(record.status));
		const terminal = all.filter((record) => isTerminalTaskStatus(record.status));
		active.sort((a, b) => a.startedAt - b.startedAt);
		terminal.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
		return [...active, ...terminal];
	}

	private requestRender(): void {
		this.syncTicker();
		this.onRequestRender();
	}

	private syncTicker(): void {
		const active = this.manager.list().length > 0 && !this.expanded;
		if (active && !this.ticker) {
			this.ticker = setInterval(() => {
				this.tick++;
				if (this.manager.list().length === 0 || this.expanded) {
					if (this.ticker) clearInterval(this.ticker);
					this.ticker = undefined;
				}
				this.onRequestRender();
			}, TICK_MS);
			(this.ticker as { unref?: () => void }).unref?.();
		}
	}

	private collapsedLine(width: number, now: number): string {
		const active = this.manager.list();
		const terminalCount = this.tasks().length - active.length;
		const marqueeSource = active[active.length - 1];
		const count = `${active.length} running${terminalCount > 0 ? ` · ${terminalCount} finished` : ""}`;
		const tail = marqueeSource
			? oneLine(marqueeSource.command)
			: this.tasks()[0]
				? oneLine(this.tasks()[0].command)
				: "";
		const scroll = tail.length > 32 ? tail.slice((this.tick * 2) % Math.max(1, tail.length), undefined) : tail;
		const prefix = `⚙ background tasks · ${count}`;
		const suffix = tail ? ` · ${scroll}` : "";
		return truncateToWidth(theme.fg("accent", prefix) + theme.fg("muted", suffix), width);
	}

	private taskLine(record: BackgroundTaskRecord, width: number, now: number): string {
		const presentation = STATUS_PRESENTATION[record.status];
		const detail = record.id === this.expandedTaskId ? "▾" : "▸";
		return truncateToWidth(
			`${theme.fg(presentation.color, `${presentation.icon} ${record.id} ${presentation.word}`)}` +
				theme.fg("muted", ` ${taskTime(record, now)} ${detail} `) +
				theme.fg("dim", oneLine(record.command)),
			width,
		);
	}

	private taskDetail(record: BackgroundTaskRecord, width: number, now: number): string[] {
		const presentation = STATUS_PRESENTATION[record.status];
		const lines = [
			truncateToWidth(
				theme.fg(presentation.color, `  ${record.status}`) +
					theme.fg(
						"muted",
						` · pid ${record.pid ?? "?"} · ${taskTime(record, now)}${record.promoted ? " · ↪ promoted" : ""}`,
					),
				width,
			),
			truncateToWidth(theme.fg("muted", `  log ${record.outputPath}`), width),
		];
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
		const lines = [this.collapsedLine(width, now)];
		if (!this.expanded) return lines;
		for (const record of this.tasks()) {
			lines.push(this.taskLine(record, width, now));
			if (record.id === this.expandedTaskId) lines.push(...this.taskDetail(record, width, now));
		}
		if (this.tasks().length === 0) lines.push(theme.fg("muted", "no tasks"));
		return lines;
	}

	/** Stop the ticker when the block leaves the transcript. */
	dispose(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
		for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
	}
}
