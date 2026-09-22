import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSnapshot, localDayKey, usageCacheHitRate } from "../src/core/stats/aggregate.ts";
import { isTempPath, scanSessions } from "../src/core/stats/scan.ts";
import type { ScanResult, StatsSnapshot } from "../src/core/stats/types.ts";

/**
 * Fixture corpus (one directory per "project", mirroring the real layout):
 *   A  real session, five usage-bearing entries across two calendar days
 *   B  session in a temporary cwd                     -> excluded (temp-cwd)
 *   C  session whose only provider is `faux`           -> excluded (faux-provider)
 *   D  forked session (inherited entry must be skipped, own entry counted)
 *   E  file whose header is not a v3 session           -> skipped
 *   F  valid session with one malformed line           -> line counted as parse error
 *   G  valid session without usage                     -> no records, not in session rows
 */

const PROJECT_CWD = "/Users/w/Projects/easy-pi";
const OTHER_CWD = "/Users/w/Projects/other";
const TEMP_CWD = join(tmpdir(), "epi-stats-fixture-temp");

const DAY_ONE_A = "2026-09-19T10:00:05.000Z";
const DAY_ONE_B = "2026-09-19T10:00:06.000Z";
const DAY_ONE_F = "2026-09-19T10:30:00.000Z";
const DAY_TWO_A2 = "2026-09-22T09:00:00.000Z";
const DAY_TWO_COMPACTION = "2026-09-22T09:10:00.000Z";
const DAY_TWO_BRANCH = "2026-09-22T09:20:00.000Z";
const DAY_TWO_FORK_HEADER = "2026-09-22T08:00:00.000Z";
const DAY_TWO_FORK_INHERITED = "2026-09-22T07:00:00.000Z";
const DAY_TWO_FORK_OWN = "2026-09-22T09:00:00.000Z";

/** Independent reimplementation of the local calendar day, used to build expectations. */
function dayOf(isoOrMs: string | number): string {
	const date = new Date(isoOrMs);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function usage(
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	totalTokens: number,
	cost: number,
) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function sessionHeader(options: { id: string; timestamp: string; cwd: string; parentSession?: string }) {
	return {
		type: "session",
		version: 3,
		id: options.id,
		timestamp: options.timestamp,
		cwd: options.cwd,
		...(options.parentSession ? { parentSession: options.parentSession } : {}),
	};
}

function modelChange(provider: string, modelId: string, timestamp: string) {
	return { type: "model_change", id: `mc-${provider}`, parentId: null, timestamp, provider, modelId };
}

function assistantMessage(options: {
	id: string;
	entryTimestamp: string;
	messageTimestamp: number;
	provider: string;
	model: string;
	responseModel?: string;
	usage: ReturnType<typeof usage>;
}) {
	return {
		type: "message",
		id: options.id,
		parentId: null,
		timestamp: options.entryTimestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: options.provider,
			model: options.model,
			...(options.responseModel ? { responseModel: options.responseModel } : {}),
			usage: options.usage,
			stopReason: "stop",
			timestamp: options.messageTimestamp,
		},
	};
}

function toolResultMessage(options: {
	id: string;
	entryTimestamp: string;
	messageTimestamp: number;
	usage: ReturnType<typeof usage>;
}) {
	return {
		type: "message",
		id: options.id,
		parentId: null,
		timestamp: options.entryTimestamp,
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "done" }],
			isError: false,
			usage: options.usage,
			timestamp: options.messageTimestamp,
		},
	};
}

function userMessage(id: string, timestamp: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.parse(timestamp) },
	};
}

let fixtureRoot: string;
let scan: ScanResult;
let snapshot: StatsSnapshot;

function writeSession(dirName: string, fileName: string, lines: unknown[]): string {
	const dir = join(fixtureRoot, dirName);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, fileName);
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
	return path;
}

