import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Component, ScrollView, stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { type GrokChromeTheme, GrokComponentFactory } from "../src/modes/interactive-grok/grok-component-factory.ts";

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

/** Theme that wraps each style in distinct ANSI codes so styling is assertable at zero visible width. */
const T = "\x1b[31m";
const A = "\x1b[32m";
const M = "\x1b[33m";
const D = "\x1b[34m";
const S = "\x1b[35m";
const W = "\x1b[36m";
const E = "\x1b[91m";
const P = "\x1b[95m";
const X = "\x1b[0m";
const markerTheme: GrokChromeTheme = {
	text: (text) => `${T}${text}${X}`,
	accent: (text) => `${A}${text}${X}`,
	muted: (text) => `${M}${text}${X}`,
	dim: (text) => `${D}${text}${X}`,
	border: identity,
	success: (text) => `${S}${text}${X}`,
	warning: (text) => `${W}${text}${X}`,
	error: (text) => `${E}${text}${X}`,
	thinkingLevel: (level: ThinkingLevel, text: string) => {
		const style =
			level === "minimal"
				? markerTheme.muted
				: level === "low"
					? markerTheme.text
					: level === "medium"
						? markerTheme.accent
						: level === "high"
							? markerTheme.warning
							: level === "xhigh"
								? markerTheme.error
								: (value: string) => `${P}${value}${X}`;
		return style(text);
	},
};

interface StubUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

function createStubSession(options: {
	usage?: StubUsage;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	contextPercent?: number;
	contextWindow?: number;
	usingSubscription?: boolean;
}): AgentSession {
	const entries = options.usage ? [{ type: "message", message: { role: "assistant", usage: options.usage } }] : [];
	return {
		state: {
			model: {
				id: options.modelId ?? "gpt-5.6-sol",
				provider: options.provider ?? "openai-codex",
				contextWindow: options.contextWindow ?? 272_000,
				reasoning: options.reasoning ?? true,
			},
			thinkingLevel: options.thinkingLevel ?? "high",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => null,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({
			contextWindow: options.contextWindow ?? 272_000,
			percent: options.contextPercent ?? 35.8,
		}),
		modelRuntime: { isUsingSubscription: () => options.usingSubscription ?? false },
		autoCompactionEnabled: true,
	} as unknown as AgentSession;
}

function createStubFooterData(providerCount: number): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: () => () => {},
	};
}

class StubComponent implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.lines.map((line) => line.slice(0, width));
	}
}

class EditorHost implements Component {
	readonly inputs: string[] = [];
	invalidated = false;

