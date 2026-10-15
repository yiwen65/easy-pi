import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	COMPACTION_DIAGNOSTICS_ENTRY_TYPE,
	type CompactionDiagnosticsSnapshot,
} from "../src/core/compaction/subsystem/observability.ts";
import { type CustomEntry, SessionManager } from "../src/core/session-manager.ts";
import { createHarness, createHarnessWithExtensions, fauxModel, type Harness } from "./test-harness.ts";

const harnesses: Harness[] = [];
const sessionDirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const h of harnesses.splice(0)) {
		await h.session.shutdown();
		h.cleanup();
	}
	for (const dir of sessionDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const handoff = [
	"## Conversation timeline",
	"The user asked for a diagnostics implementation; the agent inspected and implemented it.",
	"## Current continuation point",
	"Next concrete action: verify the implementation with targeted tests.",
].join("\n");

function diagnostics(h: Harness): CompactionDiagnosticsSnapshot[] {
	return h.sessionManager
		.getEntries()
		.filter(
			(entry): entry is CustomEntry<CompactionDiagnosticsSnapshot> =>
				entry.type === "custom" && entry.customType === COMPACTION_DIAGNOSTICS_ENTRY_TYPE,
		)
		.map((entry) => entry.data!);
}

function seedHistory(h: Harness): void {
	const now = Date.now() - 1000;
	h.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: `private-user-history ${"historical request ".repeat(100)}` }],
		timestamp: now,
	});
	h.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `private-assistant-history ${"completed work ".repeat(100)}` }],
		api: h.session.model!.api,
		provider: h.session.model!.provider,
		model: h.session.model!.id,
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: now + 1,
	});
	h.agent.state.messages = h.sessionManager.buildSessionContext().messages;
}

function expectHostStages(snapshot: CompactionDiagnosticsSnapshot): void {
	expect(snapshot.durationMs).toBeGreaterThanOrEqual(0);
	expect(snapshot.stages).toEqual({
		preparationMs: expect.any(Number),
		generationMs: expect.any(Number),
		validationMs: expect.any(Number),
	});
	for (const duration of Object.values(snapshot.stages!)) {
		expect(duration).toBeGreaterThanOrEqual(0);
	}
}

