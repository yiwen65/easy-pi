import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	defaultStatsRoots,
	describeMissingRoots,
	handleStatsCommand,
	isStatsCommandHelp,
	normalizeStatsRoots,
	parseStatsCommand,
	StatsCommandError,
	statsPanelUrl,
	statsRangeForDays,
} from "../src/cli/stats-command.ts";
import { getSessionsDir } from "../src/config.ts";

describe("parseStatsCommand", () => {
	it("ignores arguments that are not the stats command", () => {
		expect(parseStatsCommand([])).toBeUndefined();
		expect(parseStatsCommand(["message"])).toBeUndefined();
		expect(parseStatsCommand(["--json"])).toBeUndefined();
	});

	it("applies documented defaults", () => {
		const options = parseStatsCommand(["stats"]);
		expect(options).toEqual({
			dirs: [],
			days: 30,
			includeAll: false,
			json: false,
			open: true,
			port: null,
		});
	});

	it("parses flags and repeatable --dir values", () => {
		const options = parseStatsCommand([
			"stats",
			"--port",
			"9000",
			"--dir",
			"/tmp/a",
			"--dir",
			"/tmp/b",
			"--days",
			"0",
			"--all",
			"--json",
			"--no-open",
		]);
		expect(options).toEqual({
			dirs: ["/tmp/a", "/tmp/b"],
			days: 0,
			includeAll: true,
			json: true,
			open: false,
			port: 9000,
		});
	});

	it("rejects invalid values and unknown options", () => {
		const cases: string[][] = [
			["stats", "--port", "abc"],
			["stats", "--port", "0"],
			["stats", "--port", "70000"],
			["stats", "--port"],
			["stats", "--days", "-1"],
			["stats", "--days", "many"],
			["stats", "--dir", ""],
			["stats", "--dir"],
			["stats", "--wat"],
		];
		for (const args of cases) {
			expect(() => parseStatsCommand(args), args.join(" ")).toThrow(StatsCommandError);
		}
	});

	it("treats `stats help` and `--help` as help, but not a bare `stats` (which serves)", () => {
		expect(isStatsCommandHelp(["stats"])).toBe(false);
		expect(isStatsCommandHelp(["stats", "help"])).toBe(true);
		expect(isStatsCommandHelp(["stats", "--help"])).toBe(true);
		expect(isStatsCommandHelp(["stats", "-h"])).toBe(true);
		expect(isStatsCommandHelp(["stats", "--json"])).toBe(false);
		expect(isStatsCommandHelp(["other"])).toBe(false);
	});
});

describe("defaultStatsRoots", () => {
	it("prefers the session-dir environment override", () => {
		expect(defaultStatsRoots("/from/settings", { EASY_PI_CODING_AGENT_SESSION_DIR: "/from/env" })).toEqual([
			"/from/env",
		]);
	});

	it("falls back to the configured sessionDir, then the agent sessions directory", () => {
		expect(defaultStatsRoots("/from/settings", {})).toEqual(["/from/settings"]);
		expect(defaultStatsRoots(null, {})).toEqual([getSessionsDir()]);
		expect(defaultStatsRoots("   ", {})).toEqual([getSessionsDir()]);
	});
});

describe("normalizeStatsRoots", () => {
	it("expands `~`, resolves and de-duplicates roots", () => {
		const roots = normalizeStatsRoots(["~/x", "~/x", "/tmp/../tmp/y", "/tmp/y"]);
		expect(roots).toHaveLength(2);
		expect(roots[0]).toBe(`${homedir()}/x`);
		expect(roots[1]).toBe("/tmp/y");
	});

	it("drops roots nested inside another root so files are never counted twice", () => {
		expect(normalizeStatsRoots(["/data/sessions", "/data/sessions/project-a"])).toEqual(["/data/sessions"]);
		expect(normalizeStatsRoots(["/data/sessions/project-a", "/data/sessions"])).toEqual(["/data/sessions"]);
		expect(normalizeStatsRoots(["/data/sessions", "/data/sessions-2"])).toHaveLength(2);
	});
});

describe("describeMissingRoots", () => {
	it("warns for missing paths and non-directories, and stays quiet for directories", () => {
		const dir = mkdtempSync(join(tmpdir(), "stats-roots-"));
		const file = join(dir, "sessions.jsonl");
		writeFileSync(file, "{}\n");
		try {
			expect(describeMissingRoots([dir])).toEqual([]);
			expect(describeMissingRoots([join(dir, "nope")])[0]).toContain("not found");
			expect(describeMissingRoots([file])[0]).toContain("not a directory");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("statsRangeForDays", () => {
	it("computes an inclusive local range ending today", () => {
		const now = new Date(2026, 8, 20, 15, 30);
		expect(statsRangeForDays(30, now)).toEqual({ from: "2026-08-22", to: "2026-09-20" });
		expect(statsRangeForDays(1, now)).toEqual({ from: "2026-09-20", to: "2026-09-20" });
	});

	it("crosses month boundaries", () => {
		const now = new Date(2026, 2, 1, 9, 0);
		expect(statsRangeForDays(2, now)).toEqual({ from: "2026-02-28", to: "2026-03-01" });
	});

	it("returns open bounds for all time", () => {
		expect(statsRangeForDays(0)).toEqual({ from: null, to: null });
		expect(statsRangeForDays(null)).toEqual({ from: null, to: null });
	});
});

describe("statsPanelUrl", () => {
	const base = { dirs: [], includeAll: false, json: false, open: true, port: null };

	it("adds the initial view parameters", () => {
		expect(statsPanelUrl("http://127.0.0.1:8787/", { ...base, days: 7 })).toBe("http://127.0.0.1:8787/?days=7");
		expect(statsPanelUrl("http://127.0.0.1:8787/", { ...base, days: 0, includeAll: true })).toBe(
			"http://127.0.0.1:8787/?days=0&includeAll=1",
		);
	});

	it("keeps all time without extra parameters", () => {
		expect(statsPanelUrl("http://127.0.0.1:8787/", { ...base, days: null })).toBe("http://127.0.0.1:8787/");
	});
});

describe("handleStatsCommand", () => {
	it("does not consume unrelated arguments", async () => {
		await expect(handleStatsCommand(["hello"])).resolves.toBe(false);
		await expect(handleStatsCommand([])).resolves.toBe(false);
	});
});
