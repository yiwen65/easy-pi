import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLatestCompactionEntry } from "../../src/core/session-manager.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const COMPACT_DECISION = {
	action: "compact" as const,
	reasons: ["test"],
	triggerTokens: 190_000,
	overflowRecovery: false,
};

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (
		reason: "overflow" | "threshold",
		willRetry: boolean,
		decision: typeof COMPACT_DECISION,
	) => Promise<boolean>;
	_overflowRecoveryAttempted: boolean;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

/**
 * Subsystem compactor stream: serves the single local compaction-item request and returns
 * captured request contexts with a call counter.
 */
function installCompactorStream(
	harness: Harness,
	narrativeText = "subsystem narrative",
	onRequest?: (context: Context, options: SimpleStreamOptions | undefined) => void,
): { callCount: () => number; contexts: () => Context[] } {
	const contexts: Context[] = [];
	let count = 0;
	harness.session.agent.streamFunction = (model, context, options) => {
		count++;
		contexts.push(context);
		onRequest?.(context, options);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(narrativeText),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return { callCount: () => count, contexts: () => contexts };
}

function createLargeResultTool(terminate = false): AgentTool {
	return {
		name: "large_result",
		label: "Large result",
		description: "Returns enough content to cross the compaction threshold",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: `large-tool-result:${"x".repeat(10_000)}` }],
			details: {},
			terminate,
		}),
	};
}

