import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertMessages } from "../../../../ai/src/api/openai-completions.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { TaskRecoveryJournal } from "../../../src/core/task-recovery.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

const wireCompat: Parameters<typeof convertMessages>[2] = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
};

function providerWire(harness: Harness, context: Context) {
	const model: Model<"openai-completions"> = { ...harness.getModel(), api: "openai-completions", provider: "openai" };
	return convertMessages(model, context, wireCompat);
}

function barrier() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function result(id: string, name = "effect"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: `verified:${id}` }],
		isError: false,
		timestamp: 1,
	};
}

function seed(manager: SessionManager, ids: string[], stopReason: "toolUse" | "length" = "toolUse") {
	const journal = new TaskRecoveryJournal(manager);
	const user = { role: "user" as const, content: "original task", timestamp: 1 };
	journal.start([user]);
	manager.appendMessage(user, journal.state!.promptEntryIds[0]);
	const calls = ids.map((id) => fauxToolCall("effect", { value: id }, { id }));
	const assistant = fauxAssistantMessage(
		stopReason === "length" ? [{ type: "text", text: "truncated response body" }, ...calls] : calls,
		{ stopReason },
	);
	journal.beginStep(assistant);
	for (const [index, block] of assistant.content.entries()) journal.completeItem(index, block, assistant);
	journal.commitAssistant(assistant, manager.appendMessage(assistant));
	journal.update((state) => {
		state.status = "interrupted";
	});
	return { journal, calls };
}

const effectSchema = Type.Object({ value: Type.String() });
type EffectTool = AgentTool<typeof effectSchema>;

function effectTool(execute: EffectTool["execute"]): AgentTool {
	const tool: EffectTool = {
		name: "effect",
		label: "Effect",
		description: "Offline test effect",
		parameters: effectSchema,
		executionMode: "sequential",
		execute,
	};
	return {
		...tool,
		execute: (id, params, signal, onUpdate) => {
			if (!Check(effectSchema, params)) throw new Error("Invalid effect test arguments");
			return tool.execute(id, params, signal, onUpdate);
		},
	};
}

