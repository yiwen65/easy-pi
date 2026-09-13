import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	type Focusable,
	Input,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatCollaborationError } from "@easy-pi/subagent/collaboration-contract";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type {
	AgentListRow,
	AgentRowState,
	PiCollaborationMonitor,
} from "../../../extensions/pi-collaboration-monitor.ts";
import type { Theme } from "../../interactive/theme/theme.ts";

const safe = (text: string) =>
	stripVTControlCharacters(text)
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.replace(/\t/g, "    ");
const oneLine = (text: string) => safe(text).replace(/\s+/g, " ");

/** Below this width the panel switches to a compact single-line list layout. */
const COMPACT_WIDTH = 60;
/** Fixed notice area height; longer notices are truncated instead of squeezing the conversation. */
const NOTICE_LINES = 2;

const STATE_PRESENTATION: Record<
	AgentRowState,
	{ icon: string; word: string; color: "success" | "warning" | "error" | "muted" | "dim" }
> = {
	pending: { icon: "◌", word: "Pending", color: "dim" },
	running: { icon: "●", word: "Running", color: "success" },
	idle: { icon: "○", word: "Idle", color: "dim" },
	completed: { icon: "✓", word: "Done", color: "dim" },
	failed: { icon: "✗", word: "Failed", color: "error" },
	interrupted: { icon: "⏸", word: "Interrupted", color: "warning" },
	closed: { icon: "■", word: "Closed", color: "muted" },
};

