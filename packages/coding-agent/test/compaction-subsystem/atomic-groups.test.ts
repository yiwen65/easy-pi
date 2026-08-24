import { describe, expect, it } from "vitest";
import { buildAtomicGroups, planSafeCut } from "../../src/core/compaction/subsystem/atomic-groups.ts";
import { InMemoryEventLog } from "../../src/core/compaction/subsystem/event-log.ts";
import type { EventEnvelope } from "../../src/core/compaction/subsystem/types.ts";

const authority = { kind: "agent" as const, id: "a-1", verified: true };

interface Spec {
	id: string;
	type: "message" | "tool_call" | "tool_result" | "transaction_call" | "transaction_result";
	authority?: "user" | "agent";
	toolCallId?: string;
	transactionId?: string;
	parents?: string[];
	text?: string;
	toolName?: string;
}

function buildEvents(specs: Spec[]): EventEnvelope[] {
	const log = new InMemoryEventLog();
	for (const spec of specs) {
		const eventType =
			spec.type === "message"
				? "message"
				: spec.type === "tool_call" || spec.type === "transaction_call"
					? "tool_call"
					: "tool_result";
		log.append({
			sessionId: "s-1",
			agentId: "a-1",
			eventId: spec.id,
			eventType,
			toolCallId: spec.toolCallId,
			transactionId: spec.transactionId,
			causalParentIds: spec.parents ?? [],
			payload:
				spec.type === "tool_call" || spec.type === "transaction_call"
					? { name: spec.toolName ?? "bash", arguments: { command: spec.text ?? "cmd" } }
					: { text: spec.text ?? spec.id },
			authority: spec.authority === "user" ? { kind: "user", id: "u-1", verified: true } : authority,
		});
	}
	return log.all("s-1");
}

