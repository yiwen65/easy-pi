import { type AssistantMessage, createAssistantMessageEventStream, createModels } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AgentHarness, HarnessFault, type HarnessTool } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage, JsonlSessionRepo, Session } from "../../src/harness/session/index.ts";
import { AgentToolError, type StreamFn } from "../../src/types.ts";
import { createTempDir } from "./session-test-utils.ts";

const model = getModel("google", "gemini-2.5-flash");
function message(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason,
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
const call = { type: "toolCall" as const, id: "effect-1", name: "effect", arguments: {} };
function tool(execute: HarnessTool["execute"], contract?: HarnessTool["contract"]): HarnessTool {
	return {
		name: "effect",
		label: "Effect",
		description: "offline",
		parameters: Type.Object({}),
		execute,
		...(contract ? { contract } : {}),
	};
}
function harness(session: Session, streamFn: StreamFn, tools: HarnessTool[] = [], maxRetries = 1) {
	return AgentHarness.create({
		session,
		model,
		models: createModels(),
		streamFn,
		tools,
		retry: { enabled: true, maxRetries, baseDelayMs: 0 },
	});
}
function finalStream() {
	const stream = createAssistantMessageEventStream();
	stream.end(message());
	return stream;
}

describe("durable atomic recovery", () => {
	it("cancelling a read-only observation aborts the run without requiring effect reconciliation", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "readonly-cancel", createdAt: 1 }));
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let requests = 0;
		const { harness: driver } = await harness(session, () => {
			requests++;
			const stream = createAssistantMessageEventStream();
			stream.end({ ...message("toolUse"), content: [call] });
			return stream;
		}, [
			tool(
				async (_id, _args, signal) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("observation cancelled")), { once: true });
						entered();
					}),
				{ readOnly: true },
			),
		]);
		const running = driver.prompt("observe");
		await ready;
		await driver.abort();
		const outcome = await running;
		expect(outcome.ok && outcome.value.kind).toBe("aborted");
		expect(requests).toBe(1);
		expect(await session.findRecords({ type: "tool_reconciliation" })).toHaveLength(0);
		await driver.close();
	});
	it("commits a non-replay-safe Bash exit error and continues without executing it twice", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "bash-exit", createdAt: 1 }));
		let effects = 0;
		let requests = 0;
		const bashCall = { ...call, name: "bash", arguments: { command: "ls missing" } };
		const bash: HarnessTool = {
			name: "bash",
			label: "bash",
			description: "offline",
			parameters: Type.Object({ command: Type.String() }),
			replay: "never",
			execute: async () => {
				effects++;
				throw new AgentToolError("Command exited with code 2", {
					command: "ls missing",
					cwd: "/workspace",
					exitCode: 2,
					signal: null,
					terminationReason: "exit",
					terminationRequested: false,
					timedOut: false,
					durationMs: 42,
				});
			},
		};
		const { harness: driver } = await harness(session, () => {
			if (++requests > 1) return finalStream();
			const stream = createAssistantMessageEventStream();
			stream.end({ ...message("toolUse"), content: [bashCall] });
			return stream;
		}, [bash]);
		const outcome = await driver.prompt("inspect");
		expect(outcome.ok && outcome.value.kind).toBe("completed");
		expect(effects).toBe(1);
		expect(requests).toBe(2);
		expect(await session.findRecords({ type: "tool_reconciliation" })).toHaveLength(0);
		expect(
			(await session.findEntries()).find((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toMatchObject({ message: { isError: true, details: { exitCode: 2 } } });
	});
	it("a network error after an unsafe side effect blocks model reissue", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "unsafe-error", createdAt: 1 }));
		let effects = 0;
		let requests = 0;
		const { harness: driver } = await harness(session, () => {
			const stream = createAssistantMessageEventStream();
			stream.end({ ...message("toolUse"), content: [{ ...call, id: `effect-${++requests}` }] });
			return stream;
		}, [
			tool(async () => {
				effects++;
				throw new Error("ECONNRESET after remote commit");
			}),
		]);
		const outcome = await driver.prompt("perform");
		expect(outcome.ok && outcome.value.kind).toBe("needs_reconciliation");
		const resumed = await driver.resume();
		expect(resumed.ok && resumed.value.kind).toBe("needs_reconciliation");
		expect(effects).toBe(1);
		expect(requests).toBe(1);
		expect(
			(await session.findEntries()).filter(
				(entry) => entry.type === "message" && entry.message.role === "toolResult",
			),
		).toHaveLength(0);
	});

	it.each(["safety", "schema"])(
		"revalidates the current %s before replaying a previously safe call",
		async (changed) => {
			const session = new Session(new InMemorySessionStorage({ id: `changed-${changed}`, createdAt: 1 }));
			const originalTool = tool(
				async () => {
					throw new HarnessFault("crash", undefined);
				},
				{ readOnly: true },
			);
			const { harness: original } = await harness(session, () => {
				const stream = createAssistantMessageEventStream();
				stream.end({ ...message("toolUse"), content: [call] });
				return stream;
			}, [originalTool]);
			await expect(original.prompt("perform")).rejects.toThrow("crash");
			let replays = 0;
			let requests = 0;
			const currentTool = tool(
				async () => {
					replays++;
					return { content: [], details: {} };
				},
				changed === "schema" ? { readOnly: true } : undefined,
			);
			if (changed === "schema") currentTool.parameters = Type.Object({ newlyRequired: Type.String() });
			const { harness: recovered } = await harness(session, () => {
				requests++;
				return finalStream();
			}, [currentTool]);
			const outcome = await recovered.resume();
			expect(outcome.ok && outcome.value.kind).toBe("needs_reconciliation");
			expect(replays).toBe(0);
			expect(requests).toBe(0);
			const again = await recovered.resume();
			expect(again.ok && again.value.kind).toBe("needs_reconciliation");
			expect(replays).toBe(0);
		},
	);

	it("complete tool-call events supply authoritative arguments when partial content is stale", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "stale-partial", createdAt: 1 }));
		let requests = 0;
		let effects = 0;
		const { harness: driver } = await harness(session, () => {
			if (++requests > 1) return finalStream();
			const stream = createAssistantMessageEventStream();
			const partial = { ...message("error"), content: [], errorMessage: "ECONNRESET fetch failed" };
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial, itemComplete: true });
			stream.push({ type: "error", reason: "error", error: partial });
			stream.end(partial);
			return stream;
		}, [
			tool(async () => {
				effects++;
				return { content: [], details: {} };
			}),
		]);
		const outcome = await driver.prompt("perform");
		expect(outcome.ok && outcome.value.kind).toBe("completed");
		expect(effects).toBe(1);
	});

	it("close pauses the stream and releases ownership while retaining resumable intent", async () => {
		const root = createTempDir();
		const repository = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		const session = await repository.create({ id: "close-stream", cwd: root });
		let entered = false;
		const { harness: driver } = await harness(session, (_model, _context, options) => {
			entered = true;
			const stream = createAssistantMessageEventStream();
			options?.signal?.addEventListener("abort", () => stream.end(message("aborted")), { once: true });
			return stream;
		});
		const running = driver.prompt("perform");
		while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));
		await driver.close();
		const result = await running;
		expect(result.ok && result.value.kind).toBe("paused");
		expect(await session.findRecords({ type: "abort_requested" })).toHaveLength(0);
		expect(await session.findRecords({ type: "operation_finished" })).toHaveLength(0);
		const reopened = await repository.open(await session.getMetadata());
		const { harness: recovered } = await harness(reopened, finalStream);
		const resumed = await recovered.resume();
		expect(resumed.ok && resumed.value.kind).toBe("completed");
		await recovered.close();
	});

	it("close refuses to release ownership until a timed-out physical tool exits", async () => {
		const root = createTempDir();
		const repository = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		const session = await repository.create({ id: "close-tool", cwd: root });
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { harness: driver } = await harness(session, () => {
			const stream = createAssistantMessageEventStream();
			stream.end({ ...message("toolUse"), content: [call] });
			return stream;
		}, [
			tool(
				async () => {
					await gate;
					return { content: [{ type: "text", text: "late result" }], details: {} };
				},
				{ timeoutMs: 5 },
			),
		]);
		const outcome = await driver.prompt("perform");
		expect(outcome.ok && outcome.value.kind).toBe("needs_reconciliation");
		await expect(driver.close()).rejects.toThrow("ownership was retained");
		await expect(repository.open(await session.getMetadata())).rejects.toBeInstanceOf(Error);
		release();
		await new Promise((resolve) => setTimeout(resolve, 1));
		await driver.close();
		const reopened = await repository.open(await session.getMetadata());
		expect(await reopened.findOpenOperations("main")).toHaveLength(1);
		await reopened.release();
	});

	it("text-only checkpoints continue the task with the committed prose", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "text", createdAt: 1 }));
		let requests = 0;
		const { harness: driver } = await harness(session, (_model, context) => {
			if (++requests > 1) {
				expect(context.messages.at(-1)).toMatchObject({
					role: "assistant",
					content: [{ type: "text", text: "done" }],
				});
				return finalStream();
			}
			const stream = createAssistantMessageEventStream();
			const partial = { ...message("error"), errorMessage: "ECONNRESET fetch failed" };
			stream.push({ type: "text_end", contentIndex: 0, content: "done", partial, itemComplete: true });
			stream.push({ type: "error", reason: "error", error: partial });
			stream.end(partial);
			return stream;
		});
		const result = await driver.prompt("perform");
		expect(result.ok && result.value.kind).toBe("completed");
		expect(requests).toBe(2);
	});

	it("commits complete items while streaming without dispatch, then executes after disconnect", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "stream", createdAt: 1 }));
		const stream = createAssistantMessageEventStream();
		const partial = { ...message("toolUse"), content: [call] };
		let effects = 0;
		let requests = 0;
		const { harness: driver } = await harness(session, () => (++requests === 1 ? stream : finalStream()), [
			tool(async () => {
				effects++;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			}),
		]);
		const running = driver.prompt("perform");
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial, itemComplete: true });
		while ((await session.findRecords({ type: "assistant_checkpoint" })).length === 0)
			await new Promise((resolve) => setTimeout(resolve, 1));
		expect(effects).toBe(0);
		const error = { ...partial, stopReason: "error" as const, errorMessage: "fetch failed (ECONNRESET)" };
		stream.push({ type: "error", reason: "error", error });
		stream.end(error);
		const result = await running;
		expect(result.ok && result.value.kind).toBe("completed");
		expect(effects).toBe(1);
		expect(requests).toBe(2);
		expect(
			(await session.findEntries()).filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.isResponseCheckpoint,
			),
		).toHaveLength(1);
	});

	it("recovers complete items from a crash before the stream result was committed", async () => {
		const root = createTempDir();
		const repository = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		const session = await repository.create({ id: "crash", cwd: root });
		await session.appendRecord({
			type: "operation_started",
			id: "run",
			lane: "main",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [], initialMessages: [] },
		});
		await session.appendRecord({
			type: "step_attempt",
			id: "step",
			lane: "main",
			runId: "run",
			step: "assistant",
			resultEntryId: "assistant",
			attempt: 1,
		});
		await session.appendRecord({
			type: "assistant_checkpoint",
			id: "checkpoint",
			lane: "main",
			runId: "run",
			resultEntryId: "assistant",
			attempt: 1,
			message: { ...message("toolUse"), content: [call], isResponseCheckpoint: true },
		});
		await session.release();
		let effects = 0;
		const reopened = await repository.open(await session.getMetadata());
		const { harness: recovered } = await harness(reopened, finalStream, [
			tool(async () => {
				effects++;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			}),
		]);
		const result = await recovered.resume();
		expect(result.ok && result.value.kind).toBe("completed");
		expect(effects).toBe(1);
		expect(await reopened.getEntry("assistant")).toMatchObject({ message: { isResponseCheckpoint: true } });
	});

	it("timeout cancels the tool signal and never requests a model continuation", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "timeout", createdAt: 1 }));
		let cancelled = false;
		let requests = 0;
		const cooperative = tool(
			async (_id, _args, signal) =>
				new Promise((_resolve, reject) =>
					signal?.addEventListener(
						"abort",
						() => {
							cancelled = true;
							reject(new Error("cancelled"));
						},
						{ once: true },
					),
				),
			{ timeoutMs: 5 },
		);
		const { harness: driver } = await harness(session, () => {
			requests++;
			const stream = createAssistantMessageEventStream();
			stream.end({ ...message("toolUse"), content: [call] });
			return stream;
		}, [cooperative]);
		const result = await driver.prompt("perform");
		expect(result.ok && result.value.kind).toBe("needs_reconciliation");
		expect(cancelled).toBe(true);
		expect(requests).toBe(1);
		expect(await session.findRecords({ type: "operation_finished" })).toHaveLength(0);
		const { harness: restarted } = await harness(session, () => {
			throw new Error("must not request model");
		}, [cooperative]);
		const resumed = await restarted.resume();
		expect(resumed.ok && resumed.value.kind).toBe("needs_reconciliation");
	});

	it("explicit retry authorization permits one dispatch and is consumed before execution", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "authorize", createdAt: 1 }));
		let effects = 0;
		const crashing = tool(async () => {
			effects++;
			throw new HarnessFault("crash", undefined);
		});
		const { harness: original } = await harness(session, () => {
			const stream = createAssistantMessageEventStream();
			stream.end({ ...message("toolUse"), content: [call] });
			return stream;
		}, [crashing]);
		await expect(original.prompt("perform")).rejects.toThrow("crash");
		const { harness: recovered } = await harness(session, finalStream, [crashing]);
		await recovered.reconcileTool(call.id, { kind: "retry" });
		await expect(recovered.resume()).rejects.toThrow("crash");
		expect(effects).toBe(2);
		const resumed = await recovered.resume();
		expect(resumed.ok && resumed.value.kind).toBe("needs_reconciliation");
		expect(effects).toBe(2);
	});

	it("does not retry authentication failures", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "auth", createdAt: 1 }));
		let requests = 0;
		const { harness: driver } = await harness(session, () => {
			requests++;
			const stream = createAssistantMessageEventStream();
			stream.end({ ...message("error"), errorMessage: "401 unauthorized" });
			return stream;
		});
		const result = await driver.prompt("perform");
		expect(result.ok && result.value.kind).toBe("failed");
		expect(requests).toBe(1);
	});

	it("cancelled in-flight tools preserve the unresolved operation instead of finishing it", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "cancel", createdAt: 1 }));
		let dispatched = false;
		const { harness: driver } = await harness(session, () => {
			const stream = createAssistantMessageEventStream();
			stream.end({ ...message("toolUse"), content: [call] });
			return stream;
		}, [
			tool(async () => {
				dispatched = true;
				return await new Promise(() => undefined);
			}),
		]);
		const running = driver.prompt("perform");
		while (!dispatched) await new Promise((resolve) => setTimeout(resolve, 1));
		await driver.abort();
		const outcome = await running;
		expect(outcome.ok && outcome.value.kind).toBe("needs_reconciliation");
		expect(await session.findRecords({ type: "operation_finished" })).toHaveLength(0);
	});

	it("repeated complete checkpoints consume the retry budget", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "budget", createdAt: 1 }));
		let requests = 0;
		let effects = 0;
		const { harness: driver } = await harness(session, () => {
			requests++;
			const stream = createAssistantMessageEventStream();
			const nextCall = { ...call, id: `effect-${requests}` };
			const partial = { ...message("error"), content: [nextCall], errorMessage: "ECONNRESET fetch failed" };
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: nextCall, partial, itemComplete: true });
			stream.push({ type: "error", reason: "error", error: partial });
			stream.end(partial);
			return stream;
		}, [
			tool(async () => {
				effects++;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			}),
		]);
		const result = await driver.prompt("perform");
		expect(result.ok && result.value.kind).toBe("failed");
		expect(requests).toBe(2);
		expect(effects).toBe(2);
	});
});