describe("AgentSession compaction diagnostics", () => {
	it("records manual adapter and host metrics before notifying listeners, without injecting metadata into context", async () => {
		const h = await createHarness({
			settings: { compaction: { enabled: false } },
			responses: [{ text: handoff, thinking: "private-compactor-thinking" }, "next answer"],
		});
		harnesses.push(h);
		seedHistory(h);
		const endSnapshots: CompactionDiagnosticsSnapshot[][] = [];
		h.session.subscribe((event) => {
			if (event.type === "compaction_end") endSnapshots.push(diagnostics(h));
		});

		await h.session.compact("private-compaction-instructions");

		const records = diagnostics(h);
		expect(records).toHaveLength(1);
		expect(endSnapshots).toEqual([records]);
		expect(records[0]).toMatchObject({ version: 1, reason: "manual", outcome: "activated", retryCount: 0 });
		expectHostStages(records[0]);
		expect(records[0].attempts).toHaveLength(1);
		expect(records[0].attempts[0]).toMatchObject({
			provider: "faux",
			model: "faux-1",
			api: "anthropic-messages",
			stopReason: "stop",
			firstEventMs: expect.any(Number),
			firstTextMs: expect.any(Number),
			firstThinkingMs: expect.any(Number),
			usage: { input: 100, output: 50 },
		});
		const serialized = JSON.stringify(records);
		expect(serialized).not.toContain("private-");
		expect(serialized).not.toContain(handoff);
		expect(serialized).not.toContain("faux-key");
		expect(h.session.messages).toEqual(h.sessionManager.buildSessionContext().messages);

		await h.session.prompt("continue");
		expect(JSON.stringify(h.faux.contexts)).not.toContain(COMPACTION_DIAGNOSTICS_ENTRY_TYPE);
		expect(JSON.stringify(h.session.messages)).not.toContain(COMPACTION_DIAGNOSTICS_ENTRY_TYPE);
	});

	it.each([
		["manual", "high"],
		["manual", "medium"],
		["manual", "off"],
		["threshold", "high"],
		["threshold", "medium"],
		["threshold", "off"],
	] as const)("inherits the current main-agent effort for %s compaction at %s", async (reason, thinkingLevel) => {
		const h = await createHarness({
			model: { ...fauxModel, reasoning: true },
			contextWindow: 60_000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			responses:
				reason === "manual"
					? [handoff]
					: [
							{ text: "first answer", usage: { totalTokens: 500 } },
							{ text: "second answer", usage: { totalTokens: 57_500 } },
							handoff,
							{ text: "post-compaction answer", usage: { totalTokens: 100 } },
						],
		});
		harnesses.push(h);
		const captured: SimpleStreamOptions[] = [];
		const stream = h.agent.streamFunction;
		h.agent.streamFunction = (model, context, options) => {
			if (options?.toolChoice === "none") captured.push(options);
			return stream(model, context, options);
		};
		if (reason === "threshold") {
			await h.session.prompt("start");
			await h.session.prompt("continue");
		} else {
			seedHistory(h);
		}
		h.session.setThinkingLevel(thinkingLevel);
		h.agent.thinkingBudgets = { medium: 4096, high: 12288 };
		if (reason === "manual") await h.session.compact();
		else await h.session.prompt("next real request");

		expect(captured).toHaveLength(1);
		expect(captured[0]).toMatchObject({
			reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
			thinkingBudgets: h.agent.thinkingBudgets,
		});
		expect(h.session.thinkingLevel).toBe(thinkingLevel);
		expect(diagnostics(h)[0]).toMatchObject({ reason, attempts: [{ reasoning: thinkingLevel }] });
	});

	it("restores diagnostics from disk without replaying metadata into the active context", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-compaction-diagnostics-"));
		sessionDirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		const h = await createHarness({ sessionManager: manager, responses: [handoff] });
		harnesses.push(h);
		seedHistory(h);
		await h.session.compact();

		const restored = SessionManager.open(manager.getSessionFile()!);
		const entries = restored
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === COMPACTION_DIAGNOSTICS_ENTRY_TYPE);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			data: { version: 1, outcome: "activated", attempts: [{ usage: { input: 100, output: 50 } }] },
		});
		expect(JSON.stringify(entries)).not.toContain("private-");
		expect(restored.buildSessionContext().messages).toEqual(h.session.messages);
		expect(JSON.stringify(restored.buildSessionContext().messages)).not.toContain(COMPACTION_DIAGNOSTICS_ENTRY_TYPE);
	});

	it("uses separate collectors for rejection and a following successful manual attempt", async () => {
		const h = await createHarness({ responses: ["x", handoff] });
		harnesses.push(h);
		seedHistory(h);

		await expect(h.session.compact()).rejects.toThrow("Compaction rejected");
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		await h.session.compact();

		const records = diagnostics(h);
		expect(records.map((record) => record.outcome)).toEqual(["failed", "activated"]);
		for (const record of records) {
			expect(record.attempts).toHaveLength(1);
			expectHostStages(record);
		}
	});

	it("retains host timing when configComplete bypasses the production adapter", async () => {
		const complete = vi.fn(async () => ({ text: handoff, stopReason: "stop" as const }));
		const h = await createHarness({ hfCompaction: { mode: "full_pipeline", complete } });
		harnesses.push(h);
		seedHistory(h);

		await h.session.compact();

		expect(complete).toHaveBeenCalledOnce();
		expect(h.faux.callCount).toBe(0);
		expect(diagnostics(h)).toHaveLength(1);
		expect(diagnostics(h)[0]).toMatchObject({ reason: "manual", outcome: "activated", attempts: [] });
		expectHostStages(diagnostics(h)[0]);
	});

	it("keeps collectors independent when a post-commit extension starts another manual compaction", async () => {
		let nestedCompact: (() => Promise<unknown>) | undefined;
		let nested = false;
		const complete = vi
			.fn()
			.mockResolvedValueOnce({ text: handoff, stopReason: "stop" })
			.mockResolvedValueOnce({ text: "Nested handoff.", stopReason: "stop" });
		const h = await createHarnessWithExtensions({
			hfCompaction: { mode: "full_pipeline", complete },
			extensionFactories: [
				{
					path: "<nested-compaction>",
					factory: (pi) => {
						pi.on("session_compact", async () => {
							if (nested) return;
							nested = true;
							await nestedCompact!();
						});
					},
				},
			],
		});
		harnesses.push(h);
		seedHistory(h);
		nestedCompact = () => h.session.compact();

		await h.session.compact();

		expect(complete).toHaveBeenCalledTimes(2);
		expect(h.eventsOfType("compaction_start")).toHaveLength(2);
		expect(h.eventsOfType("compaction_end")).toHaveLength(2);
		expect(diagnostics(h).map((record) => record.outcome)).toEqual(["activated", "activated"]);
		for (const record of diagnostics(h)) expectHostStages(record);
	});

	it.each(["manual", "threshold"] as const)(
		"records %s failure and cleans up when a start subscriber throws",
		async (reason) => {
			const h = await createHarness({
				contextWindow: 60_000,
				settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
				responses: [
					{ text: "first answer", usage: { totalTokens: 500 } },
					{ text: "second answer", usage: { totalTokens: 57_500 } },
					{ text: "continued without compaction", usage: { totalTokens: 100 } },
				],
			});
			harnesses.push(h);
			if (reason === "threshold") {
				await h.session.prompt("start");
				await h.session.prompt("continue");
			} else {
				seedHistory(h);
			}
			h.session.subscribe((event) => {
				if (event.type === "compaction_start") throw new Error("private-start-subscriber-error");
			});

			if (reason === "manual") await expect(h.session.compact()).rejects.toThrow("private-start-subscriber-error");
			else await h.session.prompt("next real request");

			expect(diagnostics(h)).toHaveLength(1);
			expect(diagnostics(h)[0]).toMatchObject({ reason, outcome: "failed", attempts: [] });
			expect(JSON.stringify(diagnostics(h))).not.toContain("private-start-subscriber-error");
			expect(h.eventsOfType("compaction_end")).toHaveLength(1);
			expect(h.session.isCompacting).toBe(false);
			expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		},
	);

	it("finalizes once even if a subscriber throws after a committed checkpoint", async () => {
		const h = await createHarness({ responses: [handoff] });
		harnesses.push(h);
		seedHistory(h);
		let firstEnd = true;
		h.session.subscribe((event) => {
			if (event.type === "compaction_end" && firstEnd) {
				firstEnd = false;
				throw new Error("subscriber failure");
			}
		});

		await expect(h.session.compact()).rejects.toThrow("subscriber failure");

		expect(diagnostics(h)).toHaveLength(1);
		expect(diagnostics(h)[0].outcome).toBe("activated");
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("records manual cancellation during injected generation without storing its content", async () => {
		let abort = () => {};
		const h = await createHarness({
			hfCompaction: {
				mode: "full_pipeline",
				complete: async () => {
					abort();
					return { text: handoff, stopReason: "stop" };
				},
			},
		});
		harnesses.push(h);
		seedHistory(h);
		abort = () => h.session.abortCompaction();

		await expect(h.session.compact()).rejects.toThrow("Compaction cancelled");

		expect(diagnostics(h)).toHaveLength(1);
		expect(diagnostics(h)[0]).toMatchObject({ reason: "manual", outcome: "aborted", attempts: [] });
		expectHostStages(diagnostics(h)[0]);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("records generation failure without retaining raw errors", async () => {
		const h = await createHarness({
			hfCompaction: {
				mode: "full_pipeline",
				complete: async () => {
					throw new Error("private-error-with-credentials");
				},
			},
		});
		harnesses.push(h);
		seedHistory(h);

		await expect(h.session.compact()).rejects.toThrow("private-error-with-credentials");

		expect(diagnostics(h)).toHaveLength(1);
		expect(diagnostics(h)[0].outcome).toBe("failed");
		expectHostStages(diagnostics(h)[0]);
		expect(JSON.stringify(diagnostics(h))).not.toContain("private-error-with-credentials");
	});

	it.each([true, false])("diagnostics write failure does not alter manual success=%s", async (success) => {
		const h = await createHarness({ responses: [success ? handoff : "x"] });
		harnesses.push(h);
		seedHistory(h);
		const append = vi.spyOn(h.sessionManager, "appendCustomEntry").mockImplementation(() => {
			throw new Error("diagnostics write failure");
		});

		if (success) await expect(h.session.compact()).resolves.toMatchObject({ summary: expect.any(String) });
		else await expect(h.session.compact()).rejects.toThrow("Compaction rejected");

		expect(append).toHaveBeenCalledOnce();
		expect(append).toHaveBeenCalledWith(
			COMPACTION_DIAGNOSTICS_ENTRY_TYPE,
			expect.objectContaining({ outcome: success ? "activated" : "failed" }),
		);
		expect(h.eventsOfType("compaction_end")).toHaveLength(1);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
			success ? 1 : 0,
		);
	});

	it("records a threshold lifecycle including an adapter retry and then continues the pending request", async () => {
		const h = await createHarness({
			contextWindow: 60_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			},
			responses: [
				{ text: `first answer ${"padding ".repeat(150)}`, usage: { totalTokens: 500 } },
				{ text: `second answer ${"padding ".repeat(150)}`, usage: { totalTokens: 57_500 } },
				{ error: "terminated private-provider-error" },
				{ text: handoff },
				{ text: "post-compaction answer", usage: { totalTokens: 100 } },
			],
		});
		harnesses.push(h);

		await h.session.prompt("start");
		await h.session.prompt("continue");
		await h.session.prompt("send the next real request");

		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
		expect(diagnostics(h)).toHaveLength(1);
		const record = diagnostics(h)[0];
		expect(record).toMatchObject({
			reason: "threshold",
			outcome: "activated",
			retryCount: 1,
			scheduledRetryDelayMs: 1,
		});
		expect(record.attempts.map((attempt) => attempt.stopReason)).toEqual(["error", "stop"]);
		expectHostStages(record);
		expect(JSON.stringify(record)).not.toContain("private-provider-error");
		expect(h.session.getLastAssistantText()).toBe("post-compaction answer");
		expect(JSON.stringify(h.faux.contexts)).not.toContain(COMPACTION_DIAGNOSTICS_ENTRY_TYPE);
	});

	it.each([true, false])("records automatic cancellation=%s or rejection", async (cancel) => {
		const h = await createHarnessWithExtensions({
			contextWindow: 60_000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
			extensionFactories: [
				{
					path: "<automatic-cancellation>",
					factory: (pi) => {
						pi.on("session_before_compact", () => (cancel ? { cancel: true } : undefined));
					},
				},
			],
			responses: [
				{ text: `first ${"padding ".repeat(150)}`, usage: { totalTokens: 500 } },
				{ text: `second ${"padding ".repeat(150)}`, usage: { totalTokens: 57_500 } },
				...(cancel ? [] : [{ text: "x" }]),
				{ text: "continued without compaction", usage: { totalTokens: 100 } },
			],
		});
		harnesses.push(h);

		await h.session.prompt("start");
		await h.session.prompt("continue");
		await h.session.prompt("next request");

		expect(diagnostics(h)).toHaveLength(1);
		expect(diagnostics(h)[0]).toMatchObject({ reason: "threshold", outcome: cancel ? "aborted" : "failed" });
		expect(diagnostics(h)[0].attempts).toHaveLength(cancel ? 0 : 1);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(h.session.getLastAssistantText()).toBe("continued without compaction");
	});

	it("does not fabricate a failed record for overflow recovery's terminal end without a new start", async () => {
		// Faux responses can otherwise share the checkpoint's millisecond and be treated as stale.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
		const h = await createHarness({
			contextWindow: 20_000,
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 } },
			responses: [
				{ text: `first ${"padding ".repeat(150)}`, usage: { totalTokens: 500 } },
				{ text: "truncated", stopReason: "length", usage: { totalTokens: 990 } },
				{ text: handoff },
				{ text: "truncated again", stopReason: "length", usage: { totalTokens: 120 } },
			],
		});
		harnesses.push(h);

		await h.session.prompt("start");
		await h.session.prompt("second turn");

		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
		expect(h.eventsOfType("compaction_end")).toHaveLength(2);
		expect(h.eventsOfType("compaction_end")[1].errorMessage).toContain("recovery failed");
		expect(diagnostics(h)).toHaveLength(1);
		expect(diagnostics(h)[0]).toMatchObject({ reason: "overflow", outcome: "activated" });
		expect(diagnostics(h)[0].attempts).toHaveLength(1);
	});
});
