import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { GrokAssistantMessageComponent } from "../src/modes/interactive-grok/components/grok-assistant-message.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createEventHost(component: AssistantMessageComponent = new AssistantMessageComponent()) {
	const chatContainer = new Container();
	chatContainer.addChild(component);
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		grokView: undefined,
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
	"fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted address: chatgpt.com:443))",
	"Codex error: Our servers are currently overloaded. Please try again later.",
	"503 service unavailable",
];

describe("InteractiveMode bounded retry rendering", () => {
	beforeAll(() => initTheme("dark"));

	it.each(
		availabilityErrors.flatMap((errorMessage) => [
			{ errorMessage, engine: "legacy" },
			{ errorMessage, engine: "grok" },
		]),
	)("keeps $engine failed messages visible: $errorMessage", async ({ errorMessage, engine }) => {
		const component = engine === "grok" ? new GrokAssistantMessageComponent() : new AssistantMessageComponent();
		const updateContent = vi.spyOn(component, "updateContent");
		const host = createEventHost(component);
		const pendingTool = { updateResult: vi.fn() };
		host.pendingTools.set("unfinished-tool", pendingTool);
		const message = fauxAssistantMessage("partial answer", { stopReason: "error", errorMessage });

		await handleEvent.call(host, { type: "message_end", message });

		expect(host.chatContainer.children).toContain(component);
		expect(updateContent).toHaveBeenCalledWith(message, false);
		expect(stripAnsi(host.chatContainer.render(240).join("\n"))).toContain(`Error: ${errorMessage}`);
		expect(pendingTool.updateResult).toHaveBeenCalledWith({
			content: [{ type: "text", text: errorMessage }],
			isError: true,
		});
		expect(host.pendingTools.size).toBe(0);
		expect(host.streamingComponent).toBeUndefined();
		expect(host.streamingMessage).toBeUndefined();
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

	it("shows summarization socket failures and its finite retry budget", async () => {
		const host = createEventHost();
		try {
			await handleEvent.call(host, {
				type: "summarization_retry_scheduled",
				attempt: 1,
				maxAttempts: 2,
				delayMs: 1_000,
				errorMessage: availabilityErrors[0]!,
			});
			expect(host.showError).toHaveBeenCalledWith(availabilityErrors[0]);
			expect(stripAnsi(host.activeStatusIndicator?.render(120).join("\n") ?? "")).toContain("Retrying (1/2) in 1s");
			await handleEvent.call(host, { type: "summarization_retry_finished" });
			expect(host.activeStatusIndicator).toBeUndefined();
		} finally {
			host.activeStatusIndicator?.dispose();
		}
	});
});
