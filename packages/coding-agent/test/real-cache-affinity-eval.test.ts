/**
 * Manual real-provider validation for durable AgentHarness prompt-cache affinity.
 *
 * Never calls a provider unless PI_REAL_MODEL_EVAL=1 is set explicitly. The
 * test uses the production ModelRuntime/AuthStorage path and prints only usage
 * and latency metrics, never credentials or response content.
 *
 * Run explicitly:
 *   PI_REAL_MODEL_EVAL=1 node ../../node_modules/vitest/dist/cli.js --run \
 *     test/real-cache-affinity-eval.test.ts --silent=false
 */

import { AgentHarness, InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const RUN = process.env.PI_REAL_MODEL_EVAL === "1";
if (RUN) configureHttpDispatcher();
const MODEL_PROVIDER = process.env.PI_REAL_CACHE_PROVIDER ?? "openai-codex";
const MODEL_ID = process.env.PI_REAL_CACHE_MODEL ?? "gpt-5.5";
const TRANSPORT = process.env.PI_REAL_CACHE_TRANSPORT === "auto" ? "auto" : "sse";

function errorSummary(error: unknown, depth = 0): unknown {
	if (!(error instanceof Error) || depth >= 4) return String(error);
	const code = (error as Error & { code?: unknown }).code;
	return {
		name: error.name,
		message: error.message,
		...(typeof code === "string" || typeof code === "number" ? { code } : {}),
		...(error.cause !== undefined ? { cause: errorSummary(error.cause, depth + 1) } : {}),
	};
}

const diagnosticFetch: typeof globalThis.fetch = async (input, init) => {
	try {
		return await globalThis.fetch(input, init);
	} catch (error) {
		const rawUrl = input instanceof Request ? input.url : String(input);
		let host = "unknown";
		try {
			host = new URL(rawUrl).host;
		} catch {
			// Keep the redacted fallback; never print the raw request URL.
		}
		console.log(JSON.stringify({ eval: "real-cache-affinity-fetch-error", host, error: errorSummary(error) }));
		throw error;
	}
};

function stableSystemPrompt(): string {
	const filler = Array.from(
		{ length: 220 },
		(_, index) =>
			`Stable cache validation record ${String(index + 1).padStart(3, "0")}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.`,
	).join("\n");
	return [
		"You are participating in an authorized prompt-cache validation. Follow the current user request exactly and answer in one short line.",
		filler,
		"The records above are intentionally stable across requests so provider cache-read usage can be measured.",
	].join("\n\n");
}

function completedUsage(result: Awaited<ReturnType<AgentHarness["prompt"]>>) {
	expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	if (result.value.kind === "failed") {
		throw new Error(`Run failed: ${result.value.error.code}: ${result.value.error.message}`);
	}
	expect(result.value.kind).toBe("completed");
	if (result.value.kind !== "completed") throw new Error(`Unexpected run outcome: ${result.value.kind}`);
	return result.value.finalMessage.usage;
}

describe.skipIf(!RUN)("real durable prompt-cache affinity", () => {
	it("reports cache reads on the warm configured-provider request", { timeout: 180_000 }, async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(),
			allowModelNetwork: false,
		});
		const model = runtime.getModel(MODEL_PROVIDER, MODEL_ID);
		if (!model) throw new Error(`${MODEL_PROVIDER}/${MODEL_ID} is not in the local model catalog`);
		const auth = await runtime.getAuth(model);
		if (!auth) throw new Error(`${MODEL_PROVIDER}/${MODEL_ID} has no configured credentials`);

		const sessionId = `real-cache-affinity-${Date.now()}`;
		const session = new Session(new InMemorySessionStorage({ id: sessionId, createdAt: Date.now() }));
		const { harness } = await AgentHarness.create({
			session,
			models: runtime,
			model,
			systemPrompt: stableSystemPrompt(),
			streamOptions: {
				cacheRetention: "short",
				maxTokens: 64,
				maxRetries: 1,
				timeoutMs: 120_000,
				transport: TRANSPORT,
				fetch: diagnosticFetch,
			},
			streamFn: (requestModel, context, options) => runtime.streamSimple(requestModel, context, options),
		});

		try {
			const coldStartedAt = Date.now();
			const cold = completedUsage(await harness.prompt("Cache validation request 1. Reply exactly: CACHE-OK-1"));
			const coldElapsedMs = Date.now() - coldStartedAt;

			const warmStartedAt = Date.now();
			const warm = completedUsage(await harness.prompt("Cache validation request 2. Reply exactly: CACHE-OK-2"));
			const warmElapsedMs = Date.now() - warmStartedAt;
			const warmPromptTokens = warm.input + warm.cacheRead + warm.cacheWrite;
			const warmCacheReadRatio = warmPromptTokens > 0 ? warm.cacheRead / warmPromptTokens : 0;

			console.log(
				JSON.stringify({
					eval: "real-cache-affinity",
					provider: MODEL_PROVIDER,
					model: MODEL_ID,
					transport: TRANSPORT,
					cold: {
						input: cold.input,
						output: cold.output,
						cacheRead: cold.cacheRead,
						cacheWrite: cold.cacheWrite,
						elapsedMs: coldElapsedMs,
					},
					warm: {
						input: warm.input,
						output: warm.output,
						cacheRead: warm.cacheRead,
						cacheWrite: warm.cacheWrite,
						cacheReadRatio: Number(warmCacheReadRatio.toFixed(4)),
						elapsedMs: warmElapsedMs,
					},
				}),
			);

			expect(cold.input + cold.cacheRead + cold.cacheWrite).toBeGreaterThan(1024);
			expect(warm.cacheRead).toBeGreaterThan(0);
			expect(warmCacheReadRatio).toBeGreaterThan(0);
		} finally {
			await harness.close();
		}
	});
});
