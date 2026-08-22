import { describe, expect, it } from "vitest";
import { InMemoryEventLog } from "../../src/core/compaction/subsystem/event-log.ts";
import { ReducerError, reduceEvents } from "../../src/core/compaction/subsystem/reducer.ts";
import type { EventEnvelope } from "../../src/core/compaction/subsystem/types.ts";

const authority = { kind: "agent" as const, id: "agent-1", verified: true };

function makeEvents(): EventEnvelope[] {
	const log = new InMemoryEventLog();
	const append = (partial: Parameters<typeof log.append>[0]) => log.append(partial);
	append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-1",
		eventType: "contract",
		payload: { contractId: "c-1", version: 2 },
		authority,
	});
	append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-2",
		eventType: "state_change",
		payload: { kind: "task_update", taskId: "t-1", title: "Implement store", state: "pending" },
		authority,
	});
	append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-3",
		eventType: "state_change",
		payload: { kind: "task_update", taskId: "t-1", state: "in_progress" },
		authority,
		causalParentIds: ["e-2"],
	});
	append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-4",
		eventType: "tool_call",
		toolCallId: "tc-1",
		payload: { name: "write", arguments: { path: "/tmp/a.ts", content: "x" } },
		authority,
		causalParentIds: ["e-3"],
	});
	append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-5",
		eventType: "tool_result",
		toolCallId: "tc-1",
		payload: { isError: false, content: "ok", exitCode: 0 },
		authority,
		causalParentIds: ["e-4"],
	});
	append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-6",
		eventType: "tool_call",
		toolCallId: "tc-2",
		payload: { name: "bash", arguments: { command: "npm publish" } },
		authority,
	});
	append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-7",
		eventType: "tool_result",
		toolCallId: "tc-2",
		payload: { isError: true, content: "network timeout" },
		authority,
		causalParentIds: ["e-6"],
	});
	append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-8",
		eventType: "artifact",
		payload: {
			ref: `artifact://sha256/${"a".repeat(64)}`,
			kind: "tool_result",
			size: 5000,
			preview: "log...",
			pinned: true,
		},
		authority,
	});
	append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-9",
		eventType: "state_change",
		payload: { kind: "task_update", taskId: "t-1", state: "done" },
		authority,
		causalParentIds: ["e-5"],
	});
	return log.all("s-1");
}

describe("reduceEvents", () => {
	it("derives deterministic state with provenance from events", () => {
		const state = reduceEvents(makeEvents());
		expect(state.contractRef).toEqual({ contractId: "c-1", version: 2 });
		expect(state.tasks).toHaveLength(1);
		expect(state.tasks[0].state).toBe("done");
		expect(state.tasks[0].provenance.sourceEventIds).toContain("e-9");
		expect(state.tools).toHaveLength(2);
		const tc1 = state.tools.find((t) => t.toolCallId === "tc-1")!;
		expect(tc1.state).toBe("succeeded");
		expect(tc1.exitCode).toBe(0);
		const tc2 = state.tools.find((t) => t.toolCallId === "tc-2")!;
		expect(tc2.state).toBe("failed");
		// Failed tool result surfaces as an unresolved error.
		expect(state.errors.some((e) => e.toolCallId === "tc-2" && !e.resolved)).toBe(true);
		expect(state.artifacts).toHaveLength(1);
		expect(state.artifacts[0].pinned).toBe(true);
		expect(state.lastEventSeq).toBe(9);
	});

	it("incremental reduce equals full replay", () => {
		const events = makeEvents();
		const full = reduceEvents(events);
		const first3 = reduceEvents(events.slice(0, 3));
		const incremental = reduceEvents(events.slice(3), first3);
		expect(incremental).toEqual(full);
	});

	it("rejects out-of-order or gapped event sequences explicitly", () => {
		const events = makeEvents();
		const shuffled = [...events];
		[shuffled[3], shuffled[4]] = [shuffled[4], shuffled[3]];
		expect(() => reduceEvents(shuffled)).toThrow(ReducerError);
		// Gap when continuing from a prior state.
		const prior = reduceEvents(events.slice(0, 3));
		expect(() => reduceEvents(events.slice(4), prior)).toThrow(/gap|seq|missing/i);
	});

	it("rejects duplicate event ids", () => {
		const events = makeEvents();
		const dup = { ...events[1], seq: events.length + 1 };
		expect(() => reduceEvents([...events, dup])).toThrow(/duplicate/i);
	});

	it("rejects orphan tool results (no matching call)", () => {
		const log = new InMemoryEventLog();
		log.append({
			sessionId: "s-2",
			agentId: "a-1",
			eventId: "x-1",
			eventType: "tool_result",
			toolCallId: "tc-ghost",
			payload: { isError: false, content: "phantom" },
			authority,
		});
		expect(() => reduceEvents(log.all("s-2"))).toThrow(/orphan|no matching/i);
	});

	it("never marks a task done without an explicit event; unknown when evidence missing", () => {
		const log = new InMemoryEventLog();
		log.append({
			sessionId: "s-3",
			agentId: "a-1",
			eventId: "y-1",
			eventType: "tool_call",
			toolCallId: "tc-1",
			payload: { name: "bash", arguments: { command: "deploy" } },
			authority,
		});
		const state = reduceEvents(log.all("s-3"));
		const tool = state.tools.find((t) => t.toolCallId === "tc-1")!;
		// Call without result: no evidence → started, not succeeded.
		expect(tool.state).toBe("started");
		expect(state.tasks).toHaveLength(0);
	});

	it("extracts tool info from session-adapter shaped payloads too", () => {
		const log = new InMemoryEventLog();
		log.append({
			sessionId: "s-4",
			agentId: "a-1",
			eventId: "z-1",
			eventType: "tool_call",
			toolCallId: "tc-9",
			payload: {
				type: "message",
				id: "m-2",
				parentId: "m-1",
				timestamp: "t",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-9", name: "read", arguments: { path: "/b" } }],
				},
			},
			authority,
		});
		log.append({
			sessionId: "s-4",
			agentId: "a-1",
			eventId: "z-2",
			eventType: "tool_result",
			toolCallId: "tc-9",
			payload: {
				type: "message",
				id: "m-3",
				parentId: "m-2",
				timestamp: "t",
				message: {
					role: "toolResult",
					toolCallId: "tc-9",
					toolName: "read",
					content: [{ type: "text", text: "data" }],
					isError: false,
				},
			},
			authority,
		});
		const state = reduceEvents(log.all("s-4"));
		const tool = state.tools.find((t) => t.toolCallId === "tc-9")!;
		expect(tool.name).toBe("read");
		expect(tool.state).toBe("succeeded");
	});
});
