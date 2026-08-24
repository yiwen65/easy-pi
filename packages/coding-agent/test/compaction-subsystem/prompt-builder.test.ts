import { describe, expect, it } from "vitest";
import { PromptBudgetExceededError } from "../../src/core/compaction/subsystem/active-projection.ts";
import { InMemoryEventLog } from "../../src/core/compaction/subsystem/event-log.ts";
import {
	buildFocusView,
	buildPassthroughPrompt,
	buildPrompt,
	type VersionedTaskLedgerLike,
} from "../../src/core/compaction/subsystem/prompt-builder.ts";
import type { LedgerTask } from "../../src/core/compaction/subsystem/task-ledger.ts";
import type { StructuredSnapshot, TaskContract } from "../../src/core/compaction/subsystem/types.ts";

const user = { kind: "user" as const, id: "user-1", verified: true };

const contract: TaskContract = {
	contractId: "c-1",
	sessionId: "s-1",
	version: 3,
	goal: "Ship the compaction subsystem",
	acceptanceCriteria: ["all tests pass"],
	constraints: [
		{ id: "c-1", kind: "positive", text: "Always run tests before commit", authority: user },
		{ id: "c-2", kind: "negative", text: "Never delete raw events", authority: user },
	],
	permissions: { allow: ["read"], deny: [], approvalRequired: ["bash"] },
	budgets: { maxTokens: 50000 },
	authority: user,
	provenance: { sourceEventIds: [], source: "contract" },
	validFrom: "2026-08-22T00:00:00Z",
	allowedUpdaters: ["user-1"],
	schemaVersion: 1,
};

const snapshot: StructuredSnapshot = {
	snapshotVersion: 2,
	sessionId: "s-1",
	parentVersion: 1,
	baseEventSeq: 12,
	lineage: [1],
	contractRef: { contractId: "c-1", version: 3 },
	constraints: contract.constraints,
	facts: [
		{
			id: "f-1",
			text: "Store uses sha256 content addressing",
			kind: "fact",
			verified: true,
			provenance: { sourceEventIds: ["e-5"], source: "reducer" },
		},
	],
	decisions: [
		{
			id: "d-1",
			text: "CAS activation",
			rationale: "concurrency safety",
			causalParentDecisionIds: [],
			provenance: { sourceEventIds: ["e-7"], source: "reducer" },
		},
	],
	tasks: [
		{
			id: "t-1",
			title: "Implement store",
			state: "done",
			blockers: [],
			provenance: { sourceEventIds: ["e-9"], source: "reducer" },
		},
		{
			id: "t-2",
			title: "Wire orchestrator",
			state: "in_progress",
			blockers: [],
			provenance: { sourceEventIds: ["e-11"], source: "reducer" },
		},
	],
	tools: [],
	artifacts: [],
	errors: [],
	nextActions: [
		{ id: "n-1", text: "Run validator tests", provenance: { sourceEventIds: ["e-11"], source: "reducer" } },
	],
	recallCatalogRefs: ["rc-1"],
	sourceEventRanges: [{ fromSeq: 1, toSeq: 12 }],
	narrative: "We built the store and are now wiring the orchestrator.",
	compactor: { promptVersion: "1.0.0", schemaVersion: 1 },
	tokenStats: {
		system: 0,
		tools: 0,
		contract: 0,
		snapshot: 0,
		narrative: 0,
		recall: 0,
		recentTail: 0,
		currentInput: 0,
		outputReserve: 0,
		total: 0,
	},
	createdAt: "2026-08-22T01:00:00Z",
	schemaVersion: 1,
};

