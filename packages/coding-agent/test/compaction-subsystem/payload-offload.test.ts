import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "../../src/core/compaction/subsystem/artifact-store.ts";
import { InMemoryEventLog } from "../../src/core/compaction/subsystem/event-log.ts";
import {
	classifyPayload,
	offloadPayloads,
	projectOffloadedEvent,
} from "../../src/core/compaction/subsystem/payload-offload.ts";
import type { EventEnvelope } from "../../src/core/compaction/subsystem/types.ts";

const authority = { kind: "agent" as const, id: "a-1", verified: true };

interface Opts {
	big?: string;
	name?: string;
	id: string;
}

function makeLog(): { log: InMemoryEventLog; call: (o: Opts) => void; result: (o: Opts & { callId: string }) => void } {
	const log = new InMemoryEventLog();
	return {
		log,
		call: (o) => {
			log.append({
				sessionId: "s-1",
				agentId: "a-1",
				eventId: o.id,
				eventType: "tool_call",
				toolCallId: o.id,
				payload: { name: o.name ?? "bash", arguments: { command: "run" } },
				authority,
			});
		},
		result: (o) => {
			log.append({
				sessionId: "s-1",
				agentId: "a-1",
				eventId: o.id,
				eventType: "tool_result",
				toolCallId: o.callId,
				payload: { isError: false, content: o.big ?? "ok", exitCode: 0 },
				authority,
			});
		},
	};
}

describe("classifyPayload", () => {
	it("classifies approvals and contract events as must-keep-verbatim", () => {
		const log = new InMemoryEventLog();
		const approval = log.append({
			sessionId: "s-1",
			agentId: "a-1",
			eventId: "ap-1",
			eventType: "approval",
			toolCallId: "tc-1",
			payload: { approvedBy: userLike(), at: "t" },
			authority,
		});
		const contract = log.append({
			sessionId: "s-1",
			agentId: "a-1",
			eventId: "ct-1",
			eventType: "contract",
			payload: { contractId: "c-1", version: 1 },
			authority,
		});
		expect(classifyPayload(approval, defaultPolicy())).toBe("must_keep_verbatim");
		expect(classifyPayload(contract, defaultPolicy())).toBe("must_keep_verbatim");
	});

	it("classifies big tool results as offloadable, small as structured", () => {
		const log = new InMemoryEventLog();
		const big = log.append({
			sessionId: "s-1",
			agentId: "a-1",
			eventId: "r-1",
			eventType: "tool_result",
			toolCallId: "tc-1",
			payload: { isError: false, content: "x".repeat(9000) },
			authority,
		});
		const small = log.append({
			sessionId: "s-1",
			agentId: "a-1",
			eventId: "r-2",
			eventType: "tool_result",
			toolCallId: "tc-2",
			payload: { isError: false, content: "tiny" },
			authority,
		});
		const policy = defaultPolicy();
		expect(classifyPayload(big, policy)).toBe("offloadable");
		expect(classifyPayload(small, policy)).toBe("structured");
	});
});

function userLike() {
	return { kind: "user" as const, id: "user-1", verified: true };
}

function defaultPolicy() {
	return {
		maxInlineBytes: 2000,
		keepRecentToolResults: 0,
		toolExclusions: [] as string[],
		highRiskTools: [] as string[],
	};
}

