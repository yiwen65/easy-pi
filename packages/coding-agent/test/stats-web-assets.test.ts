import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural checks for the stats panel assets (T-003).
 *
 * These assertions are intentionally independent of markup formatting: they verify
 * the properties that actually matter for a loopback, offline, dependency-free panel
 * (no external references, ids referenced by app.js exist, frozen contract fields are
 * used, cost is rendered with 3 decimals) instead of snapshotting the HTML.
 */

const WEB_DIR = new URL("../src/core/stats/web/", import.meta.url);

function readAsset(name: string): string {
	return readFileSync(fileURLToPath(new URL(name, WEB_DIR)), "utf8");
}

const html = readAsset("index.html");
const css = readAsset("app.css");
const js = readAsset("app.js");

const FROZEN_FIELDS = [
	"totals",
	"cacheHitRate",
	"byDay",
	"byModel",
	"byProvider",
	"byProject",
	"sessions",
	"excluded",
	"scan",
	"range",
];

const REQUIRED_IDS = [
	"days-select",
	"include-all-toggle",
	"refresh-button",
	"status-bar",
	"summary-cards",
	"chart-container",
	"chart-legend",
	"model-table",
	"provider-table",
	"project-table",
	"sessions-table",
	"excluded-panel",
	"excluded-summary",
];

describe("stats panel assets (T-003)", () => {
	it("are non-empty and declare the panel title", () => {
		expect(html.length).toBeGreaterThan(500);
		expect(css.length).toBeGreaterThan(500);
		expect(js.length).toBeGreaterThan(500);
		expect(html).toContain('charset="UTF-8"');
		expect(html).toContain("<title>easy-pi token usage</title>");
	});

	it("reference no external resources (offline/self-contained)", () => {
		for (const [name, text] of [
			["index.html", html],
			["app.css", css],
			["app.js", js],
		] as const) {
			const urls = text.match(/https?:\/\/[^\s"'()<>]+/g) ?? [];
			// The only permitted absolute URI is the SVG XML namespace used by createElementNS.
			for (const url of urls) {
				expect(url, `${name} must not reference ${url}`).toBe("http://www.w3.org/2000/svg");
			}
			expect(text, `${name} must not use protocol-relative URLs`).not.toMatch(/["'(]\/\/[a-z0-9-]+\.[a-z]{2,}/i);
			expect(text, `${name} must not use CSS @import`).not.toContain("@import url(");
		}
		expect(css).not.toMatch(/url\(\s*['"]?https?:/i);
	});

	it("loads only its own css and script", () => {
		const linkHrefs = [...html.matchAll(/<link\b[^>]*href="([^"]+)"/g)].map((match) => match[1]);
		const scriptSrcs = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((match) => match[1]);
		expect(linkHrefs).toEqual(["/app.css"]);
		expect(scriptSrcs).toEqual(["/app.js"]);
	});

	it("requests the frozen stats endpoint from a relative path", () => {
		const fetchTargets = [...js.matchAll(/fetch\(\s*([^,)]+)/g)].map((match) => match[1].trim());
		expect(fetchTargets.length).toBeGreaterThan(0);
		for (const target of fetchTargets) {
			expect(target, `fetch target must not be absolute, got ${target}`).not.toMatch(/^["'`]?https?:/i);
			expect(target, `fetch target must not be protocol-relative, got ${target}`).not.toMatch(/^["'`]?\/\//);
		}
		expect(js).toContain('const API_URL = "/api/stats"');
		expect(js).toContain("URLSearchParams");
	});

	it("renders the frozen snapshot fields", () => {
		for (const field of FROZEN_FIELDS) {
			expect(js, `app.js must read ${field}`).toContain(field);
		}
		expect(js).toContain("includeAll");
		expect(js).toContain("refresh");
	});

	it("formats cost with exactly three decimals", () => {
		expect(js).toMatch(/COST_FRACTION_DIGITS\s*=\s*3/);
		expect(js).toContain("toFixed(COST_FRACTION_DIGITS)");
		expect(js).toMatch(/function fmtCost\(/);
		expect(js).toContain("`$${");
	});

	it("builds the daily chart as inline svg with a stacked series and a cost line", () => {
		expect(js).toContain("createElementNS");
		for (const series of ["input", "cacheRead", "cacheWrite", "output"]) {
			expect(js).toContain(`key: "${series}"`);
		}
		expect(js).toContain("cost-line");
		expect(js).toContain('elNs("title"');
	});

	it("parses as valid JavaScript without imports", () => {
		expect(js).not.toMatch(/^\s*(import|export)\s/m);
		expect(() => new Function(js)).not.toThrow();
	});

	it("keeps every id referenced by app.js present in index.html", () => {
		const referenced = [...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
		expect(referenced.length).toBeGreaterThanOrEqual(10);
		const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
		for (const id of referenced) {
			expect(declared.has(id), `index.html is missing id="${id}"`).toBe(true);
		}
	});

	it("declares every required panel section", () => {
		for (const id of REQUIRED_IDS) {
			expect(html, `index.html must declare id="${id}"`).toContain(`id="${id}"`);
		}
		expect(html).toContain("Include test &amp; temp sessions");
		expect(html).toContain("<select");
	});

	it("documents the cost basis and the local-day convention", () => {
		expect(html).toContain("catalog-rate");
		expect(html.toLowerCase()).toContain("local calendar days");
		expect(js).toContain("cache read / (input + cache read + cache write)");
	});

	it("supports light and dark themes without external fonts", () => {
		expect(css).toContain("prefers-color-scheme: dark");
		expect(css).toContain("--c-input");
		expect(css).toContain("font-variant-numeric: tabular-nums");
		expect(css).not.toMatch(/@font-face/);
	});
});
