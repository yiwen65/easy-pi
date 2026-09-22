import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { localDayKey } from "../src/core/stats/aggregate.ts";
import { scanSessions } from "../src/core/stats/scan.ts";
import {
	DEFAULT_STATS_HOST,
	DEFAULT_STATS_PORT,
	type StatsServerHandle,
	startStatsServer,
} from "../src/core/stats/server.ts";

/**
 * Fixture corpus (one directory per project, mirroring the real layout):
 *   alpha   real session: one assistant entry       -> counted
 *   beta    real session: toolResult + compaction   -> counted
 *   temp    session in a temporary cwd              -> excluded (temp-cwd)
 *   faux    session whose only provider is `faux`   -> excluded (faux-provider)
 */

const WEB_DIR = resolve(fileURLToPath(new URL("../src/core/stats/web", import.meta.url)));

const ALPHA_CWD = "/Users/w/Projects/alpha";
const BETA_CWD = "/Users/w/Projects/beta";
const GAMMA_CWD = "/Users/w/Projects/gamma";
const TEMP_CWD = join(tmpdir(), "epi-stats-server-fixture-temp");

const DAY_ONE_MS = Date.parse("2026-09-19T10:00:05.000Z");
const DAY_ONE_ISO = "2026-09-19T10:00:05.000Z";
const DAY_TWO_MS = Date.parse("2026-09-22T09:00:00.000Z");
const DAY_TWO_ISO = "2026-09-22T09:00:00.000Z";

interface UsageFixture {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

const ALPHA_USAGE: UsageFixture = {
	input: 100,
	output: 20,
	cacheRead: 300,
	cacheWrite: 10,
	totalTokens: 430,
	cost: 0.0125,
};
const BETA_TOOL_USAGE: UsageFixture = {
	input: 5,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5,
	cost: 0.0001,
};
const BETA_COMPACTION_USAGE: UsageFixture = {
	input: 1000,
	output: 200,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1200,
	cost: 0.05,
};
const TEMP_USAGE: UsageFixture = {
	input: 10,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 11,
	cost: 0.001,
};
const FAUX_USAGE: UsageFixture = {
	input: 7,
	output: 3,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 10,
	cost: 0.002,
};

/** Only the fields `scanSessions()` reads; the rest of the session shape is irrelevant here. */
function toUsageJson(usage: UsageFixture): Record<string, number | Record<string, number>> {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: usage.cost,
		},
	};
}

function sessionHeader(id: string, cwd: string, timestampIso: string): Record<string, unknown> {
	return { type: "session", version: 3, id, timestamp: timestampIso, cwd };
}

function assistantEntry(
	id: string,
	provider: string,
	model: string,
	timestampMs: number,
	usage: UsageFixture,
): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestampMs).toISOString(),
		message: {
			role: "assistant",
			provider,
			model,
			api: "test",
			timestamp: timestampMs,
			usage: toUsageJson(usage),
		},
	};
}

function toolResultEntry(id: string, timestampMs: number, usage: UsageFixture): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestampMs).toISOString(),
		message: { role: "toolResult", toolCallId: "call-1", timestamp: timestampMs, usage: toUsageJson(usage) },
	};
}

function writeSession(root: string, dir: string, file: string, lines: readonly unknown[]): void {
	const target = join(root, dir);
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, file), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function createFixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "epi-stats-server-"));
	writeSession(root, "--Users-w-Projects-alpha--", "alpha.jsonl", [
		sessionHeader("alpha", ALPHA_CWD, DAY_ONE_ISO),
		assistantEntry("a-1", "anthropic", "claude-x", DAY_ONE_MS, ALPHA_USAGE),
	]);
	writeSession(root, "--Users-w-Projects-beta--", "beta.jsonl", [
		sessionHeader("beta", BETA_CWD, DAY_TWO_ISO),
		toolResultEntry("b-1", DAY_TWO_MS, BETA_TOOL_USAGE),
		{
			type: "compaction",
			id: "b-2",
			parentId: null,
			timestamp: DAY_TWO_ISO,
			usage: toUsageJson(BETA_COMPACTION_USAGE),
		},
	]);
	writeSession(root, "--tmp-epi-stats--", "temp.jsonl", [
		sessionHeader("temp", TEMP_CWD, DAY_ONE_ISO),
		assistantEntry("t-1", "anthropic", "claude-x", DAY_ONE_MS, TEMP_USAGE),
	]);
	writeSession(root, "--Users-w-Projects-gamma--", "gamma.jsonl", [
		sessionHeader("gamma", GAMMA_CWD, DAY_TWO_ISO),
		assistantEntry("g-1", "faux", "faux-1", DAY_TWO_MS, FAUX_USAGE),
	]);
	return root;
}

