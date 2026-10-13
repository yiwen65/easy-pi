// WF07 benchmark harness (docs/web_fetch/WEB_FETCH_REMEDIATION_PLAN.md WF07 / section 6).
//
// Runs a fixed list of the existing loopback fixtures N times against one or two
// worktrees in this process, interleaving the sides per repetition, and prints raw
// per-read counters as JSON (nothing derived is invented: medians/p95 are computed
// from the recorded attempts, failures included, and every page reports its captured
// text hash so the before/after text can be compared byte for byte).
//
// Usage (from the repository root):
//   node packages/pi-web-search/test/bench.mjs --worktree=. --baseline=/tmp/pi-wf07-base --runs=10
// The baseline worktree is created read-only for comparison:
//   git worktree add --detach /tmp/pi-wf07-base 60daaeef5
//
// Not a *.test.mjs file on purpose: test/run.mjs must not pick this up.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setupBrowserFixtures } from "./browser-harness.mjs";
import { fixturePage as fullPagePages } from "./full-page-fixtures.mjs";
import { fixturePage as samplingPages } from "./sampling-fixtures.mjs";

const args = new Map(
	process.argv.slice(2).map((argument) => {
		const at = argument.indexOf("=");
		return at < 0 ? [argument.replace(/^--/, ""), "1"] : [argument.slice(2, at), argument.slice(at + 1)];
	}),
);
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const worktreeArg = resolve(args.get("worktree") ?? packageRoot);
const baselineArg = args.get("baseline") ? resolve(args.get("baseline")) : undefined;
const runs = Number(args.get("runs") ?? 10);

/** Accept either a repository worktree root or the package directory itself. */
const moduleFor = (directory) => {
	const local = resolve(directory, "src/browser.ts");
	if (existsSync(local)) return local;
	return resolve(directory, "packages/pi-web-search/src/browser.ts");
};

const DEFAULT_PAGES = ["/static", "/c02", "/c05", "/c06", "/c09", "/lazy"];
const paths = (args.get("urls") ?? DEFAULT_PAGES.join(",")).split(",").filter(Boolean);
// The sampling fixtures and the full-page fixtures live on different loopback hosts.
const hostFor = (path) => (/^\/c\d/.test(path) ? "sample.public.org" : "page.public.org");
const pages = paths.map((path) => ({ host: hostFor(path), path }));

// The harness refuses to run with credentials or runtime hooks in the environment and
// patches only the OS boundaries; the same isolation the other browser tests use.
for (const name of Object.keys(process.env))
	if (/KEY|TOKEN|SECRET|AUTH|PROXY|^NODE_(OPTIONS|PATH)$/.test(name)) delete process.env[name];
process.env.PI_FULL_PAGE_BROWSER_TEST = "1";
process.env.PI_WEB_FETCH_BROWSER_MODULE = moduleFor(worktreeArg);
if (!process.env.TMPDIR) process.env.TMPDIR = tmpdir();

const fixturePage = (path) => fullPagePages(path) ?? samplingPages(path);
const harness = await setupBrowserFixtures({
	fixturePage,
	hosts: ["page.public.org", "sample.public.org"],
});

const sides = [{ name: "current", directory: worktreeArg, readPage: harness.readPage }];
if (baselineArg) {
	const baselineModule = await import(pathToFileURL(moduleFor(baselineArg)).href);
	sides.push({ name: "baseline", directory: baselineArg, readPage: baselineModule.readPage });
}

const textHash = (text) => createHash("sha256").update(text, "utf8").digest("hex");

async function measure(side, page, run) {
	const started = performance.now();
	try {
		const rendered = await side.readPage(`http://${page.host}${page.path}`);
		const metrics = rendered.metrics;
		return {
			side: side.name,
			path: page.path,
			run,
			ok: true,
			elapsedMs: metrics.elapsedMs,
			wallMs: performance.now() - started,
			samples: metrics.samples,
			serializations: metrics.serializations ?? null,
			cdpBytesIn: metrics.cdpBytesIn,
			cdpBytesOut: metrics.cdpBytesOut,
			scanMs: metrics.scanMs,
			startupMs: metrics.startupMs,
			navigateMs: metrics.navigateMs,
			cleanupMs: metrics.cleanupMs,
			framesRead: rendered.framesRead,
			textChars: Array.from(rendered.text).length,
			textHash: textHash(rendered.text),
			scanComplete: rendered.scanComplete,
			incompleteReasons: rendered.incompleteReasons,
		};
	} catch (error) {
		return {
			side: side.name,
			path: page.path,
			run,
			ok: false,
			elapsedMs: performance.now() - started,
			wallMs: performance.now() - started,
			code: error?.code ?? null,
			error: String(error?.message ?? error).slice(0, 240),
			samples: null,
			serializations: null,
			cdpBytesIn: null,
			cdpBytesOut: null,
			textHash: null,
		};
	}
}

