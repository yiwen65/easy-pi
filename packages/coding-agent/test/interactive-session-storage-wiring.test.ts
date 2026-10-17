import { join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../src/config.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionManager } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

vi.mock("../src/modes/interactive/components/session-selector.ts");

type SelectorFactory = (done: () => void) => { component: Component; focus: Component };

type SessionSelectorContext = {
	runtimeHost: { services: Pick<AgentSessionRuntime["services"], "agentDir"> };
	sessionManager: Pick<SessionManager, "getSessionFile">;
	keybindings: KeybindingsManager;
	showSelector: (create: SelectorFactory) => void;
};

const prototype = InteractiveMode.prototype as unknown as {
	showSessionSelector(this: SessionSelectorContext): void;
};

describe("InteractiveMode session storage wiring", () => {
	it("passes the runtime agentDir to the resume selector and focuses the selector itself", () => {
		const agentDir = join(getAgentDir(), "custom-sdk-agent-dir");
		const currentSessionFile = join(agentDir, "sessions", "current.jsonl");
		const showSelector = vi.fn((create: SelectorFactory) => create(vi.fn()));
		const keybindings = new KeybindingsManager();

		prototype.showSessionSelector.call({
			runtimeHost: { services: { agentDir } },
			sessionManager: { getSessionFile: () => currentSessionFile },
			keybindings,
			showSelector,
		});

		expect(agentDir).not.toBe(getAgentDir());
		expect(showSelector).toHaveBeenCalledOnce();
		const selectorConstructor = vi.mocked(SessionSelectorComponent);
		expect(selectorConstructor).toHaveBeenCalledOnce();
		expect(selectorConstructor.mock.calls[0]?.[6]).toMatchObject({ agentDir, keybindings, showRenameHint: true });
		expect(selectorConstructor.mock.calls[0]?.[7]).toBe(currentSessionFile);
		const created = showSelector.mock.results[0]?.value;
		expect(created?.component).toBeInstanceOf(SessionSelectorComponent);
		expect(created?.focus).toBe(created?.component);
	});
});
