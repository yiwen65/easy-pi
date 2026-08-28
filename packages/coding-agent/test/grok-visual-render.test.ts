import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { type GrokChromeTheme, GrokComponentFactory } from "../src/modes/interactive-grok/grok-component-factory.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const identity = (text: string) => text;
const identityTheme: GrokChromeTheme = {
	text: identity,
	accent: identity,
	muted: identity,
	dim: identity,
	border: identity,
	success: identity,
	warning: identity,
	error: identity,
	thinkingLevel: (_level, text) => text,
};

class FixedComponent implements Component {
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return [this.text.slice(0, width)];
	}
}

function renderRegular(components: readonly Component[], width: number): string[] {
	return components.flatMap((component) => component.render(width));
}

function createGoldenSession(): AgentSession {
	return {
		state: {
			model: { id: "fixture", provider: "test", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: { input: 800, output: 120, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
			getSessionName: () => null,
			getCwd: () => "/workspace",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 42 }),
		modelRuntime: { isUsingSubscription: () => false },
		autoCompactionEnabled: true,
	} as unknown as AgentSession;
}

function createGoldenFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

describe("Grok visual contract", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => initTheme("dark"));

	test("matches the stable 40-column shell golden", () => {
		const factory = new GrokComponentFactory(identityTheme);
		const view = factory.createInteractiveView({
			document: new FixedComponent("transcript"),
			transcriptViewport: new FixedComponent("transcript viewport"),
			editorHost: new FixedComponent("Build anything"),
			location: { path: "/workspace" },
			contextPercent: 42,
			session: createGoldenSession(),
			footerData: createGoldenFooterData(),
		});

		expect(renderRegular(view.regularComponents, 40)).toEqual([
			"/workspace                    ███░░░ 42%",
			"transcript",
			"",
			"╭──────────────────────────────────────╮",
			"│❯ Build anything                      │",
			"╰──────────────────────────────────────╯",
			"↑800 ↓120 42.0%/200k (auto)      fixture",
		]);
		view.dispose();
	});

	test("keeps Pi inline UI replacements inside the Grok composer chrome", () => {
		const host = new Container();
		host.addChild(new Text("editor", 0, 0));
		const frame = new GrokComponentFactory(identityTheme).createEditorFrame(host);
		expect(frame.render(40).join("\n")).toContain("❯ editor");

		host.clear();
		host.addChild(new Text("Allow extension tool?  Yes / No", 0, 0));
		const confirm = frame.render(40).join("\n");
		expect(confirm).toContain("Allow extension tool?  Yes / No");
		expect(confirm).toContain("╭");
		expect(confirm).toContain("╰──────────────────────────────────────╯");

		host.clear();
		host.addChild(new Text("custom extension editor", 0, 0));
		expect(frame.render(40).join("\n")).toContain("❯ custom extension editor");
	});

	test("preserves plain layout while dark and light themes produce different styles", () => {
		const topBar = new GrokComponentFactory().createTopBar({ path: "/workspace" }, 10);
		initTheme("dark");
		const dark = topBar.render(40)[0] ?? "";
		initTheme("light");
		const light = topBar.render(40)[0] ?? "";

		expect(stripAnsi(dark)).toBe(stripAnsi(light));
		expect(dark).not.toBe(light);
	});

	test("exposes positive Grok signatures that a plain Pi component tree does not invent", () => {
		const factory = new GrokComponentFactory(identityTheme);
		const shell = [
			...factory.createEditorFrame(new FixedComponent("prompt")).render(40),
			...factory.createStatus({ kind: "working", label: "Responding…" }).render(40),
		].join("\n");
		const plainPi = new Container();
		plainPi.addChild(new Text("prompt", 0, 0));
		const legacy = plainPi.render(40).join("\n");

		expect(shell).toContain("╭──────────────────────────────────────╮");
		expect(shell).toContain("❯ prompt");
		expect(shell).toContain("● Responding…");
		expect(legacy).not.toContain("❯");
		expect(legacy).not.toContain("Responding");
	});
});
