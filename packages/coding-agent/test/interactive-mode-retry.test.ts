import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode unlimited retry rendering", () => {
	it.each([
		"fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted address: chatgpt.com:443))",
		"Codex error: Our servers are currently overloaded. Please try again later.",
	])("removes unlimited retry errors from the transcript: %s", async (errorMessage) => {
		const component: Component & { updateContent: ReturnType<typeof vi.fn> } = {
			invalidate: vi.fn(),
			render: () => ["network error"],
			updateContent: vi.fn(),
		};
		const chatContainer = new Container();
		chatContainer.addChild(component);
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			grokView: undefined,
			streamingComponent: component,
			streamingMessage: undefined,
			chatContainer,
			pendingTools: new Map(),
			session: { autoRetryEnabled: true, retryAttempt: 0 },
			ui: { requestRender: vi.fn() },
			maybeShowCacheMissNotice: vi.fn(),
			updateTurnThinking: vi.fn(),
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "message_end";
				message: ReturnType<typeof fauxAssistantMessage>;
			},
		) => Promise<void>;
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage });

		await handleEvent.call(fakeThis, { type: "message_end", message });

		expect(chatContainer.children).not.toContain(component);
		expect(component.updateContent).not.toHaveBeenCalled();
		expect(fakeThis.streamingComponent).toBeUndefined();
	});
});
