import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	type Focusable,
	Input,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { CollaborationError } from "@easy-pi/subagent/collaboration-contract";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { PiCollaborationMonitor } from "../../../extensions/pi-collaboration-monitor.ts";
import type { Theme } from "../../interactive/theme/theme.ts";

const safe = (text: string) =>
	stripVTControlCharacters(text)
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.replace(/\t/g, "    ");
const oneLine = (text: string) => safe(text).replace(/\s+/g, " ");

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
	private notice = "";
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
		this.notice = "";
		const path = this.path();
		void this.monitor.readHistory(path).catch(() => {
			if (!this.closed && this.path() === path) {
				this.notice =
					"Retained preview unavailable (missing, unsafe or over 4 MiB); inspect the session file separately.";
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
			this.composing = undefined;
			this.input.setValue("");
		} catch (error) {
			this.notice = `Action rejected: ${error instanceof CollaborationError ? error.code : "unavailable"}. Draft retained; nothing is retried automatically.`;
		} finally {
			this.busy = false;
			this.focused = this.focus;
			if (!this.closed) this.requestRender();
		}
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
			else if (this.keys.matches(data, "tui.select.confirm")) {
				if (this.path() === "/root") this.close();
				else this.open();
			}
		} else if (this.keys.matches(data, "app.agents.previous") || this.keys.matches(data, "app.agents.next")) {
			const delta = this.keys.matches(data, "app.agents.next") ? 1 : -1;
			this.selected = Math.max(0, Math.min(this.monitor.list().length - 1, this.selected + delta));
			if (this.path() === "/root") this.close();
			else this.open();
		} else if (this.keys.matches(data, "tui.select.pageUp")) this.scroll += Math.max(1, this.height() - 9);
		else if (this.keys.matches(data, "tui.select.pageDown"))
			this.scroll = Math.max(0, this.scroll - Math.max(1, this.height() - 9));
		else if (this.keys.matches(data, "app.agents.message")) this.composing = "send";
		else if (this.keys.matches(data, "app.agents.followup")) this.composing = "followup";
		else if (this.keys.matches(data, "app.agents.interrupt")) this.composing = "interrupt";
		this.focused = this.focus;
		if (!this.closed) this.requestRender();
	}
	render(width: number): string[] {
		if (this.closed) return [];
		const th = this.theme;
		const hint = (id: Parameters<KeybindingsManager["getKeys"]>[0]) => this.keys.getKeys(id).join("/") || "unbound";
		const rows = this.monitor.list();
		const height = Math.max(4, this.height());
		const framed = width >= 4;
		const contentWidth = Math.max(1, width - (framed ? 4 : 0));
		const maxHeight = height - (framed ? 2 : 0);
		const cancelTarget = this.composing ? "cancel action" : this.watching ? "back to list" : "return to main session";
		const lines = [
			th.fg("accent", th.bold("Agents — shared workspace")),
			th.fg("warning", `${hint("tui.select.cancel")}: ${cancelTarget} · Main editor inactive`),
		];
		if (!this.watching) {
			lines.push(
				th.fg(
					"dim",
					`${hint("tui.select.up")}/${hint("tui.select.down")} select · ${hint("tui.select.confirm")} watch · ${hint("tui.select.cancel")} root`,
				),
			);
			const available = Math.max(1, maxHeight - lines.length - 1);
			const start = Math.max(0, this.selected - available + 1);
			for (const [index, row] of rows.slice(start, start + available).entries()) {
				const label = `${start + index === this.selected ? ">" : " "} ${row.task_name}  ${row.status}  ${row.loaded ? "loaded" : "unloaded"}${row.task_name === "/root" ? " — return to main session" : ""}`;
				lines.push(th.fg(start + index === this.selected ? "accent" : "text", label));
			}
			if (rows.length === 1)
				lines.push(th.fg("muted", "No child agents yet. Ask root to delegate with spawn_agent."));
		} else {
			const view = this.monitor.view(this.path());
			lines.push(th.fg("accent", `${view.path} · ${view.status} · ${view.loaded ? "loaded" : "unloaded"}`));
			lines.push(th.fg("muted", oneLine(view.model)));
			lines.push(
				th.fg(
					"dim",
					oneLine(
						`History: ${view.sessionFile ?? "memory only"} · bounded preview (last 100 initial messages / 64 Ki characters)`,
					),
				),
			);
			lines.push(
				th.fg(
					"dim",
					`${hint("app.agents.previous")}/${hint("app.agents.next")} agent · ${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} scroll · ${hint("tui.select.cancel")} list`,
				),
			);
			lines.push(
				th.fg(
					"dim",
					`${hint("app.agents.message")} message · ${hint("app.agents.followup")} new task · ${hint("app.agents.interrupt")} interrupt`,
				),
			);
			const body = wrapTextWithAnsi(safe(view.text || "Waiting for session activity…"), contentWidth);
			const room = Math.max(1, maxHeight - lines.length - (this.composing ? 3 : 1));
			this.scroll = Math.min(this.scroll, Math.max(0, body.length - room));
			const end = Math.max(room, body.length - this.scroll);
			lines.push(...body.slice(Math.max(0, end - room), end));
			if (this.composing) {
				lines.push(
					th.fg(
						"warning",
						this.composing === "interrupt"
							? `Interrupt ${view.path}? ${hint("tui.select.confirm")} confirm; edits are retained.`
							: `${this.composing === "send" ? "Message (does not start idle agent)" : "New task (idle child only)"} → ${view.path}`,
					),
				);
				if (this.composing !== "interrupt") lines.push(...this.input.render(contentWidth));
			}
		}
		if (this.notice || this.busy) lines.push(th.fg("warning", oneLine(this.busy ? "Submitting…" : this.notice)));
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
