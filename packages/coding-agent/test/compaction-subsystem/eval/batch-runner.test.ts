import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompleteFn } from "../../../src/core/compaction/subsystem/types.ts";
import type { EvalFixture } from "./atoms.ts";
import { runCorpus, withCache } from "./batch-runner.ts";

function tinyFixture(name: string, bigLines: number): EvalFixture {
	return {
		name,
		contract: { goal: `goal ${name}`, constraints: ["Never delete raw events"] },
		compactionRounds: 2,
		events: [
			{ eventType: "message", id: `${name}-u`, payload: { text: `user: do ${name}` } },
			{
				eventType: "tool_call",
				id: `${name}-c`,
				toolCallId: `tc-${name}`,
				payload: { name: "bash", arguments: { command: "run" } },
			},
			{
				eventType: "tool_result",
				id: `${name}-r`,
				toolCallId: `tc-${name}`,
				payload: { isError: false, content: `RESULT ${name}\n${"log\n".repeat(bigLines)}`, exitCode: 0 },
			},
			{
				eventType: "state_change",
				id: `${name}-t`,
				payload: { kind: "task_update", taskId: `t-${name}`, title: `work ${name}`, state: "in_progress" },
			},
		],
		atoms: [
			{ id: "C-1", kind: "C", text: "Never delete raw events" },
			{ id: "T-1", kind: "T", text: "tool ran", toolCallId: `tc-${name}`, expectToolState: "succeeded" },
		],
		needleQueries: [{ id: "N-1", mustFind: `RESULT ${name}` }],
	};
}

function countingComplete(
	counter: { calls: number },
	failOn?: (req: Parameters<CompleteFn>[0]) => boolean,
): CompleteFn {
	return async (req) => {
		counter.calls += 1;
		if (failOn?.(req)) throw new Error("model exploded");
		return {
			text: req.responseSchema ? JSON.stringify({ facts: [], decisions: [], nextActions: [] }) : "narrative",
			stopReason: "stop",
			usage: { input: 10, output: 10 },
		};
	};
}

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "corpus-"));
	dirs.push(d);
	return d;
}

describe("withCache", () => {
	it("serves identical requests from cache (model called once), persisted across instances", async () => {
		const dir = tmp();
		const counter = { calls: 0 };
		const cached = withCache(countingComplete(counter), { cacheDir: dir, modelId: "m-1" });
		const req = {
			systemPrompt: "s",
			messages: [{ role: "user" as const, content: "hello" }],
			maxTokens: 100,
			promptVersion: "1.0.0",
		};
		const r1 = await cached(req);
		expect(counter.calls).toBe(1);
		const cached2 = withCache(countingComplete(counter), { cacheDir: dir, modelId: "m-1" });
		const r2 = await cached2(req);
		expect(counter.calls).toBe(1); // served from disk cache
		expect(r2.text).toBe(r1.text);
	});

	it("cache keys differ by model, prompt version, and content", async () => {
		const dir = tmp();
		const counter = { calls: 0 };
		const a = withCache(countingComplete(counter), { cacheDir: dir, modelId: "m-1" });
		const b = withCache(countingComplete(counter), { cacheDir: dir, modelId: "m-2" });
		const req = {
			systemPrompt: "s",
			messages: [{ role: "user" as const, content: "x" }],
			maxTokens: 100,
			promptVersion: "1.0.0",
		};
		await a(req);
		await b(req);
		await withCache(countingComplete(counter), { cacheDir: dir, modelId: "m-1" })({
			...req,
			promptVersion: "2.0.0",
		});
		expect(counter.calls).toBe(3);
	});
});

describe("runCorpus", () => {
	it("aggregates per-cell reports with median token gain and per-kind retention", async () => {
		const counter = { calls: 0 };
		const report = await runCorpus([tinyFixture("a", 500), tinyFixture("b", 700)], countingComplete(counter), {
			roundsSchedule: [2],
			reps: 2,
			label: "faux",
		});
		expect(report.cells).toHaveLength(4); // 2 fixtures × 1 round × 2 reps
		expect(report.cells.every((c) => c.overallRetention === 1)).toBe(true);
		expect(report.retentionByKind.C).toBe(1);
		expect(report.retentionByKind.T).toBe(1);
		expect(report.medianTokenGainPct).not.toBeNull();
		expect(report.medianTokenGainPct!).toBeGreaterThan(0);
		expect(report.failures).toEqual([]);
	});

	it("isolates cell failures without aborting the corpus", async () => {
		const counter = { calls: 0 };
		// Corrupt fixture: duplicate event id makes runEval throw during append.
		const bad = tinyFixture("bad", 500);
		bad.events = [...bad.events, { ...bad.events[0], payload: { text: "dup" } }];
		const report = await runCorpus([tinyFixture("a", 500), bad, tinyFixture("b", 700)], countingComplete(counter), {
			roundsSchedule: [2],
			reps: 1,
		});
		expect(report.cells.length).toBe(2); // a and b completed
		expect(report.failures).toHaveLength(1);
		expect(report.failures[0]).toContain("bad@2r#1");
	});

	it("runs serially (concurrency 1) and honors pacing", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const serial: CompleteFn = async (req) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight -= 1;
			return {
				text: req.responseSchema ? JSON.stringify({ facts: [], decisions: [], nextActions: [] }) : "n",
				stopReason: "stop",
			};
		};
		await runCorpus([tinyFixture("a", 300), tinyFixture("b", 300)], serial, {
			roundsSchedule: [1],
			reps: 1,
			pacingMs: 2,
		});
		expect(maxInFlight).toBe(1);
	});
});
