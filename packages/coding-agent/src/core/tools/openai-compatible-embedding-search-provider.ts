import { createHash } from "node:crypto";
import {
	type SearchCapabilities,
	type SearchExecutionContext,
	type SearchHit,
	type SearchPage,
	type SearchProvider,
	SearchProviderError,
	type SearchRequest,
} from "@earendil-works/pi-agent-core";
import { minimatch } from "minimatch";
import type {
	SemanticCandidateDocument,
	SemanticDocumentPage,
	TypeScriptCodeIndexProvider,
} from "./typescript-code-index-provider.ts";

const DEFAULT_MAX_DOCUMENTS = 200;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_MAX_INPUT_BYTES = 512 * 1024;
const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_MAX_CACHE_ENTRIES = 2_000;
const MAX_CURSORS = 200;

export interface OpenAICompatibleEmbeddingSearchOptions {
	baseUrl: string;
	model: string;
	apiKey: string;
	usdPerMillionTokens: number;
	maxCostUsd: number;
	maxDocuments?: number;
	batchSize?: number;
	maxInputBytes?: number;
	maxRequests?: number;
	maxCacheEntries?: number;
	fetchFn?: typeof fetch;
}

export interface EmbeddingSearchUsage {
	requests: number;
	estimatedOrReportedTokens: number;
	estimatedCostUsd: number;
}

type EmbeddingCursor = {
	hits: SearchHit[];
	generation: string;
	signature: string;
	complete: boolean;
	skipped: SemanticDocumentPage["skipped"];
	matchedCount: number;
	truncatedBy?: "provider_limit";
};

type EmbeddingResponse = {
	data: Array<{ index: number; embedding: number[] }>;
	usage?: { prompt_tokens?: number; total_tokens?: number };
};

function normalizeEndpoint(baseUrl: string): string {
	const url = new URL(baseUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Embedding base URL must use http or https.");
	}
	if (url.username || url.password) throw new Error("Embedding credentials must not be embedded in the base URL.");
	url.pathname = url.pathname.replace(/\/$/, "");
	if (!url.pathname.endsWith("/embeddings")) url.pathname += "/embeddings";
	return url.toString();
}

function tokenize(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9_$]+/)
		.filter((token) => token.length > 1);
}

function embeddingCursorSignature(request: SearchRequest, context: SearchExecutionContext): string {
	return JSON.stringify({
		scopeId: context.scopeId,
		workspaceRoot: context.workspaceRoot,
		query: request.query,
		kind: request.kind,
		path: request.path,
		fileGlob: request.fileGlob,
		include: request.include ?? [],
		exclude: request.exclude ?? [],
		honorIgnore: request.honorIgnore !== false,
		includeHidden: request.includeHidden === true,
		followSymlinks: request.followSymlinks === true,
		case: request.case,
		regex: request.regex,
		mode: request.mode,
		targetKind: request.targetKind,
		wordBoundary: request.wordBoundary === true,
		context: request.context,
		limit: request.limit,
		ranking: request.ranking,
		queryTemplate: request.queryTemplate,
		preferredPaths: request.preferredPaths ?? [],
	});
}

function localCandidateScore(
	document: SemanticCandidateDocument,
	queryTokens: Set<string>,
	request: SearchRequest,
): number {
	const documentTokens = new Set(tokenize(`${document.path} ${document.symbol} ${document.text.slice(0, 2_000)}`));
	let score = 0;
	for (const token of queryTokens) if (documentTokens.has(token)) score += 4;
	if (document.fileClass === "production") score += 2;
	if (
		request.preferredPaths?.some((pattern) => minimatch(document.path, pattern, { dot: true, matchBase: true })) ===
		true
	) {
		score += 8;
	}
	return score;
}

function selectSemanticCandidates(
	ranked: Array<{ document: SemanticCandidateDocument; score: number }>,
	limit: number,
): SemanticCandidateDocument[] {
	if (ranked.length <= limit) return ranked.map((entry) => entry.document);
	const reserve = limit > 1 ? Math.min(Math.floor(limit / 2), Math.max(1, Math.floor(limit / 4))) : 0;
	const leaderCount = limit - reserve;
	const selected = ranked.slice(0, leaderCount).map((entry) => entry.document);
	const remainder = ranked.slice(leaderCount);
	for (let index = 1; index <= reserve; index++) {
		const diversityIndex = Math.ceil((index * remainder.length) / reserve) - 1;
		const entry = remainder[diversityIndex];
		if (entry) selected.push(entry.document);
	}
	return selected;
}

