import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { Container, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { TurnTranscriptContainer } from "../src/modes/interactive/components/turn-transcript-container.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { GrokAssistantMessageComponent } from "../src/modes/interactive-grok/components/grok-assistant-message.ts";
import { GrokComponentFactory } from "../src/modes/interactive-grok/grok-component-factory.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createEventHost(component: AssistantMessageComponent = new AssistantMessageComponent()) {
	const chatContainer = new Container();
	chatContainer.addChild(component);
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		grokView: undefined,
		settingsManager: { getShowTerminalProgress: () => false },
		completeTurnGroups: vi.fn(),
		finishGrokTurnTiming: () => undefined,
		streamingComponent: component as AssistantMessageComponent | undefined,
		streamingMessage: undefined as AssistantMessage | undefined,
		chatContainer,
		pendingTools: new Map<string, { updateResult: ReturnType<typeof vi.fn> }>(),
		session: { autoRetryEnabled: true, retryAttempt: 0, abortRetry: vi.fn() },
		ui: { requestRender: vi.fn() },
		defaultEditor: { onEscape: vi.fn() as (() => void) | undefined },
		retryEscapeHandler: undefined as (() => void) | undefined,
		activeStatusIndicator: undefined as StatusIndicator | undefined,
		showStatusIndicator(indicator: StatusIndicator) {
			this.activeStatusIndicator?.dispose();
			this.activeStatusIndicator = indicator;
		},
		clearStatusIndicator(kind?: StatusIndicator["kind"]) {
			if (kind && this.activeStatusIndicator?.kind !== kind) return;
			this.activeStatusIndicator?.dispose();
			this.activeStatusIndicator = undefined;
		},
		showError: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		updateTurnThinking: vi.fn(),
	};
}

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: ReturnType<typeof createEventHost>,
	event: AgentSessionEvent,
) => Promise<void>;

const availabilityErrors = [
	"terminated (UND_ERR_SOCKET: other side closed)",
	"fetch failed (ECONNRESET: Client network socket disconnected before secure TLS connection was established)",
	"fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted address: chatgpt.com:443))",
	"Codex error: Our servers are currently overloaded. Please try again later.",
	"503 service unavailable",
];

function createReplayHost(grok: boolean) {
	const sessionManager = SessionManager.inMemory();
	return Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: {
			session: {
				sessionManager,
				modelRuntime: {},
				retryAttempt: 0,
				settingsManager: { getShowCacheMissNotices: () => false },
				extensionRunner: { getEntryRenderer: () => undefined },
			},
		},
		chatContainer: new TurnTranscriptContainer(),
		grokComponentFactory: grok ? new GrokComponentFactory() : undefined,
		pendingTools: new Map(),
		pendingSkillMentions: [],
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking",
		outputPad: 1,
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
		ui: { requestRender: vi.fn() },
	}) as {
		chatContainer: TurnTranscriptContainer;
		renderSessionItems(items: (AgentMessage | Extract<SessionEntry, { type: "custom" }>)[]): void;
		clearChatContainer(): void;
	};
}

