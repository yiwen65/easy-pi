import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("strict model generation", () => {
	it.each([false, true])("generates Kimi data from the matching regional catalog (dataOnly=%s)", (dataOnly) => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-kimi-models-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		// Hydration should need only the provider under test, independent of local generated data.
		const providersDir = join(isolatedPackageRoot, "src/providers");
		rmSync(providersDir, { recursive: true });
		mkdirSync(providersDir);
		cpSync(join(packageRoot, "src/providers/kimi-coding.models.ts"), join(providersDir, "kimi-coding.models.ts"));
		writeFileSync(
			join(isolatedPackageRoot, "src/models.generated.ts"),
			'import { KIMI_CODING_MODELS } from "./providers/kimi-coding.models.ts";\n',
		);
		const modelIds = [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-max",
		];
		const catalog = {
			"alibaba-token-plan": {
				models: Object.fromEntries(modelIds.map((id) => [id, { id, name: id, tool_call: true }])),
			},
			"kimi-code-plan-cn": {
				models: {
					"kimi-for-coding": {
						id: "kimi-for-coding",
						name: "Kimi CN",
						tool_call: true,
						reasoning: true,
						limit: { context: 1048576, output: 32768 },
						modalities: { input: ["text", "image"] },
					},
				},
			},
			"kimi-code-plan-global": {
				models: {
					"global-only": { id: "global-only", name: "Global only", tool_call: true },
				},
			},
		};
		const preloadPath = join(fixtureRoot, "mock-catalog.mjs");
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  const url = String(input);\n` +
				`  if (url === "https://models.dev/api.json") return Response.json(catalog);\n` +
				`  if (["https://openrouter.ai/api/v1/models", "https://ai-gateway.vercel.sh/v1/models"].includes(url)) return Response.json({ data: [] });\n` +
				`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
				`};\n`,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--strict",
				...(dataOnly ? ["--data-only"] : []),
			],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 },
		);
		expect(result.status, result.stderr).toBe(0);
		const values = JSON.parse(readFileSync(join(providersDir, "data/kimi-coding.json"), "utf8"));
		expect(Object.keys(values["anthropic-messages"])).toEqual(["kimi-for-coding"]);
		expect(values["anthropic-messages"]["kimi-for-coding"]).toMatchObject({
			provider: "kimi-coding",
			baseUrl: "https://api.kimi.com/coding",
			name: "Kimi CN",
			contextWindow: 1048576,
			maxTokens: 32768,
		});
	});

	it("preserves Together DeepSeek effort metadata for versioned model IDs", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-together-models-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		const modelId = "deepseek-ai/DeepSeek-V4-Pro-0813";
		const catalog = {
			together: {
				models: {
					[modelId]: {
						id: modelId,
						tool_call: true,
						reasoning: true,
						reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
					},
				},
			},
		};
		const preloadPath = join(fixtureRoot, "mock-catalog.mjs");
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  if (String(input) === "https://models.dev/api.json") return Response.json(catalog);\n` +
				`  return Response.json({ data: [] });\n` +
				`};\n`,
		);
		const outputDir = join(fixtureRoot, "catalog");
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--json-only",
				"--json-output",
				outputDir,
			],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 },
		);
		expect(result.status, result.stderr).toBe(0);
		const values = JSON.parse(readFileSync(join(outputDir, "providers/together.json"), "utf8"));
		expect(values[modelId].thinkingLevelMap).toEqual({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		expect(values[modelId].compat).toMatchObject({ supportsReasoningEffort: true, thinkingFormat: "together" });
	});

	it("fails before mutating generated data when an Individual model loses tool support", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
		const modelIds = [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-max",
			"qwen3.8-max-preview",
		];
		const sourceModels = Object.fromEntries(
			modelIds.map((id) => [
				id,
				{
					id,
					name: id,
					tool_call: id !== "deepseek-v4-flash-0731",
				},
			]),
		);
		const catalog = { "alibaba-token-plan": { models: sourceModels } };
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  if (String(input) === "https://models.dev/api.json") {\n` +
				`    return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  }\n` +
				`  throw new Error(\`Unexpected fetch: \${String(input)}\`);\n` +
				`};\n`,
		);

		const generatedPaths = [
			"src/models.generated.ts",
			"src/providers/qwen-token-plan-individual.models.ts",
			"src/providers/data/qwen-token-plan-individual.json",
			"src/providers/data/.manifest.json",
		];
		const sourceBefore = generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"));
		const isolatedBefore = generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"));

		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict"],
			{
				cwd: isolatedPackageRoot,
				encoding: "utf8",
				timeout: 10_000,
			},
		);

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"qwen-token-plan-individual model IDs do not match (missing: deepseek-v4-flash-0731)",
		);
		expect(generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"))).toEqual(
			isolatedBefore,
		);
		expect(generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"))).toEqual(sourceBefore);
	});
});
