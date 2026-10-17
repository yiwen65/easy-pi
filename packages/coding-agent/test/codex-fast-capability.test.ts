import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, createProvider, type Model } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { isCodexFastModeAvailable, resolveCodexServiceTierRequest } from "../src/core/codex-service-tier.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { formatCodexServiceTierLabel } from "../src/modes/interactive/codex-service-tier-ui.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("loads and merges explicit Codex Fast model overrides without losing other capabilities", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-fast-capability-"));
	roots.push(root);
	const path = join(root, "models.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				"openai-codex": {
					modelOverrides: {
						"gpt-6.1-sol": { compat: { supportsFastMode: false } },
						"gpt-5.4": { compat: { supportsFastMode: true } },
					},
				},
			},
		}),
	);
	const config = await ModelConfig.load(path);
	expect(config.getError()).toBeUndefined();
	const registry = await createModelRegistry(AuthStorage.inMemory(), path);
	expect(registry.getError()).toBeUndefined();
	const disabled = registry.find("openai-codex", "gpt-6.1-sol");
	expect(disabled?.compat).toMatchObject({ supportsFastMode: false, supportsOpenAIGrammarTools: true });
	expect(registry.find("openai-codex", "gpt-5.4")?.compat).toMatchObject({ supportsFastMode: true });
});

it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-sol"])(
	"retains Fast eligibility when models.json redefines known Codex model %s",
	async (id) => {
		const root = mkdtempSync(join(tmpdir(), "pi-codex-fast-redefined-"));
		roots.push(root);
		const path = join(root, "models.json");
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					"openai-codex": {
						models: [
							{
								id,
								name: "Custom label",
								contextWindow: 100000,
								maxTokens: 12000,
								compat: { supportsToolSearch: false },
							},
						],
					},
				},
			}),
		);
		const registry = await createModelRegistry(AuthStorage.inMemory(), path);
		expect(registry.getError()).toBeUndefined();
		const model = registry.find("openai-codex", id);
		expect(model).toMatchObject({
			name: "Custom label",
			contextWindow: 100000,
			maxTokens: 12000,
			compat: { supportsFastMode: true, supportsToolSearch: false },
		});
		// Custom definitions still replace unrelated built-in metadata.
		expect(model?.compat ?? {}).not.toHaveProperty("supportsOpenAIGrammarTools");
		expect(isCodexFastModeAvailable(model)).toBe(true);
		expect(resolveCodexServiceTierRequest(model!, "fast")).toBe("fast");
		expect(
			formatCodexServiceTierLabel({
				preference: "fast",
				source: "settings",
				available: isCodexFastModeAvailable(model),
			}),
		).toBe("fast");
	},
);

it.each(
	([undefined, false, true] as const).flatMap((providerFlag) =>
		([undefined, false, true] as const).flatMap((modelFlag) =>
			([undefined, false, true] as const).map((overrideFlag) => ({ providerFlag, modelFlag, overrideFlag })),
		),
	),
)(
	"keeps explicit capability precedence: provider=$providerFlag model=$modelFlag override=$overrideFlag",
	async ({ providerFlag, modelFlag, overrideFlag }) => {
		const root = mkdtempSync(join(tmpdir(), "pi-codex-fast-precedence-"));
		roots.push(root);
		const path = join(root, "models.json");
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					"openai-codex": {
						compat: { supportsFastMode: providerFlag },
						models: [{ id: "gpt-6-astra", compat: { supportsFastMode: modelFlag } }],
						modelOverrides: { "gpt-6-astra": { compat: { supportsFastMode: overrideFlag } } },
					},
				},
			}),
		);
		const registry = await createModelRegistry(AuthStorage.inMemory(), path);
		expect(registry.getError()).toBeUndefined();
		const selected = registry.find("openai-codex", "gpt-6-astra");
		const expected = overrideFlag ?? modelFlag ?? providerFlag ?? true;
		expect(selected?.compat).toMatchObject({ supportsFastMode: expected });
		expect(isCodexFastModeAvailable(selected)).toBe(expected);
	},
);

it.each([
	{
		provider: "openai-codex",
		id: "unknown-model",
		baseApi: "openai-codex-responses",
		api: "openai-codex-responses",
		baseFlag: true,
		expected: undefined,
	},
	{
		provider: "openai-codex",
		id: "gpt-6-astra",
		baseApi: "openai-codex-responses",
		api: "openai-responses",
		baseFlag: true,
		expected: undefined,
	},
	{
		provider: "openai-codex",
		id: "gpt-6-astra",
		baseApi: "openai-responses",
		api: "openai-codex-responses",
		baseFlag: true,
		expected: undefined,
	},
	{
		provider: "other-provider",
		id: "gpt-6-astra",
		baseApi: "openai-codex-responses",
		api: "openai-codex-responses",
		baseFlag: true,
		expected: undefined,
	},
	{
		provider: "openai-codex",
		id: "gpt-6-astra",
		baseApi: "openai-codex-responses",
		api: "openai-codex-responses",
		baseFlag: false,
		expected: false,
	},
] as const)(
	"limits inheritance to matching Codex identity: $provider/$id $baseApi->$api ($baseFlag)",
	async ({ provider, id, baseApi, api, baseFlag, expected }) => {
		const root = mkdtempSync(join(tmpdir(), "pi-codex-fast-identity-"));
		roots.push(root);
		const path = join(root, "models.json");
		writeFileSync(path, JSON.stringify({ providers: { [provider]: { models: [{ id, api }] } } }));
		const known: Model<Api> = {
			id: "gpt-6-astra",
			name: "Known",
			api: baseApi,
			provider,
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			contextWindow: 100000,
			maxTokens: 10000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsFastMode: baseFlag },
		};
		const base = createProvider({
			id: provider,
			models: [known],
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		});
		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		const composed = composeModelProvider(provider, base, config, undefined);
		const selected = composed.getModels().find((model) => model.id === id);
		expect(selected).toBeDefined();
		if (expected === undefined) expect(selected?.compat ?? {}).not.toHaveProperty("supportsFastMode");
		else expect(selected?.compat).toMatchObject({ supportsFastMode: expected });
		expect(isCodexFastModeAvailable(selected)).toBe(false);
	},
);

it("keeps unknown models unmarked and supports explicit custom Codex capability declarations", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-fast-custom-"));
	roots.push(root);
	const path = join(root, "models.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				"openai-codex": {
					models: [
						{ id: "custom-fast", api: "openai-codex-responses", compat: { supportsFastMode: true } },
						{ id: "custom-unknown", api: "openai-codex-responses" },
					],
				},
			},
		}),
	);
	const registry = await createModelRegistry(AuthStorage.inMemory(), path);
	expect(registry.getError()).toBeUndefined();
	expect(registry.find("openai-codex", "custom-fast")?.compat).toMatchObject({ supportsFastMode: true });
	expect(registry.find("openai-codex", "custom-unknown")?.compat ?? {}).not.toHaveProperty("supportsFastMode");
});
