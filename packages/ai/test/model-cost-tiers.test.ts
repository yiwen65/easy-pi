import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createModelDataManifest,
	MODEL_DATA_MANIFEST_FILE,
	type ModelDataStructure,
	validateModelDataDirectory,
} from "../scripts/model-data.ts";
import { streamSimple as streamSimpleOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { calculateCost, clampThinkingLevel, getSupportedThinkingLevels, hasApi } from "../src/models.ts";
import type { Api, Model, Usage } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const base = { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 1.25 };
const tiers = [
	{ inputTokensAbove: 100000, input: 2, output: 5, cacheRead: 0.2, cacheWrite: 1.25 },
	{ inputTokensAbove: 200000, input: 1, output: 12, cacheRead: 0, cacheWrite: 2.5 },
];
const sourceCost = {
	input: 1,
	output: 5,
	cache_read: 0.2,
	cache_write: 1.25,
	tiers: [
		{ tier: { type: "context", size: 200000 }, output: 12, cache_read: 0, cache_write: 2.5 },
		{ tier: { type: "context", size: 100000 }, input: 2 },
		{ tier: { type: "time", size: 50000 }, input: 3 },
		{ tier: { type: "context", size: -1 }, input: 3 },
		{ tier: { type: "context", size: 1.5 }, input: 3 },
	],
};
const sourceModel = {
	id: "tiered-fixture",
	name: "Offline tier fixture",
	tool_call: true,
	reasoning: true,
	reasoning_options: [{ type: "effort", values: ["low", "high"] }],
	modalities: { input: ["text", "image"], output: ["text"] },
	provider: { npm: "@ai-sdk/anthropic" },
	limit: { context: 500000, output: 8192 },
	cost: sourceCost,
};
const providerModels = [
	["amazon-bedrock", "anthropic.claude-fixture", "amazon-bedrock"],
	["anthropic", "tiered-fixture", "anthropic"],
	["google", "tiered-fixture", "google"],
	["google-vertex", "gemini-tiered-fixture", "google-vertex"],
	["openai", "tiered-fixture", "openai"],
	["groq", "tiered-fixture", "groq"],
	["cerebras", "tiered-fixture", "cerebras"],
	["cloudflare-workers-ai", "tiered-fixture", "cloudflare-workers-ai"],
	["cloudflare-ai-gateway", "anthropic/tiered-fixture", "cloudflare-ai-gateway"],
	["xai", "tiered-fixture", "xai"],
	["zai-coding-plan", "tiered-fixture", "zai"],
	["zhipuai-coding-plan", "tiered-fixture", "zai-coding-cn"],
	["mistral", "tiered-fixture", "mistral"],
	["huggingface", "tiered-fixture", "huggingface"],
	["fireworks-ai", "tiered-fixture", "fireworks"],
	["nvidia", "tiered-fixture", "nvidia"],
	["together", "tiered-fixture", "together"],
	["baseten", "tiered-fixture", "baseten"],
	["opencode", "tiered-fixture", "opencode"],
	["opencode-go", "tiered-fixture", "opencode-go"],
	["github-copilot", "tiered-fixture", "github-copilot"],
	["minimax", "MiniMax-M3", "minimax"],
	["minimax-cn", "MiniMax-M3", "minimax-cn"],
	["kimi-code-plan-cn", "tiered-fixture", "kimi-coding"],
	["moonshotai", "tiered-fixture", "moonshotai"],
	["moonshotai-cn", "tiered-fixture", "moonshotai-cn"],
	["xiaomi", "tiered-fixture", "xiaomi"],
	["xiaomi-token-plan-cn", "tiered-fixture", "xiaomi-token-plan-cn"],
	["xiaomi-token-plan-ams", "tiered-fixture", "xiaomi-token-plan-ams"],
	["xiaomi-token-plan-sgp", "tiered-fixture", "xiaomi-token-plan-sgp"],
	["alibaba-token-plan-cn", "tiered-fixture", "qwen-token-plan-cn"],
] as const;
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

let fixtureRoot: string;
let catalog: Record<string, Record<string, Model<Api>>>;
let catalogWithSol: Record<string, Record<string, Model<Api>>>;
const solProviders = ["openai", "azure-openai-responses", "openai-codex"] as const;

beforeAll(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "pi-cost-tiers-"));
	const isolatedPackageRoot = join(fixtureRoot, "package");
	mkdirSync(join(isolatedPackageRoot, "src/api"), { recursive: true });
	// Only executable inputs are copied. --json-only never rewrites the real generated products.
	cpSync(join(packageRoot, "scripts"), join(isolatedPackageRoot, "scripts"), { recursive: true });
	for (const path of ["package.json", "src/types.ts", "src/api/cloudflare.ts"]) {
		cpSync(join(packageRoot, path), join(isolatedPackageRoot, path));
	}
	const modelsDev: Record<string, { models: Record<string, unknown> }> = {};
	for (const [source, id] of providerModels) {
		modelsDev[source] = { models: { [id]: { ...sourceModel, id } } };
	}
	modelsDev["alibaba-token-plan"] = {
		models: Object.fromEntries(individualIds.map((id) => [id, { ...sourceModel, id }])),
	};
	modelsDev.google.models["gemini-2.5-flash"] = { ...sourceModel, id: "gemini-2.5-flash" };
	modelsDev["google-vertex"].models["gemini-2.5-flash"] = { ...sourceModel, id: "gemini-2.5-flash" };
	modelsDev.mistral.models["cache-fallback"] = { ...sourceModel, cost: { ...sourceCost, cache_read: undefined } };
	modelsDev["kimi-code-plan-cn"].models["kimi-for-coding"] = {
		...sourceModel,
		cost: { ...sourceCost, input: 0, output: 0, cache_read: 0, cache_write: 0 },
	};
	modelsDev.anthropic.models["invalid-rates"] = {
		...sourceModel,
		cost: {
			input: "bad",
			output: -1,
			cache_read: null,
			tiers: [{ tier: { type: "context", size: 10 }, input: "bad" }],
		},
	};
	const openRouter = (id: string, pricing: unknown, supported_parameters = ["tools", "reasoning"]) => ({
		id,
		name: id,
		supported_parameters,
		pricing,
		architecture: { modality: "text+image->text" },
		top_provider: { context_length: 500000, max_completion_tokens: 8192 },
	});
	const perTokenBase = {
		prompt: "0.000001",
		completion: "0.000005",
		input_cache_read: "0.0000002",
		input_cache_write: "0.00000125",
	};
	const fixtures = {
		"https://models.dev/api.json": modelsDev,
		"https://integrate.api.nvidia.com/v1/models": { data: [{ id: "tiered-fixture" }] },
		"https://openrouter.ai/api/v1/models": {
			data: [
				openRouter("tiered-fixture", {
					...perTokenBase,
					overrides: [
						{
							min_prompt_tokens: 200000,
							completion: "0.000012",
							input_cache_read: "0",
							input_cache_write: "0.0000025",
						},
						{ min_prompt_tokens: 100000, prompt: "0.000002" },
						{ min_prompt_tokens: 1, utc_start: 0, prompt: "0" },
						{ min_prompt_tokens: 1, utc_end: 1600, prompt: "0" },
						{ min_prompt_tokens: 1, utc_days: [], prompt: "0" },
						{ min_prompt_tokens: -1, prompt: "0" },
						{ min_prompt_tokens: 1.5, prompt: "0" },
					],
				}),
				openRouter("invalid-rates", {
					prompt: "bad",
					completion: "Infinity",
					input_cache_read: "-1",
					overrides: [{ min_prompt_tokens: 10, prompt: "NaN", completion: "0.000001garbage" }],
				}),
				openRouter("time-only", { ...perTokenBase, overrides: [{ utc_days: ["saturday"], prompt: "0" }] }),
				openRouter("no-tools", perTokenBase, []),
			],
		},
		"https://ai-gateway.vercel.sh/v1/models": {
			data: [
				{
					id: "tiered-fixture",
					name: "Gateway fixture",
					tags: ["tool-use", "vision", "reasoning"],
					context_window: 500000,
					max_tokens: 8192,
					pricing: {
						input: "0.000001",
						output: "0.000005",
						input_cache_read: "0.0000002",
						input_cache_write: "0.00000125",
						input_tiers: [
							{ min: 0, max: 32001, cost: "0.000001" },
							{ min: 32001, max: 128001, cost: "0.0000018" },
							{ min: 128001, cost: "0.000003" },
						],
						output_tiers: [{ min: 64001, max: 200001, cost: "0.000009" }],
						input_cache_read_tiers: [{ min: 128001, cost: "0" }],
						input_cache_write_tiers: [
							{ min: -1, cost: "1" },
							{ min: 1.5, cost: "1" },
							{ min: 10, max: 5, cost: "1" },
						],
					},
				},
				{
					id: "invalid-rates",
					tags: ["tool-use"],
					pricing: {
						input: "bad",
						output: "Infinity",
						input_cache_read: "-1",
						input_tiers: [{ min: 10, cost: "NaN" }],
					},
				},
				{ id: "no-tools", tags: [], pricing: { input: "1" } },
			],
		},
	};
	const generateCatalog = (): Record<string, Record<string, Model<Api>>> => {
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
		const evidenceDir = process.env.PI_SOL_EVIDENCE_DIR;
		if (evidenceDir && !modelsDev.openai.models["gpt-6.1-sol"]) {
			mkdirSync(evidenceDir, { recursive: true });
			cpSync(preloadPath, join(evidenceDir, "generator-replay.mjs"));
		}
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
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		return JSON.parse(readFileSync(join(outputDir, "models.json"), "utf8"));
	};
	catalog = generateCatalog();
	// An incoming catalog must not override source-defined Sol prices or effort restrictions.
	modelsDev.openai.models["gpt-6.1-sol"] = {
		...sourceModel,
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		reasoning_options: [{ type: "effort", values: ["none", "low"] }],
		limit: { context: 1050000, output: 999999 },
	};
	catalogWithSol = generateCatalog();
});

