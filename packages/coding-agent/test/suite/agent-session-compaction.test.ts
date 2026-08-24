import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const SOFT_DECISION = { action: "soft_compact" as const, reasons: ["test"] };

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (
		reason: "overflow" | "threshold",
		willRetry: boolean,
		decision: typeof SOFT_DECISION,
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
 * Subsystem compactor stream (post-removal): serves extraction JSON when the
 * prompt demands a JSON object, narrative text otherwise. Returns captured
 * request contexts and a call counter.
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
		const requestText = JSON.stringify(context.messages);
		const text = requestText.includes("ONLY a JSON object")
			? JSON.stringify({ facts: [], decisions: [], nextActions: [] })
			: requestText.includes("single clear sentence")
				? "Distilled goal sentence."
				: narrativeText;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(text),
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
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
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
		expect(result.summary).toContain("[high-fidelity snapshot");
		expect(result.summary).toContain("subsystem narrative text");
		expect(result.summary).not.toContain("summary from extension");
		// No legacy entry is persisted; the fixed layer is injected dynamically.
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.session.hfCompactionHost!.buildPinnedLedgerLayer()).toContain("Global Contract");
	});

	it("allows a queued prompt to start when manual compaction ends", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([
			fauxAssistantMessage("Distilled goal sentence."),
			fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] })),
			fauxAssistantMessage("compaction narrative"),
			fauxAssistantMessage("queued response"),
		]);

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

	it("keeps the session usable when extraction contains an empty placeholder and text alias", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sourceEventId = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
		harness.setResponses([
			fauxAssistantMessage("Distilled goal sentence."),
			fauxAssistantMessage(
				JSON.stringify({
					facts: [
						{ text: "", kind: "fact", sourceEventIds: [sourceEventId] },
						{ description: "Recovered fact", kind: "fact", sourceEventIds: [sourceEventId] },
					],
					decisions: [],
					nextActions: [],
				}),
			),
			fauxAssistantMessage("compaction narrative"),
			fauxAssistantMessage("session still works"),
		]);

		await expect(harness.session.compact()).resolves.toEqual(
			expect.objectContaining({ summary: expect.stringContaining("[high-fidelity snapshot") }),
		);
		await expect(harness.session.prompt("continue after compaction")).resolves.toBeUndefined();
		expect(harness.session.getLastAssistantText()).toBe("session still works");
		const extractAudit = harness.session.hfCompactionHost!.audit.byType("extract").at(-1);
		expect(extractAudit?.details.droppedEmptyItems).toBe(1);
		expect(extractAudit?.details.normalizedTextAliases).toBe(1);
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
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const stream = installCompactorStream(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(result.summary).toContain("[high-fidelity snapshot");
		// The custom streamFn serves all subsystem compactor calls (distill + extraction + narrative).
		expect(stream.callCount()).toBe(3);
	});

	it("manually compacts with provider-resolved bearer auth", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
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
			() => fauxAssistantMessage("Distilled goal sentence."),
			(_context, options) => {
				expect(options?.apiKey).toBeUndefined();
				expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
				return fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] }));
			},
			(_context, options) => {
				expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
				return fauxAssistantMessage("summary with bearer auth");
			},
		]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary with bearer auth");
		expect(result.summary).toContain("[high-fidelity snapshot");
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("uses the subsystem compactor request context (isolated, untrusted-wrapped)", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
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
		expect(stream.callCount()).toBe(3);
		// contexts[0] is goal distillation; contexts[1] is structured extraction.
		const extractionContext = stream.contexts()[1];
		expect(extractionContext?.systemPrompt).not.toBe(harness.session.agent.state.systemPrompt);
		expect(extractionContext?.systemPrompt).toContain("untrusted data");
		expect(extractionContext?.tools).toBeUndefined();
		expect(JSON.stringify(extractionContext?.messages)).toContain("<untrusted-history>");
	});

	it("exposes subsystem token stats on manual compaction without writing legacy entries", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		installCompactorStream(harness);

		const result = await harness.session.compact();

		// No legacy compaction entry and no usage entry are written anymore.
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(result.tokensBefore).toBeGreaterThan(0);
		expect(result.summary).toContain("[high-fidelity snapshot");
		const host = harness.session.hfCompactionHost!;
		expect(host.audit.byType("compact_committed")).toHaveLength(1);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const stream = installCompactorStream(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false, SOFT_DECISION);

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThanOrEqual(0);
		expect(compactionEnd?.result?.summary).toContain("[high-fidelity snapshot");
		expect(stream.callCount()).toBe(3);
	});

	it("notifies extensions when auto-compaction fails", async () => {
		const failedEvents: Array<{
			reason: "manual" | "threshold" | "overflow";
			errorMessage?: string;
			aborted: boolean;
			willRetry: boolean;
			fromExtension: boolean;
		}> = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
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

		await expect(sessionInternals._runAutoCompaction("threshold", false, SOFT_DECISION)).resolves.toBe(false);

		// The subsystem fails closed; the failure is observable with the root cause included.
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
		});
		expect(compactionEnd?.errorMessage).toContain("summary generator blew up");
		expect(failedEvents).toEqual([
			expect.objectContaining({
				type: "session_compact_failed",
				reason: "threshold",
				aborted: false,
				willRetry: false,
				fromExtension: false,
			}),
		]);
		expect(failedEvents[0].errorMessage).toContain("summary generator blew up");
	});

	it("compacts and resumes after a length stop below the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("Distilled goal sentence."),
			fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] })),
			fauxAssistantMessage("overflow narrative"),
			fauxAssistantMessage("completed response"),
			// The completed response's faux usage re-triggers a (case-2, no-retry)
			// overflow compaction; distillation happens once per session, so the
			// second compaction consumes only extraction + narrative.
			fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] })),
			fauxAssistantMessage("second narrative"),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(5);
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
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
		});
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("x".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			() => fauxAssistantMessage("Distilled goal sentence."),
			() => fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] })),
			() => fauxAssistantMessage("overflow narrative"),
			() => fauxAssistantMessage("y".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(5);
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

	it("keeps provider-side aborted extraction as failure without a local abort signal", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: {
				mode: "full_pipeline",
				minTokenGainFraction: -1,
				complete: async (request) => {
					const prompt = JSON.stringify(request.messages);
					return prompt.includes("single clear sentence")
						? { text: "Distilled goal sentence.", stopReason: "stop" }
						: { text: "", stopReason: "aborted" };
				},
			},
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false, SOFT_DECISION)).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: expect.stringContaining("stopReason=aborted"),
		});
	});

	it("classifies signal-aborted auto extraction as cancellation", async () => {
		let extractionStarted = false;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: {
				mode: "full_pipeline",
				minTokenGainFraction: -1,
				complete: async (request) => {
					const prompt = JSON.stringify(request.messages);
					if (prompt.includes("single clear sentence")) {
						return { text: "Distilled goal sentence.", stopReason: "stop" };
					}
					if (!prompt.includes("ONLY a JSON object")) {
						throw new Error("unexpected compactor stage");
					}
					extractionStarted = true;
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

		const compactPromise = sessionInternals._runAutoCompaction("threshold", false, SOFT_DECISION);
		await vi.waitFor(() => expect(extractionStarted).toBe(true));
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

	it("cancels auto compaction while goal distillation is in progress", async () => {
		let distillationStarted = false;
		let releaseDistillation: (() => void) | undefined;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: {
				mode: "full_pipeline",
				minTokenGainFraction: -1,
				complete: async (request) => {
					const prompt = JSON.stringify(request.messages);
					if (!prompt.includes("single clear sentence")) {
						return { text: "", stopReason: "aborted" };
					}
					distillationStarted = true;
					return await new Promise((resolve) => {
						const finish = () => resolve({ text: "", stopReason: "aborted" as const });
						releaseDistillation = finish;
						if (request.signal?.aborted) finish();
						else request.signal?.addEventListener("abort", finish, { once: true });
					});
				},
			},
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		let settled = false;
		const compactPromise = sessionInternals._runAutoCompaction("threshold", false, SOFT_DECISION).then((result) => {
			settled = true;
			return result;
		});
		await vi.waitFor(() => expect(distillationStarted).toBe(true));
		harness.session.abortCompaction();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const settledFromAbort = settled;
		releaseDistillation?.();

		await expect(compactPromise).resolves.toBe(false);
		expect(settledFromAbort).toBe(true);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: true,
			willRetry: false,
		});
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
				messages: projectedMessages,
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
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] })),
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

		await expect(sessionInternals._runAutoCompaction("threshold", false, SOFT_DECISION)).resolves.toBe(true);
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

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			hfCompaction: { mode: "full_pipeline", minTokenGainFraction: -1 },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("completed answer"),
			fauxAssistantMessage(JSON.stringify({ facts: [], decisions: [], nextActions: [] })),
			fauxAssistantMessage("overflow narrative"),
		]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		// One agent turn + two subsystem compactor calls.
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
			decision: SOFT_DECISION,
			predictedNextRequestTokens: 190_000,
			tokenEstimateProvenance: "provider_projection",
			recoverableToolTokens: 0,
			compactionCooldownRemaining: 0,
			incrementalCompactionsSinceRebuild: 0,
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false, SOFT_DECISION, "", 0);
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
