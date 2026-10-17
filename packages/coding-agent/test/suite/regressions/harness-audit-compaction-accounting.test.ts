import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	COMPACTION_DIAGNOSTICS_ENTRY_TYPE,
	type CompactionDiagnosticsSnapshot,
} from "../../../src/core/compaction/subsystem/observability.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { scanSessions } from "../../../src/core/stats/scan.ts";
import { getUsageCostBreakdown } from "../../../src/core/usage-totals.ts";
import { computeSessionUsageStats, FooterComponent } from "../../../src/modes/interactive/components/footer.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
beforeAll(() => initTheme(undefined, false));
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.shutdown();
		harness.cleanup();
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const reported: Usage = {
	input: 10,
	output: 20,
	cacheRead: 30,
	cacheWrite: 40,
	totalTokens: 100,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-compaction-accounting-"));
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
	manager.appendMessage({ role: "user", content: "old history ".repeat(500), timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("old answer ".repeat(300)));
	harness.session.agent.state.messages = manager.buildSessionContext().messages;
	return { harness, manager, directory };
}

function assertConsumers(harness: Harness, directory: string, count: number): void {
	const tokens = { input: 10 * count, output: 20 * count, cacheRead: 30 * count, cacheWrite: 40 * count };
	expect
		.soft(harness.session.getSessionStats())
		.toMatchObject({ tokens: { ...tokens, total: 100 * count }, cost: count });
	expect.soft(computeSessionUsageStats(harness.session).totals).toEqual({ ...tokens, cost: count });
	expect
		.soft(getUsageCostBreakdown(harness.sessionManager.getEntries()))
		.toEqual(count ? [{ key: "Tools/summaries", tokens: 100 * count, cost: count }] : []);
	const scanned = scanSessions({ roots: [join(directory, "sessions")] });
	expect.soft(scanned.sessions).toHaveLength(1);
	expect.soft(scanned.sessions[0]).toMatchObject({ ...tokens, totalTokens: 100 * count, cost: count });
	if (count > 0) {
		const footer = new FooterComponent(harness.session, {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		});
		expect.soft(stripAnsi(footer.render(200).join("\n"))).toContain(`$${count.toFixed(3)}`);
	}
}

describe("T-154 non-activated compaction accounting", () => {
	for (const automatic of [false, true]) {
		for (const outcome of ["failed", "aborted", "rejected", "retry-exhausted", "no-usage", "activated"] as const) {
			it(`${automatic ? "automatic" : "manual"} ${outcome}: counts reported usage once in every consumer and after reopen`, async () => {
				const { harness, manager, directory } = await fixture();
				const expectedCount = outcome === "no-usage" ? 0 : outcome === "retry-exhausted" ? 2 : 1;
				let summaryCalls = 0;
				let calls = 0;
				harness.session.agent.streamFunction = (model) => {
					calls++;
					const initial = automatic && calls === 1;
					const continuation = automatic && outcome === "activated" && calls === 3;
					if (!initial && !continuation) summaryCalls++;
					if (!initial && !continuation && outcome === "no-usage") throw new Error("stream failed before usage");
					const step: AssistantMessage = initial
						? fauxAssistantMessage("partial", { stopReason: "length" })
						: continuation
							? fauxAssistantMessage("done")
							: {
									...fauxAssistantMessage(outcome === "rejected" ? "#" : "A complete compact handoff", {
										stopReason:
											outcome === "failed" || outcome === "retry-exhausted"
												? "error"
												: outcome === "aborted"
													? "aborted"
													: "stop",
										errorMessage:
											outcome === "retry-exhausted"
												? "overloaded"
												: outcome === "failed"
													? "invalid request"
													: undefined,
									}),
									usage: structuredClone(reported),
								};
					const message = { ...step, api: model.api, provider: model.provider, model: model.id };
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						if (!initial && outcome === "aborted") harness.session.abortCompaction();
						if (message.stopReason === "error" || message.stopReason === "aborted")
							stream.push({ type: "error", reason: message.stopReason, error: message });
						else stream.push({ type: "done", reason: message.stopReason as "stop" | "length", message });
					});
					return stream;
				};
				if (automatic) await harness.session.prompt("continue");
				else if (outcome === "activated") await harness.session.compact();
				else await expect(harness.session.compact()).rejects.toThrow();
				expect(summaryCalls).toBe(outcome === "retry-exhausted" ? 2 : 1);
				expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
					outcome === "activated" ? 1 : 0,
				);
				const entry = manager
					.getEntries()
					.find((item) => item.type === "custom" && item.customType === COMPACTION_DIAGNOSTICS_ENTRY_TYPE);
				if (entry?.type !== "custom") throw new Error("Missing compaction diagnostics");
				const diagnostics = entry.data as CompactionDiagnosticsSnapshot;
				expect(diagnostics.outcome).toBe(
					outcome === "activated" ? "activated" : outcome === "aborted" ? "aborted" : "failed",
				);
				expect(diagnostics.attempts.flatMap((attempt) => (attempt.usage ? [attempt.usage] : []))).toEqual(
					Array.from({ length: expectedCount }, () => reported),
				);
				assertConsumers(harness, directory, expectedCount);
				await harness.session.shutdown();
				const reopened = await createHarness({ sessionManager: SessionManager.open(manager.getSessionFile()!) });
				harnesses.push(reopened);
				assertConsumers(reopened, directory, expectedCount);
			});
		}
	}

	it("ignores malformed, unknown-version, activated and absent usage without inventing cost", async () => {
		const { harness, manager, directory } = await fixture();
		const base = { version: 1, outcome: "failed", attempts: [{ usage: reported }] };
		for (const data of [
			null,
			[],
			"bad",
			{},
			{ ...base, version: 2 },
			{ ...base, outcome: "activated" },
			{ ...base, outcome: "unknown" },
			{ ...base, attempts: null },
			{ ...base, attempts: {} },
			{
				...base,
				attempts: [
					null,
					{},
					{ usage: null },
					{ usage: "bad" },
					{ usage: { ...reported, input: "10" } },
					{ usage: { ...reported, cacheRead: -1 } },
					{ usage: { ...reported, output: Infinity } },
					{ usage: { ...reported, cost: { ...reported.cost, total: -1 } } },
					{ usage: { input: 10 } },
				],
			},
		])
			manager.appendCustomEntry(COMPACTION_DIAGNOSTICS_ENTRY_TYPE, data);
		assertConsumers(harness, directory, 0);
		manager.appendCustomEntry(COMPACTION_DIAGNOSTICS_ENTRY_TYPE, {
			...base,
			attempts: [null, {}, { usage: reported }],
		});
		assertConsumers(harness, directory, 1);
		await harness.session.shutdown();
		const reopened = await createHarness({ sessionManager: SessionManager.open(manager.getSessionFile()!) });
		harnesses.push(reopened);
		assertConsumers(reopened, directory, 1);
	});
});