function cosine(left: number[], right: number[]): number {
	if (left.length === 0 || left.length !== right.length) return Number.NEGATIVE_INFINITY;
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index++) {
		const a = left[index];
		const b = right[index];
		if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NEGATIVE_INFINITY;
		dot += a * b;
		leftNorm += a * a;
		rightNorm += b * b;
	}
	if (leftNorm === 0 || rightNorm === 0) return Number.NEGATIVE_INFINITY;
	return dot / Math.sqrt(leftNorm * rightNorm);
}

function parseEmbeddingResponse(value: unknown, expected: number): EmbeddingResponse {
	if (!value || typeof value !== "object")
		throw new SearchProviderError("unavailable", "Embedding response is invalid.");
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.data))
		throw new SearchProviderError("unavailable", "Embedding response has no data array.");
	const data = record.data.map((item, fallbackIndex) => {
		if (!item || typeof item !== "object") throw new SearchProviderError("unavailable", "Embedding item is invalid.");
		const entry = item as Record<string, unknown>;
		const index = typeof entry.index === "number" ? entry.index : fallbackIndex;
		if (!Array.isArray(entry.embedding) || !entry.embedding.every((number) => Number.isFinite(number))) {
			throw new SearchProviderError("unavailable", "Embedding vector is invalid.");
		}
		return { index, embedding: entry.embedding as number[] };
	});
	data.sort((left, right) => left.index - right.index);
	if (data.length !== expected || data.some((entry, index) => entry.index !== index)) {
		throw new SearchProviderError("unavailable", "Embedding response indexes are incomplete.");
	}
	const dimension = data[0]?.embedding.length ?? 0;
	if (dimension === 0 || data.some((entry) => entry.embedding.length !== dimension)) {
		throw new SearchProviderError("unavailable", "Embedding vector dimensions are inconsistent.");
	}
	const usageRecord =
		record.usage && typeof record.usage === "object" ? (record.usage as Record<string, unknown>) : undefined;
	return {
		data,
		usage: usageRecord
			? {
					prompt_tokens:
						Number.isFinite(usageRecord.prompt_tokens) && Number(usageRecord.prompt_tokens) >= 0
							? Number(usageRecord.prompt_tokens)
							: undefined,
					total_tokens:
						Number.isFinite(usageRecord.total_tokens) && Number(usageRecord.total_tokens) >= 0
							? Number(usageRecord.total_tokens)
							: undefined,
				}
			: undefined,
	};
}

/** Explicit opt-in semantic candidate provider backed by an OpenAI-compatible embeddings endpoint. */
export class OpenAICompatibleEmbeddingSearchProvider implements SearchProvider {
	readonly id = "openai-compatible-embeddings";
	readonly capabilities: SearchCapabilities = {
		textLiteral: false,
		textRegex: false,
		context: false,
		fuzzyFiles: false,
		glob: false,
		stableCursor: true,
		globalRanking: false,
		taskRanking: true,
		scopeFilters: true,
		wordBoundary: false,
		structuredModes: ["semantic_candidate"],
	};
	private readonly source: TypeScriptCodeIndexProvider;
	private readonly endpoint: string;
	private readonly model: string;
	private readonly apiKey: string;
	private readonly usdPerMillionTokens: number;
	private readonly maxCostUsd: number;
	private readonly maxDocuments: number;
	private readonly batchSize: number;
	private readonly maxInputBytes: number;
	private readonly maxRequests: number;
	private readonly maxCacheEntries: number;
	private readonly fetchFn: typeof fetch;
	private readonly cache = new Map<string, number[]>();
	private readonly cursors = new Map<string, EmbeddingCursor>();
	private requestCount = 0;
	private tokenCount = 0;
	private costUsd = 0;
	private sequence = 0;

	constructor(source: TypeScriptCodeIndexProvider, options: OpenAICompatibleEmbeddingSearchOptions) {
		if (!options.model.trim()) throw new Error("Embedding model must not be empty.");
		if (!options.apiKey.trim()) throw new Error("Embedding API key must not be empty.");
		if (!Number.isFinite(options.usdPerMillionTokens) || options.usdPerMillionTokens < 0) {
			throw new Error("Embedding token price must be a non-negative finite number.");
		}
		if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
			throw new Error("Embedding cost budget must be a positive finite number.");
		}
		const maxDocuments = options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
		const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
		const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
		const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
		const maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
		for (const [name, value] of [
			["maxDocuments", maxDocuments],
			["batchSize", batchSize],
			["maxInputBytes", maxInputBytes],
			["maxRequests", maxRequests],
			["maxCacheEntries", maxCacheEntries],
		] as const) {
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
		}
		this.source = source;
		this.endpoint = normalizeEndpoint(options.baseUrl);
		this.model = options.model;
		this.apiKey = options.apiKey;
		this.usdPerMillionTokens = options.usdPerMillionTokens;
		this.maxCostUsd = options.maxCostUsd;
		this.maxDocuments = maxDocuments;
		this.batchSize = batchSize;
		this.maxInputBytes = maxInputBytes;
		this.maxRequests = maxRequests;
		this.maxCacheEntries = maxCacheEntries;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	getUsage(): EmbeddingSearchUsage {
		return {
			requests: this.requestCount,
			estimatedOrReportedTokens: this.tokenCount,
			estimatedCostUsd: this.costUsd,
		};
	}

