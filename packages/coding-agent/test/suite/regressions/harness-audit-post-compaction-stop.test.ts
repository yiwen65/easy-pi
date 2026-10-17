import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRecoveryJournal } from "../../../src/core/task-recovery.ts";
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

describe("T-084 stop at post-publication continuation admission", () => {
	for (const entrypoint of ["prompt", "resumeTask"] as const) {
		for (const boundary of ["session_compact", "compaction_end"] as const) {
			for (const stop of ["abort", "stopAfterCurrentTurn"] as const) {
				it(`${entrypoint}: ${stop} during ${boundary} retains the checkpoint without a new request`, async () => {
					const entered = deferred();
					const release = deferred();
					const harness = await createHarness({
						models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 100 }],
						settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 }, retry: { enabled: false } },
						extensionFactories: [
							(pi) => {
								pi.on("session_compact", async () => {
									if (boundary !== "session_compact") return;
									entered.resolve();
									await release.promise;
								});
							},
						],
					});
					harnesses.push(harness);
					let abort: Promise<void> | undefined;
					let stopped = false;
					const requestStop = () => {
						stopped = true;
						if (stop === "abort") abort = harness.session.abort();
						else harness.session.stopAfterCurrentTurn();
					};
					harness.session.subscribe((event) => {
						if (boundary === "compaction_end" && event.type === "compaction_end" && event.result && !stopped) {
							requestStop();
							entered.resolve();
						}
					});
					harness.setResponses([
						fauxAssistantMessage("partial", { stopReason: "length" }),
						fauxAssistantMessage("Published handoff retained after cancellation"),
						fauxAssistantMessage("Unwanted continuation"),
					]);
					const prompt = "x".repeat(5000);
					if (entrypoint === "resumeTask")
						new TaskRecoveryJournal(harness.sessionManager).start([
							{ role: "user", content: prompt, timestamp: 1 },
						]);
					const run = entrypoint === "prompt" ? harness.session.prompt(prompt) : harness.session.resumeTask();
					await entered.promise;
					const checkpoint = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
					try {
						expect(checkpoint).toHaveLength(1);
						if (boundary === "session_compact") requestStop();
					} finally {
						release.resolve();
						await run;
						await abort;
					}
					expect(harness.faux.state.callCount).toBe(2);
					expect(harness.session.isIdle).toBe(true);
					expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual(
						checkpoint,
					);
					harness.setResponses([fauxAssistantMessage("Explicit next task works")]);
					await harness.session.prompt("new explicit task");
					expect(harness.faux.state.callCount).toBe(3);
					expect(harness.session.getLastAssistantText()).toBe("Explicit next task works");
				});
			}
		}
	}
});
