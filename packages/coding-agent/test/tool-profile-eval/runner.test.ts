import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { type EvalExecutionInput, runToolProfileEvaluation, type ToolProfileEvalManifest } from "./runner.ts";

function assistantText(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
		if (!("content" in message) || !Array.isArray(message.content)) return "";
		return message.content
			.flatMap((part: unknown) =>
				part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
					? [String(part.text)]
					: [],
			)
			.join("\n");
	}
	return "";
}

describe("tool profile A/B evaluation scaffold", () => {
	let tempDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;
	let modelRuntime: ModelRuntime;
	let manifest: ToolProfileEvalManifest;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-tool-profile-eval-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		manifest = JSON.parse(
			readFileSync(join(dirname(fileURLToPath(import.meta.url)), "manifest.json"), "utf8"),
		) as ToolProfileEvalManifest;
		faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(tempDir, "models.json") });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
	});

	afterEach(() => {
		faux.unregister();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function execute(input: EvalExecutionInput) {
		const score = ((input.seed + input.task.id.length + (input.profile === "v2" ? 1 : 0)) % 3) / 2;
		faux.setResponses([fauxAssistantMessage(JSON.stringify({ success: true, score }))]);
		const cwd = join(tempDir, "fixtures", `${input.task.id}-${input.seed}-${input.profile}`);
		mkdirSync(cwd, { recursive: true });
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: tempDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir: tempDir,
			modelRuntime,
			model: faux.getModel(),
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			toolProfile: input.profile,
		});
		try {
			await session.prompt(input.task.prompt);
			const judged = JSON.parse(assistantText(session.messages)) as { success: boolean; score: number };
			return {
				success: judged.success,
				score: judged.score,
				turns: 1,
				systemPrompt: session.systemPrompt,
				tools: session.getAllTools().map(({ name, description, parameters }) => ({
					name,
					description,
					parameters,
				})),
			};
		} finally {
			session.dispose();
		}
	}

	it("runs credential-free faux-provider pairs with deterministic hashes and bootstrap output", async () => {
		const first = await runToolProfileEvaluation(manifest, execute);
		const second = await runToolProfileEvaluation(manifest, execute);

		expect(second).toEqual(first);
		expect(first.records).toHaveLength(manifest.tasks.length * manifest.seeds.length * 2);
		expect(first.profiles.legacy.runs).toBe(first.profiles.v2.runs);
		expect(
			new Set(first.records.filter((record) => record.profile === "legacy").map((record) => record.schemaHash)).size,
		).toBe(1);
		expect(
			new Set(first.records.filter((record) => record.profile === "v2").map((record) => record.schemaHash)).size,
		).toBe(1);
		expect(first.records.find((record) => record.profile === "legacy")?.schemaHash).not.toBe(
			first.records.find((record) => record.profile === "v2")?.schemaHash,
		);
	});
});
