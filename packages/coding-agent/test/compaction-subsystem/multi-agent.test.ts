import { describe, expect, it } from "vitest";
import { InMemoryEventLog } from "../../src/core/compaction/subsystem/event-log.ts";
import {
	agentView,
	buildHandoffCapsule,
	parseHandoffCapsule,
	SharedRegistry,
	SideEffectRegistry,
} from "../../src/core/compaction/subsystem/multi-agent.ts";

const a1 = { kind: "agent" as const, id: "agent-a", verified: true };
const a2 = { kind: "agent" as const, id: "agent-b", verified: true };

describe("agentView", () => {
	it("projects a shared log into a per-agent view with causal context intact", () => {
		const log = new InMemoryEventLog();
		log.append({
			sessionId: "s-1",
			agentId: "agent-a",
			eventId: "e-1",
			eventType: "message",
			payload: { text: "from a" },
			authority: a1,
		});
		log.append({
			sessionId: "s-1",
			agentId: "agent-b",
			eventId: "e-2",
			eventType: "message",
			payload: { text: "from b" },
			authority: a2,
			causalParentIds: ["e-1"],
		});
		log.append({
			sessionId: "s-1",
			agentId: "agent-a",
			eventId: "e-3",
			eventType: "message",
			payload: { text: "a again" },
			authority: a1,
			causalParentIds: ["e-2"],
		});
		const view = agentView(log.all("s-1"), "agent-a");
		expect(view.map((e) => e.eventId)).toEqual(["e-1", "e-3"]);
		// Causal parent ids are preserved even when the parent belongs to another agent.
		expect(view[1].causalParentIds).toEqual(["e-2"]);
	});
});

describe("SharedRegistry (field-level conflict detection)", () => {
	it("accepts a first registration and a fast-forward update", () => {
		const reg = new SharedRegistry<{ status: string }>();
		const v1 = reg.register("task", "t-1", { status: "open" }, "agent-a");
		const updated = reg.update("task", "t-1", { status: "done" }, "agent-a", v1);
		expect(updated.ok).toBe(true);
		expect(reg.get("task", "t-1")?.fields.status).toBe("done");
	});

	it("never silently last-write-wins: concurrent field divergence is a conflict", () => {
		const reg = new SharedRegistry<{ status: string; note: string }>();
		const v1 = reg.register("decision", "d-1", { status: "proposed", note: "initial" }, "agent-a");
		// Two agents read v1; both write different values for the same field.
		reg.update("decision", "d-1", { note: "from A" }, "agent-a", v1);
		const result = reg.update("decision", "d-1", { note: "from B" }, "agent-b", v1);
		expect(result.ok).toBe(false);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts![0].field).toBe("note");
		// The stored value is A's (first writer); B's write did NOT overwrite silently.
		expect(reg.get("decision", "d-1")?.fields.note).toBe("from A");
		// B's conflicting value is recorded for review.
		expect(reg.conflicts()).toHaveLength(1);
	});

	it("allows disjoint field updates from different agents (no false conflict)", () => {
		const reg = new SharedRegistry<{ status?: string; note?: string }>();
		const v1 = reg.register("task", "t-1", { status: "open", note: "x" }, "agent-a");
		const r1 = reg.update("task", "t-1", { status: "in_progress" }, "agent-a", v1);
		// B read the version that already includes A's status change.
		const r2 = reg.update("task", "t-1", { note: "reviewed" }, "agent-b", reg.get("task", "t-1")!.version);
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		expect(reg.get("task", "t-1")?.fields).toEqual({ status: "in_progress", note: "reviewed" });
	});
});

describe("SideEffectRegistry (cross-agent idempotency)", () => {
	it("detects duplicate side effects across agents by idempotency key", () => {
		const reg = new SideEffectRegistry();
		expect(reg.register("key-1", "agent-a", "tc-1").duplicate).toBe(false);
		const dup = reg.register("key-1", "agent-b", "tc-9");
		expect(dup.duplicate).toBe(true);
		expect(dup.existing?.agentId).toBe("agent-a");
	});

	it("distinct keys do not collide", () => {
		const reg = new SideEffectRegistry();
		reg.register("key-1", "agent-a", "tc-1");
		expect(reg.register("key-2", "agent-b", "tc-2").duplicate).toBe(false);
	});
});

describe("HandoffCapsule", () => {
	it("round-trips a structured handoff between agents", () => {
		const capsule = buildHandoffCapsule({
			fromAgent: "agent-a",
			toAgent: "agent-b",
			goal: "finish the migration",
			openTasks: [{ id: "t-2", title: "wire tests", state: "in_progress" }],
			decisionRefs: ["d-1"],
			constraintRefs: ["c-1"],
			recallRefs: ["rc-1"],
			note: "watch the ledger",
		});
		const text = JSON.stringify(capsule);
		const parsed = parseHandoffCapsule(text);
		expect(parsed.fromAgent).toBe("agent-a");
		expect(parsed.toAgent).toBe("agent-b");
		expect(parsed.openTasks[0].id).toBe("t-2");
		expect(parsed.recallRefs).toEqual(["rc-1"]);
	});
});