function taskLedger(): VersionedTaskLedgerLike {
	const common = {
		status: "active" as const,
		createdAt: "2026-08-22T00:00:00Z",
		updatedAt: "2026-08-22T00:00:00Z",
	};
	const focus: LedgerTask = {
		...common,
		taskId: "T-403",
		version: 7,
		goal: {
			normalized: "Keep the focused task contract pinned",
			verbatimSourceEventIds: ["ev-goal"],
			scope: ["prompt"],
			exclusions: ["TUI"],
		},
		acceptanceCriteria: ["token accounting includes the ledger"],
		constraints: [{ id: "tc-1", kind: "negative", text: "Do not edit the TUI", authority: user }],
		permissions: { allow: ["read", "edit"], deny: ["delete"], approvalRequired: ["network"] },
		budgets: { maxTokens: 12000, maxToolCalls: 20, maxDurationMs: 60000 },
		outputContract: "Return changed files and checks",
		relations: { parentTaskId: "T-400", dependsOn: ["T-402"], supersedes: "T-399" },
		provenance: { createdBy: user, createdFromEvent: "ev-create", updatedFromEvents: ["ev-update"] },
		blockers: ["waiting for review"],
	};
	const other: LedgerTask = {
		...common,
		taskId: "T-404",
		version: 2,
		status: "background",
		goal: { normalized: "Follow-up work", verbatimSourceEventIds: ["ev-other"] },
		acceptanceCriteria: ["not copied into the focus contract"],
		constraints: [{ id: "tc-2", kind: "positive", text: "Preserve compatibility", authority: user }],
		permissions: { allow: ["read"], deny: [], approvalRequired: [] },
		budgets: {},
		outputContract: "This non-focus output contract must not be copied",
		relations: { dependsOn: [] },
		provenance: { createdBy: user, createdFromEvent: "ev-other", updatedFromEvents: ["ev-other"] },
		blockers: [],
	};
	return {
		getFocusTask: () => focus,
		getFocusTaskId: () => focus.taskId,
		getLedgerVersion: () => 11,
		getTask: (taskId) => (taskId === focus.taskId ? focus : taskId === other.taskId ? other : undefined),
		nonTerminalIndex: () =>
			[focus, other].map((task) => ({
				taskId: task.taskId,
				status: task.status,
				goal: task.goal.normalized,
				blockers: task.blockers,
				version: task.version,
			})),
		getPendingGoalChanges: () => [],
	};
}

function tailEvents() {
	const log = new InMemoryEventLog();
	log.append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-13",
		eventType: "message",
		payload: { text: "user: now add the validator" },
		authority: user,
	});
	log.append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-14",
		eventType: "message",
		payload: { text: "assistant: writing validator.ts" },
		authority: user,
	});
	return log.all("s-1");
}