describe("buildAtomicGroups", () => {
	it("pairs tool calls with results; batches parallel calls", () => {
		const events = buildEvents([
			{ id: "u-1", type: "message", text: "please do work" },
			{ id: "c-1", type: "tool_call", toolCallId: "tc-1", parents: ["u-1"] },
			{ id: "c-2", type: "tool_call", toolCallId: "tc-2", parents: ["u-1"] },
			{ id: "r-1", type: "tool_result", toolCallId: "tc-1", parents: ["c-1"] },
			{ id: "r-2", type: "tool_result", toolCallId: "tc-2", parents: ["c-2"] },
			{ id: "a-1", type: "message", text: "done both" },
		]);
		const groups = buildAtomicGroups(events);
		const batch = groups.find((g) => g.kind === "parallel_batch");
		expect(batch).toBeDefined();
		expect(batch!.eventIds).toEqual(["c-1", "c-2", "r-1", "r-2"]);
		expect(batch!.closed).toBe(true);
	});

	it("merges chained tool pairs into a tool loop", () => {
		const events = buildEvents([
			{ id: "u-1", type: "message" },
			{ id: "c-1", type: "tool_call", toolCallId: "tc-1", parents: ["u-1"] },
			{ id: "r-1", type: "tool_result", toolCallId: "tc-1", parents: ["c-1"] },
			{ id: "c-2", type: "tool_call", toolCallId: "tc-2", parents: ["r-1"] },
			{ id: "r-2", type: "tool_result", toolCallId: "tc-2", parents: ["c-2"] },
			{ id: "a-1", type: "message", text: "finished" },
		]);
		const groups = buildAtomicGroups(events);
		const loop = groups.find((g) => g.kind === "tool_loop");
		expect(loop).toBeDefined();
		expect(loop!.eventIds).toEqual(["c-1", "r-1", "c-2", "r-2"]);
		expect(loop!.closed).toBe(true);
	});

	it("groups events sharing a transaction id", () => {
		const events = buildEvents([
			{ id: "u-1", type: "message" },
			{ id: "t-1", type: "transaction_call", toolCallId: "tc-1", transactionId: "tx-1" },
			{ id: "t-2", type: "transaction_result", toolCallId: "tc-1", transactionId: "tx-1" },
			{ id: "t-3", type: "transaction_call", toolCallId: "tc-2", transactionId: "tx-1" },
			{ id: "t-4", type: "transaction_result", toolCallId: "tc-2", transactionId: "tx-1" },
		]);
		const groups = buildAtomicGroups(events);
		const tx = groups.find((g) => g.kind === "transaction");
		expect(tx).toBeDefined();
		expect(tx!.eventIds).toEqual(["t-1", "t-2", "t-3", "t-4"]);
	});

	it("marks a call without result as unclosed", () => {
		const events = buildEvents([
			{ id: "u-1", type: "message" },
			{ id: "c-1", type: "tool_call", toolCallId: "tc-1", parents: ["u-1"] },
		]);
		const groups = buildAtomicGroups(events);
		const pair = groups.find((g) => g.kind === "tool_pair");
		expect(pair).toBeDefined();
		expect(pair!.closed).toBe(false);
	});

	it("closes an abandoned tool batch at the next verified user turn", () => {
		const events = buildEvents([
			{ id: "u-1", type: "message", authority: "user" },
			{ id: "c-1", type: "tool_call", toolCallId: "tc-1", parents: ["u-1"] },
			{ id: "u-2", type: "message", authority: "user", text: "interrupt and continue" },
			{ id: "a-2", type: "message", text: "continued" },
		]);
		const groups = buildAtomicGroups(events);
		const abandoned = groups.find((group) => group.eventIds.includes("c-1"));
		expect(abandoned?.closed).toBe(true);
		expect(abandoned?.eventIds).not.toContain("u-2");
	});

	it("keeps ledger transitions between a tool call and result inside one contiguous atom", () => {
		const log = new InMemoryEventLog();
		for (const input of [
			{ eventId: "c-1", eventType: "tool_call" as const, toolCallId: "tc-1", payload: { name: "read" } },
			{ eventId: "l-1", eventType: "ledger" as const, toolCallId: "tc-1", payload: { to: "started" } },
			{ eventId: "r-1", eventType: "tool_result" as const, toolCallId: "tc-1", payload: { text: "done" } },
			{ eventId: "m-1", eventType: "message" as const, payload: { text: "continue" } },
		]) {
			log.append({ sessionId: "s-1", agentId: "a-1", authority, ...input });
		}

		const groups = buildAtomicGroups(log.all("s-1"));
		expect(groups[0].eventIds).toEqual(["c-1", "l-1", "r-1"]);
		for (let index = 1; index < groups.length; index++) {
			expect(groups[index - 1].toSeq).toBeLessThan(groups[index].fromSeq);
		}
		const manifest = planSafeCut(groups, groups[1].tokenEstimate);
		expect(manifest.compactedGroupIds).toContain(groups[0].groupId);
		expect(manifest.keptGroupIds).toContain(groups[1].groupId);
	});

	it("groups complete user turns and merges nested tool atoms into the turn", () => {
		const events = buildEvents([
			{ id: "u-1", type: "message", authority: "user", text: "first request" },
			{ id: "c-1", type: "tool_call", toolCallId: "tc-1", parents: ["u-1"] },
			{ id: "r-1", type: "tool_result", toolCallId: "tc-1", parents: ["c-1"] },
			{ id: "a-1", type: "message", text: "first answer" },
			{ id: "u-2", type: "message", authority: "user", text: "second request" },
			{ id: "a-2", type: "message", text: "second answer" },
		]);

		const groups = buildAtomicGroups(events);
		expect(groups.map((group) => group.kind)).toEqual(["turn", "turn"]);
		expect(groups[0].eventIds).toEqual(["u-1", "c-1", "r-1", "a-1"]);
		expect(groups[1].eventIds).toEqual(["u-2", "a-2"]);
		expect(groups[0].closed).toBe(true);
		expect(groups[1].closed).toBe(false);
	});

	it("closes the latest turn when the session projection contains an assistant completion", () => {
		const log = new InMemoryEventLog();
		log.append({
			sessionId: "s-1",
			agentId: "a-1",
			eventId: "u-1",
			eventType: "message",
			payload: { role: "user", text: "request" },
			authority: { kind: "user", id: "u-1", verified: true },
		});
		log.append({
			sessionId: "s-1",
			agentId: "a-1",
			eventId: "a-1",
			eventType: "message",
			payload: { role: "assistant", text: "done" },
			authority,
		});

		expect(buildAtomicGroups(log.all("s-1"))).toMatchObject([{ kind: "turn", closed: true }]);
	});

	it("spans a transaction across intervening untagged ledger events", () => {
		const log = new InMemoryEventLog();
		for (const input of [
			{
				eventId: "c-1",
				eventType: "tool_call" as const,
				toolCallId: "tc-1",
				transactionId: "tx-1",
				payload: { name: "write" },
			},
			{ eventId: "l-1", eventType: "ledger" as const, payload: { to: "started" } },
			{
				eventId: "r-1",
				eventType: "tool_result" as const,
				toolCallId: "tc-1",
				transactionId: "tx-1",
				payload: { text: "done" },
			},
		]) {
			log.append({ sessionId: "s-1", agentId: "a-1", authority, ...input });
		}

		const groups = buildAtomicGroups(log.all("s-1"));
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe("transaction");
		expect(groups[0].eventIds).toEqual(["c-1", "l-1", "r-1"]);
		expect(groups[0].closed).toBe(true);
	});

	it("recognizes edit/write followed by a bash validation as a patch-test atom", () => {
		const events = buildEvents([
			{ id: "c-1", type: "tool_call", toolCallId: "tc-1", toolName: "edit" },
			{ id: "r-1", type: "tool_result", toolCallId: "tc-1" },
			{ id: "c-2", type: "tool_call", toolCallId: "tc-2", text: "npm run check" },
			{ id: "r-2", type: "tool_result", toolCallId: "tc-2" },
		]);

		const groups = buildAtomicGroups(events);
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe("patch_test");
		expect(groups[0].eventIds).toEqual(["c-1", "r-1", "c-2", "r-2"]);
		expect(groups[0].closed).toBe(true);
	});

	it("keeps an observed patch-test atom open until the test result arrives", () => {
		const events = buildEvents([
			{ id: "c-1", type: "tool_call", toolCallId: "tc-1", toolName: "write" },
			{ id: "r-1", type: "tool_result", toolCallId: "tc-1" },
			{ id: "c-2", type: "tool_call", toolCallId: "tc-2", text: "./test.sh" },
		]);

		const groups = buildAtomicGroups(events);
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe("patch_test");
		expect(groups[0].closed).toBe(false);
		const manifest = planSafeCut(groups, 0);
		expect(manifest.keptGroupIds).toEqual([groups[0].groupId]);
	});

	it("does not infer a patch-test atom from test-like text inside another command", () => {
		const events = buildEvents([
			{ id: "c-1", type: "tool_call", toolCallId: "tc-1", toolName: "edit" },
			{ id: "r-1", type: "tool_result", toolCallId: "tc-1" },
			{ id: "c-2", type: "tool_call", toolCallId: "tc-2", text: "echo npm test" },
			{ id: "r-2", type: "tool_result", toolCallId: "tc-2" },
		]);

		const groups = buildAtomicGroups(events);
		expect(groups.some((group) => group.kind === "patch_test")).toBe(false);
	});
});