	async search(request: SearchRequest, context: SearchExecutionContext, signal?: AbortSignal): Promise<SearchPage> {
		if (request.mode !== "semantic_candidate") {
			throw new SearchProviderError("unsupported", "This provider only supports semantic_candidate mode.");
		}
		if (request.cursor) return this.continueCursor(request, request.cursor, context, signal);
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Semantic search aborted.");
		const page = await this.source.listSemanticDocuments(request, signal);
		const queryTokens = new Set(tokenize(request.query));
		const rankedLocally = page.documents
			.map((document) => ({ document, score: localCandidateScore(document, queryTokens, request) }))
			.sort(
				(left, right) =>
					right.score - left.score ||
					(left.document.path < right.document.path ? -1 : left.document.path > right.document.path ? 1 : 0) ||
					left.document.line - right.document.line,
			);
		const selected = selectSemanticCandidates(rankedLocally, this.maxDocuments);
		const candidateLimited = rankedLocally.length > selected.length;
		if (selected.length === 0) {
			return {
				hits: [],
				complete: page.complete,
				approximate: true,
				partial: !page.complete,
				generation: page.generation,
				matchedCount: 0,
				matchedCountRelation: page.complete ? "exact" : "at_least",
				skipped: page.skipped.length > 0 ? page.skipped : undefined,
			};
		}
		const documentVectors = new Map<string, number[]>();
		const missing: SemanticCandidateDocument[] = [];
		for (const document of selected) {
			const key = this.cacheKey(document.text);
			const cached = this.cache.get(key);
			if (cached) documentVectors.set(document.id, cached);
			else missing.push(document);
		}
		const operationBytes =
			Buffer.byteLength(request.query) +
			missing.reduce((sum, document) => sum + Buffer.byteLength(document.text), 0);
		if (operationBytes > this.maxInputBytes) {
			throw new SearchProviderError(
				"budget_exceeded",
				`Semantic uncached input exceeds the ${this.maxInputBytes}-byte operation budget. Narrow the scope.`,
			);
		}
		const firstDocumentBatchSize = Math.min(missing.length, Math.max(0, this.batchSize - 1));
		const requiredRequests = 1 + Math.ceil((missing.length - firstDocumentBatchSize) / this.batchSize);
		if (this.requestCount + requiredRequests > this.maxRequests) {
			throw new SearchProviderError("budget_exceeded", "Embedding request budget would be exceeded.");
		}
		const estimatedOperationTokens = Math.ceil(
			(request.query.length + missing.reduce((sum, document) => sum + document.text.length, 0)) / 4,
		);
		if (this.costUsd + (estimatedOperationTokens / 1_000_000) * this.usdPerMillionTokens > this.maxCostUsd) {
			throw new SearchProviderError("budget_exceeded", "Embedding cost budget would be exceeded.");
		}
		const firstDocuments = missing.slice(0, firstDocumentBatchSize);
		const firstVectors = await this.embed(
			[request.query, ...firstDocuments.map((document) => document.text)],
			signal,
		);
		const queryVector = firstVectors[0];
		if (!queryVector) throw new SearchProviderError("unavailable", "Embedding query vector is missing.");
		for (let index = 0; index < firstDocuments.length; index++) {
			const document = firstDocuments[index];
			const vector = firstVectors[index + 1];
			if (!document || !vector) throw new SearchProviderError("unavailable", "Embedding batch is incomplete.");
			documentVectors.set(document.id, vector);
			this.cache.set(this.cacheKey(document.text), vector);
			this.trim(this.cache, this.maxCacheEntries);
		}
		for (let offset = firstDocumentBatchSize; offset < missing.length; offset += this.batchSize) {
			const batch = missing.slice(offset, offset + this.batchSize);
			const vectors = await this.embed(
				batch.map((document) => document.text),
				signal,
			);
			for (let index = 0; index < batch.length; index++) {
				const document = batch[index];
				const vector = vectors[index];
				if (!document || !vector) throw new SearchProviderError("unavailable", "Embedding batch is incomplete.");
				documentVectors.set(document.id, vector);
				this.cache.set(this.cacheKey(document.text), vector);
				this.trim(this.cache, this.maxCacheEntries);
			}
		}
		if ([...documentVectors.values()].some((vector) => vector.length !== queryVector.length)) {
			throw new SearchProviderError("unavailable", "Embedding vector dimensions changed between batches.");
		}
		const scored = selected
			.map((document) => {
				const similarity = cosine(queryVector, documentVectors.get(document.id) ?? []);
				const preferred =
					request.preferredPaths?.some((pattern) =>
						minimatch(document.path, pattern, { dot: true, matchBase: true }),
					) === true;
				const production = document.fileClass === "production";
				return {
					document,
					preferred,
					production,
					score: similarity + (preferred ? 0.05 : 0) + (production ? 0.01 : 0),
				};
			})
			.filter((entry) => Number.isFinite(entry.score))
			.sort(
				(left, right) =>
					right.score - left.score ||
					(left.document.path < right.document.path ? -1 : left.document.path > right.document.path ? 1 : 0) ||
					left.document.line - right.document.line,
			);
		const hits = scored.map(({ document, preferred, production, score }): SearchHit => {
			const simpleSymbol = document.symbol.split(".").at(-1) ?? document.symbol;
			const matchIndex = Math.max(0, document.lineText.indexOf(simpleSymbol));
			return {
				kind: "text",
				path: document.path,
				line: document.line,
				endLine: document.endLine,
				column: document.column,
				endColumn: document.column + simpleSymbol.length,
				text: document.lineText || simpleSymbol,
				ranges: [[matchIndex, matchIndex + simpleSymbol.length]],
				matchKind: "semantic_candidate",
				enclosingSymbol: document.symbol,
				nodeKind: document.nodeKind,
				fileClass: document.fileClass,
				score,
				rankReasons: [
					"semantic_similarity",
					...(production ? ["production_source"] : []),
					...(preferred ? ["preferred_path"] : []),
				],
			};
		});
		const visible = hits.slice(0, request.limit);
		const remaining = hits.slice(request.limit);
		let nextCursor: string | undefined;
		const complete = page.complete && !candidateLimited;
		const skipped = [
			...page.skipped,
			...(candidateLimited
				? [{ reason: "SEMANTIC_CANDIDATE_LIMIT", count: rankedLocally.length - selected.length }]
				: []),
		];
		if (remaining.length > 0) {
			nextCursor = `embc_${this.sequence++}`;
			this.cursors.set(nextCursor, {
				hits: remaining,
				generation: page.generation,
				signature: embeddingCursorSignature(request, context),
				complete,
				skipped,
				matchedCount: hits.length,
				truncatedBy: candidateLimited ? "provider_limit" : undefined,
			});
			this.trim(this.cursors, MAX_CURSORS);
		}
		return {
			hits: visible,
			nextCursor,
			complete,
			approximate: true,
			partial: !complete,
			generation: page.generation,
			matchedCount: hits.length,
			matchedCountRelation: complete ? "exact" : "at_least",
			truncatedBy: nextCursor ? "max_results_global" : candidateLimited ? "provider_limit" : undefined,
			skipped: skipped.length > 0 ? skipped : undefined,
		};
	}