describe("InteractiveMode bounded retry rendering", () => {
	beforeAll(() => initTheme("dark"));

	it.each(
		availabilityErrors.flatMap((errorMessage) => [
			{ errorMessage, engine: "legacy" },
			{ errorMessage, engine: "grok" },
		]),
	)("keeps $engine partial content but clears retried errors: $errorMessage", async ({ errorMessage, engine }) => {
		const component = engine === "grok" ? new GrokAssistantMessageComponent() : new AssistantMessageComponent();
		const updateContent = vi.spyOn(component, "updateContent");
		const host = createEventHost(component);
		const pendingTool = { updateResult: vi.fn() };
		host.pendingTools.set("unfinished-tool", pendingTool);
		const message = fauxAssistantMessage("partial answer", { stopReason: "error", errorMessage });
		expect(isRetryableAssistantError(message)).toBe(true);

		await handleEvent.call(host, { type: "message_end", message });

		expect(host.chatContainer.children).toContain(component);
		expect(updateContent).toHaveBeenCalledWith(message, false);
		expect(stripAnsi(host.chatContainer.render(240).join("\n"))).not.toContain(`Error: ${errorMessage}`);
		expect(pendingTool.updateResult).toHaveBeenCalledWith({
			content: [{ type: "text", text: "Response interrupted" }],
			isError: true,
		});
		expect(host.pendingTools.size).toBe(0);
		expect(host.streamingComponent).toBeUndefined();
		expect(host.streamingMessage).toBeUndefined();
		try {
			await handleEvent.call(host, {
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 10,
				delayMs: 1_000,
				errorMessage,
			});
			expect(stripAnsi(host.chatContainer.render(240).join("\n"))).not.toContain(`Error: ${errorMessage}`);
			expect(stripAnsi(host.chatContainer.render(240).join("\n"))).toContain("partial answer");
			component.invalidate();
			if (component instanceof GrokAssistantMessageComponent) component.setExpanded(true);
			expect(stripAnsi(host.chatContainer.render(240).join("\n"))).not.toContain(`Error: ${errorMessage}`);
			expect(pendingTool.updateResult).toHaveBeenLastCalledWith({
				content: [{ type: "text", text: "Response interrupted" }],
				isError: true,
			});
			expect(stripAnsi(host.activeStatusIndicator?.render(240).join("\n") ?? "")).toContain(errorMessage);
			await handleEvent.call(host, { type: "auto_retry_end", success: true, attempt: 1 });
			expect(host.activeStatusIndicator).toBeUndefined();
			expect(host.showError).not.toHaveBeenCalled();
			expect(message).toMatchObject({ stopReason: "error", errorMessage });
		} finally {
			host.activeStatusIndicator?.dispose();
		}
	});

	it("clears bounded retry status, restores interrupt, and shows the final error", async () => {
		const host = createEventHost();
		const originalEscape = host.defaultEditor.onEscape;
		try {
			await handleEvent.call(host, {
				type: "auto_retry_start",
				attempt: 2,
				maxAttempts: 10,
				delayMs: 30_000,
				errorMessage: availabilityErrors[0]!,
			});
			expect(stripAnsi(host.activeStatusIndicator?.render(120).join("\n") ?? "")).toContain(
				"Retrying (2/10) in 30s",
			);
			host.defaultEditor.onEscape?.();
			expect(host.session.abortRetry).toHaveBeenCalledOnce();

			await handleEvent.call(host, {
				type: "auto_retry_end",
				success: false,
				attempt: 2,
				finalError: availabilityErrors[0]!,
			});

			expect(host.activeStatusIndicator).toBeUndefined();
			expect(host.defaultEditor.onEscape).toBe(originalEscape);
			expect(host.showError).toHaveBeenCalledWith(`Retry failed after 2 attempts: ${availabilityErrors[0]}`);
		} finally {
			host.activeStatusIndicator?.dispose();
		}
	});

	it("shows summarization socket failures temporarily with its finite retry budget", async () => {
		const host = createEventHost();
		try {
			await handleEvent.call(host, {
				type: "summarization_retry_scheduled",
				attempt: 1,
				maxAttempts: 2,
				delayMs: 1_000,
				errorMessage: availabilityErrors[0]!,
			});
			expect(host.showError).not.toHaveBeenCalled();
			expect(stripAnsi(host.activeStatusIndicator?.render(240).join("\n") ?? "")).toContain(availabilityErrors[0]);
			expect(stripAnsi(host.activeStatusIndicator?.render(120).join("\n") ?? "")).toContain("Retrying (1/2) in 1s");
			await handleEvent.call(host, { type: "summarization_retry_finished" });
			expect(host.activeStatusIndicator).toBeUndefined();
		} finally {
			host.activeStatusIndicator?.dispose();
		}
	});

	it("keeps only one final error after the retry budget is exhausted", async () => {
		const component = new AssistantMessageComponent();
		const host = createEventHost(component);
		const errorMessage = availabilityErrors[0]!;
		await handleEvent.call(host, {
			type: "message_end",
			message: fauxAssistantMessage("partial", { stopReason: "error", errorMessage }),
		});
		await handleEvent.call(host, {
			type: "agent_end",
			messages: [fauxAssistantMessage("partial", { stopReason: "error", errorMessage })],
			willRetry: false,
		});
		expect(stripAnsi(host.chatContainer.render(200).join("\n"))).toContain(errorMessage);
		await handleEvent.call(host, { type: "auto_retry_end", success: false, attempt: 10, finalError: errorMessage });
		expect(stripAnsi(host.chatContainer.render(200).join("\n"))).not.toContain(errorMessage);
		expect(host.showError).toHaveBeenCalledExactlyOnceWith(`Retry failed after 10 attempts: ${errorMessage}`);
	});

	it.each(["legacy", "grok"])("shows the final %s failure when no retry will start", async (engine) => {
		const component = engine === "grok" ? new GrokAssistantMessageComponent() : new AssistantMessageComponent();
		const host = createEventHost(component);
		const errorMessage = availabilityErrors[0]!;
		const message = fauxAssistantMessage("partial", { stopReason: "error", errorMessage });
		await handleEvent.call(host, { type: "message_end", message });
		expect(stripAnsi(host.chatContainer.render(200).join("\n"))).not.toContain(errorMessage);
		await handleEvent.call(host, { type: "agent_end", messages: [message], willRetry: false });
		expect(stripAnsi(host.chatContainer.render(200).join("\n"))).toContain(`Error: ${errorMessage}`);
	});

	it.each([false, true])("does not restore recovered error notices when replaying history (grok %s)", (grok) => {
		const host = createReplayHost(grok);
		const first = fauxAssistantMessage("first partial", { stopReason: "error", errorMessage: availabilityErrors[0] });
		const second = fauxAssistantMessage("second partial", {
			stopReason: "error",
			errorMessage: availabilityErrors[1],
		});
		try {
			host.renderSessionItems([
				{ role: "user", content: "test", timestamp: 0 },
				first,
				second,
				fauxAssistantMessage("recovered"),
			]);
			const text = stripAnsi(host.chatContainer.render(240).join("\n"));
			expect(text).toContain("first partial");
			expect(text).toContain("second partial");
			expect(text).toContain("recovered");
			expect(text).not.toContain("Error:");
			expect(first.errorMessage).toBe(availabilityErrors[0]);
			expect(second.errorMessage).toBe(availabilityErrors[1]);
		} finally {
			host.clearChatContainer();
		}
	});

	it.each([false, true])("replay retains terminal and non-retryable failures (grok %s)", (grok) => {
		const host = createReplayHost(grok);
		try {
			host.renderSessionItems([
				{ role: "user", content: "first", timestamp: 0 },
				fauxAssistantMessage("", { stopReason: "error", errorMessage: availabilityErrors[0] }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
				{ role: "user", content: "second", timestamp: 1 },
				fauxAssistantMessage("", { stopReason: "error", errorMessage: availabilityErrors[1] }),
			]);
			const text = stripAnsi(host.chatContainer.render(240).join("\n"));
			expect(text).not.toContain(availabilityErrors[0]);
			expect(text).toContain("invalid_api_key");
			expect(text).toContain(availabilityErrors[1]);
		} finally {
			host.clearChatContainer();
		}
	});

	it("does not hide a terminal failure across a recorded turn boundary", () => {
		const host = createReplayHost(true);
		try {
			host.renderSessionItems([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: availabilityErrors[0] }),
				{
					type: "custom",
					customType: "pi-turn-duration",
					id: "duration",
					parentId: null,
					timestamp: "2026-10-09T00:00:00Z",
					data: { durationMs: 100 },
				},
				fauxAssistantMessage("later response"),
			]);
			expect(stripAnsi(host.chatContainer.render(200).join("\n"))).toContain(availabilityErrors[0]);
		} finally {
			host.clearChatContainer();
		}
	});

	it.each(
		availabilityErrors.flatMap((errorMessage) => [
			{ mode: "regular", errorMessage },
			{ mode: "fullscreen", errorMessage },
		]),
	)("clears the temporary notice from the $mode terminal: $errorMessage", async ({ mode, errorMessage }) => {
		const terminal = new VirtualTerminal(160, 24);
		const ui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
		const host = createEventHost();
		ui.addChild({
			render: (width) => [...host.chatContainer.render(width), ...(host.activeStatusIndicator?.render(width) ?? [])],
			invalidate() {},
		});
		ui.start();
		try {
			await handleEvent.call(host, {
				type: "message_end",
				message: fauxAssistantMessage("partial answer", {
					stopReason: "error",
					errorMessage,
				}),
			});
			ui.renderNow();
			await terminal.flush();
			expect(terminal.getScrollBuffer().join("\n")).not.toContain(errorMessage);
			await handleEvent.call(host, {
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 10,
				delayMs: 1_000,
				errorMessage,
			});
			ui.renderNow();
			await terminal.flush();
			expect(terminal.getViewport().join("\n")).toContain(errorMessage);
			await handleEvent.call(host, { type: "auto_retry_end", success: true, attempt: 1 });
			ui.renderNow();
			await terminal.flush();
			expect(terminal.getScrollBuffer().join("\n")).not.toContain(errorMessage);
			expect(terminal.getViewport().join("\n")).toContain("partial answer");
		} finally {
			host.activeStatusIndicator?.dispose();
			ui.stop();
			await terminal.flush();
		}
	});
});
