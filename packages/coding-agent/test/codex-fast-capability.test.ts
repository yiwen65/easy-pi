import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
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