describe("planSafeCut", () => {
	function biggerEvents(): EventEnvelope[] {
		// 6 standalone messages then a parallel batch at the end.
		const specs: Spec[] = [];
		for (let i = 1; i <= 6; i++)
			specs.push({ id: `m-${i}`, type: "message", text: `message ${i} ${"y".repeat(200)}` });
		specs.push(
			{ id: "u-1", type: "message", text: "run two things" },
			{ id: "c-1", type: "tool_call", toolCallId: "tc-1", parents: ["u-1"], text: "a".repeat(400) },
			{ id: "c-2", type: "tool_call", toolCallId: "tc-2", parents: ["u-1"], text: "b".repeat(400) },
			{ id: "r-1", type: "tool_result", toolCallId: "tc-1", parents: ["c-1"], text: "r".repeat(400) },
			{ id: "r-2", type: "tool_result", toolCallId: "tc-2", parents: ["c-2"], text: "r".repeat(400) },
		);
		return buildEvents(specs);
	}

	it("never splits a parallel batch across the cut", () => {
		const events = biggerEvents();
		const groups = buildAtomicGroups(events);
		// Budget that would land mid-batch if groups were splittable.
		const manifest = planSafeCut(groups, 300);
		const batch = groups.find((g) => g.kind === "parallel_batch")!;
		if (manifest.keptGroupIds.includes(batch.groupId)) {
			expect(manifest.cutAfterSeq).toBeLessThan(batch.fromSeq);
		} else {
			expect(manifest.compactedGroupIds).toContain(batch.groupId);
			expect(manifest.cutAfterSeq).toBeGreaterThanOrEqual(batch.toSeq);
		}
	});

	it("never splits a transaction", () => {
		const events = buildEvents([
			{ id: "m-1", type: "message", text: "z".repeat(500) },
			{ id: "m-2", type: "message", text: "z".repeat(500) },
			{ id: "t-1", type: "transaction_call", toolCallId: "tc-1", transactionId: "tx-1", text: "a".repeat(300) },
			{ id: "t-2", type: "transaction_result", toolCallId: "tc-1", transactionId: "tx-1", text: "b".repeat(300) },
			{ id: "t-3", type: "transaction_call", toolCallId: "tc-2", transactionId: "tx-1", text: "c".repeat(300) },
			{ id: "t-4", type: "transaction_result", toolCallId: "tc-2", transactionId: "tx-1", text: "d".repeat(300) },
		]);
		const groups = buildAtomicGroups(events);
		const tx = groups.find((g) => g.kind === "transaction")!;
		// Budget small enough to cut inside the transaction if splits were allowed.
		const manifest = planSafeCut(groups, 200);
		if (manifest.keptGroupIds.includes(tx.groupId)) {
			expect(manifest.cutAfterSeq).toBeLessThan(tx.fromSeq);
		} else {
			expect(manifest.compactedGroupIds).toContain(tx.groupId);
			expect(manifest.cutAfterSeq).toBeGreaterThanOrEqual(tx.toSeq);
		}
	});

	it("never cuts inside a user turn", () => {
		const events = buildEvents([
			{ id: "u-1", type: "message", authority: "user", text: "z".repeat(500) },
			{ id: "a-1", type: "message", text: "z".repeat(500) },
			{ id: "u-2", type: "message", authority: "user", text: "short" },
			{ id: "a-2", type: "message", text: "short" },
		]);
		const groups = buildAtomicGroups(events);
		const manifest = planSafeCut(groups, groups[1].tokenEstimate);
		expect(manifest.compactedGroupIds).toEqual([groups[0].groupId]);
		expect(manifest.keptGroupIds).toEqual([groups[1].groupId]);
		expect(manifest.cutAfterSeq).toBe(groups[0].toSeq);
	});

	it("keeps an unclosed tool loop whole even when over budget", () => {
		const events = buildEvents([
			{ id: "m-1", type: "message", text: "z".repeat(300) },
			{ id: "c-1", type: "tool_call", toolCallId: "tc-1", parents: ["m-1"], text: "a".repeat(300) },
			{ id: "r-1", type: "tool_result", toolCallId: "tc-1", parents: ["c-1"], text: "b".repeat(300) },
			{ id: "c-2", type: "tool_call", toolCallId: "tc-2", parents: ["r-1"], text: "c".repeat(300) },
			// tc-2 has no result: loop is open.
		]);
		const groups = buildAtomicGroups(events);
		const manifest = planSafeCut(groups, 50);
		const loop = groups.find((g) => g.kind === "tool_loop")!;
		expect(loop.closed).toBe(false);
		expect(manifest.keptGroupIds).toContain(loop.groupId);
		expect(manifest.unclosedGroupIds).toContain(loop.groupId);
	});

	it("compacts an oversized closed newest group instead of violating the tail budget", () => {
		const events = buildEvents([
			{ id: "u-1", type: "message", authority: "user", text: "z".repeat(500) },
			{ id: "a-1", type: "message", text: "done" },
			{ id: "u-2", type: "message", authority: "user", text: "next" },
		]);
		const closedOnly = buildAtomicGroups(events).slice(0, 1);
		const manifest = planSafeCut(closedOnly, 1);
		expect(manifest.keptGroupIds).toEqual([]);
		expect(manifest.compactedGroupIds).toEqual([closedOnly[0].groupId]);
	});

	it("recent tail consists only of complete groups; everything kept when budget allows", () => {
		const events = biggerEvents();
		const groups = buildAtomicGroups(events);
		const manifest = planSafeCut(groups, 100000);
		expect(manifest.cutAfterSeq).toBe(0);
		expect(manifest.compactedGroupIds).toEqual([]);
		expect(manifest.keptGroupIds).toEqual(groups.map((g) => g.groupId));
	});

	it("produces a coverage manifest consistent with the cut", () => {
		const events = biggerEvents();
		const groups = buildAtomicGroups(events);
		const manifest = planSafeCut(groups, 400);
		const allIds = [...manifest.keptGroupIds, ...manifest.compactedGroupIds].sort();
		expect(allIds).toEqual(groups.map((g) => g.groupId).sort());
		// Every compacted group ends at or before cutAfterSeq; every kept group starts after it.
		for (const g of groups) {
			if (manifest.compactedGroupIds.includes(g.groupId)) {
				expect(g.toSeq).toBeLessThanOrEqual(manifest.cutAfterSeq);
			} else {
				expect(g.fromSeq).toBeGreaterThan(manifest.cutAfterSeq);
			}
		}
	});
});

