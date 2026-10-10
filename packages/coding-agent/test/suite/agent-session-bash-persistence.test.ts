import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { finished } from "node:stream/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "../../src/core/tools/truncate.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

function getEntryTypes(harness: Harness): string[] {
	return harness.sessionManager.getEntries().map((entry) => entry.type);
}

interface ControlledBashInvocation {
	signal: AbortSignal | undefined;
	finish: () => void;
}

function createControlledBashOperations(invocations: ControlledBashInvocation[]): BashOperations {
	return {
		exec: async (_command, _cwd, options) => {
			return await new Promise<{ exitCode: number | null }>((resolve) => {
				invocations.push({
					signal: options.signal,
					finish: () => resolve({ exitCode: 0 }),
				});
			});
		},
	};
}

describe("AgentSession bash and persistence characterization", () => {
	const harnesses: Harness[] = [];
	const outputFiles: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		for (const path of outputFiles.splice(0)) {
			fs.rmSync(path, { force: true });
		}
	});

	it("records bash results immediately while idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
		expect(getEntryTypes(harness)).toContain("message");
	});

	it("defers bash results while streaming and flushes them before the next prompt", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("after flush"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const firstPrompt = harness.session.prompt("start");
		await sawToolStart;
		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);

		releaseToolExecution?.();
		await firstPrompt;

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);

		await harness.session.prompt("next turn");

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);
		expect(getEntryTypes(harness).filter((type) => type === "message").length).toBeGreaterThan(0);
	});

	it("executes bash commands and records the result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const result = await harness.session.executeBash("printf 'hello'");

		expect(result.output).toContain("hello");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});

	it("cancels running bash commands with abortBash", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				return await new Promise<{ exitCode: number | null }>((_resolve, reject) => {
					options.signal?.addEventListener(
						"abort",
						() => {
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
			},
		};

		const bashPromise = harness.session.executeBash("sleep", undefined, { operations });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isBashRunning).toBe(true);
		harness.session.abortBash();

		const result = await bashPromise;
		expect(result.cancelled).toBe(true);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("keeps newer bash execution tracked when an older execution finishes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const invocations: ControlledBashInvocation[] = [];
		const operations = createControlledBashOperations(invocations);

		const firstBash = harness.session.executeBash("first", undefined, { operations });
		const secondBash = harness.session.executeBash("second", undefined, { operations });

		invocations[0].finish();
		const firstResult = await firstBash;
		const runningAfterFirstSettles = harness.session.isBashRunning;

		harness.session.abortBash();
		const secondWasAborted = invocations[1].signal?.aborted;
		invocations[1].finish();
		const secondResult = await secondBash;

		expect(firstResult.cancelled).toBe(false);
		expect(runningAfterFirstSettles).toBe(true);
		expect(secondWasAborted).toBe(true);
		expect(secondResult.cancelled).toBe(true);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("aborts all active bash executions", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const invocations: ControlledBashInvocation[] = [];
		const operations = createControlledBashOperations(invocations);

		const firstBash = harness.session.executeBash("first", undefined, { operations });
		const secondBash = harness.session.executeBash("second", undefined, { operations });

		harness.session.abortBash();
		const abortedSignals = invocations.map((invocation) => invocation.signal?.aborted);
		for (const invocation of invocations) {
			invocation.finish();
		}
		const results = await Promise.all([firstBash, secondBash]);

		expect(abortedSignals).toEqual([true, true]);
		expect(results.map((result) => result.cancelled)).toEqual([true, true]);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("persists user, assistant, toolResult, and custom messages in order", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.sendCustomMessage({
			customType: "note",
			content: "hello",
			display: true,
			details: { a: 1 },
		});
		await harness.session.prompt("start");

		const entries = harness.sessionManager.getEntries();
		const auditEntries = entries.filter((entry) => entry.type === "custom");
		expect(auditEntries.length).toBeGreaterThan(0);
		expect(
			auditEntries.every(
				(entry) => entry.customType === "pi-task-recovery" || entry.customType === "pi-tool-interruption",
			),
		).toBe(true);
		expect(entries.filter((entry) => entry.type !== "custom").map((entry) => entry.type)).toEqual([
			"custom_message",
			"message",
			"message",
			"message",
			"message",
		]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"custom",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("does not emit message_end for bash execution messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const messageEndRoles: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end") {
				messageEndRoles.push(event.message.role);
			}
		});

		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(messageEndRoles).toEqual([]);
	});

	it("persists aborted assistant messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await promptPromise;

		const entries = harness.sessionManager.getEntries();
		const auditEntries = entries.filter((entry) => entry.type === "custom");
		expect(auditEntries.length).toBeGreaterThan(0);
		expect(
			auditEntries.every(
				(entry) => entry.customType === "pi-task-recovery" || entry.customType === "pi-tool-interruption",
			),
		).toBe(true);
		const lastEntry = entries.filter((entry) => entry.type === "message").at(-1);
		expect(lastEntry?.type).toBe("message");
		if (lastEntry?.type === "message") {
			expect(lastEntry.message.role).toBe("assistant");
			if (lastEntry.message.role === "assistant") {
				expect(lastEntry.message.stopReason).toBe("aborted");
			}
		}
	});

	it("records bash output through custom operations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("hello from custom ops"));
				return { exitCode: 0 };
			},
		};

		const result = await harness.session.executeBash("custom", undefined, { operations });

		expect(result.output).toContain("hello from custom ops");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});

	it("streams bash output to the callback and session events", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const callbackDeltas: string[] = [];
		const eventUpdates: Array<{ id: string | undefined; delta: string }> = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "bash_execution_update") {
				eventUpdates.push({ id: event.id, delta: event.delta });
			}
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("hello "));
				options.onData(Buffer.from("world"));
				return { exitCode: 0 };
			},
		};

		await harness.session.executeBash("custom", (delta) => callbackDeltas.push(delta), {
			id: "bash-1",
			operations,
		});
		unsubscribe();

		expect(callbackDeltas).toEqual(["hello ", "world"]);
		expect(eventUpdates).toEqual([
			{ id: "bash-1", delta: "hello " },
			{ id: "bash-1", delta: "world" },
		]);
	});

	describe("escape sequences split across output chunks", () => {
		async function runChunks(chunks: Array<string | Buffer>, beforeExit?: (streamed: string) => void, abort = false) {
			const harness = await createHarness();
			harnesses.push(harness);
			const deltas: string[] = [];
			const operations: BashOperations = {
				exec: async (_command, _cwd, options) => {
					for (const chunk of chunks) {
						options.onData(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
					}
					beforeExit?.(deltas.join(""));
					if (abort) {
						harness.session.abortBash();
						throw new Error("aborted");
					}
					return { exitCode: 0 };
				},
			};
			const result = await harness.session.executeBash("custom", (delta) => deltas.push(delta), { operations });
			if (result.fullOutputPath) {
				outputFiles.push(result.fullOutputPath);
			}
			const recorded = harness.session.messages.at(-1);
			const persisted = harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message")
				.at(-1);
			expect(recorded?.role).toBe("bashExecution");
			expect(recorded?.role === "bashExecution" ? recorded.output : undefined).toBe(result.output);
			expect(
				persisted?.type === "message" && persisted.message.role === "bashExecution"
					? persisted.message.output
					: undefined,
			).toBe(result.output);
			expect(
				harness
					.eventsOfType("bash_execution_update")
					.map((event) => event.delta)
					.join(""),
			).toBe(deltas.join(""));
			expect(harness.session.isBashRunning).toBe(false);
			return { result, streamed: deltas.join("") };
		}

		it.each([
			{
				name: "CSI reset inside parameters",
				chunks: ["\x1b[31mERROR: file.py:1\x1b[0", "m\n"],
				expected: "ERROR: file.py:1\n",
			},
			{
				name: "CSI immediately after ESC",
				chunks: ["before\x1b", "[32mafter\n"],
				expected: "beforeafter\n",
			},
			{
				name: "C1 CSI inside parameters",
				chunks: ["before\x9b3", "2mafter\n"],
				expected: "beforeafter\n",
			},
			{
				name: "DEC private modes inside parameters",
				chunks: ["a\x1b[?104", "9lb\x1b[?47", "h"],
				expected: "ab",
			},
			{
				name: "OSC before BEL",
				chunks: ["a\x1b]0;window ", "title\x07b\n"],
				expected: "ab\n",
			},
			{
				name: "OSC inside ESC-backslash terminator",
				chunks: ["a\x1b]0;window ", "title\x1b", "\\b\n"],
				expected: "ab\n",
			},
			{
				name: "OSC before C1 terminator",
				chunks: ["a\x1b]0;window ", "title\x9cb\n"],
				expected: "ab\n",
			},
			{
				name: "CSI mixed with binary controls and CRLF",
				chunks: ["a\x00\t\r\n\x1b[3", "1mb\ufff9\r\n"],
				expected: "a\t\nb\n",
			},
		])("strips $name as a whole", async ({ chunks, expected }) => {
			const { result, streamed } = await runChunks(chunks);
			expect(result.output).toBe(expected);
			expect(streamed).toBe(expected);
			expect(result.exitCode).toBe(0);
			expect(result.cancelled).toBe(false);
			expect(result.truncated).toBe(false);
		});

		it("decodes UTF-8 split across chunks without replacement characters", async () => {
			const bytes = Buffer.from("é🙂");
			const { result, streamed } = await runChunks(Array.from(bytes, (byte) => Buffer.from([byte])));
			expect(result.output).toBe("é🙂");
			expect(streamed).toBe("é🙂");
		});

		it("flushes incomplete UTF-8 at successful EOF", async () => {
			const { result, streamed } = await runChunks(["ok", Buffer.from("é").subarray(0, 1)]);
			expect(result.output).toBe("ok\uFFFD");
			expect(streamed).toBe("ok\uFFFD");
		});

		it("flushes an unfinished ANSI suffix through the existing sanitizer at EOF", async () => {
			const { result, streamed } = await runChunks(["ok\x1b["]);
			expect(result.output).toBe("ok[");
			expect(streamed).toBe("ok[");
		});

		it("does not hold back output behind a long unterminated OSC", async () => {
			const long = "x".repeat(300);
			const { result, streamed } = await runChunks([`\x1b]${long}`], (beforeExit) => {
				expect(beforeExit).toBe(`]${long}`);
			});
			expect(result.output).toBe(`]${long}`);
			expect(streamed).toBe(`]${long}`);
		});

		it("flushes incomplete UTF-8 and preserves sanitized partial output on abort", async () => {
			const { result, streamed } = await runChunks(
				["partial \x1b[31mred\x1b[0", "m", Buffer.from("é").subarray(0, 1)],
				undefined,
				true,
			);
			expect(result.output).toBe("partial red\uFFFD");
			expect(streamed).toBe("partial red\uFFFD");
			expect(result.cancelled).toBe(true);
			expect(result.exitCode).toBeUndefined();
		});

		it.each([
			{
				name: "rolling buffer eviction and byte truncation",
				chunks: [
					`\x1b[31mfirst:${"a".repeat(DEFAULT_MAX_BYTES)}\n\x1b[0`,
					`mmiddle:${"b".repeat(DEFAULT_MAX_BYTES)}\n`,
					"\x1b]0;title",
					`\x07tail:${"é".repeat(DEFAULT_MAX_BYTES)}\n`,
				],
				expected: `first:${"a".repeat(DEFAULT_MAX_BYTES)}\nmiddle:${"b".repeat(DEFAULT_MAX_BYTES)}\ntail:${"é".repeat(DEFAULT_MAX_BYTES)}\n`,
				abort: false,
			},
			{
				name: "EOF decoder flush crossing the byte threshold",
				chunks: ["a".repeat(DEFAULT_MAX_BYTES - 1), Buffer.from("é").subarray(0, 1)],
				expected: `${"a".repeat(DEFAULT_MAX_BYTES - 1)}\uFFFD`,
				abort: false,
			},
			{
				name: "line truncation after EOF decoder flush",
				chunks: ["line\n".repeat(DEFAULT_MAX_LINES + 1), Buffer.from("é").subarray(0, 1)],
				expected: `${"line\n".repeat(DEFAULT_MAX_LINES + 1)}\uFFFD`,
				abort: false,
			},
			{
				name: "abort after large partial output",
				chunks: [`\x1b[31m${"a".repeat(DEFAULT_MAX_BYTES + 1)}\x1b[0`, "m", Buffer.from("é").subarray(0, 1)],
				expected: `${"a".repeat(DEFAULT_MAX_BYTES + 1)}\uFFFD`,
				abort: true,
			},
		])("preserves full sanitized tempfile output during $name", async ({ chunks, expected, abort }) => {
			const { result, streamed } = await runChunks(chunks, undefined, abort);
			expect(streamed).toBe(expected);
			expect(result.output).toBe(truncateTail(expected).content);
			expect(result.truncated).toBe(true);
			expect(result.cancelled).toBe(abort);
			expect(result.exitCode).toBe(abort ? undefined : 0);
			expect(result.fullOutputPath).toBeDefined();
			const path = result.fullOutputPath!;
			await expect.poll(() => (fs.existsSync(path) ? fs.readFileSync(path, "utf8") : undefined)).toBe(expected);
		});

		it("preserves the raw-byte tempfile threshold for ANSI-only trailing chunks", async () => {
			const expected = "a".repeat(DEFAULT_MAX_BYTES);
			const { result, streamed } = await runChunks([expected, "\x1b[31m"]);
			expect(result.output).toBe(expected);
			expect(streamed).toBe(expected);
			expect(result.truncated).toBe(false);
			expect(result.fullOutputPath).toBeDefined();
			const path = result.fullOutputPath!;
			await expect.poll(() => (fs.existsSync(path) ? fs.readFileSync(path, "utf8") : undefined)).toBe(expected);
		});

		it("ends the existing tempfile stream and rethrows non-abort operation errors", async () => {
			const harness = await createHarness();
			harnesses.push(harness);
			const createStream = vi.mocked(fs.createWriteStream);
			createStream.mockClear();
			const error = new Error("custom operation failed");
			const partial = "a".repeat(DEFAULT_MAX_BYTES + 1);
			const deltas: string[] = [];
			const operations: BashOperations = {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from(partial));
					options.onData(Buffer.from("\x1b["));
					options.onData(Buffer.from("é").subarray(0, 1));
					throw error;
				},
			};
			try {
				await expect(
					harness.session.executeBash("custom", (delta) => deltas.push(delta), { operations }),
				).rejects.toBe(error);
				expect(createStream).toHaveBeenCalledTimes(1);
				const stream = createStream.mock.results[0].value as fs.WriteStream;
				outputFiles.push(String(stream.path));
				expect(stream.writableEnded).toBe(true);
				await finished(stream);
				expect(fs.readFileSync(stream.path, "utf8")).toBe(partial);
				expect(deltas.join("")).toBe(partial);
				expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);
				expect(harness.session.isBashRunning).toBe(false);
			} finally {
				createStream.mockClear();
			}
		});
	});
});
