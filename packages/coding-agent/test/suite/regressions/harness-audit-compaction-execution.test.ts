import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCompaction } from "../../../src/core/compaction/compaction.ts";
import { createHarness, type Harness } from "../harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.shutdown();
		harness.cleanup();
	}
});

const decision = { action: "compact" as const, reasons: ["test"], triggerTokens: 100, overflowRecovery: false };
type CompactionInternals = {
	_runAutoCompaction: (reason: "threshold", retry: boolean, trigger: typeof decision) => Promise<boolean>;
};

function seed(harness: Harness, checkpoint: boolean): void {
	const messages = [
		{ role: "user", content: "short history ".repeat(100), timestamp: 1 },
		{
			...fauxAssistantMessage("short answer ".repeat(100)),
			api: harness.getModel().api,
			provider: harness.getModel().provider,
			model: harness.getModel().id,
			usage: {
				input: 2500,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	] satisfies AgentMessage[];
	if (checkpoint) harness.sessionManager.appendCompactionCheckpoint(messages, 1000);
	else for (const message of messages) harness.sessionManager.appendMessage(message);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("T-085 modern compaction cancellation boundary", () => {
	for (const checkpoint of [false, true]) {
		for (const automatic of [false, true]) {
			it(`calls the hook without a legacy cut (${checkpoint ? "checkpoint" : "short history"}, ${automatic ? "automatic" : "manual"})`, async () => {
				let hooks = 0;
				const harness = await createHarness({
					extensionFactories: [
						(pi) => {
							pi.on("session_before_compact", (event) => {
								hooks++;
								expect(event.preparation).toBeUndefined();
								expect(event.branchEntries.length).toBeGreaterThan(0);
								return { cancel: true };
							});
						},
					],
				});
				harnesses.push(harness);
				seed(harness, checkpoint);
				const branchBefore = harness.sessionManager.getBranch();
				expect(prepareCompaction(branchBefore, harness.settingsManager.getCompactionSettings())).toBeUndefined();
				harness.setResponses([fauxAssistantMessage("a compact handoff")]);
				if (automatic) {
					await (harness.session as unknown as CompactionInternals)._runAutoCompaction(
						"threshold",
						false,
						decision,
					);
				} else {
					await harness.session.compact().catch(() => undefined);
				}
				expect(hooks).toBe(1);
				expect(harness.faux.state.callCount).toBe(0);
				expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toEqual(
					branchBefore.filter((entry) => entry.type === "compaction"),
				);
				expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, willRetry: false });
			});
		}
	}
});

describe("T-084 abort owns automatic compaction", () => {
	for (const boundary of ["overflow", "threshold"] as const) {
		it(`cancels the pending ${boundary} summary without publication or continuation`, async () => {
			const entered = deferred();
			let finish!: () => void;
			let summarySignal: AbortSignal | undefined;
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: boundary === "threshold" ? 3_000 : 20_000, maxTokens: 100 }],
				settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 }, retry: { enabled: false } },
			});
			harnesses.push(harness);
			if (boundary === "threshold") seed(harness, false);
			const blockSummary = (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
				new Promise<AssistantMessage>((resolve) => {
					summarySignal = options?.signal;
					finish = () => resolve(fauxAssistantMessage("late handoff must not publish"));
					summarySignal?.addEventListener("abort", finish, { once: true });
					entered.resolve();
				});
			harness.setResponses([
				...(boundary === "overflow" ? [fauxAssistantMessage("partial", { stopReason: "length" })] : []),
				blockSummary,
				fauxAssistantMessage("must not continue"),
			]);
			const prompt = harness.session.prompt("x".repeat(5000));
			await entered.promise;
			const abort = harness.session.abort();
			try {
				expect(summarySignal?.aborted).toBe(true);
			} finally {
				finish();
				await Promise.all([prompt, abort]);
			}
			expect(harness.session.isIdle).toBe(true);
			expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, willRetry: false });
			expect(harness.faux.state.callCount).toBe(boundary === "overflow" ? 2 : 1);
		});
	}
});