	async close(): Promise<void> {
		this.cache.clear();
		this.cursors.clear();
	}

	private async embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
		if (inputs.length === 0) return [];
		if (signal?.aborted) throw new SearchProviderError("unavailable", "Semantic search aborted.");
		if (this.requestCount >= this.maxRequests) {
			throw new SearchProviderError("budget_exceeded", "Embedding request budget exhausted.");
		}
		const bytes = inputs.reduce((sum, input) => sum + Buffer.byteLength(input), 0);
		if (bytes > this.maxInputBytes) {
			throw new SearchProviderError("budget_exceeded", "Embedding batch exceeds the input byte budget.");
		}
		const estimatedTokens = Math.ceil(inputs.reduce((sum, input) => sum + input.length, 0) / 4);
		const estimatedCost = (estimatedTokens / 1_000_000) * this.usdPerMillionTokens;
		if (this.costUsd + estimatedCost > this.maxCostUsd) {
			throw new SearchProviderError("budget_exceeded", "Embedding cost budget would be exceeded.");
		}
		this.requestCount++;
		let response: Response;
		try {
			response = await this.fetchFn(this.endpoint, {
				method: "POST",
				headers: {
					accept: "application/json",
					authorization: `Bearer ${this.apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ model: this.model, input: inputs, encoding_format: "float" }),
				signal,
			});
		} catch (error) {
			if (signal?.aborted) throw new SearchProviderError("unavailable", "Semantic search aborted.");
			throw new SearchProviderError(
				"unavailable",
				`Embedding request failed: ${error instanceof Error ? error.name : "network error"}.`,
			);
		}
		if (!response.ok) {
			throw new SearchProviderError("unavailable", `Embedding endpoint returned HTTP ${response.status}.`);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new SearchProviderError("unavailable", "Embedding endpoint returned invalid JSON.");
		}
		const parsed = parseEmbeddingResponse(payload, inputs.length);
		const usedTokens = parsed.usage?.prompt_tokens ?? parsed.usage?.total_tokens ?? estimatedTokens;
		this.tokenCount += usedTokens;
		this.costUsd += (usedTokens / 1_000_000) * this.usdPerMillionTokens;
		if (this.costUsd > this.maxCostUsd) {
			throw new SearchProviderError("budget_exceeded", "Embedding endpoint usage exhausted the cost budget.");
		}
		return parsed.data.map((entry) => entry.embedding);
	}

	private async continueCursor(
		request: SearchRequest,
		cursor: string,
		context: SearchExecutionContext,
		signal?: AbortSignal,
	): Promise<SearchPage> {
		const record = this.cursors.get(cursor);
		if (
			!record ||
			record.generation !== request.expectedGeneration ||
			record.signature !== embeddingCursorSignature(request, context)
		) {
			throw new SearchProviderError("stale_cursor", "The semantic cursor is no longer available.");
		}
		const current = await this.source.listSemanticDocuments(request, signal);
		if (current.generation !== record.generation) {
			this.cursors.delete(cursor);
			throw new SearchProviderError(
				"stale_cursor",
				"The JS/TS source changed after the semantic cursor was issued.",
			);
		}
		this.cursors.delete(cursor);
		const hits = record.hits.slice(0, request.limit);
		const remaining = record.hits.slice(request.limit);
		let nextCursor: string | undefined;
		if (remaining.length > 0) {
			nextCursor = `embc_${this.sequence++}`;
			this.cursors.set(nextCursor, { ...record, hits: remaining });
		}
		return {
			hits,
			nextCursor,
			complete: record.complete,
			approximate: true,
			partial: !record.complete,
			generation: record.generation,
			matchedCount: record.matchedCount,
			matchedCountRelation: record.complete ? "exact" : "at_least",
			truncatedBy: nextCursor ? "max_results_global" : record.truncatedBy,
			skipped: record.skipped.length > 0 ? record.skipped : undefined,
		};
	}

	private cacheKey(text: string): string {
		return createHash("sha256").update(`${this.model}\0${text}`).digest("hex");
	}

	private trim<T>(map: Map<string, T>, limit: number): void {
		while (map.size > limit) {
			const oldest = map.keys().next().value;
			if (oldest === undefined) break;
			map.delete(oldest);
		}
	}
}

export function createOpenAICompatibleEmbeddingSearchProviderFromEnv(
	source: TypeScriptCodeIndexProvider,
	env: NodeJS.ProcessEnv = process.env,
): OpenAICompatibleEmbeddingSearchProvider | undefined {
	if (env.PI_SEMANTIC_SEARCH !== "1") return undefined;
	const baseUrl = env.PI_EMBEDDING_BASE_URL;
	const model = env.PI_EMBEDDING_MODEL;
	const apiKey = env.PI_EMBEDDING_API_KEY;
	const price = Number(env.PI_EMBEDDING_USD_PER_MILLION_TOKENS);
	const maxCost = Number(env.PI_EMBEDDING_MAX_COST_USD ?? "5");
	if (!baseUrl || !model || !apiKey || !Number.isFinite(price) || price < 0) {
		throw new Error(
			"PI_SEMANTIC_SEARCH=1 requires PI_EMBEDDING_BASE_URL, PI_EMBEDDING_MODEL, PI_EMBEDDING_API_KEY, and PI_EMBEDDING_USD_PER_MILLION_TOKENS.",
		);
	}
	return new OpenAICompatibleEmbeddingSearchProvider(source, {
		baseUrl,
		model,
		apiKey,
		usdPerMillionTokens: price,
		maxCostUsd: maxCost,
	});
}