const attempts = [];
for (let run = 1; run <= runs; run++) {
	// Interleave the sides (order alternating per repetition) so a drift in machine load
	// cannot land on one side only.
	const order = run % 2 === 1 ? sides : [...sides].reverse();
	for (const page of pages)
		for (const side of order) {
			const attempt = await measure(side, page, run);
			attempts.push(attempt);
			process.stderr.write(
				`run ${run}/${runs} ${side.name} ${page.path} ${attempt.ok ? "ok" : "FAIL"} ${Math.round(attempt.wallMs)}ms\n`,
			);
		}
}

const quantile = (values, fraction) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
	return sorted[index];
};
const median = (values) => quantile(values, 0.5);

const summary = [];
for (const page of pages) {
	for (const side of sides) {
		const rows = attempts.filter((attempt) => attempt.side === side.name && attempt.path === page.path);
		const durations = rows.map((row) => row.elapsedMs);
		const ok = rows.filter((row) => row.ok);
		summary.push({
			side: side.name,
			path: page.path,
			attempts: rows.length,
			ok: ok.length,
			failures: rows.length - ok.length,
			failureCodes: rows.filter((row) => !row.ok).map((row) => row.code ?? "unknown"),
			medianMs: median(durations),
			p95Ms: quantile(durations, 0.95),
			minMs: durations.length ? Math.min(...durations) : null,
			maxMs: durations.length ? Math.max(...durations) : null,
			medianSamples: median(ok.map((row) => row.samples)),
			medianSerializations: median(ok.map((row) => row.serializations).filter((value) => value !== null)),
			serializationsMeasured: ok.some((row) => row.serializations !== null),
			medianCdpBytesIn: median(ok.map((row) => row.cdpBytesIn)),
			medianCdpBytesOut: median(ok.map((row) => row.cdpBytesOut)),
			medianScanMs: median(ok.map((row) => row.scanMs)),
			textHashes: [...new Set(ok.map((row) => row.textHash))],
			complete: ok.filter((row) => row.scanComplete).length,
		});
	}
}

const quality = [];
if (sides.length === 2)
	for (const page of pages) {
		const hashes = (side) =>
			[...new Set(attempts.filter((a) => a.side === side && a.path === page.path && a.ok).map((a) => a.textHash))];
		const currentHashes = hashes("current");
		const baselineHashes = hashes("baseline");
		quality.push({
			path: page.path,
			baselineHashes,
			currentHashes,
			identical:
				currentHashes.length > 0 &&
				baselineHashes.length > 0 &&
				currentHashes.length === 1 &&
				baselineHashes.length === 1 &&
				currentHashes[0] === baselineHashes[0],
		});
	}

const leftoverProfiles = readdirSync(process.env.TMPDIR).filter((name) => name.startsWith("pi-web-fetch-"));
const report = {
	tool: "wf07-bench",
	node: process.version,
	worktree: worktreeArg,
	baseline: baselineArg ?? null,
	worktreeModule: moduleFor(worktreeArg),
	baselineModule: baselineArg ? moduleFor(baselineArg) : null,
	runs,
	pages: pages.map((page) => `http://${page.host}${page.path}`),
	countersNote:
		"samples = collector evaluations; serializations = full page-text rebuilds (null when the side has no such counter); cdpBytesIn = bytes received from the browser; elapsedMs = the read's own monotonic duration. Failures keep their attempt and are counted in the duration sample.",
	fixtureRequests: harness.stats.publicAttempts,
	leftoverProfiles,
	attempts,
	summary,
	quality,
};
// Synchronous write so process.exit cannot truncate the report on a pipe.
writeSync(1, `${JSON.stringify(report, null, 2)}\n`);
process.exit(leftoverProfiles.length || harness.stats.publicAttempts === 0 ? 1 : 0);
