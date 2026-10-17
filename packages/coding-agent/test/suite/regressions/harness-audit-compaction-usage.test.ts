import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPACTION_DIAGNOSTICS_ENTRY_TYPE,
	type CompactionDiagnosticsSnapshot,
} from "../../../src/core/compaction/subsystem/observability.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.shutdown();
		harness.cleanup();
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function usage(input = 10): Usage {
	return {
		input,
		output: 20,
		cacheRead: 30,
		cacheWrite: 40,
		cacheWrite1h: 5,
		reasoning: 7,
		totalTokens: input + 90,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
	};
}

function seed(harness: Harness): void {
	harness.sessionManager.appendMessage({ role: "user", content: "historical task ".repeat(200), timestamp: 1 });
	harness.sessionManager.appendMessage(
		fauxAssistantMessage(fauxToolCall("read", { path: "historical.txt" }, { id: "old-read" }), {
			stopReason: "toolUse",
		}),
	);
	harness.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "old-read",
		toolName: "read",
		content: [{ type: "text", text: "historical output ".repeat(200) }],
		isError: false,
		timestamp: 2,
	});
	harness.sessionManager.appendMessage(fauxAssistantMessage("historical answer ".repeat(200)));
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("T-086 modern compaction usage", () => {
	for (const automatic of [false, true]) {
		for (const attempts of ["single", "retry", "overflow", "retry-overflow"] as const) {
			it(`accounts full usage exactly once after ${automatic ? "automatic" : "manual"} ${attempts} compaction and reopening`, async () => {
				const directory = mkdtempSync(join(tmpdir(), "pi-compaction-usage-"));
				directories.push(directory);
				const manager = SessionManager.create(directory, join(directory, "sessions"));
				const harness = await createHarness({
					sessionManager: manager,
					models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 100 }],
					settings: {
						compaction: { keepRecentTokens: 1, reserveTokens: 0 },
						retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
					},
				});
				harnesses.push(harness);
				seed(harness);
				const usages =
					attempts === "single"
						? [usage()]
						: attempts === "retry-overflow"
							? [usage(), usage(25_000), usage()]
							: [usage(attempts === "overflow" ? 25_000 : 10), usage()];
				const steps: AssistantMessage[] = [
					...(automatic ? [fauxAssistantMessage("partial", { stopReason: "length" })] : []),
					...(attempts === "single"
						? []
						: [
								{
									...fauxAssistantMessage(
										"unsuitable handoff",
										attempts === "retry" || attempts === "retry-overflow"
											? { stopReason: "error", errorMessage: "overloaded" }
											: {},
									),
									usage: usages[0],
								},
							]),
					...(attempts === "retry-overflow"
						? [{ ...fauxAssistantMessage("overflowed handoff"), usage: usages[1] }]
						: []),
					{ ...fauxAssistantMessage("A complete compact handoff"), usage: usages.at(-1)! },
					...(automatic ? [fauxAssistantMessage("completed")] : []),
				];
				let calls = 0;
				harness.session.agent.streamFunction = (model) => {
					calls++;
					const step = steps.shift();
					if (!step) throw new Error("Unexpected provider call");
					const message = { ...step, api: model.api, provider: model.provider, model: model.id };
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
						else stream.push({ type: "done", reason: message.stopReason as "stop" | "length", message });
					});
					return stream;
				};
				if (automatic) await harness.session.prompt("continue the original task");
				else await harness.session.compact();
				expect(calls).toBe(usages.length + (automatic ? 2 : 0));
				expect(steps).toHaveLength(0);
				const entries = manager.getEntries().filter((entry) => entry.type === "compaction");
				expect(entries).toHaveLength(1);
				const expected = usage(usages.reduce((sum, value) => sum + value.input, 0));
				for (const key of [
					"output",
					"cacheRead",
					"cacheWrite",
					"cacheWrite1h",
					"reasoning",
					"totalTokens",
				] as const)
					expected[key] = usages.reduce((sum, value) => sum + (value[key] ?? 0), 0);
				for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
					expected.cost[key] = usages.reduce((sum, value) => sum + value.cost[key], 0);
				expect(entries[0].usage).toEqual(expected);
				const diagnostics = manager
					.getEntries()
					.find((entry) => entry.type === "custom" && entry.customType === COMPACTION_DIAGNOSTICS_ENTRY_TYPE);
				if (diagnostics?.type !== "custom") throw new Error("Missing compaction diagnostics");
				const metrics = diagnostics.data as CompactionDiagnosticsSnapshot;
				expect(metrics.outcome).toBe("activated");
				expect(metrics.attempts.map((attempt) => attempt.usage)).toEqual(usages);
				const totals = {
					tokens: {
						input: expected.input,
						output: expected.output,
						cacheRead: expected.cacheRead,
						cacheWrite: expected.cacheWrite,
						total: expected.totalTokens,
					},
					cost: expected.cost.total,
				};
				expect(harness.session.getSessionStats()).toMatchObject(totals);
				await harness.session.shutdown();
				const reopened = await createHarness({ sessionManager: SessionManager.open(manager.getSessionFile()!) });
				harnesses.push(reopened);
				expect(reopened.session.getSessionStats()).toMatchObject(totals);
			});
		}
	}
});
