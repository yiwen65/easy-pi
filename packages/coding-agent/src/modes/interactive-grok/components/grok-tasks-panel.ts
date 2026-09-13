import { stripVTControlCharacters } from "node:util";
import {
	type BackgroundTaskManager,
	type BackgroundTaskRecord,
	type BackgroundTaskStatus,
	isTerminalTaskStatus,
} from "@earendil-works/pi-agent-core/node";
import {
	type Component,
	type Focusable,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { Theme } from "../../interactive/theme/theme.ts";

const safe = (text: string) =>
	stripVTControlCharacters(text)
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.replace(/\t/g, "    ");
const oneLine = (text: string) => safe(text).replace(/\s+/g, " ");

/** Output tail preview size for the detail view; the per-task log file always holds the full output. */
const OUTPUT_PREVIEW_BYTES = 16 * 1024;
/** Repaint cadence while any task is active so elapsed times and output tails stay live. */
const ACTIVE_TICK_MS = 1_000;
/** Below this width the panel switches to a compact single-line layout. */
const COMPACT_WIDTH = 60;

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

/** Active tasks show running elapsed time; finished tasks show how long ago they ended. */
function timeText(record: BackgroundTaskRecord, now: number): string {
	if (isTerminalTaskStatus(record.status)) return `${durationText(now - (record.endedAt ?? now))} ago`;
	return durationText(now - record.startedAt);
}

function statusText(record: BackgroundTaskRecord): string {
	const presentation = STATUS_PRESENTATION[record.status];
	if (record.status === "failed" && record.exitCode !== undefined && record.exitCode !== null) {
		return `${presentation.word} exit ${record.exitCode}`;
	}
	return presentation.word;
}

function outcome(record: BackgroundTaskRecord): string {
	if (record.exitCode !== undefined && record.exitCode !== null) return `exit ${record.exitCode}`;
	if (record.signal) return `signal ${record.signal}`;
	return record.error ?? "no exit status";
}

function pad(text: string, width: number): string {
	const padding = width - visibleWidth(text);
	return padding > 0 ? text + " ".repeat(padding) : text;
}

/**
 * Focused read-only overlay for background bash tasks, following the GrokAgentsPanel precedent.
 * The panel never mutates task state: lifecycle changes stay with the task tools
 * (task_list/task_output/task_stop/wait_for) or the managed processes themselves.
 *
 * Follow semantics in the detail view: pinned to the newest output while at the bottom;
 * paging up detaches, End (or paging back to the bottom) reattaches.
 */
export class GrokTasksPanel implements Component, Focusable {
	private readonly manager: BackgroundTaskManager;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: () => void;
	private readonly height: () => number;
	private readonly onCopyPath: ((path: string) => void) | undefined;
	private readonly unsubscribes: Array<() => void>;
	private readonly tick: ReturnType<typeof setInterval>;
	private selected = 0;
	private watchingId: string | undefined;
	private scroll = 0;
	private follow = true;
	private closed = false;
	private focus = false;
	get focused(): boolean {
		return this.focus;
	}
	set focused(value: boolean) {
		this.focus = value;
	}

	constructor(options: {
		manager: BackgroundTaskManager;
		theme: Theme;
		keybindings: KeybindingsManager;
		requestRender: () => void;
		done: () => void;
		height: () => number;
		onCopyPath?: (path: string) => void;
	}) {
		this.manager = options.manager;
		this.theme = options.theme;
		this.keys = options.keybindings;
		this.requestRender = options.requestRender;
		this.done = options.done;
		this.height = options.height;
		this.onCopyPath = options.onCopyPath;
		const refresh = (): void => {
			if (!this.closed) this.requestRender();
		};
		this.unsubscribes = [this.manager.onStart(refresh), this.manager.onTerminal(refresh)];
		this.tick = setInterval(() => {
			if (!this.closed && this.manager.list().length > 0) this.requestRender();
		}, ACTIVE_TICK_MS);
		(this.tick as { unref?: () => void }).unref?.();
	}

	private close(): void {
		if (!this.closed) {
			this.dispose();
			this.done();
		}
	}

	/** Active tasks first (oldest running at top), then finished tasks, newest first. */
	private tasks(): BackgroundTaskRecord[] {
		const all = this.manager.list({ activeOnly: false });
		const active = all.filter((record) => !isTerminalTaskStatus(record.status));
		const finished = all.filter((record) => isTerminalTaskStatus(record.status));
		active.sort((a, b) => a.startedAt - b.startedAt);
		finished.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
		return [...active, ...finished];
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.keys.matches(data, "tui.select.cancel")) {
			if (this.watchingId !== undefined) {
				this.watchingId = undefined;
				this.scroll = 0;
			} else this.close();
		} else if (this.watchingId === undefined) {
			const rows = this.tasks();
			if (this.keys.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
			else if (this.keys.matches(data, "tui.select.down"))
				this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + 1);
			else if (this.keys.matches(data, "tui.select.pageUp"))
				this.selected = Math.max(0, this.selected - Math.max(1, this.height() - 9));
			else if (this.keys.matches(data, "tui.select.pageDown"))
				this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + Math.max(1, this.height() - 9));
			else if (this.keys.matches(data, "tui.select.confirm") && rows.length > 0) {
				this.watchingId = rows[Math.min(this.selected, rows.length - 1)].id;
				this.scroll = 0;
				this.follow = true;
			}
		} else if (this.keys.matches(data, "tui.select.pageUp")) {
			this.follow = false;
			this.scroll += Math.max(1, this.height() - 9);
		} else if (this.keys.matches(data, "tui.select.pageDown")) {
			this.scroll = Math.max(0, this.scroll - Math.max(1, this.height() - 9));
			if (this.scroll === 0) this.follow = true;
		} else if (data === "\x1b[F" || data === "\x1b[4~") {
			// End: jump to the newest output and reattach follow mode.
			this.follow = true;
			this.scroll = 0;
		} else if (data === "y" && this.onCopyPath) {
			const record = this.manager.get(this.watchingId);
			if (record) {
				const path = record.outputPath;
				this.close();
				this.onCopyPath(path);
			}
		}
		if (!this.closed) this.requestRender();
	}

	private renderList(
		width: number,
		now: number,
		hint: (id: Parameters<KeybindingsManager["getKeys"]>[0]) => string,
	): string[] {
		const th = this.theme;
		const rows = this.tasks();
		const activeCount = rows.filter((record) => !isTerminalTaskStatus(record.status)).length;
		const lines: string[] = [];
		lines.push(
			th.fg(
				"dim",
				`${rows.length === 0 ? "No" : activeCount} active · ${rows.length - activeCount} finished — ${hint("tui.select.up")}/${hint("tui.select.down")} select · ${hint("tui.select.confirm")} details · read-only`,
			),
		);
		if (rows.length === 0) {
			lines.push("");
			lines.push(
				th.fg(
					"muted",
					"No background tasks yet. Bash starts them with run_in_background or after a foreground timeout.",
				),
			);
			return lines;
		}
		this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
		const compact = width < COMPACT_WIDTH;
		const idWidth = Math.min(12, Math.max(7, ...rows.map((record) => record.id.length)));
		let dividerInserted = false;
		for (const [index, record] of rows.entries()) {
			const isActive = !isTerminalTaskStatus(record.status);
			if (!isActive && !dividerInserted && activeCount > 0) {
				dividerInserted = true;
				lines.push(th.fg("dim", "─".repeat(Math.max(4, width))));
			}
			const presentation = STATUS_PRESENTATION[record.status];
			const selectedRow = index === this.selected;
			const marker = selectedRow ? "›" : " ";
			const command = oneLine(record.command);
			const text = compact
				? `${marker} ${presentation.icon} ${record.id} ${statusText(record)} ${timeText(record, now)} ${command}`
				: `${marker} ${presentation.icon} ${pad(record.id, idWidth)} ${pad(statusText(record), 15)} ${pad(timeText(record, now), 10)}${record.promoted ? pad("↪ promoted", 12) : pad("", 12)}${command}`;
			lines.push(th.fg(selectedRow ? "accent" : presentation.color, text));
		}
		return lines;
	}

	render(width: number): string[] {
		if (this.closed) return [];
		const th = this.theme;
		const now = Date.now();
		const hint = (id: Parameters<KeybindingsManager["getKeys"]>[0]) => this.keys.getKeys(id).join("/") || "unbound";
		const height = Math.max(4, this.height());
		const framed = width >= 4;
		const contentWidth = Math.max(1, width - (framed ? 4 : 0));
		const maxHeight = height - (framed ? 2 : 0);
		const cancelTarget = this.watchingId !== undefined ? "back to list" : "return to main session";
		const lines = [
			th.fg("accent", th.bold("Background tasks")),
			th.fg("warning", `${hint("tui.select.cancel")}: ${cancelTarget} · Read-only · Main editor inactive`),
		];
		if (this.watchingId === undefined) {
			lines.push(...this.renderList(contentWidth, now, hint));
		} else {
			const record = this.manager.get(this.watchingId);
			if (!record) {
				lines.push(th.fg("warning", `Task ${this.watchingId} no longer exists.`));
			} else {
				const presentation = STATUS_PRESENTATION[record.status];
				const pid = record.pid !== undefined ? ` · pid ${record.pid}` : "";
				lines.push(
					th.fg(
						presentation.color,
						`${presentation.icon} ${record.id} · ${statusText(record)} · ${timeText(record, now)}${pid}`,
					),
				);
				lines.push(th.fg("text", oneLine(`$ ${record.command}`)));
				const meta = [
					`cwd ${record.cwd}`,
					record.promoted ? "↪ promoted from a timed-out foreground command" : undefined,
				]
					.filter(Boolean)
					.join(" · ");
				lines.push(th.fg("muted", oneLine(meta)));
				lines.push(th.fg("dim", oneLine(`log ${record.outputPath}`)));
				if (isTerminalTaskStatus(record.status)) lines.push(th.fg("dim", outcome(record)));
				lines.push(
					th.fg(
						"dim",
						`${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} scroll · End latest${this.onCopyPath ? " · y copy log path" : ""} · ${hint("tui.select.cancel")} back`,
					),
				);
				const output = this.manager.readOutput(record.id, OUTPUT_PREVIEW_BYTES);
				const body = output.ok
					? [
							th.fg(
								"dim",
								output.value.truncated
									? `output tail (${output.value.totalBytes} B total; the log file holds everything):`
									: "output:",
							),
							...wrapTextWithAnsi(safe(output.value.output || "No output yet…"), contentWidth),
						]
					: [th.fg("warning", `Output unavailable: ${output.error.message}`)];
				const room = Math.max(1, maxHeight - lines.length - 1);
				this.scroll = Math.min(this.scroll, Math.max(0, body.length - room));
				if (this.follow) this.scroll = 0;
				const end = Math.max(room, body.length - this.scroll);
				const top = Math.max(0, end - room);
				const marker =
					body.length <= room
						? ""
						: this.follow
							? "  [latest]"
							: `  [${Math.round((top / Math.max(1, body.length - room)) * 100)}% — PgUp/PgDn, End for latest]`;
				const divider = `── output ${"─".repeat(Math.max(2, contentWidth - 11 - visibleWidth(marker)))}${th.fg("warning", marker)}`;
				lines.push(th.fg("dim", divider));
				lines.push(...body.slice(top, end));
			}
		}
		// Fill the viewport, including empty rows: this is a focused modal, not
		// transcript output. Never leave a usable-looking root editor underneath.
		const bodyLines = Array.from({ length: maxHeight }, (_, index) => {
			const line = truncateToWidth(lines[index] ?? "", contentWidth);
			if (!framed) return truncateToWidth(line, Math.max(0, width));
			return `${th.fg("accent", "│")} ${line}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))} ${th.fg("accent", "│")}`;
		});
		return framed
			? [th.fg("accent", `╭${"─".repeat(width - 2)}╮`), ...bodyLines, th.fg("accent", `╰${"─".repeat(width - 2)}╯`)]
			: bodyLines;
	}

	invalidate(): void {
		// The component has no render cache.
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.tick);
		for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
	}
}