describe("b824062c: recovery driver, accounting, and branch queue contracts", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it.each([false, true])(
		"rejects a second preflight driver without settling or replacing the first: persisted=%s",
		async (persisted) => {
			const firstPreflight = barrier();
			const secondPreflight = barrier();
			const bothPreflights = barrier();
			const providerStarted = barrier();
			const providerRelease = barrier();
			let entered = 0;
			const dir = persisted ? mkdtempSync(join(tmpdir(), "pi-driver-contract-")) : undefined;
			if (dir) dirs.push(dir);
			const harness = await createHarness({
				sessionManager: dir ? SessionManager.create(dir, join(dir, "sessions")) : undefined,
				hfCompaction: { mode: "off" },
				tools: [],
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", async (event) => {
							if (++entered === 2) bothPreflights.release();
							await (event.prompt === "first" ? firstPreflight.promise : secondPreflight.promise);
							return { systemPrompt: `system:${event.prompt}` };
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				async () => {
					providerStarted.release();
					await providerRelease.promise;
					return fauxAssistantMessage("first complete");
				},
			]);
			const first = harness.session.prompt("first");
			const second = harness.session.prompt("second").catch((error: unknown) => error);
			await bothPreflights.promise;
			firstPreflight.release();
			await providerStarted.promise;
			const firstTaskId = harness.session.taskRecovery!.id;
			try {
				secondPreflight.release();
				expect(await second).toBeInstanceOf(Error);
				expect(harness.session.taskRecovery?.id).toBe(firstTaskId);
				expect(harness.session.taskRecovery?.status).toBe("running");
				expect(harness.session.systemPrompt).toBe("system:first");
				expect(harness.session.isIdle).toBe(false);
				expect(harness.session.agent.state.isStreaming).toBe(true);
				expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
			} finally {
				providerRelease.release();
				await first;
			}
			expect(getUserTexts(harness)).toEqual(["first"]);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			if (persisted) expect(existsSync(`${harness.session.sessionFile}.task.lock`)).toBe(false);
		},
	);

	it("keeps memory ownership through nested queue, cancel, and retirement operations", () => {
		const manager = SessionManager.inMemory();
		const journal = new TaskRecoveryJournal(manager);
		journal.start([]);
		journal.acquire();
		const acquire = vi.spyOn(journal, "acquire");
		const release = vi.spyOn(journal, "release");
		try {
			const ids = journal.queue("followUp", [{ role: "user", content: "queued", timestamp: 1 }]);
			journal.cancelQueued(new Set(ids));
			const capture = fauxToolCall("computer", { request: { op: "capture" } }, { id: "capture" });
			journal.dispatch(capture, capture.arguments, false);
			journal.retireRemovedComputerCaptures(new Set());
			expect(acquire).not.toHaveBeenCalled();
			expect(release).not.toHaveBeenCalled();
			expect(() => journal.acquire()).toThrow("already active");
			expect(() => new TaskRecoveryJournal(manager).acquire()).toThrow("already active");
		} finally {
			journal.release();
		}
		journal.acquire();
		journal.release();
	});

	it.each([
		{ ids: [], recorded: false },
		{ ids: ["truncated-a", "truncated-b"], recorded: false },
		{ ids: ["truncated-a", "truncated-b"], recorded: true },
	])(
		"continues a committed length response with safe missing results and no dispatch: calls=$ids recorded=$recorded",
		async ({ ids, recorded }) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-driver-length-"));
			dirs.push(dir);
			const manager = SessionManager.create(dir, join(dir, "sessions"));
			const { journal, calls } = seed(manager, ids, "length");
			expect(journal.state?.step?.recoverable).toBe(false);
			if (recorded) {
				const known: ToolResultMessage = {
					...result(calls[0].id),
					content: [{ type: "text", text: "not executed: truncated response" }],
					isError: true,
				};
				journal.result(known, calls[0], false, false);
				manager.appendMessage(known);
			}
			// A previous failed recovery artifact is not the fresh continuation anchor.
			manager.appendMessage(fauxAssistantMessage("", { stopReason: "error", errorMessage: "old failed recovery" }));
			const execute = vi.fn<EffectTool["execute"]>(async () => ({ content: [], details: {} }));
			const harness = await createHarness({
				sessionManager: SessionManager.open(manager.getSessionFile()!),
				tools: [effectTool(execute)],
				hfCompaction: { mode: "off" },
			});
			harnesses.push(harness);
			let providerContext: Context | undefined;
			harness.setResponses([
				(context) => {
					providerContext = context;
					return fauxAssistantMessage("fresh provider step");
				},
			]);
			await harness.session.resumeTask();
			expect(execute).not.toHaveBeenCalled();
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.taskRecovery?.status).toBe("completed");
			const canonical = harness.sessionManager.buildSessionContext().messages;
			const canonicalLength = canonical.filter(
				(message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "length",
			);
			expect(canonicalLength).toHaveLength(1);
			expect(getMessageText(canonicalLength[0])).toBe("truncated response body");
			expect(providerContext).toBeDefined();
			const outgoingTruncated = providerContext?.messages.filter(
				(message) => message.role === "assistant" && getMessageText(message) === "truncated response body",
			);
			if (ids.length === 0) {
				expect(JSON.stringify(providerContext?.messages)).not.toContain("truncated response body");
				expect(outgoingTruncated).toEqual([]);
			} else {
				// Late results may normalize the wire stop reason; preserve the real exchange.
				expect(outgoingTruncated).toHaveLength(1);
				expect(outgoingTruncated?.[0]).toMatchObject({ content: canonicalLength[0].content });
				expect(
					harness.session.messages.filter(
						(message) => message.role === "assistant" && message.stopReason === "length",
					),
				).toEqual(canonicalLength);
				expect(
					providerContext?.messages
						.filter((message) => message.role === "toolResult")
						.map((message) => message.toolCallId),
				).toEqual(ids);
			}
			const results = canonical.filter((message) => message.role === "toolResult");
			expect(harness.session.taskRecovery?.tools.filter((tool) => tool.dispatched)).toEqual([]);
			expect(results.map((message) => message.toolCallId)).toEqual(ids);
			expect(results.every((message) => message.isError && getMessageText(message).includes("not executed"))).toBe(
				true,
			);
			await harness.session.resumeTask();
			expect(execute).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	it("keeps an omitted late length artifact out of owned next-turn provider context", async () => {
		const execute = vi.fn<EffectTool["execute"]>(async () => ({ content: [], details: {} }));
		const truncated = fauxAssistantMessage("late truncated response body", { stopReason: "length" });
		const harness = await createHarness({
			tools: [effectTool(execute)],
			hfCompaction: { mode: "off" },
			prepareNextTurnWithContext: ({ context }) => ({
				context: {
					...context,
					messages: [...context.messages, { role: "user", content: "owned request marker", timestamp: 1 }],
				},
			}),
		});
		harnesses.push(harness);
		harness.session.agent.subscribe(async (event) => {
			if (event.type !== "message_end") return;
			if (event.message.role === "toolResult") await harness.session.steer("queued continuation");
			if (event.message.role === "user" && getMessageText(event.message) === "queued continuation") {
				// This recovery artifact commits after the owned-context boundary but stays absent live.
				harness.sessionManager.appendMessage(truncated);
			}
		});
		let providerContext: Context | undefined;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("effect", { value: "complete" }), { stopReason: "toolUse" }),
			(context) => {
				providerContext = context;
				return fauxAssistantMessage("fresh provider step");
			},
		]);
		await harness.session.prompt("start tool turn");
		expect(harness.faux.state.callCount).toBe(2);
		expect(execute).toHaveBeenCalledOnce();
		expect(providerContext?.messages.map(getMessageText)).toContain("owned request marker");
		expect(providerContext?.messages.map(getMessageText)).toContain("queued continuation");
		expect(JSON.stringify(providerContext?.messages)).not.toContain("late truncated response body");
		expect(harness.session.messages).not.toContain(truncated);
		expect(harness.sessionManager.buildSessionContext().messages).toContain(truncated);
	});

	it("publishes every verified journal-only result in source call order before replacing an intent", async () => {
		const manager = SessionManager.inMemory();
		const { journal, calls } = seed(manager, ["a", "b"]);
		for (const call of [...calls].reverse()) {
			journal.update((state) => {
				state.status = "running";
			});
			journal.dispatch(call, call.arguments, false);
			journal.result(result(call.id), call, false, false);
		}
		journal.update((state) => {
			state.status = "interrupted";
		});
		const harness = await createHarness({ sessionManager: manager, tools: [], hfCompaction: { mode: "off" } });
		harnesses.push(harness);
		let received: string[] = [];
		harness.setResponses([
			(context) => {
				received = context.messages
					.filter((message) => message.role === "toolResult")
					.map((message) => message.toolCallId);
				return fauxAssistantMessage("new task done");
			},
		]);
		await harness.session.prompt("new task");
		expect(received).toEqual(["a", "b"]);
		expect(
			manager
				.buildSessionContext()
				.messages.filter((message) => message.role === "toolResult")
				.map((message) => message.toolCallId),
		).toEqual(["a", "b"]);
		expect(harness.session.suspendedTaskRecovery).toEqual([]);
	});

	it("projects reconciled suspended results in both canonical history and the next provider context exactly once", async () => {
		const manager = SessionManager.inMemory();
		const { journal, calls } = seed(manager, ["archived"]);
		journal.update((state) => {
			state.status = "running";
		});
		journal.dispatch(calls[0], calls[0].arguments, false);
		journal.start([{ role: "user", content: "inspection", timestamp: 2 }]);
		journal.reconcile("archived", { kind: "result", result: result("archived") });
		const harness = await createHarness({ sessionManager: manager, tools: [], hfCompaction: { mode: "off" } });
		harnesses.push(harness);
		const observed: string[][] = [];
		harness.setResponses(
			[1, 2].map(() => (context) => {
				observed.push(
					context.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
				);
				expect(
					context.messages.some(
						(message) =>
							message.role === "assistant" &&
							message.content.some((block) => block.type === "toolCall" && block.id === "archived"),
					),
				).toBe(true);
				return fauxAssistantMessage("new done");
			}),
		);
		await harness.session.prompt("new task");
		await harness.session.prompt("another task");
		expect(observed).toEqual([["archived"], ["archived"]]);
		expect(
			manager
				.buildSessionContext()
				.messages.filter((message) => message.role === "toolResult" && message.toolCallId === "archived"),
		).toHaveLength(1);
	});

	it("keeps a planned but unaccounted task recoverable when a new prompt replaces it", async () => {
		const manager = SessionManager.inMemory();
		const { journal, calls } = seed(manager, ["a", "b"]);
		const oldId = journal.state!.id;
		journal.result(result("a"), calls[0], false, false);
		const executed: string[] = [];
		const harness = await createHarness({
			sessionManager: manager,
			tools: [
				effectTool(async (_id, params) => {
					executed.push(params.value);
					return { content: [], details: {} };
				}),
			],
			hfCompaction: { mode: "off" },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("independent work")]);
		await harness.session.prompt("new task");
		expect(harness.session.suspendedTaskRecovery.map((task) => task.state.id)).toContain(oldId);
		harness.setResponses([fauxAssistantMessage("old task done")]);
		await harness.session.resumeTask(oldId);
		expect(executed).toEqual(["b"]);
	});

	it.each(["cancelled", "completed"] as const)(
		"does not indefinitely archive %s tasks with undispatched planned calls",
		async (status) => {
			const manager = SessionManager.inMemory();
			const { journal } = seed(manager, ["never-dispatched"]);
			journal.update((state) => {
				state.status = status;
			});
			const harness = await createHarness({ sessionManager: manager, tools: [], hfCompaction: { mode: "off" } });
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("new done")]);
			await harness.session.prompt("new task");
			expect(harness.session.suspendedTaskRecovery).toEqual([]);
		},
	);

	it("does not hand off a dependent queue when reconciliation accounted only A of planned A+B", async () => {
		let effects = 0;
		const harness = await createHarness({
			tools: [
				effectTool(async (_id, params) => {
					if (params.value === "b") throw new Error("B must remain undispatched");
					effects++;
					throw new Error("lost acknowledgement after A");
				}),
				{
					name: "inspect",
					label: "Inspect",
					description: "Read-only evidence",
					parameters: Type.Object({}),
					contract: { readOnly: true },
					execute: async () => ({ content: [{ type: "text", text: "A completed" }], details: {} }),
				},
			],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		let queued = false;
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolCallId === "a" && !queued) {
				queued = true;
				void harness.session.followUp("needs B");
			}
		});
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("effect", { value: "a" }, { id: "a" }), fauxToolCall("effect", { value: "b" }, { id: "b" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("inspect", {}, { id: "inspection" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall(
					"reconcile_task",
					{
						toolCallId: "a",
						evidenceToolCallIds: ["inspection"],
						observedOutcome: "A completed",
						outcome: "succeeded",
					},
					{ id: "reconcile" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("B remains pending"),
			fauxAssistantMessage("this must not consume the dependent queue"),
		]);
		await harness.session.prompt("do A then B");
		expect(effects).toBe(1);
		const original = harness.session.suspendedTaskRecovery[0].state;
		expect(
			original.step?.message?.content.filter((block) => block.type === "toolCall").map((call) => call.id),
		).toEqual(["a", "b"]);
		expect(original.tools.map((tool) => tool.call.id)).toEqual(["a"]);
		expect(original.queued.map((group) => group.label)).toEqual(["needs B"]);
		expect(getUserTexts(harness)).not.toContain("needs B");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("hands off a fully accounted dependent queue without exposing a journal-only orphan during investigation", async () => {
		const harness = await createHarness({
			tools: [
				effectTool(async () => {
					throw new Error("lost acknowledgement");
				}),
				{
					name: "inspect",
					label: "Inspect",
					description: "Read-only evidence",
					parameters: Type.Object({}),
					contract: { readOnly: true },
					execute: async () => ({ content: [{ type: "text", text: "A completed" }], details: {} }),
				},
			],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolCallId === "a")
				void harness.session.followUp("needs A");
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("effect", { value: "a" }, { id: "a" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("inspect", {}, { id: "inspection" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall(
					"reconcile_task",
					{
						toolCallId: "a",
						evidenceToolCallIds: ["inspection"],
						observedOutcome: "A completed",
						outcome: "succeeded",
					},
					{ id: "reconcile" },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				expect(
					context.messages.some(
						(message) =>
							message.role === "assistant" &&
							message.content.some((block) => block.type === "toolCall" && block.id === "a"),
					),
				).toBe(false);
				return fauxAssistantMessage("investigation done");
			},
			fauxAssistantMessage("dependent done"),
		]);
		await harness.session.prompt("do A");
		unsubscribe();
		expect(getUserTexts(harness)).toEqual(["do A", "needs A"]);
		expect(harness.session.suspendedTaskRecovery[0].state.queued).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("rebinds every live queue to the selected branch without cancelling old durable groups", async () => {
		const harness = await createHarness({
			tools: [],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("baseline")]);
		await harness.session.prompt("baseline");
		const baseline = harness.sessionManager.getLeafId()!;
		harness.setResponses([
			async () => {
				await harness.session.followUp("stale dependent");
				await harness.session.steer("stale steering");
				await harness.session.sendCustomMessage(
					{ customType: "aside", content: "stale aside", display: false },
					{ deliverAs: "nextTurn" },
				);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Network connection lost" });
			},
		]);
		await harness.session.prompt("failed branch");
		const oldLeaf = harness.sessionManager.getLeafId()!;
		const oldGroups = structuredClone(harness.session.taskRecovery!.queued);
		expect(oldGroups).toHaveLength(3);
		await harness.session.navigateTree(baseline);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		harness.setResponses([fauxAssistantMessage("unrelated new task")]);
		await harness.session.prompt("unrelated");
		expect(getUserTexts(harness)).toEqual(["baseline", "unrelated"]);
		expect(JSON.stringify(harness.session.messages)).not.toContain("stale aside");
		await harness.session.navigateTree(oldLeaf);
		expect(harness.session.taskRecovery?.queued).toEqual(oldGroups);
		expect(harness.session.getFollowUpMessages()).toEqual(["stale dependent"]);
		expect(harness.session.getSteeringMessages()).toEqual(["stale steering"]);
		harness.session.clearQueue();
		harness.setResponses([fauxAssistantMessage("returned branch")]);
		await harness.session.prompt("return");
		expect(
			harness.session.messages.filter((message) => message.role === "custom" && message.customType === "aside"),
		).toHaveLength(1);
	});

	it("T009: preserves ordinary completed occurrences and their provider prefix when call IDs repeat", async () => {
		const values: string[] = [];
		const harness = await createHarness({
			tools: [
				effectTool(async (_id, params) => {
					values.push(params.value);
					return { content: [{ type: "text", text: params.value }], details: {} };
				}),
			],
			hfCompaction: { mode: "off" },
		});
		harnesses.push(harness);
		const contexts: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("effect", { value: "FIRST_VERIFIED" }, { id: "call_0" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				contexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
				return fauxAssistantMessage("first done");
			},
			fauxAssistantMessage(fauxToolCall("effect", { value: "SECOND_VERIFIED" }, { id: "call_0" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				contexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
				return fauxAssistantMessage("second done");
			},
		]);
		await harness.session.prompt("first task");
		const firstSnapshot = structuredClone(contexts[0]);
		const firstCanonical = structuredClone(harness.sessionManager.getEntries());
		await harness.session.prompt("second task");
		expect(values).toEqual(["FIRST_VERIFIED", "SECOND_VERIFIED"]);
		expect(harness.session.suspendedTaskRecovery).toEqual([]);
		expect(
			harness.sessionManager
				.buildSessionContext()
				.messages.filter((message) => message.role === "toolResult")
				.map(getMessageText),
		).toEqual(["FIRST_VERIFIED", "SECOND_VERIFIED"]);
		expect(
			providerWire(harness, contexts[1])
				.filter((message) => message.role === "tool")
				.map((message) => message.content),
		).toEqual(["FIRST_VERIFIED", "SECOND_VERIFIED"]);
		expect(contexts[1].messages.slice(0, firstSnapshot.messages.length)).toEqual(firstSnapshot.messages);
		expect(contexts[0]).toEqual(firstSnapshot);
		expect(harness.sessionManager.getEntries().slice(0, firstCanonical.length)).toEqual(firstCanonical);
	});

	it.each([false, true])(
		"T009: scopes pending filtering and late recovery publication when an ordinary ID was reused: later ordinary=%s",
		async (laterOrdinary) => {
			const values: string[] = [];
			const harness = await createHarness({
				tools: [
					effectTool(async (_id, params) => {
						values.push(params.value);
						if (params.value === "SECOND_VERIFIED") throw new Error("lost acknowledgement after SECOND");
						return { content: [{ type: "text", text: params.value }], details: {} };
					}),
				],
				hfCompaction: { mode: "off" },
				settings: { retry: { enabled: false } },
			});
			harnesses.push(harness);
			const inspected: ReturnType<typeof providerWire>[] = [];
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("effect", { value: "FIRST_VERIFIED" }, { id: "call_0" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("first done"),
				fauxAssistantMessage(fauxToolCall("effect", { value: "SECOND_VERIFIED" }, { id: "call_0" }), {
					stopReason: "toolUse",
				}),
				(context) => {
					inspected.push(providerWire(harness, context));
					return fauxAssistantMessage("inspect second outcome");
				},
			]);
			await harness.session.prompt("first task");
			await harness.session.prompt("second task");
			expect
				.soft(inspected[0].filter((message) => message.role === "tool").map((message) => message.content))
				.toEqual(["FIRST_VERIFIED"]);
			if (laterOrdinary) {
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("effect", { value: "THIRD_VERIFIED" }, { id: "call_0" }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("third done"),
				]);
				await harness.session.prompt("third independent task");
			}
			harness.session.reconcileTool("call_0", {
				kind: "result",
				result: { ...result("call_0"), content: [{ type: "text", text: "SECOND_VERIFIED" }] },
			});
			const prefix = structuredClone(harness.sessionManager.getEntries());
			const observed: ReturnType<typeof providerWire>[] = [];
			harness.setResponses(
				[1, 2].map(() => (context) => {
					observed.push(providerWire(harness, context));
					return fauxAssistantMessage("new done");
				}),
			);
			await harness.session.prompt("new task");
			await harness.session.prompt("another task");
			for (const wire of observed) {
				expect
					.soft(wire.filter((message) => message.role === "tool").map((message) => message.content))
					.toEqual(
						laterOrdinary
							? ["FIRST_VERIFIED", "SECOND_VERIFIED", "THIRD_VERIFIED"]
							: ["FIRST_VERIFIED", "SECOND_VERIFIED"],
					);
				expect.soft(JSON.stringify(wire)).not.toContain("No result provided");
			}
			expect(values).toEqual(
				laterOrdinary
					? ["FIRST_VERIFIED", "SECOND_VERIFIED", "THIRD_VERIFIED"]
					: ["FIRST_VERIFIED", "SECOND_VERIFIED"],
			);
			expect(
				harness.sessionManager
					.buildSessionContext()
					.messages.filter((message) => message.role === "toolResult")
					.map(getMessageText),
			).toEqual(
				laterOrdinary
					? ["FIRST_VERIFIED", "THIRD_VERIFIED", "SECOND_VERIFIED"]
					: ["FIRST_VERIFIED", "SECOND_VERIFIED"],
			);
			expect(harness.sessionManager.getEntries().slice(0, prefix.length)).toEqual(prefix);
		},
	);

	it.each([false, true])(
		"T008: projects a late reconciled result as one atomic real exchange on the provider wire: error artifact=%s",
		async (errorArtifact) => {
			const effect = vi.fn<EffectTool["execute"]>(async () => {
				throw new Error("lost acknowledgement after A");
			});
			const harness = await createHarness({
				tools: [effectTool(effect)],
				hfCompaction: { mode: "off" },
				settings: { retry: { enabled: false } },
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("effect", { value: "a" }, { id: "a" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("inspect before retrying A"),
			]);
			await harness.session.prompt("original task");
			if (errorArtifact) {
				harness.sessionManager.appendMessage(
					fauxAssistantMessage(fauxToolCall("effect", { value: "a" }, { id: "a" }), {
						stopReason: "error",
						errorMessage: "interrupted partial artifact",
					}),
				);
			}
			harness.session.reconcileTool("a", {
				kind: "result",
				result: { ...result("a"), content: [{ type: "text", text: "VERIFIED_OUTPUT_UNIQUE" }] },
			});
			const prefix = structuredClone(harness.sessionManager.getEntries());
			const observed: ReturnType<typeof providerWire>[] = [];
			harness.setResponses(
				[1, 2].map(() => (context) => {
					observed.push(providerWire(harness, context));
					return fauxAssistantMessage("new task done");
				}),
			);
			await harness.session.prompt("new task");
			await harness.session.prompt("another task");
			for (const wire of observed) {
				const outputs = wire.filter((message) => message.role === "tool" && message.tool_call_id === "a");
				expect(outputs).toHaveLength(1);
				expect(outputs[0]).toMatchObject({ content: "VERIFIED_OUTPUT_UNIQUE" });
				const callIndex = wire.findIndex(
					(message) => message.role === "assistant" && message.tool_calls?.some((call) => call.id === "a"),
				);
				expect(wire[callIndex + 1]).toMatchObject({
					role: "tool",
					tool_call_id: "a",
					content: "VERIFIED_OUTPUT_UNIQUE",
				});
				expect(JSON.stringify(wire)).not.toContain("No result provided");
			}
			expect(harness.sessionManager.getEntries().slice(0, prefix.length)).toEqual(prefix);
			const canonical = harness.sessionManager.buildSessionContext().messages;
			const callIndex = canonical.findIndex(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "toolCall" && block.id === "a"),
			);
			const resultIndex = canonical.findIndex(
				(message) => message.role === "toolResult" && message.toolCallId === "a",
			);
			expect(
				canonical
					.slice(callIndex + 1, resultIndex)
					.some((message) => message.role === "custom" || message.role === "assistant"),
			).toBe(true);
			expect(effect).toHaveBeenCalledOnce();
		},
	);

	it("T008: keeps confirmed A output visible while planned B remains undispatched and paused", async () => {
		const manager = SessionManager.inMemory();
		const { journal, calls } = seed(manager, ["a", "b"]);
		journal.update((state) => {
			state.status = "running";
		});
		journal.dispatch(calls[0], calls[0].arguments, false);
		journal.result(
			{ ...result("a"), content: [{ type: "text", text: "VERIFIED_PARTIAL_OUTPUT_UNIQUE" }] },
			calls[0],
			false,
			false,
		);
		journal.update((state) => {
			state.status = "interrupted";
		});
		const originalId = journal.state!.id;
		const prefix = structuredClone(manager.getEntries());
		const execute = vi.fn<EffectTool["execute"]>(async () => ({ content: [], details: {} }));
		const harness = await createHarness({
			sessionManager: manager,
			tools: [effectTool(execute)],
			hfCompaction: { mode: "off" },
		});
		harnesses.push(harness);
		const observed: ReturnType<typeof providerWire>[] = [];
		harness.setResponses([
			(context) => {
				observed.push(providerWire(harness, context));
				return fauxAssistantMessage("new done");
			},
		]);
		await harness.session.prompt("explain the previous output");
		expect(JSON.stringify(observed)).toContain("VERIFIED_PARTIAL_OUTPUT_UNIQUE");
		expect(JSON.stringify(observed)).not.toContain("No result provided");
		expect(observed[0].filter((message) => message.role === "tool" && message.tool_call_id === "b")).toEqual([]);
		expect(observed[0].filter((message) => message.role === "tool" && message.tool_call_id === "a")).toEqual([
			{ role: "tool", tool_call_id: "a", content: "VERIFIED_PARTIAL_OUTPUT_UNIQUE" },
		]);
		expect(
			observed[0].some(
				(message) => message.role === "assistant" && message.tool_calls?.some((call) => call.id === "b"),
			),
		).toBe(false);
		const oldTask = harness.session.suspendedTaskRecovery.find((task) => task.state.id === originalId)!.state;
		expect(oldTask.status).toBe("interrupted");
		expect(oldTask.tools.map((tool) => tool.call.id)).toEqual(["a"]);
		expect(
			oldTask.step?.message?.content.filter((block) => block.type === "toolCall").map((call) => call.id),
		).toEqual(["a", "b"]);
		expect(manager.getEntries().slice(0, prefix.length)).toEqual(prefix);
		expect(execute).not.toHaveBeenCalled();
	});

	it.each(["deliver", "cancel"] as const)(
		"T008: rebinds an ancestor queue receipt already consumed on its descendant: %s",
		async (action) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-driver-ancestor-"));
			dirs.push(dir);
			const harness = await createHarness({
				sessionManager: SessionManager.create(dir, join(dir, "sessions")),
				tools: [],
				hfCompaction: { mode: "off" },
			});
			harnesses.push(harness);
			let ancestor = "";
			let originalReceipt = "";
			harness.setResponses([
				async () => {
					await harness.session.followUp("descendant dependent");
					ancestor = harness.sessionManager.getLeafId()!;
					originalReceipt = harness.session.taskRecovery!.queued[0].entryIds[0];
					return fauxAssistantMessage("original done");
				},
				fauxAssistantMessage("dependent done"),
			]);
			await harness.session.prompt("original task");
			const descendant = harness.sessionManager.getLeafId()!;
			const oldRecord = structuredClone(harness.sessionManager.getEntry(ancestor));
			expect(harness.sessionManager.getEntry(originalReceipt)).toMatchObject({
				type: "message",
				message: { role: "user" },
			});
			await expect(harness.session.navigateTree(ancestor)).resolves.toMatchObject({ cancelled: false });
			expect(harness.session.getFollowUpMessages()).toEqual(["descendant dependent"]);
			const freshReceipt = harness.session.taskRecovery!.queued[0].entryIds[0];
			expect(freshReceipt).not.toBe(originalReceipt);
			expect(harness.sessionManager.getEntry(freshReceipt)).toBeUndefined();
			expect(
				new TaskRecoveryJournal(SessionManager.open(harness.session.sessionFile!)).state?.queued[0].entryIds,
			).toEqual([freshReceipt]);
			if (action === "cancel") {
				expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["descendant dependent"] });
				expect(harness.session.taskRecovery!.queued[0].cancelled).toBe(true);
				harness.setResponses([fauxAssistantMessage("fork done")]);
			} else harness.setResponses([fauxAssistantMessage("fork done"), fauxAssistantMessage("fork dependent done")]);
			await harness.session.prompt("fork task");
			expect(getUserTexts(harness)).toEqual(
				action === "deliver"
					? ["original task", "fork task", "descendant dependent"]
					: ["original task", "fork task"],
			);
			expect(harness.sessionManager.getEntry(ancestor)).toEqual(oldRecord);
			const fork = harness.sessionManager.getLeafId()!;
			await harness.session.navigateTree(descendant);
			expect(getUserTexts(harness)).toEqual(["original task", "descendant dependent"]);
			expect(harness.session.getFollowUpMessages()).toEqual([]);
			expect(harness.session.taskRecovery!.queued[0].entryIds).toEqual([originalReceipt]);
			expect(harness.session.taskRecovery!.queued[0].cancelled).toBeUndefined();
			await harness.session.navigateTree(fork);
			expect(harness.session.getFollowUpMessages()).toEqual([]);
			if (action === "deliver")
				expect(harness.sessionManager.getEntry(freshReceipt)).toMatchObject({
					type: "message",
					message: { role: "user" },
				});
			else expect(harness.session.taskRecovery!.queued).toEqual([]);
		},
	);

	it.each(
		(["reserve", "append", "ack"] as const).flatMap((failpoint) =>
			[false, true].map((reopen) => ({ failpoint, reopen })),
		),
	)(
		"T011: publishes one suspended result across $failpoint failure, cold reopen=$reopen",
		async ({ failpoint, reopen }) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-driver-publication-"));
			dirs.push(dir);
			const manager = SessionManager.create(dir, join(dir, "sessions"));
			const execute = vi.fn<EffectTool["execute"]>(async () => {
				throw new Error("lost acknowledgement after effect");
			});
			let harness = await createHarness({
				sessionManager: manager,
				tools: [effectTool(execute)],
				hfCompaction: { mode: "off" },
				settings: { retry: { enabled: false } },
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("effect", { value: "a" }, { id: "a" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("inspect the effect"),
			]);
			await harness.session.prompt("original task");
			harness.session.reconcileTool("a", {
				kind: "result",
				result: { ...result("a"), content: [{ type: "text", text: "CONFIRMED_UNIQUE" }] },
			});
			const sourceId = harness.session.suspendedTaskRecovery[0].state.step!.assistantEntryId!;
			const audit = structuredClone(manager.getEntries());
			const canonicalResults = () =>
				manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
			const appendCustom = manager.appendCustomEntry.bind(manager);
			let injected = false;
			vi.spyOn(manager, "appendCustomEntry").mockImplementation((kind, data) => {
				if (
					!injected &&
					kind === "pi-task-recovery" &&
					((failpoint === "reserve" && canonicalResults().length === 0) ||
						(failpoint === "ack" && canonicalResults().length === 1))
				) {
					injected = true;
					throw new Error(`publication ${failpoint} failure`);
				}
				return appendCustom(kind, data);
			});
			const appendMessage = manager.appendMessage.bind(manager);
			vi.spyOn(manager, "appendMessage").mockImplementation((message, id) => {
				if (!injected && failpoint === "append" && message.role === "toolResult") {
					injected = true;
					throw new Error("publication append failure");
				}
				return appendMessage(message, id);
			});
			await expect(harness.session.prompt("rejected new task")).rejects.toThrow(`publication ${failpoint} failure`);
			expect(injected).toBe(true);
			expect(canonicalResults()).toHaveLength(failpoint === "ack" ? 1 : 0);
			const receipt = harness.session.suspendedTaskRecovery[0].state.tools[0].resultEntryId;
			if (failpoint !== "reserve") expect.soft(receipt).toBeTruthy();
			if (failpoint === "append") expect(new TaskRecoveryJournal(manager).resultEntrySources.size).toBe(0);
			if (failpoint === "ack")
				expect.soft(new TaskRecoveryJournal(manager).resultEntrySources.get(receipt!)).toBe(sourceId);
			vi.restoreAllMocks();
			if (reopen) {
				await harness.session.shutdown();
				harness = await createHarness({
					sessionManager: SessionManager.open(manager.getSessionFile()!),
					tools: [effectTool(execute)],
					hfCompaction: { mode: "off" },
				});
				harnesses.push(harness);
			}
			const observed: ReturnType<typeof providerWire>[] = [];
			harness.setResponses(
				[1, 2].map(() => (context) => {
					observed.push(providerWire(harness, context));
					return fauxAssistantMessage("new done");
				}),
			);
			await harness.session.prompt("accepted new task");
			await harness.session.prompt("next task");
			const entries = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
			expect.soft(entries).toHaveLength(1);
			if (receipt) expect.soft(entries.map((entry) => entry.id)).toEqual([receipt]);
			for (const wire of observed) {
				expect
					.soft(wire.filter((message) => message.role === "tool").map((message) => message.content))
					.toEqual(["CONFIRMED_UNIQUE"]);
				expect.soft(JSON.stringify(wire)).not.toContain("No result provided");
			}
			expect(harness.sessionManager.getEntries().slice(0, audit.length)).toEqual(audit);
			expect(execute).toHaveBeenCalledOnce();
		},
	);

	it.each([false, true])(
		"T011: republishes an ancestor's reserved receipt on a fork when its ID was consumed off-path: reopen=%s",
		async (reopen) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-driver-result-fork-"));
			dirs.push(dir);
			const manager = SessionManager.create(dir, join(dir, "sessions"));
			const execute = vi.fn<EffectTool["execute"]>(async () => {
				throw new Error("lost acknowledgement after effect");
			});
			let harness = await createHarness({
				sessionManager: manager,
				tools: [effectTool(execute)],
				hfCompaction: { mode: "off" },
				settings: { retry: { enabled: false } },
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("effect", { value: "a" }, { id: "a" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("inspect the effect"),
			]);
			await harness.session.prompt("original task");
			const verified = { ...result("a"), content: [{ type: "text" as const, text: "FORK_VERIFIED" }] };
			harness.session.reconcileTool("a", { kind: "result", result: verified });
			const journal = new TaskRecoveryJournal(manager);
			const sourceId = journal.suspendedTasks[0].state.step!.assistantEntryId!;
			const originalReceipt = journal.recordResultEntry(sourceId, verified)!;
			const ancestor = manager.getLeafId()!;
			const ancestorRecord = structuredClone(manager.getEntry(ancestor));
			harness.setResponses([fauxAssistantMessage("first continuation done")]);
			await harness.session.prompt("first continuation");
			expect(manager.getEntry(originalReceipt)).toMatchObject({ type: "message", message: verified });
			const descendant = manager.getLeafId()!;
			const audit = structuredClone(manager.getEntries());
			if (reopen) {
				await harness.session.shutdown();
				const selected = SessionManager.open(manager.getSessionFile()!);
				selected.branch(ancestor);
				harness = await createHarness({
					sessionManager: selected,
					tools: [effectTool(execute)],
					hfCompaction: { mode: "off" },
				});
				harnesses.push(harness);
			} else await harness.session.navigateTree(ancestor);
			const selected = harness.sessionManager;
			expect(new TaskRecoveryJournal(selected).resultEntrySources.size).toBe(0);
			const observed: ReturnType<typeof providerWire>[] = [];
			harness.setResponses([
				(context) => {
					observed.push(providerWire(harness, context));
					return fauxAssistantMessage("fork continuation done");
				},
			]);
			await harness.session.prompt("fork continuation");
			const forkReceipt = harness.session.suspendedTaskRecovery[0].state.tools[0].resultEntryId!;
			expect(forkReceipt).not.toBe(originalReceipt);
			expect(
				selected
					.getBranch()
					.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
					.map((entry) => entry.id),
			).toEqual([forkReceipt]);
			expect(observed[0].filter((message) => message.role === "tool").map((message) => message.content)).toEqual([
				"FORK_VERIFIED",
			]);
			expect(JSON.stringify(observed)).not.toContain("No result provided");
			expect(
				new TaskRecoveryJournal(SessionManager.open(selected.getSessionFile()!)).resultEntrySources.get(
					forkReceipt,
				),
			).toBe(sourceId);
			expect(selected.getEntry(ancestor)).toEqual(ancestorRecord);
			expect(selected.getEntries().slice(0, audit.length)).toEqual(audit);
			await harness.session.navigateTree(descendant);
			expect(new TaskRecoveryJournal(selected).resultEntrySources.get(originalReceipt)).toBe(sourceId);
			expect(new TaskRecoveryJournal(selected).resultEntrySources.has(forkReceipt)).toBe(false);
			expect(
				selected
					.buildSessionContext()
					.messages.filter((message) => message.role === "toolResult")
					.map(getMessageText),
			).toEqual(["FORK_VERIFIED"]);
			expect(execute).toHaveBeenCalledOnce();
		},
	);

	it("T011: a reserved receipt is not published, but its canonical materialization proves the same occurrence", async () => {
		const manager = SessionManager.inMemory();
		const { journal, calls } = seed(manager, ["a", "b"]);
		journal.update((state) => {
			state.status = "running";
		});
		journal.dispatch(calls[0], calls[0].arguments, false);
		journal.result(result("a"), calls[0], false, false);
		journal.dispatch(calls[1], calls[1].arguments, false);
		const sourceId = journal.state!.step!.assistantEntryId!;
		journal.recordResultEntry(sourceId, result("a"), "reserved-a");
		journal.start([{ role: "user", content: "inspection", timestamp: 2 }]);
		const audit = structuredClone(manager.getEntries());
		const harness = await createHarness({ sessionManager: manager, tools: [], hfCompaction: { mode: "off" } });
		harnesses.push(harness);
		expect(journal.resultEntrySources.size).toBe(0);
		expect(journal.findResultEntry(sourceId, "a")).toBeUndefined();
		const reservedProjection = await harness.session.agent.transformContext!(harness.session.messages);
		const reservedWire = providerWire(harness, {
			systemPrompt: harness.session.systemPrompt,
			messages: convertToLlm(reservedProjection),
		});
		expect.soft(reservedWire.filter((message) => message.role === "tool")).toEqual([]);
		expect.soft(JSON.stringify(reservedWire)).not.toContain("No result provided");
		manager.appendMessage(result("a"), "reserved-a");
		expect(journal.resultEntrySources.get("reserved-a")).toBe(sourceId);
		expect(journal.findResultEntry(sourceId, "a")).toBe("reserved-a");
		const observed: ReturnType<typeof providerWire>[] = [];
		harness.setResponses([
			(context) => {
				observed.push(providerWire(harness, context));
				return fauxAssistantMessage("inspection done");
			},
		]);
		await harness.session.prompt("inspect B without replay");
		expect(observed[0].filter((message) => message.role === "tool").map((message) => message.content)).toEqual([
			"verified:a",
		]);
		expect(JSON.stringify(observed)).not.toContain("No result provided");
		expect(
			harness.session.suspendedTaskRecovery[0].state.tools.find((tool) => tool.call.id === "b")?.result,
		).toBeUndefined();
		expect(manager.getEntries().slice(0, audit.length)).toEqual(audit);
	});

	it("T011: historical verified facts keep their original wire position across a fixed checkpoint and tool turns", async () => {
		const manager = SessionManager.inMemory();
		const { journal, calls } = seed(manager, ["a"]);
		journal.update((state) => {
			state.status = "running";
		});
		journal.dispatch(calls[0], calls[0].arguments, false);
		journal.start([{ role: "user", content: "inspection", timestamp: 2 }]);
		const checkpointId = manager.appendCompactionCheckpoint(
			[{ role: "user", content: "Valid replacement summary: original A needs inspection", timestamp: 3 }],
			100,
		);
		journal.reconcile("a", {
			kind: "result",
			result: { ...result("a"), content: [{ type: "text", text: "CONFIRMED_UNIQUE" }] },
		});
		const audit = structuredClone(manager.getEntries());
		const inspect = vi.fn<AgentTool["execute"]>(async () => ({
			content: [{ type: "text", text: "inspected" }],
			details: {},
		}));
		const harness = await createHarness({
			sessionManager: manager,
			tools: [
				{
					name: "inspect",
					label: "Inspect",
					description: "Read-only inspection",
					parameters: Type.Object({}),
					contract: { readOnly: true },
					execute: inspect,
				},
			],
			hfCompaction: { mode: "off" },
		});
		harnesses.push(harness);
		const contexts: Context[] = [];
		harness.setResponses(
			[0, 1, 2].map((index) => (context) => {
				contexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
				return index < 2
					? fauxAssistantMessage(fauxToolCall("inspect", {}, { id: `inspection-${index}` }), {
							stopReason: "toolUse",
						})
					: fauxAssistantMessage("inspection done");
			}),
		);
		await harness.session.prompt("independent inspection");
		const wires = contexts.map((context) => providerWire(harness, context));
		for (let index = 1; index < wires.length; index++) {
			expect.soft(wires[index].slice(0, wires[index - 1].length)).toEqual(wires[index - 1]);
			expect(wires[index].length).toBeGreaterThan(wires[index - 1].length);
		}
		for (const wire of wires) {
			expect(JSON.stringify(wire)).toContain(
				"Historical verified result whose source response is outside the active projection",
			);
			expect(JSON.stringify(wire)).toContain("CONFIRMED_UNIQUE");
			expect(JSON.stringify(wire)).not.toContain("No result provided");
			expect(wire.filter((message) => message.role === "tool" && message.tool_call_id === "a")).toEqual([]);
		}
		expect(inspect).toHaveBeenCalledTimes(2);
		expect(
			manager
				.getEntries()
				.filter((entry) => entry.type === "compaction")
				.map((entry) => entry.id),
		).toEqual([checkpointId]);
		expect(manager.getEntries().slice(0, audit.length)).toEqual(audit);
	});

	it("uses complete checkpoint items rather than dispatched slots for pending-call accounting", () => {
		const manager = SessionManager.inMemory();
		const journal = new TaskRecoveryJournal(manager);
		journal.start([]);
		const a = fauxToolCall("effect", { value: "a" }, { id: "a" });
		const b = fauxToolCall("effect", { value: "b" }, { id: "b" });
		const partial = fauxAssistantMessage([a, b], { stopReason: "pending" });
		journal.beginStep(partial);
		journal.completeItem(1, b, partial);
		journal.completeItem(0, a, partial);
		journal.result(result("a"), a, false, false);
		expect(journal.plannedCalls(journal.state!).map((call) => call.id)).toEqual(["a", "b"]);
		expect(journal.hasUnaccountedCalls(journal.state!)).toBe(true);
		journal.result(result("b"), b, false, false);
		expect(journal.hasUnaccountedCalls(journal.state!)).toBe(false);
	});

	it("preserves current branch queues for cancelled and no-op navigation", async () => {
		const harness = await createHarness({
			tools: [],
			hfCompaction: { mode: "off" },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("baseline")]);
		await harness.session.prompt("baseline");
		const baseline = harness.sessionManager.getLeafId()!;
		await harness.session.followUp("keep queued");
		const leaf = harness.sessionManager.getLeafId()!;
		expect(await harness.session.navigateTree(leaf)).toEqual({ cancelled: false });
		expect(await harness.session.navigateTree(baseline)).toEqual({ cancelled: true });
		expect(harness.session.getFollowUpMessages()).toEqual(["keep queued"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(harness.session.taskRecovery?.queued[0].cancelled).toBeUndefined();
	});
});
