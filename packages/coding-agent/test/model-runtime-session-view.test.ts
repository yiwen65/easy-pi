import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const models = [
	{
		id: "original",
		name: "Original",
		reasoning: false,
		input: ["text" as const],
		contextWindow: 32000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
];

test("session views isolate both provider registration and unregister, including sibling views", async () => {
	const root = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	root.registerProvider("view-test", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		apiKey: "synthetic-key",
		models,
	});
	const a = await root.createSessionView();
	const b = await root.createSessionView();
	a.registerProvider("view-test", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		models: [{ ...models[0], id: "child-only" }],
	});
	expect(a.getModel("view-test", "child-only")).toBeDefined();
	expect(root.getModel("view-test", "child-only")).toBeUndefined();
	expect(b.getModel("view-test", "child-only")).toBeUndefined();
	a.unregisterProvider("view-test");
	expect(a.getModel("view-test", "original")).toBeUndefined();
	expect(root.getModel("view-test", "original")).toBeDefined();
	expect(b.getModel("view-test", "original")).toBeDefined();
	await root.setRuntimeApiKey("view-test", "synthetic-updated-key");
	expect((await b.getAuth("view-test"))?.auth.apiKey).toBe("synthetic-updated-key");
});

test("session views retain configured headers and do not discard model configuration on refresh", async () => {
	const directory = await mkdtemp(join(tmpdir(), "epi-model-view-"));
	try {
		await mkdir(join(directory, "agent"));
		const modelsPath = join(directory, "agent", "models.json");
		await writeFile(
			modelsPath,
			JSON.stringify({
				providers: {
					"configured-view": {
						api: "openai-completions",
						baseUrl: "https://example.invalid",
						apiKey: "synthetic-config-key",
						headers: { "x-configured": "preserved" },
						models,
					},
				},
			}),
		);
		const root = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath,
			allowModelNetwork: false,
		});
		const child = await root.createSessionView();
		const model = root.getModel("configured-view", "original")!;
		expect(child.getModel("configured-view", "original")).toEqual(model);
		expect(await child.getAuth(model)).toEqual(await root.getAuth(model));
		await child.refresh({ allowNetwork: false });
		expect((await child.getAuth(model))?.auth.headers).toMatchObject({ "x-configured": "preserved" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
