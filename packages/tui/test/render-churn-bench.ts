/**
 * Alt-screen render churn benchmark.
 *
 * Measures cumulative JS allocation and wall time for repeated TuiAltScreen
 * frames on a layout mirroring pi's fullscreen interactive mode:
 * VStack [ ScrollView(transcript), dock VStack [status, editor, footer] ].
 *
 * Bounded long-session scenarios: collapsed tool-like history, expanded logs,
 * editor updates, and resize. These are simulated NullTerminal frames, NOT
 * end-to-end real terminal latency (no terminal parsing, transport, or paint).
 *
 * Allocation is estimated with the V8 sampling heap profiler including
 * objects collected by minor/major GC, i.e. it measures churn, not retention.
 *
 * Run from packages/tui: node test/render-churn-bench.ts
 */

import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { Terminal } from "../src/terminal.ts";
import { type Component, Container, CURSOR_MARKER } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";

const COLUMNS = 100;
const ROWS = 30;
const WARMUP_FRAMES = 20;
const FRAMES = 100;
const SAMPLING_INTERVAL = 4096;

/** Terminal that discards output; keeps xterm parsing out of the measurement. */
class NullTerminal implements Terminal {
	bytesWritten = 0;
	width = COLUMNS;
	height = ROWS;
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytesWritten += data.length;
	}
	get columns(): number {
		return this.width;
	}
	get rows(): number {
		return this.height;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

/** Editor stand-in: caches lines per (text, width), re-renders when text changes. */
class EditorSim implements Component {
	private text = "";
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	append(char: string): void {
		this.text += char;
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const border = `\x1b[90m${"─".repeat(Math.max(1, width - 2))}\x1b[39m`;
		const lines = [border, ` > ${this.text}${CURSOR_MARKER}`, border];
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

const plain = (text: string) => text;
const markdownTheme: MarkdownTheme = {
	heading: (text) => `\x1b[1m${text}\x1b[22m`,
	link: plain,
	linkUrl: plain,
	code: plain,
	codeBlock: plain,
	codeBlockBorder: plain,
	quote: plain,
	quoteBorder: plain,
	hr: plain,
	listBullet: plain,
	bold: plain,
	italic: plain,
	strikethrough: plain,
	underline: plain,
};

class ToolLogSim implements Component {
	expanded = false;
	private collapsed: Text;
	private log: Text;
	constructor(index: number) {
		this.collapsed = new Text(`▸ tool ${index}: completed (30 log rows)`, 1, 0);
		this.log = new Text(
			Array.from(
				{ length: 30 },
				(_, row) => `  \x1b[32mtool ${index} log ${row}\x1b[39m 编译输出 路径/src/module-${row}.ts`,
			).join("\n"),
			1,
			0,
		);
	}
	render(width: number): string[] {
		return (this.expanded ? this.log : this.collapsed).render(width);
	}
	invalidate(): void {
		this.collapsed.invalidate();
		this.log.invalidate();
	}
}

function buildTranscript(): { transcript: Container; tools: ToolLogSim[] } {
	const transcript = new Container();
	const tools: ToolLogSim[] = [];
	for (let i = 0; i < 600; i++) {
		if (i % 6 === 0) {
			const tool = new ToolLogSim(i);
			tools.push(tool);
			transcript.addChild(tool);
		} else if (i % 3 === 0) {
			transcript.addChild(
				new Markdown(
					`## Response ${i}\n\n中文历史：检查 **布局** 与滚动。\n\n- preserve component identity\n- retain local reading offset\n\n\`\`\`ts\nconst frame = render(width);\n\`\`\``,
					1,
					0,
					markdownTheme,
				),
			);
		} else {
			transcript.addChild(
				new Text(
					`\x1b[36mmessage ${i}\x1b[39m 中文对话与 emoji 🙂: representative history with wrapping and styled content padding padding`,
					1,
					0,
				),
			);
		}
	}
	return { transcript, tools };
}

interface SamplingNode {
	selfSize: number;
	children: SamplingNode[];
}

function sumProfile(node: SamplingNode): number {
	let total = node.selfSize;
	for (const child of node.children) total += sumProfile(child);
	return total;
}

interface ScenarioResult {
	allocatedBytes: number;
	elapsedMs: number;
	bytesWritten: number;
}

async function runScenario(
	session: Session,
	terminal: NullTerminal,
	tui: TuiAltScreen,
	frame: (index: number) => void,
): Promise<ScenarioResult> {
	const writtenBefore = terminal.bytesWritten;
	await session.post("HeapProfiler.startSampling", {
		samplingInterval: SAMPLING_INTERVAL,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	const start = performance.now();
	for (let i = 0; i < FRAMES; i++) {
		frame(i);
		tui.renderNow();
	}
	const elapsedMs = performance.now() - start;
	const { profile } = await session.post("HeapProfiler.stopSampling");
	return {
		allocatedBytes: sumProfile(profile.head as SamplingNode),
		elapsedMs,
		bytesWritten: terminal.bytesWritten - writtenBefore,
	};
}

function report(name: string, result: ScenarioResult): void {
	const perFrameKiB = result.allocatedBytes / FRAMES / 1024;
	const totalMiB = result.allocatedBytes / 1024 / 1024;
	const msPerFrame = result.elapsedMs / FRAMES;
	console.log(
		`${name.padEnd(8)} allocated ${totalMiB.toFixed(1).padStart(7)} MiB total  ` +
			`${perFrameKiB.toFixed(1).padStart(8)} KiB/frame  ` +
			`${msPerFrame.toFixed(3).padStart(7)} ms/frame  ` +
			`${(result.bytesWritten / FRAMES).toFixed(0).padStart(6)} written bytes/frame`,
	);
}

async function main(): Promise<void> {
	const terminal = new NullTerminal();
	const tui = new TuiAltScreen(terminal, false, "/tmp/pi-tui-bench");

	const { transcript, tools } = buildTranscript();
	const editor = new EditorSim();
	const scrollView = new ScrollView(transcript, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: "auto",
	});
	const status = new Text("\x1b[2mstatus: idle\x1b[22m", 1, 0);
	const footer = new Text("\x1b[2m~/workspaces/pi  main  100k tokens\x1b[22m", 1, 0);
	const dock = new VStack([
		{ component: status, shrink: 1, minSize: 0 },
		{ component: editor, shrink: 1, minSize: 3 },
		{ component: footer, shrink: 1, minSize: 1 },
	]);
	const root = new VStack([
		{ component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	tui.setLayoutRoot(root);
	tui.start();

	for (let i = 0; i < WARMUP_FRAMES; i++) tui.renderNow();

	const session = new Session();
	session.connect();

	const collapsedLines = transcript.render(COLUMNS).length;
	const staticResult = await runScenario(session, terminal, tui, () => {});
	for (const tool of tools) tool.expanded = true;
	for (let i = 0; i < WARMUP_FRAMES; i++) tui.renderNow();
	const expandedLines = transcript.render(COLUMNS).length;
	const expandedResult = await runScenario(session, terminal, tui, () => {});
	const editorResult = await runScenario(session, terminal, tui, (i) => {
		editor.append(String.fromCharCode(97 + (i % 26)));
	});

	const resizeResult = await runScenario(session, terminal, tui, (i) => {
		if (i % 10 !== 0) return;
		terminal.width = i % 20 === 0 ? 80 : COLUMNS;
		terminal.height = i % 20 === 0 ? 24 : ROWS;
	});

	session.disconnect();
	tui.stop();

	console.log(
		`SIMULATED NullTerminal frames=${FRAMES}/scenario viewport=${COLUMNS}x${ROWS}; not real terminal latency`,
	);
	console.log(
		`history=600 components collapsed=${collapsedLines} lines expanded=${expandedLines} lines; resize=80x24↔100x30 every 10 frames`,
	);
	report("collapsed", staticResult);
	report("expanded", expandedResult);
	report("editor", editorResult);
	report("resize", resizeResult);
}

await main();
