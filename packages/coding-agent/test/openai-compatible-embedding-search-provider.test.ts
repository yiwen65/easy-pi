import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchRequest } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createOpenAICompatibleEmbeddingSearchProviderFromEnv,
	OpenAICompatibleEmbeddingSearchProvider,
} from "../src/core/tools/openai-compatible-embedding-search-provider.ts";
import { TypeScriptCodeIndexProvider } from "../src/core/tools/typescript-code-index-provider.ts";

function request(root: string, limit = 20): SearchRequest {
	return {
		query: "payment reconciliation workflow",
		kind: "text",
		path: root,
		case: "smart",
		regex: false,
		mode: "semantic_candidate",
		context: 0,
		limit,
		ranking: "task",
		queryTemplate: "concept",
		preferredPaths: ["src/billing/**"],
		honorIgnore: true,
		includeHidden: false,
		followSymlinks: false,
	};
}

describe("OpenAICompatibleEmbeddingSearchProvider", () => {
	let cwd: string;
	let source: TypeScriptCodeIndexProvider;
	let server: Server | undefined;
	let baseUrl: string;
	let capturedInputs: string[][];
	let capturedAuthorization: string[];

	beforeEach(async () => {
		cwd = join(tmpdir(), `pi-embedding-search-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(cwd, "src", "billing"), { recursive: true });
		mkdirSync(join(cwd, "src", "misc"), { recursive: true });
		mkdirSync(join(cwd, "generated"), { recursive: true });
		writeFileSync(join(cwd, ".gitignore"), "generated/\n");
		writeFileSync(
			join(cwd, "src", "billing", "settlement.ts"),
			"// Reconciles invoices after a payment clears.\nexport function settleInvoice() { return 'settled'; }\n",
		);
		writeFileSync(
			join(cwd, "src", "misc", "render.ts"),
			"// Draws a visual theme.\nexport function renderTheme() { return 'dark'; }\n",
		);
		writeFileSync(
			join(cwd, "generated", "secret.ts"),
			"export function paymentReconciliationSecret() { return 'ignored'; }\n",
		);
		source = new TypeScriptCodeIndexProvider();
		capturedInputs = [];
		capturedAuthorization = [];
		server = createServer((incoming, response) => {
			const chunks: Buffer[] = [];
			incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
			incoming.on("end", () => {
				capturedAuthorization.push(incoming.headers.authorization ?? "");
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
				capturedInputs.push(body.input);
				const data = body.input.map((input, index) => ({
					index,
					embedding:
						input === "payment reconciliation workflow" || input.includes("settleInvoice")
							? [1, 0.05]
							: [0.05, 1],
				}));
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ data, usage: { prompt_tokens: Math.max(1, body.input.length * 3) } }));
			});
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("fake embedding server did not bind");
		baseUrl = `http://127.0.0.1:${address.port}/v1`;
	});

	afterEach(async () => {
		await source.close();
		if (server)
			await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
		rmSync(cwd, { recursive: true, force: true });
	});

	it("ranks bounded synthetic semantic candidates without sending ignored files", async () => {
		const provider = new OpenAICompatibleEmbeddingSearchProvider(source, {
			baseUrl,
			model: "fixture-embedding",
			apiKey: "fixture-secret-key",
			usdPerMillionTokens: 0.02,
			maxCostUsd: 1,
			batchSize: 2,
		});
		const result = await provider.search(request(cwd), { workspaceRoot: cwd, scopeId: "semantic" });
		expect(result).toMatchObject({ complete: true, approximate: true, partial: false });
		expect(result.hits[0]).toMatchObject({
			kind: "text",
			path: "src/billing/settlement.ts",
			matchKind: "semantic_candidate",
			enclosingSymbol: "settleInvoice",
			rankReasons: expect.arrayContaining(["semantic_similarity", "production_source", "preferred_path"]),
		});
		const sent = capturedInputs.flat().join("\n");
		expect(sent).toContain("settleInvoice");
		expect(sent).toContain("Reconciles invoices after a payment clears");
		expect(sent).not.toContain("paymentReconciliationSecret");
		expect(capturedAuthorization).toEqual(expect.arrayContaining(["Bearer fixture-secret-key"]));
		expect(provider.getUsage()).toMatchObject({
			requests: expect.any(Number),
			estimatedOrReportedTokens: expect.any(Number),
		});
		await provider.close();
	});

	it("applies deterministic preferred-path priors after semantic scoring", async () => {
		const provider = new OpenAICompatibleEmbeddingSearchProvider(source, {
			baseUrl,
			model: "fixture-embedding",
			apiKey: "fixture-secret-key",
			usdPerMillionTokens: 0,
			maxCostUsd: 1,
			fetchFn: async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as { input: string[] };
				return new Response(
					JSON.stringify({ data: body.input.map((_text, index) => ({ index, embedding: [1, 0] })) }),
					{ status: 200 },
				);
			},
		});
		const ranked = await provider.search(
			{ ...request(cwd), preferredPaths: ["src/misc/**"] },
			{ workspaceRoot: cwd, scopeId: "semantic" },
		);
		expect(ranked.hits.map((hit) => hit.path)).toEqual(["src/misc/render.ts", "src/billing/settlement.ts"]);
		expect(ranked.hits[0]).toMatchObject({ rankReasons: expect.arrayContaining(["preferred_path"]) });
	});

	it("caches document vectors, binds cursors, and reports candidate limits", async () => {
		const provider = new OpenAICompatibleEmbeddingSearchProvider(source, {
			baseUrl,
			model: "fixture-embedding",
			apiKey: "fixture-secret-key",
			usdPerMillionTokens: 0,
			maxCostUsd: 1,
			maxDocuments: 1,
		});
		const first = await provider.search(request(cwd, 1), { workspaceRoot: cwd, scopeId: "semantic" });
		expect(first).toMatchObject({ complete: false, partial: true, truncatedBy: "provider_limit" });
		expect(first.skipped).toEqual(
			expect.arrayContaining([expect.objectContaining({ reason: "SEMANTIC_CANDIDATE_LIMIT" })]),
		);
		const requestsAfterFirst = capturedInputs.length;
		await provider.search(request(cwd, 1), { workspaceRoot: cwd, scopeId: "semantic" });
		expect(capturedInputs.length).toBe(requestsAfterFirst + 1);
		await provider.close();
	});

	it("invalidates semantic cursors when source content changes", async () => {
		const provider = new OpenAICompatibleEmbeddingSearchProvider(source, {
			baseUrl,
			model: "fixture-embedding",
			apiKey: "fixture-secret-key",
			usdPerMillionTokens: 0,
			maxCostUsd: 1,
		});
		const first = await provider.search(request(cwd, 1), { workspaceRoot: cwd, scopeId: "semantic" });
		expect(first.nextCursor).toBeTypeOf("string");
		writeFileSync(join(cwd, "src", "misc", "render.ts"), "export function renderTheme() { return 'light'; }\n");
		await expect(
			provider.search(
				{ ...request(cwd, 1), cursor: first.nextCursor, expectedGeneration: first.generation },
				{ workspaceRoot: cwd, scopeId: "semantic" },
			),
		).rejects.toMatchObject({ code: "stale_cursor" });
	});

	it("fails before network on cost, byte, request-count, and cancellation breakers", async () => {
		let calls = 0;
		const fetchFn: typeof fetch = async () => {
			calls++;
			return new Response();
		};
		const costLimited = new OpenAICompatibleEmbeddingSearchProvider(source, {
			baseUrl,
			model: "fixture-embedding",
			apiKey: "fixture-secret-key",
			usdPerMillionTokens: 1_000_000,
			maxCostUsd: 0.01,
			fetchFn,
		});
		await expect(costLimited.search(request(cwd), { workspaceRoot: cwd, scopeId: "semantic" })).rejects.toMatchObject(
			{
				code: "budget_exceeded",
			},
		);
		expect(calls).toBe(0);

		const byteLimited = new OpenAICompatibleEmbeddingSearchProvider(source, {
			baseUrl,
			model: "fixture-embedding",
			apiKey: "fixture-secret-key",
			usdPerMillionTokens: 0,
			maxCostUsd: 1,
			maxInputBytes: 10,
			fetchFn,
		});
		await expect(byteLimited.search(request(cwd), { workspaceRoot: cwd, scopeId: "semantic" })).rejects.toMatchObject(
			{
				code: "budget_exceeded",
			},
		);
		expect(calls).toBe(0);

		const requestLimited = new OpenAICompatibleEmbeddingSearchProvider(source, {
			baseUrl,
			model: "fixture-embedding",
			apiKey: "fixture-secret-key",
			usdPerMillionTokens: 0,
			maxCostUsd: 1,
			maxRequests: 1,
			fetchFn,
		});
		await expect(
			requestLimited.search(request(cwd), { workspaceRoot: cwd, scopeId: "semantic" }),
		).rejects.toMatchObject({
			code: "budget_exceeded",
		});
		expect(calls).toBe(0);

		const controller = new AbortController();
		controller.abort();
		await expect(
			byteLimited.search(request(cwd), { workspaceRoot: cwd, scopeId: "semantic" }, controller.signal),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(calls).toBe(0);
	});

	it("rejects malformed and cross-batch vectors without leaking credentials", async () => {
		const provider = new OpenAICompatibleEmbeddingSearchProvider(source, {
			baseUrl,
			model: "fixture-embedding",
			apiKey: "do-not-leak-this-key",
			usdPerMillionTokens: 0,
			maxCostUsd: 1,
			fetchFn: async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [] }] }), { status: 200 }),
		});
		let message = "";
		try {
			await provider.search(request(cwd), { workspaceRoot: cwd, scopeId: "semantic" });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("Embedding vector");
		expect(message).not.toContain("do-not-leak-this-key");

		let calls = 0;
		const dimensionChanging = new OpenAICompatibleEmbeddingSearchProvider(source, {
			baseUrl,
			model: "fixture-embedding",
			apiKey: "do-not-leak-this-key",
			usdPerMillionTokens: 0,
			maxCostUsd: 1,
			fetchFn: async (_input, init) => {
				calls++;
				const body = JSON.parse(String(init?.body)) as { input: string[] };
				const dimension = calls === 1 ? 2 : 3;
				return new Response(
					JSON.stringify({
						data: body.input.map((_text, index) => ({ index, embedding: Array(dimension).fill(1) })),
					}),
					{ status: 200 },
				);
			},
		});
		await expect(
			dimensionChanging.search(request(cwd), { workspaceRoot: cwd, scopeId: "semantic" }),
		).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("dimensions changed") });
	});

	it("sanitizes endpoint failures and avoids calls for empty filtered scopes", async () => {
		const secret = "do-not-leak-this-key";
		const sourceText = "Reconciles invoices after a payment clears";
		const failing = new OpenAICompatibleEmbeddingSearchProvider(source, {
			baseUrl,
			model: "fixture-embedding",
			apiKey: secret,
			usdPerMillionTokens: 0,
			maxCostUsd: 1,
			fetchFn: async () => new Response(`${secret} ${sourceText}`, { status: 503 }),
		});
		let message = "";
		try {
			await failing.search(request(cwd), { workspaceRoot: cwd, scopeId: "semantic" });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBe("Embedding endpoint returned HTTP 503.");
		expect(message).not.toContain(secret);
		expect(message).not.toContain(sourceText);

		let calls = 0;
		const empty = new OpenAICompatibleEmbeddingSearchProvider(source, {
			baseUrl,
			model: "fixture-embedding",
			apiKey: secret,
			usdPerMillionTokens: 0,
			maxCostUsd: 1,
			fetchFn: async () => {
				calls++;
				return new Response();
			},
		});
		const result = await empty.search(
			{ ...request(cwd), include: ["does-not-exist/**"] },
			{ workspaceRoot: cwd, scopeId: "semantic" },
		);
		expect(result).toMatchObject({ hits: [], complete: true, matchedCount: 0 });
		expect(calls).toBe(0);
	});

	it("requires explicit opt-in and the complete environment contract", () => {
		expect(createOpenAICompatibleEmbeddingSearchProviderFromEnv(source, {})).toBeUndefined();
		expect(() => createOpenAICompatibleEmbeddingSearchProviderFromEnv(source, { PI_SEMANTIC_SEARCH: "1" })).toThrow(
			"PI_SEMANTIC_SEARCH=1 requires",
		);
		const provider = createOpenAICompatibleEmbeddingSearchProviderFromEnv(source, {
			PI_SEMANTIC_SEARCH: "1",
			PI_EMBEDDING_BASE_URL: baseUrl,
			PI_EMBEDDING_MODEL: "fixture-embedding",
			PI_EMBEDDING_API_KEY: "fixture-secret-key",
			PI_EMBEDDING_USD_PER_MILLION_TOKENS: "0.02",
			PI_EMBEDDING_MAX_COST_USD: "1",
		});
		expect(provider).toBeInstanceOf(OpenAICompatibleEmbeddingSearchProvider);
	});
});
