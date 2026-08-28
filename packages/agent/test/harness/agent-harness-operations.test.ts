import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createModels,
	fauxProvider,
	type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness, type AgentHarnessOptions, HarnessFault } from "../../src/harness/agent-harness.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";
import type { StreamFn } from "../../src/types.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api" as AssistantMessage["api"],
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function staticStreamFn(text: string): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		stream.end(assistantMessage(text));
		return stream;
	};
}

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

function createFauxModels() {
	const faux = fauxProvider({
		provider: "faux-ops",
		models: [{ id: "faux-summary", reasoning: false, contextWindow: 200000, maxTokens: 8192 }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models, model: faux.getModel() };
}

async function createHarness(session: Session, overrides: Partial<AgentHarnessOptions> = {}) {
	const { models, model } = createFauxModels();
	return AgentHarness.create({ models, model, streamFn: staticStreamFn("answer"), ...overrides, session });
}

describe("AgentHarness operations (slice 3)", () => {
	it("compact persists a durable compaction operation with a summary entry", async () => {
		const session = createSession();
		const { faux, models, model } = createFauxModels();
		const { harness } = await AgentHarness.create({ session, models, model, streamFn: staticStreamFn("answer") });
		const run = await harness.prompt("hello compaction");
		expect(run.ok).toBe(true);

		faux.setResponses([assistantMessage("## Goal\ncompacted history")]);
		const result = await harness.compact();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("completed");
		if (result.value.kind !== "completed") return;
		expect(result.value.entry.summary).toContain("compacted history");
		expect(result.value.entry.retainedTail.length).toBeGreaterThan(0);

		const records = (await session.findRecords({ lane: "main" })).reverse();
		const types = records.map((record) =>
			record.type === "step_attempt" ? `${record.type}:${record.step}` : record.type,
		);
		expect(types).toContain("step_attempt:compaction");
		expect(records.at(-1)).toMatchObject({ type: "operation_finished", outcome: "completed" });
		// The compaction entry is on the branch and becomes the new leaf.
		expect(await harness.getLeafId()).toBe(result.value.entry.id);
	});

	it("compact on an empty session declines without writing entries", async () => {
		const session = createSession();
		const { harness } = await createHarness(session);
		const result = await harness.compact();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("declined");
		expect(await session.findEntries()).toHaveLength(0);
	});

	it("resume completes a compaction that crashed during summarization", async () => {
		const session = createSession();
		const { faux, models, model } = createFauxModels();
		const first = await AgentHarness.create({ session, models, model, streamFn: staticStreamFn("answer") });
		await first.harness.prompt("work to compact");

		// First summarization attempt crashes the process (fault propagates, no result entry).
		const original = models.completeSimple.bind(models);
		let crash = true;
		models.completeSimple = async (...args: Parameters<typeof original>) => {
			if (crash) {
				crash = false;
				throw new HarnessFault("simulated crash during summarization", undefined);
			}
			return original(...args);
		};
		await expect(first.harness.compact()).rejects.toBeInstanceOf(HarnessFault);

		faux.setResponses([assistantMessage("## Goal\nrecovered summary")]);
		const recovered = await AgentHarness.create({ session, models, model, streamFn: staticStreamFn("answer") });
		expect(recovered.suspended[0]).toMatchObject({ kind: "compaction", reason: "crash" });
		const resumed = await recovered.harness.resume();
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumed.value.operation).toBe("compaction");
		expect(resumed.value.kind).toBe("completed");

		const records = (await session.findRecords({ lane: "main" })).reverse();
		const attempts = records.filter((record) => record.type === "step_attempt" && record.step === "compaction");
		expect(attempts).toHaveLength(2);
		if (attempts[0]?.type === "step_attempt" && attempts[1]?.type === "step_attempt") {
			expect(attempts[1].attempt).toBe(2);
			expect(attempts[0].resultEntryId).toBe(attempts[1].resultEntryId);
		}
		const compactions = (await session.findEntries({ order: "oldestFirst" })).filter(
			(entry) => entry.type === "compaction",
		);
		expect(compactions).toHaveLength(1);
	});

	it("navigateTree summarizes the abandoned branch, moves the lane, and sets a label", async () => {
		const session = createSession();
		const { faux, models, model } = createFauxModels();
		const { harness } = await AgentHarness.create({ session, models, model, streamFn: staticStreamFn("answer") });
		await harness.prompt("first branch point");
		const entries = await session.findEntries({ order: "oldestFirst" });
		const firstUser = entries[0]!;
		await harness.prompt("second branch work");
		const oldLeaf = await harness.getLeafId();

		faux.setResponses([assistantMessage("summary of abandoned work")]);
		const result = await harness.navigateTree(firstUser.id, { summarize: true, label: "checkpoint" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("completed");
		if (result.value.kind !== "completed") return;
		expect(result.value.newLeafId).toBe(firstUser.id);
		expect(result.value.summaryEntry?.summary).toContain("summary of abandoned work");
		expect(result.value.summaryEntry?.fromId).toBe(oldLeaf);

		expect(await harness.getLeafId()).toBe(firstUser.id);
		expect(await session.getLabel(firstUser.id)).toBe("checkpoint");
		const records = (await session.findRecords({ lane: "main" })).reverse();
		expect(records.some((record) => record.type === "step_attempt" && record.step === "branch_summary")).toBe(true);
	});

	it("navigateTree without summarize just moves the lane; unknown targets are rejected", async () => {
		const session = createSession();
		const { harness } = await createHarness(session);
		await harness.prompt("entry one");
		const firstUser = (await session.findEntries({ order: "oldestFirst" }))[0]!;
		await harness.prompt("entry two");

		const unknown = await harness.navigateTree("missing-entry");
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error._tag).toBe("UnknownTarget");

		const result = await harness.navigateTree(firstUser.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.kind).toBe("completed");
		if (result.value.kind !== "completed") return;
		expect(result.value.newLeafId).toBe(firstUser.id);
		expect(result.value.summaryEntry).toBeUndefined();
		expect(await harness.getLeafId()).toBe(firstUser.id);
	});

	it("skill and promptFromTemplate expand and run through prompt", async () => {
		const session = createSession();
		const { harness } = await createHarness(session, {
			resources: {
				skills: [
					{ name: "review", description: "d", content: "REVIEW SKILL BODY", filePath: "/tmp/review/SKILL.md" },
				],
				promptTemplates: [{ name: "greet", content: "Hello $1" }],
			},
		});
		const skilled = await harness.skill("review", "focus on tests");
		expect(skilled.ok).toBe(true);
		let entries = await session.findEntries({ order: "oldestFirst" });
		expect(JSON.stringify(entries)).toContain("REVIEW SKILL BODY");
		expect(JSON.stringify(entries)).toContain("focus on tests");

		const templated = await harness.promptFromTemplate("greet", ["world"]);
		expect(templated.ok).toBe(true);
		entries = await session.findEntries({ order: "oldestFirst" });
		expect(JSON.stringify(entries)).toContain("Hello world");

		const unknownSkill = await harness.skill("missing");
		expect(unknownSkill.ok).toBe(false);
		if (!unknownSkill.ok) expect(unknownSkill.error._tag).toBe("UnknownSkill");
		const unknownTemplate = await harness.promptFromTemplate("missing");
		expect(unknownTemplate.ok).toBe(false);
		if (!unknownTemplate.ok) expect(unknownTemplate.error._tag).toBe("UnknownTemplate");
	});

	it("watch delivers a snapshot and run lifecycle events", async () => {
		const session = createSession();
		const { harness } = await createHarness(session);
		const handle = await harness.watch();
		expect(handle.snapshot.lane).toBe("main");
		expect(handle.snapshot.operation).toBeNull();
		const events: string[] = [];
		handle.start((event) => {
			events.push((event as { type: string }).type);
		});
		await harness.prompt("watched");
		expect(events).toEqual(["run_start", "run_end"]);
		handle.unsubscribe();
	});

	it("lanes and watchSession report the main lane", async () => {
		const session = createSession();
		const { harness } = await createHarness(session);
		const lanes = await harness.lanes();
		expect(lanes).toEqual([{ name: "main", leafId: null, operation: null }]);
		const handle = await harness.watchSession();
		expect(handle.snapshot.lanes).toHaveLength(1);
		expect(handle.snapshot.faulted).toBe(false);
		handle.unsubscribe();
	});

	it("runWhenIdle executes the callback after the lane settles", async () => {
		const session = createSession();
		const { harness } = await createHarness(session);
		let called = false;
		await harness.runWhenIdle(() => {
			called = true;
		});
		expect(called).toBe(true);
	});
});
