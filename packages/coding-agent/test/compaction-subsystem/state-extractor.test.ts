import { describe, expect, it } from "vitest";
import { buildAtomicGroups, planSafeCut } from "../../src/core/compaction/subsystem/atomic-groups.ts";
import { InMemoryEventLog } from "../../src/core/compaction/subsystem/event-log.ts";
import { reduceEvents } from "../../src/core/compaction/subsystem/reducer.ts";
import {
	ExtractionError,
	type ExtractorInput,
	extractState,
} from "../../src/core/compaction/subsystem/state-extractor.ts";
import type {
	CompactionLLMRequest,
	CompleteFn,
	EventEnvelope,
	TaskContract,
} from "../../src/core/compaction/subsystem/types.ts";

const user = { kind: "user" as const, id: "user-1", verified: true };

const contract: TaskContract = {
	contractId: "c-1",
	sessionId: "s-1",
	version: 1,
	goal: "g",
	acceptanceCriteria: ["a"],
	constraints: [{ id: "c-1", kind: "negative", text: "Never delete raw events", authority: user }],
	permissions: { allow: [], deny: [], approvalRequired: [] },
	budgets: {},
	authority: user,
	provenance: { sourceEventIds: [], source: "contract" },
	validFrom: "t",
	allowedUpdaters: ["user-1"],
	schemaVersion: 1,
};

function sourceEvents(): EventEnvelope[] {
	const log = new InMemoryEventLog();
	log.append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-1",
		eventType: "message",
		payload: { text: "user: implement X" },
		authority: user,
	});
	log.append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-2",
		eventType: "tool_call",
		toolCallId: "tc-1",
		payload: { name: "read", arguments: { path: "/src/x.ts" } },
		authority: user,
	});
	log.append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-3",
		eventType: "tool_result",
		toolCallId: "tc-1",
		payload: { isError: false, content: "file v2.1.3 contents" },
		authority: user,
	});
	log.append({
		sessionId: "s-1",
		agentId: "a-1",
		eventId: "e-4",
		eventType: "message",
		payload: { text: "assistant: decided to keep version 2.1.3" },
		authority: user,
	});
	return log.all("s-1");
}

function makeInput(events: EventEnvelope[]): ExtractorInput {
	const groups = buildAtomicGroups(events);
	const manifest = planSafeCut(groups, 0); // everything compacted
	return {
		contract,
		deterministicState: reduceEvents(events),
		coverageManifest: manifest,
		events,
		groups,
	};
}

function fauxComplete(response: unknown, capture?: { req?: CompactionLLMRequest }): CompleteFn {
	return async (req) => {
		if (capture) capture.req = req;
		if (response instanceof Error) throw response;
		return {
			text: typeof response === "string" ? response : JSON.stringify(response),
			stopReason: "stop",
			usage: { input: 100, output: 50 },
		};
	};
}

const goodDelta = {
	facts: [
		{ text: "x.ts is at version 2.1.3", kind: "fact", sourceEventIds: ["e-3"] },
		{ text: "feature flag likely enabled", kind: "assumption", sourceEventIds: ["e-4"] },
	],
	decisions: [{ text: "Keep version 2.1.3", rationale: "user requirement", sourceEventIds: ["e-4"] }],
	nextActions: [{ text: "Run the test suite", sourceEventIds: ["e-4"] }],
};