beforeAll(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "epi-stats-core-"));
	const projectDir = "--Users-w-Projects-easy-pi--";

	// A: real session, two calendar days, every contributing entry kind.
	writeSession(projectDir, "a.jsonl", [
		sessionHeader({ id: "sess-a", timestamp: "2026-09-19T09:59:00.000Z", cwd: PROJECT_CWD }),
		modelChange("openai-codex", "gpt-5.6-sol", "2026-09-19T09:59:01.000Z"),
		userMessage("u-1", "2026-09-19T10:00:00.000Z"),
		assistantMessage({
			id: "a-1",
			entryTimestamp: DAY_ONE_A,
			messageTimestamp: Date.parse(DAY_ONE_A),
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			usage: usage(100, 20, 900, 0, 1020, 1.5),
		}),
		toolResultMessage({
			id: "t-1",
			entryTimestamp: DAY_ONE_B,
			messageTimestamp: Date.parse(DAY_ONE_B),
			usage: usage(0, 0, 0, 0, 5, 0.25),
		}),
		assistantMessage({
			id: "a-2",
			entryTimestamp: DAY_TWO_A2,
			messageTimestamp: Date.parse(DAY_TWO_A2),
			provider: "openrouter",
			model: "auto",
			responseModel: "gpt-5.6-sol",
			usage: usage(10, 5, 0, 2, 17, 0.5),
		}),
		{
			type: "compaction",
			id: "c-1",
			parentId: null,
			timestamp: DAY_TWO_COMPACTION,
			tokensBefore: 1000,
			usage: usage(7, 3, 0, 0, 10, 0.1),
		},
		{
			type: "branch_summary",
			id: "b-1",
			parentId: null,
			timestamp: DAY_TWO_BRANCH,
			fromId: "a-2",
			summary: "branch",
			usage: usage(0, 0, 0, 0, 4, 0.05),
		},
	]);

	// B: temporary cwd session (excluded, but still counted in `excluded`).
	writeSession("--var-folders-temp--", "b.jsonl", [
		sessionHeader({ id: "sess-b", timestamp: "2026-09-19T11:00:00.000Z", cwd: TEMP_CWD }),
		assistantMessage({
			id: "b-1",
			entryTimestamp: "2026-09-19T11:00:05.000Z",
			messageTimestamp: Date.parse("2026-09-19T11:00:05.000Z"),
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			usage: usage(20, 5, 0, 0, 25, 0.3),
		}),
	]);

	// C: faux-provider session (excluded).
	writeSession("--Users-w-Projects-other--", "c.jsonl", [
		sessionHeader({ id: "sess-c", timestamp: "2026-09-19T12:00:00.000Z", cwd: OTHER_CWD }),
		modelChange("faux", "faux-1", "2026-09-19T12:00:01.000Z"),
		assistantMessage({
			id: "c-1",
			entryTimestamp: "2026-09-19T12:00:05.000Z",
			messageTimestamp: Date.parse("2026-09-19T12:00:05.000Z"),
			provider: "faux",
			model: "faux-1",
			usage: usage(1, 1, 0, 0, 2, 0.02),
		}),
	]);

	// D: fork; the entry before the fork timestamp was copied from the parent.
	writeSession(projectDir, "d.jsonl", [
		sessionHeader({
			id: "sess-d",
			timestamp: DAY_TWO_FORK_HEADER,
			cwd: PROJECT_CWD,
			parentSession: "/sessions/parent.jsonl",
		}),
		assistantMessage({
			id: "d-inherited",
			entryTimestamp: DAY_TWO_FORK_INHERITED,
			messageTimestamp: Date.parse(DAY_TWO_FORK_INHERITED),
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			usage: usage(999, 999, 0, 0, 1998, 9.99),
		}),
		assistantMessage({
			id: "d-own",
			entryTimestamp: DAY_TWO_FORK_OWN,
			messageTimestamp: Date.parse(DAY_TWO_FORK_OWN),
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			usage: usage(50, 10, 0, 0, 60, 1.0),
		}),
	]);

	// E: not a v3 session file.
	writeSession(projectDir, "e.jsonl", [{ type: "not-a-session", payload: "garbage" }]);

	// F: valid session with one malformed line in the middle.
	const fDir = join(fixtureRoot, projectDir);
	mkdirSync(fDir, { recursive: true });
	writeFileSync(
		join(fDir, "f.jsonl"),
		`${JSON.stringify(sessionHeader({ id: "sess-f", timestamp: "2026-09-19T10:20:00.000Z", cwd: PROJECT_CWD }))}\n` +
			`${JSON.stringify(
				assistantMessage({
					id: "f-1",
					entryTimestamp: DAY_ONE_F,
					messageTimestamp: Date.parse(DAY_ONE_F),
					provider: "openai-codex",
					model: "gpt-5.6-sol",
					usage: usage(3, 1, 0, 0, 4, 0.01),
				}),
			)}\n` +
			'{"type":"message","message":{"usage": broken json\n',
		"utf8",
	);

	// G: valid session without any usage.
	writeSession(projectDir, "g.jsonl", [
		sessionHeader({ id: "sess-g", timestamp: "2026-09-19T13:00:00.000Z", cwd: PROJECT_CWD }),
		userMessage("g-u1", "2026-09-19T13:00:01.000Z"),
	]);

	scan = scanSessions({ roots: [fixtureRoot] });
	snapshot = buildSnapshot(scan);
});