describe("buildPrompt", () => {
	it("assembles zones in the frozen order", () => {
		const built = buildPrompt({
			systemPrompt: "SYSTEM POLICY",
			contract,
			snapshot,
			recallGuide: "Use recall_exact(ref) to fetch moved content.",
			tailEvents: tailEvents(),
			currentInput: "continue",
			exactRecall: [],
		});
		expect(built.systemPrompt).toBe("SYSTEM POLICY");
		const order = built.sections.map((s) => s.zone);
		expect(order).toEqual(["contract", "snapshot", "narrative", "recallGuide", "recentTail", "currentInput"]);
	});

	it("every active constraint is locatable verbatim in the request", () => {
		const built = buildPrompt({
			systemPrompt: "S",
			contract,
			snapshot,
			tailEvents: tailEvents(),
			currentInput: "go",
			exactRecall: [],
		});
		const contractZone = built.sections.find((s) => s.zone === "contract")!;
		for (const c of contract.constraints) {
			expect(contractZone.text).toContain(c.text);
		}
		expect(contractZone.text).toContain("version 3");
	});

	it("pins the complete focus contract, global budgets, and only cross-task constraints", () => {
		const built = buildPrompt({
			systemPrompt: "S",
			contract,
			ledger: taskLedger(),
			tailEvents: [],
			currentInput: "go",
			exactRecall: [],
			estimateTextTokens: (text) => text.length,
		});
		const section = built.sections.find((candidate) => candidate.zone === "contract")!;
		for (const expected of [
			"max tokens: 50000",
			"task://T-403/v7",
			"Keep the focused task contract pinned",
			"token accounting includes the ledger",
			"Do not edit the TUI",
			"allow: read, edit",
			"max tool calls: 20",
			"Return changed files and checks",
			"waiting for review",
			"parent: T-400",
			"depends on: T-402",
			"supersedes: T-399",
			"ev-goal",
			"Preserve compatibility",
		]) {
			expect(section.text).toContain(expected);
		}
		expect(section.text).not.toContain("This non-focus output contract must not be copied");
		// The ledger projection is the contract zone, so its full text is counted.
		expect(section.tokens).toBe(section.text.length);
		expect(built.tokenStats.contract).toBe(section.text.length);
	});

	it("recent tail is verbatim event content in seq order", () => {
		const tail = tailEvents();
		const built = buildPrompt({
			systemPrompt: "S",
			contract,
			snapshot,
			tailEvents: tail,
			currentInput: "go",
			exactRecall: [],
		});
		const tailZone = built.sections.find((s) => s.zone === "recentTail")!;
		const firstIdx = tailZone.text.indexOf("user: now add the validator");
		const secondIdx = tailZone.text.indexOf("assistant: writing validator.ts");
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(secondIdx).toBeGreaterThan(firstIdx);
	});

	it("can measure the unbounded live provider tail before compaction", () => {
		const built = buildPrompt({
			systemPrompt: "S",
			tailEvents: tailEvents(),
			currentInput: "",
			exactRecall: [],
			estimateTextTokens: (text) => text.length,
			zoneBudgets: { recentTail: 1 },
			enforceRecentTailBudget: false,
		});
		expect(built.tokenStats.recentTail).toBeGreaterThan(1);
		expect(built.projectionStats.find((stats) => stats.zone === "recentTail")?.droppedItems).toBe(0);
	});

	it("includes image token cost from tail tool results", () => {
		const event = tailEvents()[0];
		const built = buildPrompt({
			systemPrompt: "S",
			contract,
			snapshot,
			tailEvents: [{ ...event, payload: { text: "tool result with image", imageCount: 2 } }],
			currentInput: "",
			exactRecall: [],
			estimateTextTokens: (text) => text.length,
		});
		const tailZone = built.sections.find((section) => section.zone === "recentTail")!;
		expect(built.tokenStats.recentTail).toBe(tailZone.tokens + 2400);
	});

	it("token composition adds up to the total and includes all zones + reserves", () => {
		const built = buildPrompt({
			systemPrompt: "S".repeat(40),
			contract,
			snapshot,
			tailEvents: tailEvents(),
			currentInput: "go",
			exactRecall: ["recalled block"],
			toolsTokenEstimate: 500,
			outputReserveTokens: 1000,
		});
		const t = built.tokenStats;
		expect(t.total).toBe(
			t.system +
				t.tools +
				t.contract +
				t.snapshot +
				t.narrative +
				t.recall +
				t.recentTail +
				t.currentInput +
				t.outputReserve,
		);
		expect(t.tools).toBe(500);
		expect(t.outputReserve).toBe(1000);
		expect(t.total).toBeGreaterThan(1500);
	});

	it("focus view only references IDs that exist in the snapshot", () => {
		const focus = buildFocusView(snapshot);
		const mentioned = [...focus.matchAll(/\b([fdtne]-\d+|rc-[a-z0-9-]+)\b/g)].map((m) => m[1]);
		const known = new Set([
			...snapshot.facts.map((f) => f.id),
			...snapshot.decisions.map((d) => d.id),
			...snapshot.tasks.map((t) => t.id),
			...snapshot.errors.map((e) => e.id),
			...snapshot.nextActions.map((n) => n.id),
			...snapshot.recallCatalogRefs,
		]);
		for (const id of mentioned) {
			expect(known.has(id)).toBe(true);
		}
		expect(focus).toContain("t-2");
	});

	it("bounds warm state by lifecycle while protecting open work", () => {
		const bloated: StructuredSnapshot = {
			...snapshot,
			facts: Array.from({ length: 40 }, (_, index) => ({
				id: `f-${index}`,
				text: `historical fact ${index} ${"x".repeat(30)}`,
				kind: "fact" as const,
				verified: true,
				provenance: { sourceEventIds: [`e-${index}`], source: "reducer" as const },
			})),
			errors: [
				{
					id: "e-open",
					message: "must remain visible",
					resolved: false,
					provenance: { sourceEventIds: ["e-40"], source: "reducer" },
				},
			],
		};
		const built = buildPrompt({
			systemPrompt: "S",
			contract,
			snapshot: bloated,
			tailEvents: [],
			currentInput: "go",
			exactRecall: [],
			estimateTextTokens: (text) => text.length,
			zoneBudgets: { snapshot: 650 },
		});
		const section = built.sections.find((candidate) => candidate.zone === "snapshot")!;
		const stats = built.projectionStats.find((candidate) => candidate.zone === "snapshot")!;
		expect(section.tokens).toBeLessThanOrEqual(650);
		expect(section.text).toContain("must remain visible");
		expect(stats.droppedItems).toBeGreaterThan(0);
	});

	it("fails closed instead of truncating explicit exact recall", () => {
		expect(() =>
			buildPrompt({
				systemPrompt: "S",
				tailEvents: [],
				currentInput: "go",
				exactRecall: ["recover me exactly"],
				estimateTextTokens: (text) => text.length,
				zoneBudgets: { exactRecall: 5 },
			}),
		).toThrow(PromptBudgetExceededError);
	});
});

describe("buildPassthroughPrompt", () => {
	it("compaction-off path returns the original history untouched", () => {
		const messages = [
			{ role: "user" as const, content: "original question" },
			{ role: "assistant" as const, content: "original answer" },
		];
		const out = buildPassthroughPrompt("SYS", messages);
		expect(out.systemPrompt).toBe("SYS");
		expect(out.messages).toEqual(messages);
	});
});