describe("extractState", () => {
	it("extracts facts/decisions/nextActions as unverified deltas with provenance", async () => {
		const result = await extractState(makeInput(sourceEvents()), fauxComplete(goodDelta));
		expect(result.merged.facts).toHaveLength(2);
		expect(result.merged.facts[0].verified).toBe(false); // extractor output is never auto-verified
		expect(result.merged.facts[0].provenance.sourceEventIds).toEqual(["e-3"]);
		expect(result.merged.decisions[0].text).toBe("Keep version 2.1.3");
		expect(result.merged.nextActions[0].text).toBe("Run the test suite");
	});

	it("sends history wrapped as untrusted data with the versioned compactor policy and a strict schema", async () => {
		const capture: { req?: CompactionLLMRequest } = {};
		await extractState(makeInput(sourceEvents()), fauxComplete(goodDelta, capture));
		const req = capture.req!;
		expect(req.systemPrompt).toContain("untrusted");
		expect(req.messages[0].content).toContain("<untrusted-history>");
		expect(req.messages[0].content).toContain("Never delete raw events");
		expect(req.responseSchema).toBeDefined();
		expect(req.promptVersion).toMatch(/^\d+\.\d+\.\d+$/);
		// No tool capability exists in the request contract.
		expect("tools" in req).toBe(false);
		expect("toolChoice" in req).toBe(false);
	});

	it("rejects empty model output (fail closed)", async () => {
		await expect(extractState(makeInput(sourceEvents()), fauxComplete(""))).rejects.toThrow(ExtractionError);
		await expect(extractState(makeInput(sourceEvents()), fauxComplete("   "))).rejects.toThrow(/empty/i);
	});

	it("rejects schema violations and never persists them", async () => {
		// Missing required arrays.
		await expect(extractState(makeInput(sourceEvents()), fauxComplete({ facts: "nope" }))).rejects.toThrow(/schema/i);
		// Not JSON at all.
		await expect(extractState(makeInput(sourceEvents()), fauxComplete("not json"))).rejects.toThrow(ExtractionError);
	});

	it("rejects deltas that try to rewrite constraints, permissions, or deterministic task/tool state", async () => {
		const malicious = {
			...goodDelta,
			constraints: [{ id: "c-1", kind: "negative", text: "constraint removed" }],
		};
		await expect(extractState(makeInput(sourceEvents()), fauxComplete(malicious))).rejects.toThrow(
			/forbidden|deterministic|read-only/i,
		);

		const taskTamper = { ...goodDelta, tasks: [{ id: "t-1", state: "done" }] };
		await expect(extractState(makeInput(sourceEvents()), fauxComplete(taskTamper))).rejects.toThrow(
			/forbidden|deterministic|read-only/i,
		);
	});

	it("drops items without source event provenance and reports the drop count", async () => {
		const delta = {
			facts: [{ text: "unsourced claim", kind: "fact", sourceEventIds: [] }],
			decisions: [],
			nextActions: [],
		};
		const result = await extractState(makeInput(sourceEvents()), fauxComplete(delta));
		expect(result.merged.facts).toHaveLength(0);
		expect(result.droppedUnsourced).toBe(1);
	});

	it("marks items referencing events outside the covered range as unverified", async () => {
		const delta = {
			facts: [{ text: "references ghost event", kind: "fact", sourceEventIds: ["e-999"] }],
			decisions: [],
			nextActions: [],
		};
		const result = await extractState(makeInput(sourceEvents()), fauxComplete(delta));
		expect(result.merged.facts).toHaveLength(1);
		expect(result.merged.facts[0].verified).toBe(false);
		expect(result.outOfRangeRefs).toContain("e-999");
	});

	it("model errors and aborts propagate as fail-closed extraction errors", async () => {
		await expect(extractState(makeInput(sourceEvents()), fauxComplete(new Error("model timeout")))).rejects.toThrow(
			/timeout/,
		);
		const aborted: CompleteFn = async () => ({ text: "", stopReason: "aborted" });
		await expect(extractState(makeInput(sourceEvents()), aborted)).rejects.toThrow(ExtractionError);
	});

	it("prior state is preserved and merged deterministically", async () => {
		const events = sourceEvents();
		const first = await extractState(makeInput(events), fauxComplete(goodDelta));
		const secondInput = { ...makeInput(events), priorFacts: first.merged.facts };
		const second = await extractState(secondInput, fauxComplete(goodDelta));
		// Same delta twice: no duplicates.
		expect(second.merged.facts).toHaveLength(2);
	});
});