afterAll(() => {
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

function usage(input: number, cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0): Usage {
	return {
		input,
		output: 100,
		cacheRead,
		cacheWrite,
		cacheWrite1h,
		reasoning: 80,
		totalTokens: input + cacheRead + cacheWrite + 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function sortedCost(model: Model<Api>) {
	return { ...model.cost, tiers: model.cost.tiers?.slice().sort((a, b) => a.inputTokensAbove - b.inputTokensAbove) };
}

describe("catalog pricing through the offline generator", () => {
	it.each(providerModels)("preserves models.dev tiers for %s", (_source, sourceId, provider) => {
		const id = provider === "cloudflare-ai-gateway" ? "tiered-fixture" : sourceId;
		const model = catalog[provider][id];
		const expected =
			provider === "google-vertex"
				? { ...base, cacheWrite: 0, tiers: tiers.map((tier) => ({ ...tier, cacheWrite: 0 })) }
				: { ...base, tiers };
		expect(sortedCost(model)).toEqual(expected);
		expect(model).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 500000,
			maxTokens: 8192,
		});
	});

	it("preserves derived catalogs and existing provider-specific cache corrections", () => {
		for (const provider of ["qwen-token-plan", "qwen-token-plan-individual"]) {
			expect(sortedCost(catalog[provider]["qwen3.8-max"])).toEqual({ ...base, tiers });
		}
		expect(sortedCost(catalog["azure-openai-responses"]["tiered-fixture"])).toEqual({ ...base, tiers });
		expect(sortedCost(catalog["cloudflare-ai-gateway"]["workers-ai/tiered-fixture"])).toEqual({ ...base, tiers });
		expect(sortedCost(catalog["google-vertex"]["gemini-2.5-flash"])).toEqual({
			...base,
			cacheRead: 0.03,
			cacheWrite: 0,
			tiers: tiers.map((tier) => ({ ...tier, cacheRead: 0.03, cacheWrite: 0 })),
		});
		expect(catalog.mistral["cache-fallback"].cost).toMatchObject({ cacheRead: 0.1 });
		expect(
			catalog.mistral["cache-fallback"].cost.tiers?.find((tier) => tier.inputTokensAbove === 100000)?.cacheRead,
		).toBe(0.1);
		expect(catalog["kimi-coding"]["kimi-for-coding"].cost).toMatchObject({
			input: 0.95,
			output: 4,
			cacheRead: 0.19,
			cacheWrite: 0,
		});
	});

	it("keeps reasoning maps, endpoint selection and compatibility metadata", () => {
		expect(catalog.baseten["tiered-fixture"]).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://inference.baseten.co/v1",
			thinkingLevelMap: { low: "low", high: "high", medium: null },
			compat: { supportsReasoningEffort: true, supportsStrictMode: true, thinkingFormat: "openai" },
		});
		expect(catalog["opencode-go"]["tiered-fixture"].api).toBe("anthropic-messages");
		expect(catalog["vercel-ai-gateway"]["tiered-fixture"].api).toBe("anthropic-messages");
		expect(catalog["vercel-ai-gateway"]["tiered-fixture"].compat).toBeUndefined();
		expect(catalog.openrouter["no-tools"]).toBeUndefined();
		expect(catalog["vercel-ai-gateway"]["no-tools"]).toBeUndefined();
	});

	it("converts OpenRouter per-token overrides while skipping time-of-day overlays", () => {
		expect(sortedCost(catalog.openrouter["tiered-fixture"])).toEqual({ ...base, tiers });
		expect(catalog.openrouter["time-only"].cost).toEqual(base);
	});

	it("combines Gateway per-rate inclusive brackets and restores base rates at bracket ends", () => {
		expect(catalog["vercel-ai-gateway"]["tiered-fixture"].cost).toEqual({
			...base,
			tiers: [
				{ ...base, inputTokensAbove: 32000, input: 1.8 },
				{ ...base, inputTokensAbove: 64000, input: 1.8, output: 9 },
				{ ...base, inputTokensAbove: 128000, input: 3, output: 9, cacheRead: 0 },
				{ ...base, inputTokensAbove: 200000, input: 3, cacheRead: 0 },
			],
		});
	});

	it("does not serialize invalid rates as NaN/null or accept negative prices", () => {
		for (const provider of ["anthropic", "openrouter", "vercel-ai-gateway"]) {
			const cost = catalog[provider]["invalid-rates"].cost;
			expect(cost).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			for (const tier of cost.tiers ?? []) {
				expect(tier).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			}
		}
	});

	it.each(["anthropic", "openrouter"])("uses > thresholds and prompt cache totals for %s", (provider) => {
		const model = catalog[provider]["tiered-fixture"];
		const atThreshold = calculateCost(model, usage(70000, 20000, 10000, 4000));
		expect(atThreshold.input).toBeCloseTo(0.07);
		expect(atThreshold.output).toBeCloseTo(0.0005);
		const longUsage = usage(70001, 20000, 10000, 4000);
		const cost = calculateCost(model, longUsage);
		expect(cost.input).toBeCloseTo(0.140002);
		expect(cost.output).toBeCloseTo(0.0005);
		expect(cost.cacheRead).toBeCloseTo(0.004);
		// 1h writes are a subset of cacheWrite, not additional prompt tokens.
		expect(cost.cacheWrite).toBeCloseTo((6000 * 1.25 + 4000 * 2 * 2) / 1000000);
		expect(longUsage.reasoning).toBe(80);
		const outputHeavyUsage = usage(100000);
		outputHeavyUsage.output = 500000;
		outputHeavyUsage.reasoning = 400000;
		expect(calculateCost(model, outputHeavyUsage).input).toBeCloseTo(0.1);
		expect(calculateCost(model, usage(200001)).output).toBeCloseTo(0.0012);
	});

	it("uses inclusive Gateway minima and applies the highest matching tier request-wide", () => {
		const model = catalog["vercel-ai-gateway"]["tiered-fixture"];
		expect(calculateCost(model, usage(32000)).input).toBeCloseTo(0.032);
		expect(calculateCost(model, usage(32001)).input).toBeCloseTo(0.0576018);
		expect(calculateCost(model, usage(128001)).output).toBeCloseTo(0.0009);
		expect(calculateCost(model, usage(200001)).output).toBeCloseTo(0.0005);
	});
});