const tempRoots: string[] = [];
const handles: StatsServerHandle[] = [];

async function startFixtureServer(overrides: Partial<Parameters<typeof startStatsServer>[0]> = {}) {
	const root = createFixtureRoot();
	tempRoots.push(root);
	const handle = await startStatsServer({ roots: [root], webDir: WEB_DIR, port: 0, ...overrides });
	handles.push(handle);
	return handle;
}

afterEach(async () => {
	for (const handle of handles.splice(0)) {
		await handle.close();
	}
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("stats HTTP service", () => {
	it("serves the panel assets with the expected content types", async () => {
		const handle = await startFixtureServer();

		const index = await fetch(handle.url);
		expect(index.status).toBe(200);
		expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(await index.text()).toContain("easy-pi token usage");

		const script = await fetch(`${handle.url}app.js`);
		expect(script.status).toBe(200);
		expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect((await script.text()).length).toBeGreaterThan(0);

		const style = await fetch(`${handle.url}app.css`);
		expect(style.status).toBe(200);
		expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
		expect((await style.text()).length).toBeGreaterThan(0);

		const favicon = await fetch(`${handle.url}favicon.ico`);
		expect(favicon.status).toBe(204);
	});

	it("answers HEAD for GET routes without a body", async () => {
		const handle = await startFixtureServer();
		const response = await fetch(handle.url, { method: "HEAD" });
		expect(response.status).toBe(200);
		expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
		expect(await response.text()).toBe("");
	});

	it("reports health from the cached scan", async () => {
		const handle = await startFixtureServer();
		const response = await fetch(`${handle.url}api/health`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; generatedAt: string; scanMs: number; files: number };
		expect(body.ok).toBe(true);
		expect(typeof body.generatedAt).toBe("string");
		expect(typeof body.scanMs).toBe("number");
		expect(body.files).toBe(4);
	});

	it("returns the frozen snapshot shape with hand-computed totals", async () => {
		const handle = await startFixtureServer();
		const response = await fetch(`${handle.url}api/stats`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store");

		const body = (await response.json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual([
			"byDay",
			"byModel",
			"byProject",
			"byProvider",
			"excluded",
			"generatedAt",
			"range",
			"scan",
			"sessions",
			"totals",
		]);

		expect(body.totals).toMatchObject({
			input: 1105,
			output: 220,
			cacheRead: 300,
			cacheWrite: 10,
			totalTokens: 1635,
			cost: 0.0626,
			sessions: 2,
			messages: 3,
		});
		// Aggregator normalizes values to 1e-6 precision (T-001 decision), hence the 6-digit tolerance.
		expect((body.totals as { cacheHitRate: number }).cacheHitRate).toBeCloseTo(300 / 1415, 6);

		const scan = body.scan as { roots: string[]; files: number; cached: boolean };
		expect(scan.files).toBe(4);
		expect(scan.cached).toBe(false);
		expect(scan.roots).toHaveLength(1);
		expect((body.range as { from: string; to: string }).from).toBe(localDayKey(DAY_ONE_MS));
		expect((body.range as { to: string }).to).toBe(localDayKey(DAY_TWO_MS));

		const day = (body.byDay as { day: string; totalTokens: number }[]).find(
			(row) => row.day === localDayKey(DAY_ONE_MS),
		);
		expect(day?.totalTokens).toBe(430);

		const model = (body.byModel as { key: string; cost: number }[]).find((row) => row.key === "anthropic/claude-x");
		expect(model?.cost).toBeCloseTo(0.0125, 10);

		const unknown = (body.byModel as { key: string; totalTokens: number }[]).find(
			(row) => row.key === "(unknown)/(unknown)",
		);
		expect(unknown?.totalTokens).toBe(1205);

		const sessions = body.sessions as { id: string; excluded: boolean }[];
		expect(sessions.map((row) => row.id).sort()).toEqual(["alpha", "beta"]);
		expect(sessions.every((row) => row.excluded === false)).toBe(true);

		expect(body.excluded).toEqual({
			sessions: 2,
			cost: 0.003,
			totalTokens: 21,
			reasons: { "faux-provider": 1, "temp-cwd": 1 },
		});
	});

	it("reuses the cached scan and rescans on refresh=1", async () => {
		let scans = 0;
		const handle = await startFixtureServer({
			scan: (roots) => {
				scans++;
				return scanSessions({ roots });
			},
		});

		const first = (await (await fetch(`${handle.url}api/stats`)).json()) as { scan: { cached: boolean } };
		expect(first.scan.cached).toBe(false);
		expect(scans).toBe(1);

		const second = (await (await fetch(`${handle.url}api/stats`)).json()) as { scan: { cached: boolean } };
		expect(second.scan.cached).toBe(true);
		expect(scans).toBe(1);

		const refreshed = (await (await fetch(`${handle.url}api/stats?refresh=1`)).json()) as {
			scan: { cached: boolean };
		};
		expect(refreshed.scan.cached).toBe(false);
		expect(scans).toBe(2);
	});

	it("applies from/to/includeAll filters", async () => {
		const handle = await startFixtureServer();
		const day = localDayKey(DAY_ONE_MS);

		const ranged = (await (await fetch(`${handle.url}api/stats?from=${day}&to=${day}`)).json()) as {
			totals: { totalTokens: number; sessions: number };
			byDay: { day: string }[];
		};
		expect(ranged.totals.totalTokens).toBe(430);
		expect(ranged.totals.sessions).toBe(1);
		expect(ranged.byDay.map((row) => row.day)).toEqual([day]);

		const all = (await (await fetch(`${handle.url}api/stats?includeAll=1`)).json()) as {
			totals: { totalTokens: number; sessions: number; messages: number };
		};
		expect(all.totals.totalTokens).toBe(1656);
		expect(all.totals.sessions).toBe(4);
		expect(all.totals.messages).toBe(5);
	});

	it("passes top through without inventing rows", async () => {
		const handle = await startFixtureServer();
		const response = await fetch(`${handle.url}api/stats?top=1`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			byModel: unknown[];
			byProvider: unknown[];
			byProject: unknown[];
			sessions: unknown[];
		};
		// Policy-agnostic check: `top` must cap at least the row family it owns,
		// whether that is the group buckets (current aggregator) or the session rows.
		const bucketsCapped = body.byModel.length <= 1 && body.byProvider.length <= 1 && body.byProject.length <= 1;
		expect(bucketsCapped || body.sessions.length <= 1).toBe(true);
	});

	it("rejects invalid query values with 400", async () => {
		const handle = await startFixtureServer();
		for (const query of ["from=notadate", "to=2026-13-40", "includeAll=maybe", "refresh=2", "top=-1"]) {
			const response = await fetch(`${handle.url}api/stats?${query}`);
			expect(response.status, query).toBe(400);
			const body = (await response.json()) as { error: string; message: string };
			expect(body.error).toBe("invalid_query");
			expect(body.message.length).toBeGreaterThan(0);
		}
	});

	it("rejects unknown routes and non-GET methods", async () => {
		const handle = await startFixtureServer();

		for (const path of ["/nope", "/../secrets.json", "/%2e%2e%2fsecrets.json", "/api/stats/extra"]) {
			const response = await fetch(`${handle.url.replace(/\/$/, "")}${path}`);
			expect(response.status, path).toBe(404);
			const body = (await response.json()) as { error: string };
			expect(body.error).toBe("not_found");
		}

		const posted = await fetch(`${handle.url}api/stats`, { method: "POST" });
		expect(posted.status).toBe(405);
		expect(posted.headers.get("allow")).toBe("GET, HEAD");
	});

	it("binds loopback only and falls back to an ephemeral port when busy", async () => {
		const first = await startFixtureServer();
		expect(first.host).toBe(DEFAULT_STATS_HOST);
		expect(first.url.startsWith(`http://${DEFAULT_STATS_HOST}:`)).toBe(true);

		const secondHandle = await startStatsServer({ roots: [first.url], webDir: WEB_DIR, port: first.port });
		handles.push(secondHandle);
		expect(secondHandle.port).not.toBe(first.port);
		expect((await fetch(`${secondHandle.url}api/health`)).status).toBe(200);

		await expect(startStatsServer({ webDir: WEB_DIR, port: 0, host: "0.0.0.0" })).rejects.toThrow(/loopback/);
		await expect(startStatsServer({ webDir: WEB_DIR, port: 0, host: "::" })).rejects.toThrow(/loopback/);
	});

	it("closes idempotently and stops accepting requests", async () => {
		const handle = await startFixtureServer();
		const port = handle.port;
		await handle.close();
		await expect(handle.close()).resolves.toBeUndefined();
		await expect(fetch(`http://${DEFAULT_STATS_HOST}:${port}/api/health`)).rejects.toThrow();
	});

	it("exposes the default port the CLI advertises", () => {
		expect(DEFAULT_STATS_PORT).toBe(8787);
	});
});

// Guards against accidental exposure of the listener object in the public handle.
describe("stats server handle shape", () => {
	it("exposes url/port/host/close/refresh", async () => {
		const handle = await startFixtureServer();
		expect(Object.keys(handle).sort()).toEqual(["close", "host", "port", "refresh", "url"]);
		expect(handle.port).toBeGreaterThan(0);
		// The node:http server object must stay private: no `.address()` leaking through.
		expect((handle as unknown as { address?: AddressInfo }).address).toBeUndefined();
		handle.refresh();
	});
});