afterAll(() => {
	rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("isTempPath", () => {
	it("flags temporary roots and their children only", () => {
		expect(isTempPath(tmpdir())).toBe(true);
		expect(isTempPath(join(tmpdir(), "some", "deep", "dir"))).toBe(true);
		expect(isTempPath("/var/folders/ab/cdef/T/pi-test")).toBe(true);
		expect(isTempPath(PROJECT_CWD)).toBe(false);
		expect(isTempPath("/Users/w/Projects/easy-pi-tmp")).toBe(false);
		expect(isTempPath(`${PROJECT_CWD}/var/folders`)).toBe(false);
	});
});

describe("scanSessions", () => {
	it("counts files, skips non-session files and records parse errors without throwing", () => {
		expect(scan.stats.files).toBe(7);
		expect(scan.stats.skippedFiles).toBe(1);
		expect(scan.stats.parseErrors).toBe(1);
		expect(scan.stats.bytes).toBeGreaterThan(0);
		expect(scan.stats.roots).toEqual([fixtureRoot]);
		expect(scan.stats.scanMs).toBeGreaterThanOrEqual(0);
		expect(scan.sessions).toHaveLength(6);
	});

	it("extracts every usage-bearing entry kind and counts messages", () => {
		const sessionA = scan.sessions.find((session) => session.id === "sess-a");
		expect(sessionA).toBeDefined();
		expect(sessionA?.messages).toBe(4); // 1 user + 3 message entries (assistant/toolResult/assistant)
		expect(sessionA?.usageEntries).toBe(5);
		expect(sessionA?.input).toBe(117);
		expect(sessionA?.output).toBe(28);
		expect(sessionA?.cacheRead).toBe(900);
		expect(sessionA?.cacheWrite).toBe(2);
		expect(sessionA?.totalTokens).toBe(1056);
		expect(sessionA?.cost).toBe(2.4);
		expect(sessionA?.excluded).toBe(false);
		expect(sessionA?.models).toEqual(["(unknown)/(unknown)", "openai-codex/gpt-5.6-sol", "openrouter/gpt-5.6-sol"]);
	});

	it("marks temporary and faux-only sessions as excluded", () => {
		const sessionB = scan.sessions.find((session) => session.id === "sess-b");
		const sessionC = scan.sessions.find((session) => session.id === "sess-c");
		expect(sessionB?.excluded).toBe(true);
		expect(sessionB?.excludedReason).toBe("temp-cwd");
		expect(sessionC?.excluded).toBe(true);
		expect(sessionC?.excludedReason).toBe("faux-provider");
	});

	it("skips entries inherited by a forked session and keeps its own entries", () => {
		const sessionD = scan.sessions.find((session) => session.id === "sess-d");
		expect(sessionD?.parentSession).toBe("/sessions/parent.jsonl");
		expect(sessionD?.forkInheritedEntries).toBe(1);
		expect(sessionD?.totalTokens).toBe(60);
		expect(sessionD?.cost).toBe(1);
		const inherited = scan.records.some((record) => record.totalTokens === 1998);
		expect(inherited).toBe(false);
	});

	it("consumes usage fields verbatim without estimating", () => {
		const dir = mkdtempSync(join(tmpdir(), "epi-stats-verbatim-"));
		try {
			const path = join(dir, "verbatim.jsonl");
			writeFileSync(
				path,
				`${JSON.stringify(sessionHeader({ id: "sess-v", timestamp: "2026-09-19T14:00:00.000Z", cwd: PROJECT_CWD }))}\n` +
					`${JSON.stringify({
						type: "message",
						id: "v-1",
						parentId: null,
						timestamp: "2026-09-19T14:00:01.000Z",
						message: {
							role: "assistant",
							provider: "openai-codex",
							model: "gpt-5.6-sol",
							// totalTokens and cost.total are missing: they must stay 0, never be derived
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
							timestamp: Date.parse("2026-09-19T14:00:01.000Z"),
						},
					})}\n`,
				"utf8",
			);
			const local = scanSessions({ roots: [dir] });
			expect(local.sessions[0]?.input).toBe(10);
			expect(local.sessions[0]?.output).toBe(5);
			expect(local.sessions[0]?.totalTokens).toBe(0);
			expect(local.sessions[0]?.cost).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps valid sessions without usage out of the record list", () => {
		const sessionG = scan.sessions.find((session) => session.id === "sess-g");
		expect(sessionG?.usageEntries).toBe(0);
		expect(sessionG?.totalTokens).toBe(0);
		expect(snapshot.sessions.some((row) => row.id === "sess-g")).toBe(false);
	});
});

describe("buildSnapshot totals and grouping", () => {
	it("sums usage field-by-field over included sessions", () => {
		expect(snapshot.totals.input).toBe(170);
		expect(snapshot.totals.output).toBe(39);
		expect(snapshot.totals.cacheRead).toBe(900);
		expect(snapshot.totals.cacheWrite).toBe(2);
		expect(snapshot.totals.totalTokens).toBe(1120);
		expect(snapshot.totals.cost).toBe(3.41);
		expect(snapshot.totals.messages).toBe(7);
		expect(snapshot.totals.sessions).toBe(3);
		expect(snapshot.scan.files).toBe(7);
		expect(snapshot.scan.cached).toBe(false);
	});

	it("computes the cache hit rate as cacheRead / prompt-side tokens", () => {
		expect(snapshot.totals.cacheHitRate).toBeCloseTo(0.839552, 6);
		expect(snapshot.totals.cacheHitRate).toBeCloseTo(900 / (170 + 900 + 2), 6);
		expect(usageCacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
		expect(usageCacheHitRate({ input: 100, cacheRead: 900, cacheWrite: 0 })).toBeCloseTo(0.9, 12);
	});

	it("groups by local day, model key, provider and project", () => {
		const dayOne = dayOf(DAY_ONE_A);
		const dayTwo = dayOf(DAY_TWO_A2);
		expect(snapshot.byDay.map((row) => row.day)).toEqual([dayOne, dayTwo]);
		const dayOneRow = snapshot.byDay[0];
		expect(dayOneRow).toMatchObject({
			input: 103,
			output: 21,
			cacheRead: 900,
			cacheWrite: 0,
			totalTokens: 1029,
			cost: 1.76,
			messages: 3,
			sessions: 2,
		});
		const dayTwoRow = snapshot.byDay[1];
		expect(dayTwoRow).toMatchObject({
			input: 67,
			output: 18,
			cacheRead: 0,
			cacheWrite: 2,
			totalTokens: 91,
			cost: 1.65,
			messages: 4,
			sessions: 2,
		});

		expect(snapshot.byModel.map((row) => row.key)).toEqual([
			"openai-codex/gpt-5.6-sol",
			"openrouter/gpt-5.6-sol",
			"(unknown)/(unknown)",
		]);
		expect(snapshot.byModel[0]).toMatchObject({
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			input: 153,
			output: 31,
			cacheRead: 900,
			totalTokens: 1084,
			cost: 2.51,
			messages: 3,
			sessions: 3,
		});
		// responseModel wins over the request model ("auto")
		expect(snapshot.byModel[1]).toMatchObject({ key: "openrouter/gpt-5.6-sol", cost: 0.5, totalTokens: 17 });
		// tool results, compaction and branch summaries have no model attribution
		expect(snapshot.byModel[2]).toMatchObject({ cost: 0.4, totalTokens: 19, messages: 3, sessions: 1 });

		expect(snapshot.byProvider.map((row) => row.provider)).toEqual(["openai-codex", "openrouter", "(unknown)"]);
		expect(snapshot.byProvider[0]).toMatchObject({ cost: 2.51, totalTokens: 1084, sessions: 3 });

		expect(snapshot.byProject).toHaveLength(1);
		expect(snapshot.byProject[0]).toMatchObject({
			cwd: PROJECT_CWD,
			name: basename(PROJECT_CWD),
			cost: 3.41,
			totalTokens: 1120,
			sessions: 3,
			messages: 7,
		});
		expect(snapshot.byProject[0]?.lastUsedAt).toBe(new Date(Date.parse(DAY_TWO_BRANCH)).toISOString());
	});

	it("reports session rows sorted by cost with per-session metadata", () => {
		expect(snapshot.sessions.map((row) => row.id)).toEqual(["sess-a", "sess-d", "sess-f"]);
		const rowA = snapshot.sessions[0];
		expect(rowA).toMatchObject({
			cwd: PROJECT_CWD,
			project: basename(PROJECT_CWD),
			cost: 2.4,
			totalTokens: 1056,
			messages: 5,
			excluded: false,
			excludedReason: null,
		});
		expect(rowA?.models).toEqual(["(unknown)/(unknown)", "openai-codex/gpt-5.6-sol", "openrouter/gpt-5.6-sol"]);
		expect(rowA?.startedAt).toBe("2026-09-19T09:59:00.000Z");
		expect(snapshot.sessions[1]?.models).toEqual(["openai-codex/gpt-5.6-sol"]);
	});

	it("summarizes excluded sessions and their reasons", () => {
		expect(snapshot.excluded.sessions).toBe(2);
		expect(snapshot.excluded.cost).toBe(0.32);
		expect(snapshot.excluded.totalTokens).toBe(27);
		expect(snapshot.excluded.reasons).toEqual({ "temp-cwd": 1, "faux-provider": 1 });
	});

	it("reports the data span as range when no bounds are requested", () => {
		expect(snapshot.range).toEqual({ from: dayOf(DAY_ONE_A), to: dayOf(DAY_TWO_A2) });
	});
});

describe("buildSnapshot query options", () => {
	it("omits excluded session rows unless includeAll is set", () => {
		const included = buildSnapshot(scan);
		expect(included.sessions.every((row) => !row.excluded)).toBe(true);
		expect(included.sessions.map((row) => row.id)).not.toContain("sess-b");
		expect(included.totals.sessions).toBe(included.sessions.length);

		const all = buildSnapshot(scan, { includeAll: true });
		expect(all.sessions.some((row) => row.excluded)).toBe(true);
		expect(all.sessions.length).toBeGreaterThan(included.sessions.length);
	});

	it("includes excluded sessions when includeAll is set", () => {
		const all = buildSnapshot(scan, { includeAll: true });
		expect(all.totals.input).toBe(191);
		expect(all.totals.output).toBe(45);
		expect(all.totals.totalTokens).toBe(1147);
		expect(all.totals.cost).toBe(3.73);
		expect(all.totals.messages).toBe(9);
		expect(all.totals.sessions).toBe(5);
		expect(all.byProject).toHaveLength(3); // easy-pi + temp fixture cwd + other
		expect(all.sessions.map((row) => row.id)).toContain("sess-b");
		expect(all.sessions.find((row) => row.id === "sess-b")?.excluded).toBe(true);
	});

	it("filters records by local day bounds", () => {
		const dayTwo = dayOf(DAY_TWO_A2);
		const dayTwoOnly = buildSnapshot(scan, { from: dayTwo, to: dayTwo });
		expect(dayTwoOnly.byDay.map((row) => row.day)).toEqual([dayTwo]);
		expect(dayTwoOnly.totals.input).toBe(67);
		expect(dayTwoOnly.totals.cost).toBe(1.65);
		expect(dayTwoOnly.totals.sessions).toBe(2);
		expect(dayTwoOnly.range).toEqual({ from: dayTwo, to: dayTwo });

		const dayOne = dayOf(DAY_ONE_A);
		const dayOneOnly = buildSnapshot(scan, { from: dayOne, to: dayOne });
		expect(dayOneOnly.totals.totalTokens).toBe(1029);
		expect(dayOneOnly.byDay).toHaveLength(1);
		expect(dayOneOnly.sessions.map((row) => row.id)).toEqual(["sess-a", "sess-f"]);
	});

	it("truncates grouping rows with top but keeps the session list complete", () => {
		const topOne = buildSnapshot(scan, { top: 1 });
		expect(topOne.byModel).toHaveLength(1);
		expect(topOne.byModel[0]?.key).toBe("openai-codex/gpt-5.6-sol");
		expect(topOne.byProvider).toHaveLength(1);
		expect(topOne.byDay).toHaveLength(2);
		expect(topOne.sessions).toHaveLength(3);
		expect(topOne.totals.cost).toBe(3.41);

		const allTopOne = buildSnapshot(scan, { includeAll: true, top: 1 });
		expect(allTopOne.byProject).toHaveLength(1);
		expect(allTopOne.byProject[0]?.cwd).toBe(PROJECT_CWD);
	});

	it("echoes the cached flag and ignores invalid bounds", () => {
		const cached = buildSnapshot(scan, { cached: true, from: "not-a-day" });
		expect(cached.scan.cached).toBe(true);
		expect(cached.totals.cost).toBe(3.41);
	});

	it("uses local calendar days for byDay keys", () => {
		const day = dayOf(DAY_ONE_A);
		expect(localDayKey(Date.parse(DAY_ONE_A))).toBe(day);
	});
});