function durationText(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** Running agents show active duration; settled agents show how long ago their last activity was. */
function rowTime(row: AgentListRow, now: number): string {
	const active = row.state === "running" || row.state === "pending" || row.state === "idle";
	if (row.lastActivityAt === undefined) return "";
	return active ? `${durationText(now - row.lastActivityAt)} active` : `${durationText(now - row.lastActivityAt)} ago`;
}

function pad(text: string, width: number): string {
	const padding = width - visibleWidth(text);
	return padding > 0 ? text + " ".repeat(padding) : text;
}

/** Recolor the [role] prefixes produced by the monitor's message projection into scannable labels. */
function roleLine(line: string, th: Theme): string {
	const label = (text: string, color: "accent" | "success" | "warning") =>
		`${th.fg(color, pad(text, 7))}${th.fg("text", "│")}`;
	const toolResult = line.match(/^\[toolResult (\S+) (\w+)\](.*)$/);
	if (toolResult)
		return `${label(`⚙ ${toolResult[1]}`, "warning")}${th.fg("dim", `${toolResult[2]}${toolResult[3]}`)}`;
	const tool = line.match(/^\[tool (\S+) (\w+)\](.*)$/);
	if (tool) return `${label(`⚙ ${tool[1]}`, "warning")}${th.fg("dim", `${tool[2]}${tool[3]}`)}`;
	const bash = line.match(/^\[bash\](.*)$/);
	if (bash) return `${label("⚙ bash", "warning")}${th.fg("dim", bash[1])}`;
	const user = line.match(/^\[user\](.*)$/);
	if (user) return `${label("you", "accent")}${th.fg("text", user[1])}`;
	const assistant = line.match(/^\[assistant\](.*)$/);
	if (assistant) return `${label("agent", "success")}${th.fg("text", assistant[1])}`;
	return th.fg("dim", line);
}

/** Focused overlay: closing it returns to the untouched root editor/runtime. */
export class GrokAgentsPanel implements Component, Focusable {
	private readonly monitor: PiCollaborationMonitor;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: () => void;
	private readonly height: () => number;
	private readonly unsubscribe: () => void;
	private readonly input = new Input();
	private readonly cancellation = new AbortController();
	private selected = 0;
	private watching = false;
	private composing: "send" | "followup" | "interrupt" | undefined;
	private scroll = 0;
	private follow = true;
	private notice = "";
	private noticeError = false;
	private busy = false;
	private closed = false;
	private focus = false;
	get focused(): boolean {
		return this.focus;
	}
	set focused(value: boolean) {
		this.focus = value;
		this.input.focused = value && !!this.composing;
	}

	constructor(options: {
		monitor: PiCollaborationMonitor;
		theme: Theme;
		keybindings: KeybindingsManager;
		requestRender: () => void;
		done: () => void;
		height: () => number;
	}) {
		this.monitor = options.monitor;
		this.theme = options.theme;
		this.keys = options.keybindings;
		this.requestRender = options.requestRender;
		this.done = options.done;
		this.height = options.height;
		this.unsubscribe = this.monitor.subscribe(() => {
			if (this.monitor.isClosed) {
				this.close();
				return;
			}
			if (!this.closed) this.requestRender();
		});
		this.input.onSubmit = (text) => {
			void this.submit(text);
		};
	}
	private close(): void {
		if (!this.closed) {
			this.dispose();
			this.done();
		}
	}
	private path(): string {
		return this.monitor.list()[this.selected]?.task_name ?? "/root";
	}
	private open(): void {
		this.watching = true;
		this.scroll = 0;
		this.follow = true;
		this.notice = "";
		const path = this.path();
		void this.monitor.readHistory(path).catch(() => {
			if (!this.closed && this.path() === path) {
				this.notice =
					"Retained preview unavailable (missing, unsafe or over 4 MiB); inspect the session file separately.";
				this.noticeError = true;
				this.requestRender();
			}
		});
	}
	private async submit(text: string): Promise<void> {
		const action = this.composing;
		if (!action || this.busy) return;
		const path = this.path(); // Pin the target before any await or selection change.
		this.busy = true;
		this.requestRender();
		try {
			this.notice = await this.monitor.act(path, action, text, this.cancellation.signal);
			this.noticeError = false;
			this.composing = undefined;
			this.input.setValue("");
		} catch (error) {
			this.notice = `Action rejected: ${formatCollaborationError(error)} Draft retained; nothing is retried automatically.`;
			this.noticeError = true;
		} finally {
			this.busy = false;
			this.focused = this.focus;
			if (!this.closed) this.requestRender();
		}
	}

	/** Cycle through child agents only; /root is skipped and the panel never closes from cycling. */
	private cycle(delta: number): void {
		const children = this.monitor.list().filter((row) => row.task_name !== "/root");
		if (children.length === 0) return;
		const current = children.findIndex((row) => row.task_name === this.path());
		const next = children[(current + delta + children.length) % children.length] ?? children[0];
		this.selected = this.monitor.list().findIndex((row) => row.task_name === next.task_name);
		this.open();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.keys.matches(data, "tui.select.cancel")) {
			if (this.composing && !this.busy) {
				this.composing = undefined;
				this.focused = this.focus;
			} else if (this.watching && !this.busy) {
				this.watching = false;
			} else this.close();
		} else if (this.busy) return;
		else if (this.composing) {
			if (this.composing === "interrupt") {
				if (this.keys.matches(data, "tui.select.confirm")) void this.submit("");
			} else this.input.handleInput(data);
		} else if (!this.watching) {
			if (this.keys.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
			else if (this.keys.matches(data, "tui.select.down"))
				this.selected = Math.min(this.monitor.list().length - 1, this.selected + 1);
			else if (this.keys.matches(data, "tui.select.pageUp"))
				this.selected = Math.max(0, this.selected - Math.max(1, this.height() - 9));
			else if (this.keys.matches(data, "tui.select.pageDown"))
				this.selected = Math.min(this.monitor.list().length - 1, this.selected + Math.max(1, this.height() - 9));
			else if (this.keys.matches(data, "tui.select.confirm")) {
				// Inspecting /root is meaningless and never closes the panel implicitly.
				if (this.path() !== "/root") this.open();
			} else if (
				this.keys.matches(data, "app.agents.message") ||
				this.keys.matches(data, "app.agents.followup") ||
				this.keys.matches(data, "app.agents.interrupt")
			) {
				this.startComposing(data);
			}
		} else if (this.keys.matches(data, "app.agents.previous") || this.keys.matches(data, "app.agents.next")) {
			this.cycle(this.keys.matches(data, "app.agents.next") ? 1 : -1);
		} else if (this.keys.matches(data, "tui.select.pageUp")) {
			this.follow = false;
			this.scroll += Math.max(1, this.height() - 9);
		} else if (this.keys.matches(data, "tui.select.pageDown")) {
			this.scroll = Math.max(0, this.scroll - Math.max(1, this.height() - 9));
			if (this.scroll === 0) this.follow = true;
		} else if (data === "\x1b[F" || data === "\x1b[4~") {
			this.follow = true;
			this.scroll = 0;
		} else if (
			this.keys.matches(data, "app.agents.message") ||
			this.keys.matches(data, "app.agents.followup") ||
			this.keys.matches(data, "app.agents.interrupt")
		) {
			this.startComposing(data);
		}
		this.focused = this.focus;
		if (!this.closed) this.requestRender();
	}

	private startComposing(data: string): void {
		if (this.path() === "/root") {
			this.notice = "Select a child agent first; /root is this session.";
			this.noticeError = true;
			return;
		}
		if (this.keys.matches(data, "app.agents.message")) this.composing = "send";
		else if (this.keys.matches(data, "app.agents.followup")) this.composing = "followup";
		else if (this.keys.matches(data, "app.agents.interrupt")) this.composing = "interrupt";
		this.focused = this.focus;
	}

	private renderList(
		width: number,
		now: number,
		hint: (id: Parameters<KeybindingsManager["getKeys"]>[0]) => string,
	): string[] {
		const th = this.theme;
		const rows = this.monitor.list();
		this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
		const running = rows.filter((row) => row.state === "running").length;
		const idle = rows.filter((row) => row.state === "idle" || row.state === "pending").length;
		const settled = rows.length - running - idle;
		const lines: string[] = [];
		lines.push(
			th.fg(
				"dim",
				`${running} running · ${idle} idle · ${settled} settled — ${hint("tui.select.up")}/${hint("tui.select.down")} select · ${hint("tui.select.confirm")} inspect · ${hint("app.agents.message")} message · ${hint("app.agents.followup")} new task · ${hint("app.agents.interrupt")} interrupt`,
			),
		);
		if (rows.length === 1) {
			lines.push("");
			lines.push(th.fg("muted", "No child agents yet. Ask root to delegate with spawn_agent."));
		}
		const compact = width < COMPACT_WIDTH;
		for (const [index, row] of rows.entries()) {
			const presentation = STATE_PRESENTATION[row.state];
			const selectedRow = index === this.selected;
			const marker = selectedRow ? "›" : " ";
			const suffix = row.task_name === "/root" ? "you are here" : oneLine(row.model);
			const time = rowTime(row, now);
			const text = compact
				? `${marker} ${presentation.icon} ${row.task_name} ${presentation.word} ${time}`
				: `${marker} ${presentation.icon} ${pad(row.task_name, 22)} ${pad(presentation.word, 12)} ${pad(time, 12)} ${suffix}`;
			lines.push(th.fg(selectedRow ? "accent" : presentation.color, text));
			const summary = row.resultSummary ?? row.objective;
			if (summary && row.task_name !== "/root") {
				lines.push(th.fg("dim", `    ${oneLine(summary)}`));
			}
		}
		return lines;
	}

	render(width: number): string[] {
		if (this.closed) return [];
		const th = this.theme;
		const hint = (id: Parameters<KeybindingsManager["getKeys"]>[0]) => this.keys.getKeys(id).join("/") || "unbound";
		const height = Math.max(4, this.height());
		const framed = width >= 4;
		const contentWidth = Math.max(1, width - (framed ? 4 : 0));
		const maxHeight = height - (framed ? 2 : 0);
		const notice =
			this.notice || this.busy
				? wrapTextWithAnsi(oneLine(this.busy ? "Submitting…" : this.notice), contentWidth).slice(0, NOTICE_LINES)
				: [];
		const cancelTarget = this.composing ? "cancel action" : this.watching ? "back to list" : "return to main session";
		const lines = [
			th.fg("accent", th.bold("Agents — shared workspace")),
			th.fg("warning", `${hint("tui.select.cancel")}: ${cancelTarget} · Main editor inactive`),
		];
		if (!this.watching) {
			lines.push(...this.renderList(contentWidth, Date.now(), hint));
		} else {
			const view = this.monitor.view(this.path());
			const presentation = STATE_PRESENTATION[view.state];
			lines.push(
				th.fg(
					presentation.color,
					`${presentation.icon} ${view.path} · ${presentation.word} · ${oneLine(view.model)}`,
				),
			);
			if (view.objective) lines.push(th.fg("text", oneLine(`Task: ${view.objective}`)));
			lines.push(
				th.fg(
					"muted",
					oneLine(
						`History: ${view.loaded ? "loaded" : "not loaded"} · preview last 100 msgs/64 KiB · ${view.sessionFile ?? "memory only"}`,
					),
				),
			);
			lines.push(
				th.fg(
					"dim",
					`${hint("app.agents.previous")}/${hint("app.agents.next")} agent · ${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} scroll · End latest · ${hint("tui.select.cancel")} list`,
				),
			);
			lines.push(
				th.fg(
					"dim",
					`${hint("app.agents.message")} message · ${hint("app.agents.followup")} new task · ${hint("app.agents.interrupt")} interrupt`,
				),
			);
			const body = wrapTextWithAnsi(safe(view.text || "Waiting for session activity…"), contentWidth).map((line) =>
				roleLine(line, th),
			);
			const room = Math.max(1, maxHeight - lines.length - 1 - (this.composing ? 2 : 0) - notice.length);
			this.scroll = Math.min(this.scroll, Math.max(0, body.length - room));
			if (this.follow) this.scroll = 0;
			const end = Math.max(room, body.length - this.scroll);
			const top = Math.max(0, end - room);
			const marker =
				body.length <= room
					? ""
					: this.follow
						? "  [latest]"
						: `  [${Math.round((top / Math.max(1, body.length - room)) * 100)}% — End for latest]`;
			const divider = `── conversation ${"─".repeat(Math.max(2, contentWidth - 18 - visibleWidth(marker)))}${th.fg("warning", marker)}`;
			lines.push(th.fg("dim", divider));
			lines.push(...body.slice(top, end));
		}
		if (this.composing) {
			const target = this.path();
			lines.push(
				th.fg(
					"warning",
					this.composing === "interrupt"
						? `Interrupt ${target}? Its current turn stops; history is kept. ${hint("tui.select.confirm")} confirm · ${hint("tui.select.cancel")} cancel`
						: this.composing === "send"
							? `Message → ${target} (won't start an idle agent)`
							: `New task → ${target} (starts it if idle; inherits its context) — task JSON (task, context=existing, capabilities)`,
				),
			);
			if (this.composing !== "interrupt") lines.push(...this.input.render(contentWidth));
		}
		lines.push(...notice.map((line) => th.fg(this.noticeError ? "error" : "success", line)));
		// Fill the viewport, including empty rows: this is a focused modal, not
		// transcript output. Never leave a usable-looking root editor underneath.
		const body = Array.from({ length: maxHeight }, (_, index) => {
			const line = truncateToWidth(lines[index] ?? "", contentWidth);
			if (!framed) return truncateToWidth(line, Math.max(0, width));
			return `${th.fg("accent", "│")} ${line}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))} ${th.fg("accent", "│")}`;
		});
		return framed
			? [th.fg("accent", `╭${"─".repeat(width - 2)}╮`), ...body, th.fg("accent", `╰${"─".repeat(width - 2)}╯`)]
			: body;
	}
	invalidate(): void {
		this.input.invalidate();
	}
	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.cancellation.abort();
		this.unsubscribe();
	}
}