describe("deterministic group ids (T-005)", () => {
	it("same event stream yields identical group ids across independent builds", async () => {
		const { buildAtomicGroups } = await import("../../src/core/compaction/subsystem/atomic-groups.ts");
		const makeEvents = () => [
			{
				sessionId: "s",
				agentId: "a",
				seq: 1,
				eventId: "e1",
				eventType: "message",
				payload: { text: "u" },
				contentHash: "h1",
				authority: { kind: "user" as const, id: "u", verified: true },
				timestamp: "t",
				schemaVersion: 1,
			},
			{
				sessionId: "s",
				agentId: "a",
				seq: 2,
				eventId: "e2",
				eventType: "tool_call",
				toolCallId: "tc1",
				payload: { name: "bash", arguments: {} },
				contentHash: "h2",
				authority: { kind: "user" as const, id: "u", verified: true },
				timestamp: "t",
				schemaVersion: 1,
			},
			{
				sessionId: "s",
				agentId: "a",
				seq: 3,
				eventId: "e3",
				eventType: "tool_result",
				toolCallId: "tc1",
				payload: { isError: false },
				contentHash: "h3",
				authority: { kind: "user" as const, id: "u", verified: true },
				timestamp: "t",
				schemaVersion: 1,
			},
		];
		const first = buildAtomicGroups(makeEvents() as never);
		const second = buildAtomicGroups(makeEvents() as never);
		expect(first.map((g) => g.groupId)).toEqual(second.map((g) => g.groupId));
	});
});
