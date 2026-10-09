import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionLLMRequest } from "../../src/core/compaction/subsystem/types.ts";
import { createCompactionSummaryMessage } from "../../src/core/messages.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const SOCKET_ERROR = "terminated (UND_ERR_SOCKET: other side closed)";
const HANDOFF =
	"## Conversation timeline\nThe valid conversation established the task.\n## Current continuation point\nContinue the current task.";

function usage(input: number): AssistantMessage["usage"] {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seedValidConversation(harness: Harness): void {
	const model = harness.getModel();
	harness.sessionManager.appendMessage({ role: "user", content: `valid-user:${"a".repeat(4_000)}`, timestamp: 1 });
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("valid-successful-answer", { timestamp: 2 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(2_000),
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	harness.session.hfCompactionHost?.syncFromEntries(harness.sessionManager.getBranch());
}

function failedAssistant(harness: Harness, stopReason: "error" | "aborted", text: string): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage(text, {
			stopReason,
			errorMessage: stopReason === "error" ? SOCKET_ERROR : "Operation aborted",
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(0),
	};
}

function evaluate(harness: Harness) {
	const host = harness.session.hfCompactionHost;
	if (!host) throw new Error("The full_pipeline host must be enabled");
	return host.evaluateCompactionTrigger({
		branchEntries: harness.sessionManager.getBranch(),
		modelContextLimit: harness.getModel().contextWindow,
		outputReserveTokens: harness.settingsManager.getCompactionSettings().reserveTokens,
	});
}

describe("AgentSession retry history with full_pipeline compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([0, 100_000])(
		"retries mixed failures without charging %i failed partial characters to compaction",
		async (partialSize) => {
			// The current host has only one compaction-item call, no goalComplete API.
			// Keep that call independent from the agent's faux response queue.
			const complete = vi.fn(async () => ({ text: HANDOFF, stopReason: "stop" as const }));
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 20_000 }],
				tools: [],
				settings: { compaction: { reserveTokens: 100 }, retry: { maxRetries: 2, baseDelayMs: 0 } },
				hfCompaction: { mode: "full_pipeline", complete },
			});
			harnesses.push(harness);
			seedValidConversation(harness);
			const before = structuredClone(harness.sessionManager.getEntries());
			expect(evaluate(harness).predictedNextRequestTokens).toBeLessThan(harness.getModel().contextWindow);
			expect(evaluate(harness).decision.action).toBe("none");
			const failedPartial = `failed-partial:${"x".repeat(partialSize)}`;
			const failures = [
				fauxAssistantMessage(failedPartial, { stopReason: "error", errorMessage: SOCKET_ERROR }),
				fauxAssistantMessage(failedPartial, { stopReason: "error", errorMessage: "503 service unavailable" }),
			];
			const sawFailedProviderContent: boolean[] = [];
			harness.setResponses(
				[...failures, fauxAssistantMessage("recovered normally")].map<FauxResponseStep>((response) => (context) => {
					sawFailedProviderContent.push(
						context.messages.some(
							(message) =>
								message.role === "assistant" &&
								(message.stopReason === "error" || message.stopReason === "aborted"),
						),
					);
					return response;
				}),
			);

			await harness.session.prompt("continue");

			// On the unfixed implementation this contains a local-compaction budget rejection,
			// then agent-core returns "Provider request blocked: required compaction did not activate".
			expect(harness.eventsOfType("compaction_end").map((event) => event.errorMessage)).toEqual([]);
			expect(complete).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(3);
			expect(sawFailedProviderContent).toEqual([false, false, false]);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2]);
			expect(harness.eventsOfType("auto_retry_end")).toEqual([
				{ type: "auto_retry_end", success: true, attempt: 2 },
			]);
			expect(harness.session.getLastAssistantText()).toBe("recovered normally");
			expect(harness.session.isIdle).toBe(true);
			expect(harness.session.agent.state.isStreaming).toBe(false);
			expect(harness.sessionManager.getEntries().slice(0, before.length)).toEqual(before);
			const durableFailures = harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"
						? [entry.message]
						: [],
				);
			expect(durableFailures.map((message) => [getMessageText(message), message.errorMessage])).toEqual(
				failures.map((message) => [failedPartial, message.errorMessage]),
			);
			expect(
				harness.session.messages.some((message) => message.role === "assistant" && message.stopReason === "error"),
			).toBe(false);
		},
	);

	it("still exhausts the shared retry budget with large failed partials and retains both failures", async () => {
		const complete = vi.fn(async () => ({ text: HANDOFF, stopReason: "stop" as const }));
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 20_000 }],
			tools: [],
			settings: { compaction: { reserveTokens: 100 }, retry: { maxRetries: 1, baseDelayMs: 0 } },
			hfCompaction: { mode: "full_pipeline", complete },
		});
		harnesses.push(harness);
		seedValidConversation(harness);
		const failedPartial = `failed-partial:${"x".repeat(100_000)}`;
		harness.setResponses([
			fauxAssistantMessage(failedPartial, { stopReason: "error", errorMessage: SOCKET_ERROR }),
			fauxAssistantMessage(failedPartial, { stopReason: "error", errorMessage: "503 service unavailable" }),
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("compaction_end").map((event) => event.errorMessage)).toEqual([]);
		expect(complete).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "503 service unavailable" },
		]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error",
				),
		).toHaveLength(2);
		expect(harness.session.isIdle).toBe(true);
	});

	it("excludes error and aborted output before manual compaction preparation without hiding valid content", async () => {
		let captured: CompactionLLMRequest | undefined;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 20_000 }],
			tools: [],
			settings: { compaction: { reserveTokens: 100 } },
			hfCompaction: {
				mode: "full_pipeline",
				complete: async (request) => {
					captured = request;
					return { text: HANDOFF, stopReason: "stop" };
				},
			},
		});
		harnesses.push(harness);
		seedValidConversation(harness);
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage(fauxToolCall("read", { path: "src/valid.ts" }, { id: "valid-call" }), {
				stopReason: "toolUse",
			}),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(2_100),
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolName: "read",
			toolCallId: "valid-call",
			isError: true,
			content: [{ type: "text", text: "valid-tool-error: file not found" }],
			timestamp: 3,
		});
		harness.sessionManager.appendCustomMessageEntry("provider-context", "valid-custom-content", false);
		harness.sessionManager.appendMessage({ role: "user", content: "unanswered-user-goal", timestamp: 4 });
		const error = failedAssistant(harness, "error", `error-partial:${"x".repeat(100_000)}`);
		const aborted = failedAssistant(harness, "aborted", `aborted-partial:${"x".repeat(100_000)}`);
		harness.sessionManager.appendMessage(error);
		harness.sessionManager.appendMessage(aborted);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const before = structuredClone(harness.sessionManager.getEntries());

		await expect(harness.session.compact()).resolves.toMatchObject({ summary: expect.stringContaining(HANDOFF) });

		const messages = captured?.messages ?? [];
		expect(
			messages.some(
				(message) =>
					message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"),
			),
		).toBe(false);
		const content = JSON.stringify(messages);
		for (const marker of [
			"valid-user:",
			"valid-successful-answer",
			"valid-call",
			"valid-tool-error",
			"valid-custom-content",
		]) {
			expect(content).toContain(marker);
		}
		expect(content).not.toContain("error-partial:");
		expect(content).not.toContain("aborted-partial:");
		expect(messages.find((message) => message.role === "toolResult")).toMatchObject({ isError: true });
		const entries = harness.sessionManager.getEntries();
		expect(entries.slice(0, before.length)).toEqual(before);
		expect(entries.at(-1)).toMatchObject({
			type: "compaction",
			parentId: before.at(-1)?.id,
			replacementHistory: [
				expect.objectContaining({ role: "compactionSummary" }),
				expect.objectContaining({ role: "user", content: "unanswered-user-goal" }),
			],
		});
		expect(
			harness.sessionManager
				.buildTranscriptEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						(entry.message.stopReason === "error" || entry.message.stopReason === "aborted"),
				),
		).toHaveLength(2);
	});

	it("does not count failed checkpoint tails as new provider context or diagnostic tokens", async () => {
		const harness = await createHarness({ tools: [], hfCompaction: { mode: "full_pipeline" } });
		harnesses.push(harness);
		const checkpointMessages: AgentMessage[] = [
			createCompactionSummaryMessage(HANDOFF, 2_000, new Date().toISOString()),
		];
		harness.sessionManager.appendCompactionCheckpoint(checkpointMessages, 2_000);
		const host = harness.session.hfCompactionHost;
		if (!host) throw new Error("The full_pipeline host must be enabled");
		const before = evaluate(harness);
		const beforeInspection = host.inspectActiveContext();
		harness.sessionManager.appendMessage(failedAssistant(harness, "error", "x".repeat(100_000)));
		harness.sessionManager.appendMessage(failedAssistant(harness, "aborted", "x".repeat(100_000)));
		const durableEntries = structuredClone(harness.sessionManager.getEntries());

		expect(evaluate(harness)).toEqual(before);
		expect(host.buildActiveMessages()).toEqual(checkpointMessages);
		expect(host.inspectActiveContext()).toEqual(beforeInspection);
		expect(harness.sessionManager.getEntries()).toEqual(durableEntries);
	});

	it("filters restored checkpoint failures without rewriting the stored checkpoint or branch", async () => {
		const harness = await createHarness({ tools: [], hfCompaction: { mode: "full_pipeline" } });
		harnesses.push(harness);
		const handoff = createCompactionSummaryMessage(HANDOFF, 2_000, new Date().toISOString());
		const validUser: AgentMessage = { role: "user", content: "retained checkpoint user", timestamp: 1 };
		const checkpointMessages: AgentMessage[] = [
			handoff,
			failedAssistant(harness, "error", "x".repeat(100_000)),
			failedAssistant(harness, "aborted", "x".repeat(100_000)),
			validUser,
		];
		const checkpointId = harness.sessionManager.appendCompactionCheckpoint(checkpointMessages, 2_000);
		const durableEntries = structuredClone(harness.sessionManager.getEntries());
		const host = harness.session.hfCompactionHost;
		if (!host) throw new Error("The full_pipeline host must be enabled");
		evaluate(harness);

		expect(host.buildActiveMessages()).toEqual([handoff, validUser]);
		expect(host.inspectActiveContext()).toMatchObject({
			checkpointEntryId: checkpointId,
			replacementMessageCount: 2,
			tailMessageCount: 0,
			checkpointMessages: [handoff, validUser],
		});
		expect(harness.sessionManager.getEntries()).toEqual(durableEntries);
		expect(harness.sessionManager.getLeafId()).toBe(checkpointId);
	});
});