function seedPostToolThresholdSession(harness: Harness): void {
	const model = harness.getModel();
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: `old-history:${"a".repeat(1_000)}`,
		timestamp: now - 2_000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage(`recent-history:${"b".repeat(1_000)}`, { timestamp: now - 1_000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(600),
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts while ignoring an extension-provided summary (deprecated)", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline" },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		installCompactorStream(harness, "subsystem narrative text");

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		// Extension free-text summary never enters the context or the result.
		expect(result.summary).toContain("[compaction checkpoint created]");
		expect(result.summary).toContain("subsystem narrative text");
		expect(result.summary).not.toContain("summary from extension");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.session.systemPrompt).not.toContain("Verified user directives");
	});

	it("allows a queued prompt to start when manual compaction ends", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("compaction narrative"), fauxAssistantMessage("queued response")]);

		let queuedPrompt: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "manual" && event.result) {
				expect(harness.session.isCompacting).toBe(false);
				queuedPrompt = harness.session.prompt("queued after compaction");
			}
		});

		await harness.session.compact();
		if (!queuedPrompt) throw new Error("compaction_end did not start the queued prompt");
		await queuedPrompt;

		expect(getUserTexts(harness)).toContain("queued after compaction");
		expect(harness.session.getLastAssistantText()).toBe("queued response");
	});

	it("keeps the session usable after a single compaction-item response", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("compaction narrative"), fauxAssistantMessage("session still works")]);

		await expect(harness.session.compact()).resolves.toEqual(
			expect.objectContaining({ summary: expect.stringContaining("[compaction checkpoint created]") }),
		);
		await expect(harness.session.prompt("continue after compaction")).resolves.toBeUndefined();
		expect(harness.session.getLastAssistantText()).toBe("session still works");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const stream = installCompactorStream(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(result.summary).toContain("[compaction checkpoint created]");
		// The custom streamFn serves one local compaction-item request.
		expect(stream.callCount()).toBe(1);
	});

	it("manually compacts with provider-resolved bearer auth", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Faux bearer provider",
			auth: {
				apiKey: {
					name: "Faux bearer token",
					resolve: async () => ({
						auth: { headers: { Authorization: "Bearer ambient-token" } },
						source: "ambient bearer token",
					}),
				},
			},
			getModels: () => harness.models,
			stream: () => createAssistantMessageEventStream(),
			streamSimple: () => createAssistantMessageEventStream(),
		});
		seedCompactableSession(harness);
		harness.setResponses([
			(_context, options) => {
				expect(options?.apiKey).toBeUndefined();
				expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
				return fauxAssistantMessage("summary with bearer auth");
			},
		]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary with bearer auth");
		expect(result.summary).toContain("[compaction checkpoint created]");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("uses the canonical provider prefix plus a local compaction trigger", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const transformContext = vi.fn(async (messages: AgentMessage[]) => messages);
		harness.session.agent.transformContext = transformContext;
		harness.session.agent.sessionId = "active-routing-session";
		harness.session.agent.transport = "websocket";

		const stream = installCompactorStream(harness);

		await harness.session.compact();

		expect(transformContext).not.toHaveBeenCalled();
		expect(stream.callCount()).toBe(1);
		const compactionContext = stream.contexts()[0];
		expect(compactionContext?.systemPrompt).toBe(harness.session.agent.state.systemPrompt);
		expect(compactionContext?.tools?.map((tool) => tool.name)).toEqual(
			harness.session.agent.state.tools.map((tool) => tool.name),
		);
		expect(JSON.stringify(compactionContext?.messages)).toContain("local_compaction_trigger");
		expect(JSON.stringify(compactionContext?.messages)).not.toContain("<untrusted-history>");
	});

	it("persists the replacement checkpoint on manual compaction", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		installCompactorStream(harness);

		const result = await harness.session.compact();

		const entries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ replacementHistory: expect.any(Array) });
		expect(result.tokensBefore).toBeGreaterThan(0);
		expect(result.summary).toContain("[compaction checkpoint created]");
		const host = harness.session.hfCompactionHost!;
		expect(host.audit.byType("checkpoint_validated")).toHaveLength(1);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const stream = installCompactorStream(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false, COMPACT_DECISION);

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThanOrEqual(0);
		expect(compactionEnd?.result?.summary).toContain("[compaction checkpoint created]");
		expect(stream.callCount()).toBe(1);
	});

	it("fails closed when the compaction-item stream throws", async () => {
		const failedEvents: Array<{
			reason: "manual" | "threshold" | "overflow";
			errorMessage?: string;
			aborted: boolean;
			willRetry: boolean;
			fromExtension: boolean;
		}> = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline" },
			extensionFactories: [
				(pi) => {
					pi.on("session_compact_failed", async (event) => {
						failedEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.agent.streamFunction = () => {
			throw new Error("summary generator blew up");
		};
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false, COMPACT_DECISION)).resolves.toBe(false);

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
		});
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(failedEvents).toHaveLength(1);
	});

	it("compacts and resumes after a length stop below the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("overflow narrative"),
			fauxAssistantMessage("completed response"),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(3);
		// The activated recovery compaction retries exactly once. Cooldown prevents
		// an immediate second compaction after the successful continuation.
		const ends = harness.eventsOfType("compaction_end");
		expect(ends.some((e) => e.reason === "overflow" && e.willRetry === true && !e.aborted)).toBe(true);
		expect(harness.session.getLastAssistantText()).toBe("completed response");
	});

	it("does not compact when a length stop reaches the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(400), { stopReason: "length" })]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("stops after one compact-and-retry when a second response is also truncated", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("x".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			() => fauxAssistantMessage("overflow narrative"),
			() => fauxAssistantMessage("y".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBe(
			"Truncated response recovery failed after one compact-and-retry attempt.",
		);
	});

	it("keeps overflow wording after a successful recovery when a repeated length stop fills the context window", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const lengthOverflowMessage = createAssistant(harness, {
			stopReason: "length",
			totalTokens: 100,
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockImplementationOnce(async () => {
			sessionInternals._overflowRecoveryAttempted = true;
			return true;
		});
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(lengthOverflowMessage);
		await sessionInternals._checkCompaction({ ...lengthOverflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("activates a deterministic fallback for provider-side abort without a local abort signal", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: {
				mode: "full_pipeline",
				complete: async () => ({ text: "", stopReason: "aborted" }),
			},
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false, COMPACT_DECISION)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
		});
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("classifies signal-aborted auto compaction-item generation as cancellation", async () => {
		let handoffStarted = false;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: {
				mode: "full_pipeline",
				complete: async (request) => {
					handoffStarted = true;
					return await new Promise((resolve) => {
						const finish = () => resolve({ text: "", stopReason: "aborted" as const });
						if (request.signal?.aborted) finish();
						else request.signal?.addEventListener("abort", finish, { once: true });
					});
				},
			},
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const compactPromise = sessionInternals._runAutoCompaction("threshold", false, COMPACT_DECISION);
		await vi.waitFor(() => expect(handoffStarted).toBe(true));
		harness.session.abortCompaction();

		await expect(compactPromise).resolves.toBe(false);
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "threshold",
			aborted: true,
			willRetry: false,
		});
		expect(compactionEnd).not.toHaveProperty("errorMessage");
	});

	it("does not report cancellation when manual activation won the abort race", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const projectedMessages = [...harness.session.agent.state.messages];
		vi.spyOn(harness.session.hfCompactionHost!, "attemptCompaction").mockImplementation(async () => {
			harness.session.abortCompaction();
			return {
				activated: true,
				checkpoint: {
					compactionItem: "activated before abort",
					replacementHistory: projectedMessages,
					tokensBefore: 100,
					tokensAfter: 50,
				},
				summaryText: "activated before abort",
				tokensBefore: 100,
				tokensAfter: 50,
			};
		});

		await expect(harness.session.compact()).resolves.toMatchObject({ summary: "activated before abort" });
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "manual",
			aborted: false,
			result: { summary: "activated before abort" },
		});
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("narrative"),
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false, COMPACT_DECISION)).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once after a successful activation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockImplementationOnce(async () => {
			sessionInternals._overflowRecoveryAttempted = true;
			return true;
		});
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("compacts after a tool result before the next assistant request in the same run", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 1 } },
			tools: [createLargeResultTool()],
			initialActiveToolNames: ["large_result"],
			hfCompaction: {
				mode: "full_pipeline",
				complete: async () => {
					order.push("compaction");
					return { text: "Preserve the post-tool task state.", stopReason: "stop" };
				},
			},
		});
		harnesses.push(harness);
		seedPostToolThresholdSession(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				order.push("provider");
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after compaction");
			},
		]);

		await harness.session.prompt("run the large tool");

		expect(order).toEqual(["compaction", "provider"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(resumedRequest).toContain("Preserve the post-tool task state.");
		expect(harness.session.getLastAssistantText()).toBe("finished after compaction");
	});

	it("preserves an existing next-turn context update after post-tool compaction", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 1 } },
			tools: [createLargeResultTool()],
			initialActiveToolNames: ["large_result"],
			prepareNextTurnWithContext: ({ context }) => ({
				context: {
					...context,
					messages: [
						...context.messages,
						{
							role: "user",
							content: [{ type: "text", text: "existing prepare callback marker" }],
							timestamp: Date.now(),
						},
					],
				},
			}),
			hfCompaction: {
				mode: "full_pipeline",
				complete: async () => ({ text: "Preserve the post-tool task state.", stopReason: "stop" }),
			},
		});
		harnesses.push(harness);
		seedPostToolThresholdSession(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after context update");
			},
		]);

		await harness.session.prompt("run the large tool");

		expect(resumedRequest).toContain("Preserve the post-tool task state.");
		expect(resumedRequest).toContain("existing prepare callback marker");
	});

	it("applies an extension context transform to a checkpoint activated at the provider boundary", async () => {
		const providerOnlyMarker = "provider-only context after compaction";
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => ({
						messages: [
							...event.messages,
							{
								role: "user",
								content: [{ type: "text", text: providerOnlyMarker }],
								timestamp: Date.now(),
							},
						],
					}));
				},
			],
			hfCompaction: {
				mode: "full_pipeline",
				complete: async () => ({ text: "Preserve the active task state.", stopReason: "stop" }),
			},
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: `old-history:${"a".repeat(10_000)}`,
			timestamp: Date.now() - 2_000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("old answer", { timestamp: Date.now() - 1_000 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(2_500),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		let providerRequest = "";
		harness.setResponses([
			(context) => {
				providerRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after transformed context");
			},
		]);

		await harness.session.prompt("continue the active task");

		expect(providerRequest).toContain("Preserve the active task state.");
		expect(providerRequest).toContain(providerOnlyMarker);
		const checkpoint = getLatestCompactionEntry(harness.sessionManager.getBranch());
		expect(JSON.stringify(checkpoint)).not.toContain(providerOnlyMarker);
	});

	it("includes steering queued during post-tool compaction in the resumed assistant request", async () => {
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 1 } },
			tools: [createLargeResultTool()],
			initialActiveToolNames: ["large_result"],
			hfCompaction: {
				mode: "full_pipeline",
				complete: async () => {
					markCompactionStarted();
					await compactionReleased;
					return { text: "Preserve the post-tool task state.", stopReason: "stop" };
				},
			},
		});
		harnesses.push(harness);
		seedPostToolThresholdSession(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after steering");
			},
			fauxAssistantMessage("unexpected delayed steering turn"),
		]);

		const promptPromise = harness.session.prompt("run the large tool");
		await compactionStarted;
		await harness.session.steer("change direction");
		releaseCompaction();
		await promptPromise;

		expect(resumedRequest).toContain("change direction");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("sends the complete live provider context after post-tool compaction", async () => {
		const runSystemMarker = "CURRENT RUN SYSTEM CONTRACT";
		const providerOnlyMarker = "CURRENT PROVIDER-ONLY CONTEXT";
		const steeringText = "steering queued during compaction";
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3_000, maxTokens: 100, reasoning: true }],
			settings: { compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 1 } },
			tools: [createLargeResultTool()],
			initialActiveToolNames: ["large_result"],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						systemPrompt: `${event.systemPrompt}\n\n${runSystemMarker}`,
					}));
					pi.on("context", async (event) => ({
						messages: [
							...event.messages,
							{
								role: "user",
								content: [{ type: "text", text: providerOnlyMarker }],
								timestamp: Date.now(),
							},
						],
					}));
				},
			],
			hfCompaction: {
				mode: "full_pipeline",
				complete: async () => {
					markCompactionStarted();
					await compactionReleased;
					return { text: "Integrated checkpoint handoff.", stopReason: "stop" };
				},
			},
		});
		harnesses.push(harness);
		seedPostToolThresholdSession(harness);
		harness.session.setThinkingLevel("high");
		const expectedModel = harness.getModel();
		const expectedSystemPrompt = `${harness.session.systemPrompt}\n\n${runSystemMarker}`;
		const expectedTools = harness.session.agent.state.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
		let resumedContext: Context | undefined;
		let resumedOptions: SimpleStreamOptions | undefined;
		let resumedModel: Model<string> | undefined;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context, options, _state, model) => {
				resumedContext = context;
				resumedOptions = options;
				resumedModel = model;
				return fauxAssistantMessage("finished integrated continuation");
			},
		]);

		const promptPromise = harness.session.prompt("run the large tool");
		await compactionStarted;
		await harness.session.steer(steeringText);
		releaseCompaction();
		await promptPromise;

		expect(resumedModel).toMatchObject({
			api: expectedModel.api,
			provider: expectedModel.provider,
			id: expectedModel.id,
		});
		expect(resumedOptions?.reasoning).toBe("high");
		expect(resumedContext?.systemPrompt).toBe(expectedSystemPrompt);
		expect(
			resumedContext?.tools?.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		).toEqual(expectedTools);

		const providerMessages = JSON.stringify(resumedContext?.messages);
		expect(providerMessages).toContain("Integrated checkpoint handoff.");
		expect(providerMessages).toContain(steeringText);
		expect(providerMessages).toContain(providerOnlyMarker);
		expect(providerMessages).not.toContain("old-history:");
		expect(providerMessages).not.toContain("large-tool-result:");
		expect(providerMessages).not.toContain("run the large tool");
		expect(providerMessages.indexOf("Integrated checkpoint handoff.")).toBeLessThan(
			providerMessages.indexOf(steeringText),
		);
		expect(providerMessages.indexOf(steeringText)).toBeLessThan(providerMessages.indexOf(providerOnlyMarker));
		expect(resumedContext?.messages.some((message) => message.role === "assistant")).toBe(false);
		expect(resumedContext?.messages.some((message) => message.role === "toolResult")).toBe(false);

		const checkpoint = getLatestCompactionEntry(harness.sessionManager.getBranch());
		expect(checkpoint?.replacementHistory?.map((message) => message.role)).toEqual(["compactionSummary"]);
		expect(JSON.stringify(checkpoint)).not.toContain(providerOnlyMarker);
		expect(harness.sessionManager.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
		]);
	});

	it("does not compact after a terminating tool result", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 300, keepRecentTokens: 1 } },
			tools: [createLargeResultTool(true)],
			initialActiveToolNames: ["large_result"],
			hfCompaction: {
				mode: "full_pipeline",
				complete: async () => ({ text: "unexpected compaction", stopReason: "stop" }),
			},
		});
		harnesses.push(harness);
		seedPostToolThresholdSession(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" })]);

		await harness.session.prompt("run the terminating large tool");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toEqual([]);
	});

	it("defers successful post-response compaction until the next provider request", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			hfCompaction: { mode: "full_pipeline" },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("completed answer"),
			fauxAssistantMessage("overflow narrative"),
			fauxAssistantMessage("continued answer"),
		]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
		await expect(harness.session.prompt("continue")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		// Two agent turns + one local compaction-item call.
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		vi.spyOn(harness.session.hfCompactionHost!, "evaluateCompactionTrigger").mockReturnValue({
			decision: COMPACT_DECISION,
			predictedNextRequestTokens: 190_000,
			tokenEstimateProvenance: "provider_projection",
			sameProviderContextAsLastCompaction: false,
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false, COMPACT_DECISION, "", 0);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