const solCost = {
	input: 2,
	output: 10,
	cacheRead: 0.1,
	cacheWrite: 2.5,
	tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
};

describe("source-defined GPT-6.1 Sol through the offline generator", () => {
	it.each(solProviders)("emits official fallback metadata and capabilities for %s", (provider) => {
		const model = catalog[provider]?.["gpt-6.1-sol"];
		expect(model).toBeDefined();
		expect(model).toMatchObject({
			id: "gpt-6.1-sol",
			name: "GPT-6.1 Sol",
			provider,
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 272000,
			maxTokens: 128000,
			cost: solCost,
			thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
			compat: { supportsOpenAIGrammarTools: true },
		});
		expect(model.api).toBe(
			provider === "openai"
				? "openai-responses"
				: provider === "openai-codex"
					? "openai-codex-responses"
					: "azure-openai-responses",
		);
		expect(model.baseUrl).toBe(
			provider === "openai"
				? "https://api.openai.com/v1"
				: provider === "openai-codex"
					? "https://chatgpt.com/backend-api"
					: "",
		);
		expect(getSupportedThinkingLevels(model)).toEqual(
			provider === "openai-codex"
				? ["minimal", "low", "medium", "high", "xhigh", "max"]
				: ["low", "medium", "high", "xhigh", "max"],
		);
		expect(model.thinkingLevelMap?.minimal).toBe(provider === "openai-codex" ? "low" : null);
		expect(clampThinkingLevel(model, "off")).toBe(provider === "openai-codex" ? "minimal" : "low");
		if (provider !== "azure-openai-responses") {
			expect(model.compat).toMatchObject({ supportsToolSearch: true, supportsAdditionalTools: true });
		}
		if (provider === "openai") {
			expect(model.compat).toMatchObject({ supportsStrictMode: true, supportsExplicitPromptCacheMode: true });
		}
	});

	it.each(solProviders)(
		"retains source-defined prices and unsupported none when catalogs already list %s/Sol",
		(provider) => {
			const model = catalogWithSol[provider]?.["gpt-6.1-sol"];
			expect(model).toBeDefined();
			expect(model.cost).toEqual(solCost);
			expect(model.contextWindow).toBe(272000);
			expect(model.maxTokens).toBe(128000);
			expect(getSupportedThinkingLevels(model)).toEqual(
				getSupportedThinkingLevels(catalog[provider]["gpt-6.1-sol"]),
			);
		},
	);

	it.each(solProviders)("uses the >272k request-wide price boundary for %s", (provider) => {
		const model = catalog[provider]?.["gpt-6.1-sol"];
		expect(model).toBeDefined();
		const atThreshold = usage(200000, 62000, 10000, 4000);
		const shortCost = calculateCost(model, atThreshold);
		expect(shortCost.input).toBeCloseTo(0.4, 8);
		expect(shortCost.output).toBeCloseTo(0.001, 8);
		expect(shortCost.cacheRead).toBeCloseTo(0.0062, 8);
		expect(shortCost.cacheWrite).toBeCloseTo(0.031, 8);
		const aboveThreshold = usage(200001, 62000, 10000, 4000);
		const longCost = calculateCost(model, aboveThreshold);
		expect(longCost.input).toBeCloseTo(0.800004, 8);
		expect(longCost.output).toBeCloseTo(0.0015, 8);
		expect(longCost.cacheRead).toBeCloseTo(0.0124, 8);
		expect(longCost.cacheWrite).toBeCloseTo(0.062, 8);
	});

	it.each(["max", "xhigh", "off"] as const)(
		"sends supported native Codex effort for Sol/%s without networking",
		async (reasoning) => {
			const model = catalog["openai-codex"]?.["gpt-6.1-sol"];
			expect(model).toBeDefined();
			if (!hasApi(model, "openai-codex-responses")) throw new Error("Expected a Codex Responses model");
			expect(getSupportedThinkingLevels(model)).not.toContain("off");
			const clampedReasoning = clampThinkingLevel(model, reasoning);
			expect(clampedReasoning).toBe(reasoning === "off" ? "minimal" : reasoning);
			if (clampedReasoning === "off") throw new Error("Sol must clamp unsupported off to a valid thinking level");
			const account = Buffer.from(
				JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			).toString("base64");
			let payload: unknown;
			await streamSimpleOpenAICodexResponses(
				model,
				{ messages: [{ role: "user", content: "offline payload capture", timestamp: 0 }] },
				{
					apiKey: `aaa.${account}.bbb`,
					reasoning: clampedReasoning,
					onPayload: (request) => {
						payload = request;
						throw new Error("payload captured");
					},
				},
			).result();
			expect(payload).toMatchObject({ reasoning: { effort: reasoning === "off" ? "low" : reasoning } });
		},
	);

	it("validates and optionally exports only the three source-defined Sol records", () => {
		const dataDir = join(fixtureRoot, "sol-only-data");
		mkdirSync(dataDir);
		const structure: ModelDataStructure = {};
		const files: Record<string, string> = {};
		const records: Record<string, Record<string, Record<string, Model<Api>>>> = {};
		for (const provider of solProviders) {
			const model = catalog[provider]?.["gpt-6.1-sol"];
			expect(model).toBeDefined();
			expect(model.cost).toEqual(solCost);
			structure[provider] = { [model.id]: model.api };
			records[provider] = { [model.api]: { [model.id]: model } };
			files[`${provider}.json`] = `${JSON.stringify(records[provider])}\n`;
			writeFileSync(join(dataDir, `${provider}.json`), files[`${provider}.json`]);
		}
		writeFileSync(
			join(dataDir, MODEL_DATA_MANIFEST_FILE),
			JSON.stringify(createModelDataManifest(structure, files, new Date().toISOString())),
		);
		expect(() => validateModelDataDirectory(structure, dataDir)).not.toThrow();
		// Evidence export is opt-in and contains no synthetic non-Sol catalog rows.
		const evidenceDir = process.env.PI_SOL_EVIDENCE_DIR;
		if (evidenceDir) {
			mkdirSync(evidenceDir, { recursive: true });
			writeFileSync(join(evidenceDir, "sol-records.json"), `${JSON.stringify(records, null, 2)}\n`);
		}
	});
});
