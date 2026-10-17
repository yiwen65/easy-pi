import { join, resolve } from "node:path";
import { resetCapabilitiesCache, setCapabilities, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import * as imageConvert from "../src/utils/image-convert.ts";

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

describe("ToolExecutionComponent Kitty image identity", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		vi.restoreAllMocks();
		resetCapabilitiesCache();
	});

	for (const finalMimeType of ["image/png", "image/jpeg"]) {
		test(`ignores late conversion of a replaced image when the final image is ${finalMimeType}`, async () => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
			const a = Promise.withResolvers<Awaited<ReturnType<typeof imageConvert.convertToPng>>>();
			const b = Promise.withResolvers<Awaited<ReturnType<typeof imageConvert.convertToPng>>>();
			const convert = vi
				.spyOn(imageConvert, "convertToPng")
				.mockReturnValueOnce(a.promise)
				.mockReturnValueOnce(b.promise);
			const requestRender = vi.fn();
			const component = new ToolExecutionComponent(
				"custom_tool",
				"image-update",
				{},
				{},
				undefined,
				{ requestRender } as unknown as TUI,
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "image", data: "c291cmNlLWE=", mimeType: "image/jpeg" }], isError: false },
				true,
			);
			component.updateResult({
				content: [{ type: "image", data: "c291cmNlLWI=", mimeType: finalMimeType }],
				isError: false,
			});
			if (finalMimeType === "image/jpeg") {
				b.resolve({ data: "Y29udmVydGVkLWI=", mimeType: "image/png" });
				await b.promise;
			}
			const requestsBeforeStale = requestRender.mock.calls.length;
			a.resolve({ data: "Y29udmVydGVkLWE=", mimeType: "image/png" });
			await a.promise;
			const rendered = component.render(100).join("\n");
			expect(rendered).toContain(finalMimeType === "image/png" ? "c291cmNlLWI=" : "Y29udmVydGVkLWI=");
			expect(rendered).not.toContain("Y29udmVydGVkLWE=");
			expect(requestRender).toHaveBeenCalledTimes(requestsBeforeStale);
			expect(convert).toHaveBeenCalledTimes(finalMimeType === "image/png" ? 1 : 2);
		});
	}

	test("does not resurrect removed images or let a stale failure evict a new conversion", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const removed = Promise.withResolvers<Awaited<ReturnType<typeof imageConvert.convertToPng>>>();
		const failed = Promise.withResolvers<Awaited<ReturnType<typeof imageConvert.convertToPng>>>();
		const convert = vi
			.spyOn(imageConvert, "convertToPng")
			.mockReturnValueOnce(removed.promise)
			.mockReturnValueOnce(failed.promise)
			.mockResolvedValue({ data: "Y29udmVydGVkLWI=", mimeType: "image/png" });
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"custom_tool",
			"image-removed",
			{},
			{},
			undefined,
			{ requestRender } as unknown as TUI,
			process.cwd(),
		);
		const image = { type: "image", data: "c291cmNlLWE=", mimeType: "image/jpeg" };
		component.updateResult({ content: [image], isError: false }, true);
		component.updateResult({ content: [], isError: false });
		removed.resolve({ data: "cmVtb3ZlZA==", mimeType: "image/png" });
		await removed.promise;
		expect(requestRender).not.toHaveBeenCalled();
		expect(component.render(100).join("\n")).not.toContain("\x1b_G");
		component.updateResult({ content: [image], isError: false }, true);
		component.updateResult({ content: [{ ...image, data: "c291cmNlLWI=" }], isError: false });
		failed.reject(new Error("conversion failed"));
		await failed.promise.catch(() => {});
		component.updateResult({ content: [{ ...image, data: "c291cmNlLWI=" }], isError: false });
		expect(convert).toHaveBeenCalledTimes(3);
		expect(component.render(100).join("\n")).toContain("Y29udmVydGVkLWI=");
	});

	test("reuses identical in-flight and completed images, but converts changed content at the same index", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof imageConvert.convertToPng>>>();
		const convert = vi
			.spyOn(imageConvert, "convertToPng")
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue({ data: "Y29udmVydGVkLWI=", mimeType: "image/png" });
		const component = new ToolExecutionComponent(
			"custom_tool",
			"image-cache",
			{},
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const image = { type: "image", data: "c291cmNlLWE=", mimeType: "image/jpeg" };
		component.updateResult({ content: [{ ...image }], isError: false }, true);
		component.updateResult({ content: [{ ...image }], isError: false }, true);
		expect(convert).toHaveBeenCalledTimes(1);
		pending.resolve({ data: "Y29udmVydGVkLWE=", mimeType: "image/png" });
		await pending.promise;
		component.updateResult({ content: [{ ...image }], isError: false });
		expect(convert).toHaveBeenCalledTimes(1);
		expect(component.render(100).join("\n")).toContain("Y29udmVydGVkLWE=");
		component.updateResult({ content: [{ ...image, data: "c291cmNlLWI=" }], isError: false });
		await Promise.resolve();
		expect(convert).toHaveBeenCalledTimes(2);
		expect(component.render(100).join("\n")).toContain("Y29udmVydGVkLWI=");
		expect(component.render(100).join("\n")).not.toContain("Y29udmVydGVkLWE=");
	});
});

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

	test.each(["unknown", "missing-renderer", "throwing-renderer", "self-shell-error"] as const)(
		"sanitizes raw tool-name prefixes in the %s fallback before dispatch and after errors",
		(kind) => {
			const attacks = [
				"\x1b]52;c;cGF5bG9hZA==\x07",
				"\x1b]52;c;cGF5bG9hZA==\x1b\\",
				"\x9d52;c;cGF5bG9hZA==\x9c",
				"\x1b[999;999H\x9b2J",
				"\x1b_Ga=T,f=100;payload\x1b\\",
				"\0\x07\x08\x0b\r\x7f\x85",
			];
			for (const attack of attacks) {
				for (let end = 1; end <= attack.length; end++) {
					const name = `项目_café_🦊_${attack.slice(0, end)}`;
					const call = Object.freeze({ id: "raw-name", name, arguments: Object.freeze({ value: "safe" }) });
					const definition: ToolDefinition | undefined =
						kind === "unknown"
							? undefined
							: {
									...createBaseToolDefinition(name),
									...(kind === "self-shell-error" ? { renderShell: "self" as const } : {}),
									...(kind === "missing-renderer"
										? {}
										: {
												renderCall: () => {
													throw new Error("renderer failed");
												},
											}),
								};
					const component = new ToolExecutionComponent(
						call.name,
						call.id,
						call.arguments,
						{},
						definition,
						createFakeTui(),
						process.cwd(),
					);
					for (const failed of [false, true]) {
						const result = { content: [{ type: "text", text: `Tool ${name} not found` }], isError: true };
						if (failed) component.updateResult(result);
						for (const expanded of [false, true]) {
							component.setExpanded(expanded);
							component.invalidate();
							const rendered = component.render(200).join("\n");
							expect(rendered.replace(/\x1b\[[\d;]*m/g, "")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
							expect(rendered).toContain("项目_café_🦊_");
							expect(call.name).toBe(name);
							if (definition) expect(definition.name).toBe(name);
							expect(result.content[0].text).toBe(`Tool ${name} not found`);
						}
					}
				}
			}
		},
	);

	test("does not turn a sanitized display name into a built-in registry match", () => {
		const name = "bash\x1b]52;c;cGF5bG9hZA==\x07";
		const args = Object.freeze({ command: "echo safe" });
		const component = new ToolExecutionComponent(
			name,
			"unknown-bash",
			args,
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered).toContain("bash");
		expect(rendered).toContain('"command": "echo safe"');
		expect(rendered).not.toContain("$ echo safe");
	});

	test.each(["command", "cwd"])("sanitizes untrusted bash %s previews before host styling", (field) => {
		const attacks = [
			"\x1b]52;c;cGF5bG9hZA==\x07",
			"\x1b]52;c;cGF5bG9hZA==\x1b\\",
			"\x9d52;c;cGF5bG9hZA==\x9c",
			"\x1b[2J\x1b[1;1H\x9b2J",
			"\0\x07\x08\x0b\r\x7f\x85",
		];
		const component = new ToolExecutionComponent(
			"bash",
			"safe-preview",
			{},
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		for (const attack of attacks) {
			for (let end = 1; end <= attack.length; end++) {
				const args = { command: "echo 项目", cwd: "/work", [field]: `visible ${attack.slice(0, end)}` };
				component.updateArgs(args);
				const rendered = component.render(200).join("\n");
				const plain = rendered.replace(/\x1b\[[\d;]*m/g, "");
				expect(plain).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
				expect(plain).toContain("visible");
				expect(args[field as "command" | "cwd"]).toBe(`visible ${attack.slice(0, end)}`);
			}
		}
	});

	test.each(["bash", "custom_tool"])(
		"strips C1 and incomplete controls from %s result text without stripping host colors",
		(toolName) => {
			const component = new ToolExecutionComponent(
				toolName,
				"safe-result",
				{ command: "echo" },
				{},
				undefined,
				createFakeTui(),
				process.cwd(),
			);
			component.setExpanded(true);
			component.updateResult({
				content: [{ type: "text", text: "项目\x9d52;c;cGF5bG9hZA==\x9c\x7f\x85\x1b]" }],
				isError: false,
			});
			const rendered = component.render(200).join("\n");
			expect(rendered).toMatch(/\x1b\[[\d;]*m/);
			expect(rendered.replace(/\x1b\[[\d;]*m/g, "")).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
			expect(rendered).toContain("项目");
		},
	);

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				expect(updates).toEqual([
					{
						content: [],
						details: {
							command: "sleep 10",
							cwd: process.cwd(),
							exitCode: null,
							signal: null,
							terminationReason: null,
							terminationRequested: false,
							timedOut: false,
							durationMs: 0,
						},
					},
				]);
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
		await promise;
	});

	test("bash renderer shows call metadata and the latest collapsed output", () => {
		const tool = createBashToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"bash",
			"tool-v2-bash-render",
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

	test("bash renderer preserves final status without duplicating truncation details", () => {
		const tool = createBashToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"bash",
			"tool-v2-bash-truncated",
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
						text: "latest\n\n[Showing lines 2-2 of 2. Full output: /tmp/bash.log]\n\nCommand exited with code 7",
					},
				],
				details: {
					truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 2 },
					fullOutputPath: "/tmp/bash.log",
					exitCode: 7,
					terminationReason: "exit",
				},
				isError: true,
			},
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("latest");
		expect(rendered).toContain("Command exited with code 7");
		expect(rendered.match(/Output log:/g)).toHaveLength(1);
		expect(rendered.match(/\/tmp\/bash\.log/g)).toHaveLength(1);
		expect(rendered).not.toContain("Full output:");
		expect(rendered).toContain("Truncated: showing 1 of 2 lines");
	});

	test("bash renderer labels capped logs without promising complete output", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"capped-log",
			{ command: "generate output" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({
			content: [{ type: "text", text: "latest\n\n[Showing lines 2-2 of 2. Truncated output log: /tmp/capped.log]" }],
			details: {
				truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 2 },
				fullOutputPath: "/tmp/capped.log",
				logTruncated: true,
			},
			isError: false,
		});
		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Truncated output log:/g)).toHaveLength(1);
		expect(rendered.match(/\/tmp\/capped\.log/g)).toHaveLength(1);
		expect(rendered).toContain("Full output log truncated at its byte budget");
		expect(rendered).toContain("Truncated: showing 1 of 2 lines");
		expect(rendered).not.toContain("[Showing lines");
		expect(rendered).not.toContain("Full output:");
	});

	test("bash renderer refreshes elapsed time for silent partial execution and stops after final output", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-29T00:00:00Z"));
		let renderRequests = 0;
		const tui = { requestRender: () => renderRequests++ } as unknown as TUI;
		const tool = createBashToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"bash",
			"tool-v2-bash-silent",
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
		expect(rendered.match(/Output log:/g)?.length ?? 0).toBe(1);
		expect(rendered.split(result.details.fullOutputPath!).length - 1).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Output log:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Output log:/);
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
