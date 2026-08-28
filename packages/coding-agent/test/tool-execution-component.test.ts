import { join, resolve } from "node:path";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createV2ToolDefinitions } from "../src/core/tools/tool-profile.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("v2 read renderer uses structured text ranges, syntax, and directory snapshot metadata", () => {
		const tool = createV2ToolDefinitions(process.cwd()).read;
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-render",
			{ path: "src/example.ts", offset: 20, limit: 14 },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		const lines = Array.from({ length: 14 }, (_, index) => `const value${index} = ${index};`);
		component.updateResult(
			{
				content: [{ type: "text", text: "CONTENT_SENTINEL_MUST_NOT_BE_PARSED" }],
				details: {
					path: "src/example.ts",
					kind: "text",
					range: [20, 33],
					lines,
					hasMore: true,
					nextOffset: 34,
				},
				isError: false,
			},
			false,
		);
		const collapsed = stripAnsi(component.render(48).join("\n"));
		expect(collapsed).toContain("read src/example.ts · offset 20 · limit");
		expect(collapsed).toContain("20 const value0 = 0;");
		expect(collapsed).toContain("31 const value11 = 11;");
		expect(collapsed).not.toContain("32 const value12");
		expect(collapsed).toContain("2 more lines in this page");
		expect(collapsed).toContain("Continue with offset 34");
		expect(collapsed).not.toContain("CONTENT_SENTINEL_MUST_NOT_BE_PARSED");
		for (const line of component.render(48)) expect(stripAnsi(line).length).toBeLessThanOrEqual(48);

		component.updateResult(
			{
				content: [{ type: "text", text: "ANOTHER_SENTINEL" }],
				details: {
					path: "src",
					kind: "directory",
					entries: [
						{ name: "nested", kind: "directory", size: 128, mtimeMs: 0 },
						...Array.from({ length: 13 }, (_, index) => ({ name: `file-${index}`, kind: "file" as const })),
					],
					hasMore: true,
					nextCursor: "r2-next",
					stable: true,
				},
				isError: false,
			},
			false,
		);
		const directory = stripAnsi(component.render(80).join("\n"));
		expect(directory).toContain("nested/ · directory 128B");
		expect(directory).toContain("2 more entries in this page");
		expect(directory).not.toContain("file-12");
		expect(directory).toContain("[stable snapshot]");
		expect(directory).toContain("Continue with cursor r2-next");
		expect(directory).not.toContain("ANOTHER_SENTINEL");
	});

	test("v2 search renderer consumes structured hits with grouping, ranges, status, and continuation", () => {
		const tool = createV2ToolDefinitions(process.cwd()).search;
		const component = new ToolExecutionComponent(
			"search",
			"tool-search-render",
			{
				query: "Auth",
				kind: "text",
				path: "src",
				fileGlob: "*.ts",
				context: 1,
			},
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		const hits = Array.from({ length: 10 }, (_, index) => ({
			kind: "text" as const,
			path: index < 5 ? "src/auth.ts" : "src/service.ts",
			line: index + 1,
			column: 1,
			text: `Auth marker ${index}`,
			ranges: [[0, 4]] as Array<[number, number]>,
			before: index === 0 ? [{ line: 0, text: "context before" }] : undefined,
		}));
		component.updateResult(
			{
				content: [{ type: "text", text: "CONTENT_SENTINEL_MUST_NOT_BE_PARSED" }],
				details: {
					kind: "text",
					query: "Auth",
					path: "src",
					hits,
					returnedCount: hits.length,
					complete: false,
					approximate: true,
					partial: true,
					nextCursor: "s2-next",
				},
				isError: false,
			},
			false,
		);

		const rawCollapsed = component.render(40).join("\n");
		const collapsed = stripAnsi(rawCollapsed);
		expect(collapsed).toContain('search "Auth" · text · literal · smart');
		expect(collapsed).toContain("[approximate · partial]");
		expect(collapsed).toContain("src/auth.ts");
		expect(collapsed).toContain("context before");
		expect(collapsed).toContain("Auth marker 7");
		expect(collapsed).not.toContain("Auth marker 8");
		expect(collapsed).toContain("2 more hits");
		expect(collapsed).toContain("Continue with cursor s2-next");
		expect(collapsed).not.toContain("CONTENT_SENTINEL_MUST_NOT_BE_PARSED");
		expect(rawCollapsed).toContain(theme.fg("accent", theme.bold("Auth")));
		for (const line of component.render(40)) expect(stripAnsi(line).length).toBeLessThanOrEqual(40);

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain("Auth marker 9");
	});

	test("v2 run renderer shows call metadata and the latest collapsed output", () => {
		const tool = createV2ToolDefinitions(process.cwd()).run;
		const component = new ToolExecutionComponent(
			"run",
			"tool-run-render",
			{ command: "npm run check", cwd: "workspace/subdir", timeout: 7 },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		const output = [
			"oldest-marker",
			...Array.from({ length: 20 }, (_, index) => `middle-${index}`),
			`${"x".repeat(400)}-newest-marker`,
		].join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], details: {}, isError: false }, false);

		const collapsed = stripAnsi(component.render(80).join("\n"));
		expect(collapsed).toContain("$ npm run check");
		expect(collapsed).toContain("cwd workspace/subdir");
		expect(collapsed).toContain("timeout 7s");
		expect(collapsed).toContain("newest-marker");
		expect(collapsed).toContain("earlier lines");
		expect(collapsed).not.toContain("oldest-marker");
		expect(collapsed).toContain("Took");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain("oldest-marker");
		expect(expanded).toContain("newest-marker");
	});

	test("v2 run renderer preserves final status without duplicating truncation details", () => {
		const tool = createV2ToolDefinitions(process.cwd()).run;
		const component = new ToolExecutionComponent(
			"run",
			"tool-run-truncated",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.setExpanded(true);
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: "latest\n\n[Output truncated to 50KB or configured line limit. Full output: /tmp/run.log]\n\nexit 0",
					},
				],
				details: {
					truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 2 },
					fullOutputPath: "/tmp/run.log",
				},
				isError: false,
			},
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("latest");
		expect(rendered).toContain("exit 0");
		expect(rendered.match(/Full output:/g)).toHaveLength(1);
		expect(rendered).toContain("Truncated: showing 1 of 2 lines");
	});

	test("v2 run renderer refreshes elapsed time for silent partial execution and stops after final output", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-29T00:00:00Z"));
		let renderRequests = 0;
		const tui = { requestRender: () => renderRequests++ } as unknown as TUI;
		const tool = createV2ToolDefinitions(process.cwd()).run;
		const component = new ToolExecutionComponent(
			"run",
			"tool-run-silent",
			{ command: "sleep 10" },
			{},
			tool,
			tui,
			process.cwd(),
		);

		try {
			component.markExecutionStarted();
			component.updateResult({ content: [], details: {}, isError: false }, true);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("Elapsed 0.0s");

			const requestsAfterStart = renderRequests;
			vi.advanceTimersByTime(1200);
			expect(renderRequests).toBeGreaterThan(requestsAfterStart);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("Elapsed 1.0s");

			component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
			const requestsAfterFinal = renderRequests;
			vi.advanceTimersByTime(2000);
			expect(renderRequests).toBe(requestsAfterFinal);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("Took 1.2s");
		} finally {
			vi.useRealTimers();
		}
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("collapses fallback results until expanded", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		const output = Array.from({ length: 15 }, (_, index) => `line-${index + 1}`).join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], details: {}, isError: false }, false);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("custom_tool");
		expect(collapsed).toContain("line-10");
		expect(collapsed).not.toContain("line-11");
		expect(collapsed).toContain("5 more lines");
		expect(collapsed).toContain("to expand");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("line-15");
		expect(expanded).not.toContain("more lines");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("does not syntax-highlight read errors based on the requested file path", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-error-highlighting",
			{ path: "config.exs", offset: 120, limit: 130 },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const error = "Offset 120 is beyond end of file (96 lines total)";
		component.updateResult({ content: [{ type: "text", text: error }], details: undefined, isError: true }, false);

		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered)).toContain(error);
		expect(rendered).toContain(theme.fg("toolOutput", error));
	});

	test("collapses ordinary read results until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("read");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".pi", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "read resource .pi/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "AGENTS.override.md",
			path: join(process.cwd(), ".pi", "AGENTS.override.md"),
			content: "Hidden override instructions",
			compact: "read resource .pi/AGENTS.override.md",
			hidden: "Hidden override instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `read resource ${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")}`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio:120-329" },
		{ title: "Pi documentation", path: getReadmePath(), compact: "read docs README.md:120-329" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}
});
