import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelsDevCost } from "../scripts/catalog-pricing.ts";
import type { Api, Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const moonshotProviders = ["moonshotai", "moonshotai-cn"] as const;
const kimiK3Cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 };
const sourceRates = { input: 3, output: 15, cache_read: 0.3 };
const cases: { name: string; cost: ModelsDevCost | undefined; expectedCost: Model<Api>["cost"] }[] = [
	{ name: "missing cost", cost: undefined, expectedCost: kimiK3Cost },
	{ name: "missing cache write", cost: sourceRates, expectedCost: kimiK3Cost },
	{ name: "stale zero cache write", cost: { ...sourceRates, cache_write: 0 }, expectedCost: kimiK3Cost },
	{ name: "current cache write", cost: { ...sourceRates, cache_write: 3 }, expectedCost: kimiK3Cost },
	{
		name: "explicit nonzero cache write and context tier",
		cost: {
			...sourceRates,
			cache_write: 4.5,
			tiers: [{ tier: { type: "context", size: 200000 }, input: 6, output: 30, cache_read: 0.6, cache_write: 5 }],
		},
		expectedCost: {
			...kimiK3Cost,
			cacheWrite: 4.5,
			tiers: [{ inputTokensAbove: 200000, input: 6, output: 30, cacheRead: 0.6, cacheWrite: 5 }],
		},
	},
];

let fixtureRoot: string;
const catalogs: Record<string, Record<string, Record<string, Model<Api>>>> = {};

beforeAll(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "pi-moonshot-k3-pricing-"));
	const isolatedPackageRoot = join(fixtureRoot, "package");
	mkdirSync(join(isolatedPackageRoot, "src/api"), { recursive: true });
	// Execute the real generator, but only copy its inputs and emit JSON into the fixture directory.
	cpSync(join(packageRoot, "scripts"), join(isolatedPackageRoot, "scripts"), { recursive: true });
	for (const path of ["package.json", "src/types.ts", "src/api/cloudflare.ts"]) {
		cpSync(join(packageRoot, path), join(isolatedPackageRoot, path));
	}
	const individualIds = [
		"deepseek-v4-flash-0731",
		"deepseek-v4-pro",
		"deepseek-v4-pro-0813",
		"glm-5.2",
		"qwen3.6-flash",
		"qwen3.7-max",
		"qwen3.7-plus",
		"qwen3.8-max",
	];
	const sourceModel = { tool_call: true, limit: { context: 1048576, output: 131072 } };
	for (const testCase of cases) {
		const fixtures = {
			"https://models.dev/api.json": {
				...Object.fromEntries(
					moonshotProviders.map((provider) => [
						provider,
						{
							models: {
								"kimi-k3": { ...sourceModel, cost: testCase.cost },
								"kimi-k3-preview": sourceModel,
								"kimi-k2.7-code": {
									...sourceModel,
									cost: { input: 0.95, output: 4, cache_read: 0.19, cache_write: 0 },
								},
							},
						},
					]),
				),
				openai: { models: { "kimi-k3": sourceModel } },
				"kimi-code-plan-cn": {
					models: { k3: { ...sourceModel, cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } },
				},
				"alibaba-token-plan": {
					models: Object.fromEntries(individualIds.map((id) => [id, { tool_call: true }])),
				},
			},
			"https://openrouter.ai/api/v1/models": { data: [] },
			"https://ai-gateway.vercel.sh/v1/models": { data: [] },
		};
		const preloadPath = join(fixtureRoot, "catalog-fixtures.mjs");
		writeFileSync(
			preloadPath,
			`const fixtures = ${JSON.stringify(fixtures)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  const url = String(input);\n` +
				`  if (!Object.hasOwn(fixtures, url)) throw new Error(\`Unexpected fetch: \${url}\`);\n` +
				`  return Response.json(fixtures[url]);\n` +
				`};\n`,
		);
		const outputDir = join(fixtureRoot, "catalog");
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--strict",
				"--json-only",
				"--json-output",
				outputDir,
			],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10000 },
		);
		expect(result.status, `${testCase.name}\n${result.stdout}\n${result.stderr}`).toBe(0);
		catalogs[testCase.name] = JSON.parse(readFileSync(join(outputDir, "models.json"), "utf8"));
	}
});

afterAll(() => {
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("Moonshot Kimi K3 pricing through the offline generator", () => {
	describe.each(moonshotProviders)("%s", (provider) => {
		it.each(cases)("uses default 5min cache-write pricing for $name", ({ name, expectedCost }) => {
			expect(catalogs[name][provider]["kimi-k3"].cost).toEqual(expectedCost);
		});
	});

	it.each(cases)("keeps other models and Kimi Coding costs unchanged for $name", ({ name }) => {
		const catalog = catalogs[name];
		const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		for (const provider of moonshotProviders) {
			expect(catalog[provider]["kimi-k3-preview"].cost).toEqual(zeroCost);
			expect(catalog[provider]["kimi-k2.7-code"].cost).toEqual({
				input: 0.95,
				output: 4,
				cacheRead: 0.19,
				cacheWrite: 0,
			});
		}
		expect(catalog.openai["kimi-k3"].cost).toEqual(zeroCost);
		expect(catalog["kimi-coding"].k3.cost).toEqual({ ...kimiK3Cost, cacheWrite: 0 });
	});
});