describe("offloadPayloads", () => {
	it("offloads a big tool result: keeps call ID/status/exit code/preview/ref and stays recoverable", () => {
		const { log, call, result } = makeLog();
		call({ id: "tc-1", name: "bash" });
		const bigContent = `BUILD LOG ${"l".repeat(8000)}`;
		result({ id: "r-1", callId: "tc-1", big: bigContent });
		const store = new InMemoryArtifactStore();

		const outcome = offloadPayloads({
			events: log.all("s-1"),
			store,
			policy: defaultPolicy(),
			tenant: "t-1",
		});
		expect(outcome.records).toHaveLength(1);
		const record = outcome.records[0];
		expect(record.toolCallId).toBe("tc-1");
		expect(record.bytesOffloaded).toBeGreaterThan(8000);

		// Recovery: original bytes come back via the stable ref.
		const stored = store.get(record.artifactRef, "t-1");
		expect(new TextDecoder().decode(stored!.data)).toContain("BUILD LOG");

		// Projection keeps the working metadata.
		const event = log.all("s-1").find((e) => e.eventId === "r-1")!;
		const projected = projectOffloadedEvent(event, record);
		expect(projected.toolCallId).toBe("tc-1");
		expect(projected.status).toBe("succeeded");
		expect(projected.exitCode).toBe(0);
		expect(projected.preview.length).toBeLessThanOrEqual(200);
		expect(projected.ref).toBe(record.artifactRef);
	});

	it("never offloads approvals or high-risk/excluded tool results", () => {
		const { log, call, result } = makeLog();
		call({ id: "tc-1", name: "deploy" });
		result({ id: "r-1", callId: "tc-1", big: `DEPLOY OUTPUT ${"d".repeat(5000)}` });
		log.append({
			sessionId: "s-1",
			agentId: "a-1",
			eventId: "ap-1",
			eventType: "approval",
			toolCallId: "tc-1",
			payload: { approvedBy: userLike(), at: "t" },
			authority,
		});
		const store = new InMemoryArtifactStore();
		const outcome = offloadPayloads({
			events: log.all("s-1"),
			store,
			policy: { ...defaultPolicy(), highRiskTools: ["deploy"], toolExclusions: ["deploy"] },
			tenant: "t-1",
		});
		expect(outcome.records).toHaveLength(0);
		expect(outcome.skipped.map((s) => s.eventId).sort()).toEqual(["ap-1", "r-1", "tc-1"]);
	});

	it("keeps inline content when the object store fails", () => {
		const { log, call, result } = makeLog();
		call({ id: "tc-1" });
		result({ id: "r-1", callId: "tc-1", big: "y".repeat(5000) });
		const store = new InMemoryArtifactStore();
		store.put = () => {
			throw new Error("store unavailable");
		};
		const outcome = offloadPayloads({ events: log.all("s-1"), store, policy: defaultPolicy(), tenant: "t-1" });
		expect(outcome.records).toHaveLength(0);
		expect(outcome.failed.map((f) => f.eventId)).toEqual(["r-1"]);
		// Original event untouched.
		const event = log.all("s-1").find((e) => e.eventId === "r-1")!;
		expect(event.payload).toBeDefined();
	});

	it("is idempotent: re-running offload produces no new records", () => {
		const { log, call, result } = makeLog();
		call({ id: "tc-1" });
		result({ id: "r-1", callId: "tc-1", big: "z".repeat(5000) });
		const store = new InMemoryArtifactStore();
		const first = offloadPayloads({ events: log.all("s-1"), store, policy: defaultPolicy(), tenant: "t-1" });
		expect(first.records).toHaveLength(1);
		const second = offloadPayloads({
			events: log.all("s-1"),
			store,
			policy: defaultPolicy(),
			tenant: "t-1",
			priorRecords: first.records,
		});
		expect(second.records).toHaveLength(0);
		expect(second.alreadyOffloaded).toContain("r-1");
	});

	it("reverse token budget: the N most recent tool results stay inline", () => {
		const { log, call, result } = makeLog();
		for (let i = 1; i <= 4; i++) {
			call({ id: `tc-${i}` });
			result({ id: `r-${i}`, callId: `tc-${i}`, big: `LOG${i} ${"q".repeat(4000)}` });
		}
		const store = new InMemoryArtifactStore();
		const outcome = offloadPayloads({
			events: log.all("s-1"),
			store,
			policy: { ...defaultPolicy(), keepRecentToolResults: 2 },
			tenant: "t-1",
		});
		const offloadedIds = outcome.records.map((r) => r.eventId).sort();
		expect(offloadedIds).toEqual(["r-1", "r-2"]);
	});
});

describe("projectOffloadedEvent without record", () => {
	it("passes through events that were not offloaded", () => {
		const { log, call, result } = makeLog();
		call({ id: "tc-1" });
		result({ id: "r-1", callId: "tc-1" });
		const event: EventEnvelope = log.all("s-1").find((e) => e.eventId === "r-1")!;
		const projected = projectOffloadedEvent(event, undefined);
		expect(projected.toolCallId).toBe("tc-1");
		expect(projected.status).toBe("succeeded");
		expect(projected.ref).toBeUndefined();
	});
});