	invalidate(): void {
		this.invalidated = true;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(width: number): string[] {
		return ["─".repeat(width), "write a message", "─".repeat(width)];
	}
}

function expectWithinWidth(component: Component, widths: readonly number[]): void {
	for (const width of widths) {
		for (const line of component.render(width)) {
			expect(visibleWidth(line), `${stripTerminalSequences(line)} at ${width} columns`).toBeLessThanOrEqual(width);
		}
	}
}

describe("Grok shell components", () => {
	it("renders location and context meter in a responsive top bar", () => {
		const factory = new GrokComponentFactory(identityTheme);
		const topBar = factory.createTopBar({ path: "/Users/example/a-very-long/project/path", branch: "main" }, 42);

		expect(topBar.render(40)[0]).toContain("…");
		expect(topBar.render(80)[0]).toContain("/Users/example/a-very-long/project/path");
		expect(topBar.render(80)[0]).toContain("(main)");
		expect(topBar.render(80)[0]).toContain("42%");
		// The branch survives while the path truncates from the left.
		const narrow = topBar.render(30)[0] ?? "";
		expect(narrow).toContain("(main)");
		expect(narrow).toContain("…");
		expectWithinWidth(topBar, [40, 80, 120]);
	});

	it("color-codes the context meter as usage grows", () => {
		const factory = new GrokComponentFactory(markerTheme);
		const topBar = factory.createTopBar({ path: "/workspace" }, 42);
		expect(topBar.render(80)[0]).toContain(`${S}███░░░${X}`);
		topBar.setContextPercent(85);
		expect(topBar.render(80)[0]).toContain(`${W}█████░${X}`);
		topBar.setContextPercent(95);
		expect(topBar.render(80)[0]).toContain(`${E}██████${X}`);
		topBar.setContextPercent(null);
		expect(topBar.render(80)[0]).toContain("context ?");
	});

	it("wraps the editor host in a rounded Grok frame without taking over input", () => {
		const factory = new GrokComponentFactory(identityTheme);
		const editorHost = new EditorHost();
		const frame = factory.createEditorFrame(editorHost);
		const rendered = frame.render(40);

		expect(rendered[0]).toBe(`╭${"─".repeat(38)}╮`);
		expect(rendered.some((line) => line.includes("❯ write a message"))).toBe(true);
		expect(rendered.at(-1)).toBe(`╰${"─".repeat(38)}╯`);
		expect(rendered.filter((line) => /^─+$/.test(line))).toHaveLength(0);

		frame.handleInput("hello");
		frame.invalidate();
		expect(editorHost.inputs).toEqual(["hello"]);
		expect(editorHost.invalidated).toBe(true);
		expectWithinWidth(frame, [40, 80, 120]);
	});

	it("renders the Grok editor frame with the active thinking-level border color", () => {
		const frame = new GrokComponentFactory(identityTheme).createEditorFrame(new EditorHost());
		const maxBorder = (text: string) => `${P}${text}${X}`;
		frame.setBorderColor(maxBorder);

		const rendered = frame.render(40);
		expect(rendered[0]).toBe(maxBorder(`╭${"─".repeat(38)}╮`));
		expect(rendered.at(-1)).toBe(maxBorder(`╰${"─".repeat(38)}╯`));
	});

	it("updates status synchronously and does not create animation timers", () => {
		const timerSpy = vi.spyOn(globalThis, "setTimeout");
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const factory = new GrokComponentFactory(identityTheme);
		const status = factory.createStatus({ kind: "working", label: "Responding…", detail: "1.2k tok" });

		expect(status.render(40)[0]).toContain("● Responding…");
		status.setState({ kind: "success", label: "Completed", detail: "1.3k tok" });
		expect(status.render(40)[0]).toContain("Completed");
		expect(timerSpy).not.toHaveBeenCalled();
		expect(intervalSpy).not.toHaveBeenCalled();
		timerSpy.mockRestore();
		intervalSpy.mockRestore();
		expectWithinWidth(status, [40, 80, 120]);
	});

	it("reserves the transient status row and clears it without changing layout height", () => {
		vi.useFakeTimers();
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const requestRender = vi.fn();
		const factory = new GrokComponentFactory(identityTheme);
		const view = factory.createInteractiveView({
			document: new StubComponent(["document"]),
			transcriptViewport: new StubComponent(["viewport"]),
			editorHost: new EditorHost(),
			location: { path: "/workspace" },
			contextPercent: 10,
			ui: { requestRender },
		});

		try {
			expect(view.status.render(80)).toEqual([""]);
			expect(intervalSpy).not.toHaveBeenCalled();
			view.showTransientStatus("Thinking level: max", 900);
			expect(view.status.render(80)[0]).toContain("Thinking level: max");
			expect(view.status.render(80)).toHaveLength(1);
			expect(requestRender).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(900);
			expect(view.status.render(80)).toEqual([""]);
			expect(requestRender).toHaveBeenCalledTimes(2);
		} finally {
			view.dispose();
			intervalSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("keeps transient status updates on the differential render path", () => {
		vi.useFakeTimers();
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TuiMainScreen(terminal);
		ui.setClearOnShrink(true);
		const view = new GrokComponentFactory(identityTheme).createInteractiveView({
			document: new StubComponent(["document"]),
			transcriptViewport: new StubComponent(["viewport"]),
			editorHost: new EditorHost(),
			location: { path: "/workspace" },
			contextPercent: 10,
			ui,
		});
		for (const component of view.regularComponents) ui.addChild(component);

		try {
			ui.renderNow();
			const initialFullRedraws = ui.fullRedraws;

			view.showTransientStatus("Thinking level: max", 900);
			ui.renderNow();
			expect(ui.fullRedraws).toBe(initialFullRedraws);

			vi.advanceTimersByTime(900);
			ui.renderNow();
			expect(ui.fullRedraws).toBe(initialFullRedraws);
		} finally {
			view.dispose();
			ui.stop({ preserveScreen: true });
			vi.useRealTimers();
		}
	});

	it("renders extension statuses and lets a custom footer replace the Grok footer", () => {
		const statuses = new Map([
			["z-last", "second\nstatus"],
			["a-first", "first status"],
		]);
		const footerData = {
			getExtensionStatuses: () => statuses,
		} as unknown as ReadonlyFooterDataProvider;
		const factory = new GrokComponentFactory(identityTheme);
		const footer = factory.createFooter(footerData);

		expect(footer.render(80)).toEqual(["first status  second status"]);
		footer.setVisible(false);
		expect(footer.render(80)).toEqual([]);
		footer.setVisible(true);
		expect(footer.render(80)[0]).toBe("first status  second status");
	});

	it("wraps all extension statuses on narrow widths without losing styled or wide text", () => {
		const statuses = new Map([
			["permission", "perm:full-access"],
			["status", `${A}状态：正在检查项目🙂${X}`],
		]);
		const footer = new GrokComponentFactory(markerTheme).createFooter({
			...createStubFooterData(1),
			getExtensionStatuses: () => statuses,
		});
		const expected = stripTerminalSequences(footer.render(200).join("")).replace(/\s/g, "");
		for (const width of [4, 12, 24, 40, 80]) {
			expectWithinWidth(footer, [width]);
			expect(stripTerminalSequences(footer.render(width).join("")).replace(/\s/g, "")).toBe(expected);
		}
		expect(footer.render(12).length).toBeGreaterThan(1);
	});

	it("renders nothing when there are no extension statuses", () => {
		const factory = new GrokComponentFactory(identityTheme);
		const footer = factory.createFooter(createStubFooterData(1));
		expect(footer.render(80)).toEqual([]);
		expect(factory.createFooter().render(80)).toEqual([]);
	});

	it("exposes regular and fullscreen mount structures around the same Pi hosts", () => {
		const factory = new GrokComponentFactory(identityTheme);
		const document = new StubComponent(["document"]);
		const transcriptViewport = new StubComponent(["viewport"]);
		const editorHost = new EditorHost();
		const extensionAbove = new StubComponent(["extension above"]);
		const extensionBelow = new StubComponent(["extension below"]);
		const view = factory.createInteractiveView({
			document,
			transcriptViewport,
			editorHost,
			location: { path: "/workspace" },
			contextPercent: 10,
			beforeEditor: [extensionAbove],
			afterEditor: [extensionBelow],
		});

		expect(view.regularComponents).toContain(document);
		expect(view.regularComponents).toContain(extensionAbove);
		expect(view.regularComponents).toContain(extensionBelow);
		expect(view.fullscreenRoot.render(80).join("\n")).toContain("viewport");
		view.setStatusComponent(new StubComponent(["extension working indicator"]));
		expect(view.regularComponents.flatMap((component) => component.render(80)).join("\n")).toContain(
			"extension working indicator",
		);
		view.setStatusComponent();
		expect(view.regularComponents.flatMap((component) => component.render(80)).join("\n")).not.toContain("Ready");
		expectWithinWidth(view.fullscreenRoot, [40, 80, 120]);
		view.dispose();
	});

	it("grows the fullscreen dock when footer information wraps on resize", async () => {
		const terminal = new VirtualTerminal(120, 30);
		const ui = new TuiAltScreen(terminal);
		const statuses = new Map([["permission", "perm:full-access"]]);
		const view = new GrokComponentFactory(markerTheme).createInteractiveView({
			document: new StubComponent(["transcript"]),
			transcriptViewport: new ScrollView(new StubComponent(["transcript"]), { primary: true }),
			editorHost: new EditorHost(),
			location: { path: "/workspace" },
			contextPercent: 42.6,
			session: createStubSession({
				usage: { input: 188_000, output: 8_900, cacheRead: 3_500_000, cacheWrite: 0, cost: { total: 5.877 } },
				contextPercent: 42.6,
				usingSubscription: true,
			}),
			footerData: { ...createStubFooterData(2), getExtensionStatuses: () => statuses },
		});
		ui.setLayoutRoot(view.fullscreenRoot);
		ui.start();
		try {
			for (const width of [120, 68, 40, 24, 120]) {
				terminal.resize(width, 30);
				await terminal.waitForRender();
				const viewport = terminal.getViewport();
				const editorBottom = viewport.findIndex((line) => line.includes("╰"));
				expect(editorBottom).toBeGreaterThan(0);
				const footerText = viewport
					.slice(editorBottom + 1)
					.join("")
					.replace(/\s/g, "");
				for (const text of ["↑188k", "↓8.9k", "R3.5M", "$5.877", "gpt-5.6-sol", "high", "perm:full-access"]) {
					expect(footerText).toContain(text);
				}
				expect(footerText).not.toMatch(/openai-codex|\(sub\)|\(auto\)|42\.6%|272k/);
				expect(viewport[0]).toContain("43%");
			}
		} finally {
			ui.stop();
			view.dispose();
		}
	});

	it("mounts a stats bar with native Pi session info when a session is provided", () => {
		const factory = new GrokComponentFactory(identityTheme);
		const view = factory.createInteractiveView({
			document: new StubComponent(["document"]),
			transcriptViewport: new StubComponent(["viewport"]),
			editorHost: new EditorHost(),
			location: { path: "/workspace", branch: "main" },
			contextPercent: 35.8,
			session: createStubSession({
				usage: { input: 188_000, output: 17_000, cacheRead: 1_700_000, cacheWrite: 0, cost: { total: 2.279 } },
			}),
			footerData: createStubFooterData(2),
		});

		const rendered = view.regularComponents.flatMap((component) => component.render(120)).join("\n");
		expect(rendered).toContain("(main)");
		expect(rendered).toContain("↑188k ↓17k R1.7M CR90.0% $2.279");
		expect(rendered).toContain("gpt-5.6-sol • high");
		expect(rendered).not.toMatch(/openai-codex|35\.8%\/272k|\(auto\)/);
		expectWithinWidth(view.fullscreenRoot, [40, 80, 120]);
		view.dispose();
	});
});

describe("GrokStatsBar", () => {
	const fullUsage: StubUsage = {
		input: 188_000,
		output: 17_000,
		cacheRead: 1_700_000,
		cacheWrite: 0,
		cost: { total: 2.279 },
	};

	it("shows usage, cost and model effort without provider or duplicated context", () => {
		const factory = new GrokComponentFactory(identityTheme);
		const bar = factory.createStatsBar(createStubSession({ usage: fullUsage }));

		const line = bar.render(120)[0] ?? "";
		expect(line.replace(/ +/g, " ")).toBe("↑188k ↓17k R1.7M CR90.0% $2.279 gpt-5.6-sol • high");
		expectWithinWidth(bar, [40, 80, 120]);
	});

	it("omits effort for non-reasoning models", () => {
		const factory = new GrokComponentFactory(identityTheme);
		const bar = factory.createStatsBar(createStubSession({ usage: fullUsage, reasoning: false }));

		const line = bar.render(120)[0] ?? "";
		expect(line).not.toContain("(openai-codex)");
		expect(line).toContain("gpt-5.6-sol");
		expect(line).not.toContain("• high");
	});

	it("shows off effort and subscription cost without parenthetical explanations", () => {
		const factory = new GrokComponentFactory(identityTheme);
		const bar = factory.createStatsBar(
			createStubSession({ usage: fullUsage, thinkingLevel: "off", usingSubscription: true }),
		);

		const line = bar.render(120)[0] ?? "";
		expect(line).toContain("$2.279");
		expect(line).toContain("gpt-5.6-sol • off");
		expect(line).not.toMatch(/[()]/);
	});

	it("color-codes thinking levels on a heat scale", () => {
		const factory = new GrokComponentFactory(markerTheme);
		const levelOf = (thinkingLevel: string) =>
			factory.createStatsBar(createStubSession({ usage: fullUsage, thinkingLevel }));

		expect(levelOf("off").render(120)[0]).toContain(`${D}off${X}`);
		expect(levelOf("minimal").render(120)[0]).toContain(`${M}minimal${X}`);
		expect(levelOf("low").render(120)[0]).toContain(`${T}low${X}`);
		expect(levelOf("medium").render(120)[0]).toContain(`${A}medium${X}`);
		expect(levelOf("high").render(120)[0]).toContain(`${W}high${X}`);
		expect(levelOf("xhigh").render(120)[0]).toContain(`${E}xhigh${X}`);
		expect(levelOf("max").render(120)[0]).toContain(`${P}max${X}`);
	});

	it("updates the thinking level color immediately without scheduling a fade repaint", () => {
		vi.useFakeTimers();
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			const session = createStubSession({ usage: fullUsage, thinkingLevel: "high" });
			const requestRender = vi.fn();
			const factory = new GrokComponentFactory(markerTheme);
			const bar = factory.createStatsBar(session, { requestRender });

			expect(bar.render(120)[0]).toContain(`${A}gpt-5.6-sol${X}${M} • ${X}${W}high${X}`);

			(session.state as { thinkingLevel: string }).thinkingLevel = "low";
			const switched = bar.render(120)[0] ?? "";
			expect(switched).toContain(`${A}gpt-5.6-sol${X}${M} • ${X}${T}low${X}`);
			expect(requestRender).not.toHaveBeenCalled();
			expect(timeoutSpy).not.toHaveBeenCalled();
			bar.dispose();
		} finally {
			timeoutSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("wraps stats and model information without losing content when resized", () => {
		const factory = new GrokComponentFactory(markerTheme);
		const bar = factory.createStatsBar(
			createStubSession({ usage: fullUsage, modelId: "a-very-long-model-identifier", usingSubscription: true }),
		);
		const expected = stripTerminalSequences(bar.render(200).join("")).replace(/\s/g, "");
		for (const width of [4, 12, 24, 40, 50, 68, 80, 120, 200]) {
			const lines = bar.render(width);
			expectWithinWidth(bar, [width]);
			expect(stripTerminalSequences(lines.join("")).replace(/\s/g, "")).toBe(expected);
		}
		expect(bar.render(50).length).toBeGreaterThan(1);
		expect(bar.render(200)).toHaveLength(1);
	});

	it("flashes changed segments in accent and fades back after the flash window", () => {
		vi.useFakeTimers();
		try {
			const entries: unknown[] = [{ type: "message", message: { role: "assistant", usage: { ...fullUsage } } }];
			const session = createStubSession({ usage: fullUsage });
			(session.sessionManager as unknown as { getEntries: () => unknown[] }).getEntries = () => entries;
			const requestRender = vi.fn();
			const factory = new GrokComponentFactory(markerTheme);
			const bar = factory.createStatsBar(session, { requestRender });

			const first = bar.render(120)[0] ?? "";
			expect(first).toContain(`${D}↑${X}${T}188k${X}`);

			entries.push({
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 188_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } },
				},
			});
			const second = bar.render(120)[0] ?? "";
			expect(second).toContain(`${D}↑${X}${A}376k${X}`);
			expect(second).toContain(`${D}$${X}${A}3.279${X}`);
			// Unchanged segments do not flash.
			expect(second).toContain(`${D}↓${X}${T}17k${X}`);

			vi.advanceTimersByTime(1300);
			expect(requestRender).toHaveBeenCalled();
			const third = bar.render(120)[0] ?? "";
			expect(third).toContain(`${D}↑${X}${T}376k${X}`);
			bar.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not schedule flash timers without a render driver", () => {
		const timerSpy = vi.spyOn(globalThis, "setTimeout");
		const factory = new GrokComponentFactory(markerTheme);
		const bar = factory.createStatsBar(createStubSession({ usage: fullUsage }));
		bar.render(120);
		bar.render(120);
		expect(timerSpy).not.toHaveBeenCalled();
		timerSpy.mockRestore();
	});

	it("does not read context usage for the stats bar", () => {
		const session = createStubSession({ usage: fullUsage });
		const getContextUsage = vi.spyOn(session, "getContextUsage");
		const bar = new GrokComponentFactory(markerTheme).createStatsBar(session);
		bar.render(120);
		expect(getContextUsage).not.toHaveBeenCalled();
	});

	it("wraps model-only output without an empty leading row", () => {
		const bar = new GrokComponentFactory(identityTheme).createStatsBar(
			createStubSession({ modelId: "a-very-long-model-identifier" }),
		);
		const lines = bar.render(12);
		expect(lines.every((line) => line.trim().length > 0)).toBe(true);
		expect(lines.join("").replace(/\s/g, "")).toBe("a-very-long-model-identifier•high");
		expectWithinWidth(bar, [12, 40, 80]);
	});

	it("retains zero subscription cost without the subscription label", () => {
		const bar = new GrokComponentFactory(identityTheme).createStatsBar(
			createStubSession({ usingSubscription: true }),
		);
		expect(bar.render(80)[0]?.replace(/ +/g, " ")).toBe("$0.000 gpt-5.6-sol • high");
	});
});
