import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Component,
	type Focusable,
	Input,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SideConversation } from "../../../core/side-conversation-types.ts";
import type { Theme } from "../../interactive/theme/theme.ts";

function safe(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.replace(/\t/g, "    ");
}

function messageText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return `you: ${typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n")}`;
		case "assistant":
			return message.content
				.map((part) => {
					if (part.type === "text") return `side: ${part.text}`;
					if (part.type === "toolCall") return `tool: ${part.name}`;
					return "";
				})
				.filter(Boolean)
				.join("\n");
		case "toolResult":
			return `${message.isError ? "tool error" : "tool"} ${message.toolName}: ${message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n")}`;
		default:
			return "";
	}
}

/** Focused side-only input. Disposing the view never closes or aborts its session. */
export class GrokSidePanel implements Component, Focusable {
	private readonly conversation: SideConversation;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly done: () => void;
	private readonly height: () => number;
	private readonly unsubscribe: () => void;
	private readonly input = new Input();
	private disposed = false;
	private submitting = false;
	private closing = false;
	private aborting = false;
	private notice = "";
	private scroll = 0;
	private follow = true;
	private bodyHeight = 1;
	private focusedValue = false;

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		this.input.focused = value && !this.closing;
	}

	constructor(options: {
		conversation: SideConversation;
		theme: Theme;
		keybindings: KeybindingsManager;
		requestRender: () => void;
		done: () => void;
		height: () => number;
	}) {
		this.conversation = options.conversation;
		this.theme = options.theme;
		this.keys = options.keybindings;
		this.requestRender = options.requestRender;
		this.done = options.done;
		this.height = options.height;
		this.unsubscribe = this.conversation.subscribe(() => {
			if (!this.disposed) this.requestRender();
		});
	}

	private async submit(): Promise<void> {
		const text = this.input.getValue().trim();
		if (!text || this.disposed) return;
		const state = this.conversation.snapshot.state;
		if (this.submitting || this.closing || ["starting", "running", "closing"].includes(state)) {
			this.notice = "Wait for the side answer, or cancel it first. Draft retained.";
			this.requestRender();
			return;
		}
		this.submitting = true;
		this.notice = "";
		this.input.setValue("");
		this.follow = true;
		this.requestRender();
		try {
			await this.conversation.prompt(text);
		} catch (error) {
			if (!this.disposed) {
				this.notice = error instanceof Error ? error.message : String(error);
				if (!this.input.getValue()) this.input.setValue(text);
			}
		} finally {
			this.submitting = false;
			if (!this.disposed) this.requestRender();
		}
	}

	private async closeConversation(): Promise<void> {
		if (this.closing || this.disposed) return;
		this.closing = true;
		this.notice = "Closing side conversation...";
		this.focused = this.focusedValue;
		this.requestRender();
		try {
			await this.conversation.close();
			if (this.conversation.snapshot.state === "cleanup-failed") {
				this.notice = this.conversation.snapshot.error ?? "Side resource cleanup is incomplete.";
				return;
			}
			this.hide();
		} catch (error) {
			if (!this.disposed) this.notice = error instanceof Error ? error.message : String(error);
		} finally {
			this.closing = false;
			this.focused = this.focusedValue;
			if (!this.disposed) this.requestRender();
		}
	}

	private async abortConversation(): Promise<void> {
		if (this.aborting || this.closing || this.disposed) return;
		this.aborting = true;
		this.notice = "Cancelling side answer...";
		this.requestRender();
		try {
			await this.conversation.abort();
			if (!this.disposed) this.notice = "Side answer cancelled. Main task was not interrupted.";
		} catch (error) {
			if (!this.disposed) this.notice = error instanceof Error ? error.message : String(error);
		} finally {
			this.aborting = false;
			if (!this.disposed) this.requestRender();
		}
	}

	/** Return to the original editor; the owner keeps the side available for /side or /btw. */
	hide(): void {
		if (this.disposed) return;
		this.dispose();
		this.done();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.keys.matches(data, "app.side.hide")) {
			this.hide();
			return;
		}
		if (this.keys.matches(data, "app.side.close")) {
			void this.closeConversation();
			return;
		}
		if (this.keys.matches(data, "app.side.abort")) {
			void this.abortConversation();
			return;
		}
		if (this.keys.matches(data, "tui.select.pageUp")) {
			this.follow = false;
			this.scroll = Math.max(0, this.scroll - Math.max(1, this.bodyHeight - 1));
		} else if (this.keys.matches(data, "tui.select.pageDown")) {
			this.follow = false;
			this.scroll += Math.max(1, this.bodyHeight - 1);
		} else if (this.keys.matches(data, "app.side.latest")) {
			this.follow = true;
		} else if (this.keys.matches(data, "tui.input.submit")) {
			void this.submit();
			return;
		} else if (!this.closing) {
			this.input.handleInput(data);
		}
		this.requestRender();
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const height = Math.max(1, Math.floor(this.height()));
		const snapshot = this.conversation.snapshot;
		const clip = (line: string) => truncateToWidth(line, width, "…");
		const framed = (line: string) => {
			const text = clip(line);
			return this.theme.bg("selectedBg", text + " ".repeat(Math.max(0, width - visibleWidth(text))));
		};
		const header = framed(
			this.theme.fg("accent", this.theme.bold("Side conversation — parent permissions · shared workspace")),
		);
		const hints = clip(
			this.theme.fg(
				"dim",
				`${this.keys.getKeys("app.side.hide").join("/") || "unbound"} return · ${this.keys.getKeys("app.side.abort").join("/") || "unbound"} cancel · ${this.keys.getKeys("app.side.close").join("/") || "unbound"} close`,
			),
		);
		const editor = this.input.render(Math.max(1, width - 2)).map((line) => clip(`> ${line}`));
		if (height === 1) return [header];
		if (height === 2) return [header, editor[0] ?? ">"];
		if (height === 3) return [header, editor[0] ?? ">", hints];
		const { input, cacheRead, cacheWrite } = snapshot.usage;
		const meta = clip(
			this.theme.fg(
				"muted",
				`${snapshot.state} · main ${snapshot.parentRunning ? "running" : "idle"} · input ${input} · cache read ${cacheRead} / write ${cacheWrite} (observed)`,
			),
		);
		this.bodyHeight = height - 4;
		const transcript = snapshot.messages.flatMap((message) => {
			const text = safe(messageText(message));
			return text ? wrapTextWithAnsi(text, width) : [];
		});
		if (!transcript.length)
			transcript.push(...wrapTextWithAnsi("Ask a side question. The main task keeps running.", width));
		const notice = safe(this.notice || snapshot.error || "");
		const notices = notice
			? wrapTextWithAnsi(this.theme.fg("warning", notice), width).slice(0, Math.min(2, this.bodyHeight))
			: [];
		const available = Math.max(0, this.bodyHeight - notices.length);
		const maxScroll = Math.max(0, transcript.length - available);
		this.scroll = this.follow ? maxScroll : Math.min(this.scroll, maxScroll);
		const body = [...notices, ...transcript.slice(this.scroll, this.scroll + available)];
		while (body.length < this.bodyHeight) body.push("");
		return [header, meta, ...body, editor[0] ?? ">", hints].map(clip);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.focused = false;
		this.unsubscribe();
	}
}
