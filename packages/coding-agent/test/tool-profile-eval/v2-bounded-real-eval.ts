import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const V2_BOUNDED_REAL_EVAL_MANIFEST_SHA256 = "01cee1dba7256c83c8741da46e5c4d52eebab5a31f91786188bd23f9e5694278";

export type V2BoundedEvalStage = "development" | "held_out";
export type V2BoundedEvalPhase = "baseline" | "iteration_1" | "iteration_2" | "held_out";
export type ContextByteLabel = "useful" | "duplicate" | "irrelevant" | "ambiguous";

export interface V2BoundedEvalCase {
	id: string;
	stage: V2BoundedEvalStage;
	order: number;
	seed: number;
	maxChatRequests: number;
	repository: string;
	taskFamily: string;
	targetPath: string;
	semanticPath: string;
	semanticQuery: string;
	prompt: string;
	promptHash: string;
	oldText: string;
	mutatedText: string;
	requiredSymbol: string;
	originalSha256: string;
	mutatedSha256: string;
	expectedSha256: string;
	expectedMode: number;
	requiredRange: {
		startByte: number;
		endByte: number;
		startLine: number;
		endLine: number;
	};
	fault?: {
		kind: "after_target_read";
		marker: string;
		anchor: string;
	};
}

export interface V2BoundedEvalRepository {
	id: string;
	url: string;
	commit: string;
	sparsePaths: string[];
	trackedFiles: number;
	sourceFiles: number;
	sourceBytes: number | null;
	materializedFiles: number;
	materializedSourceFiles: number;
	materializedSourceBytes: number;
}

export interface V2BoundedRealEvalManifest {
	version: 1;
	baselineCommit: string;
	claimBoundary: "bounded real evaluation";
	budgets: {
		maxKnownCostUsd: number;
		maxPaidRequests: number;
		maxChatRequests: number;
		maxEmbeddingRequests: number;
		maxCombinedReportedTokens: number;
		maxEmbeddingTokens: number;
		maxEvaluationElapsedMs: number;
		maxChatRequestsPerSession: number;
		maxEmbeddingRequestsPerSession: number;
		maxSessionElapsedMs: number;
		maxSessions: number;
		worstCaseAllocatedChatRequests: number;
		worstCaseAllocatedEmbeddingRequests: number;
	};
	provider: {
		chat: {
			provider: string;
			model: string;
			thinkingLevel: "max";
			contextWindow: number;
			catalogMaxTokens: number;
			maxOutputTokensPerRequest: number;
			compactionMode: "off";
			providerRetries: 0;
			usdPerMillionTokens: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
		};
		embedding: {
			provider: string;
			model: string;
			usdPerMillionTokens: number;
			maxDocumentsPerSession: number;
			batchSize: number;
			maxInputBytesPerOperation: number;
		};
		frozenToolContract: {
			toolNames: string[];
			schemaHash: string;
			schemaBytes: number;
			normalizedSystemPromptHash: string;
			normalizedSystemPromptBytes: number;
		};
	};
	repositories: Record<string, V2BoundedEvalRepository>;
	cases: V2BoundedEvalCase[];
	stageOrder: { development: string[]; heldOut: string[] };
	activationGates: {
		allSessions: string[];
		semanticRequired: string[];
		structuredVerificationRequired: string[];
		faultRequired: string[];
		postEditReadRequired: boolean;
		verifierRunRequired: boolean;
	};
	allowedRunCommands: Record<string, string>;
}

export interface V2BoundedEvalUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

interface PendingReservation {
	kind: "chat" | "embedding";
	id: string;
	reservedTokens: number;
	reservedCostUsd: number;
}

export interface V2BoundedEvalBudgetState {
	version: 1;
	contractHash: string;
	startedAtMs: number;
	chatRequests: number;
	embeddingRequests: number;
	sessionsStarted: number;
	attemptIds: string[];
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	embeddingTokens: number;
	knownCostUsd: number;
	pending?: PendingReservation;
	integrityFailure?: string;
	integrityResolutions?: Array<{
		category: string;
		resolution: "allowed_static_documentation_lines";
		attemptId: "baseline-D-01";
		resolvedAtMs: number;
	}>;
}

export interface ContextByteCounts {
	useful: number;
	duplicate: number;
	irrelevant: number;
	ambiguous: number;
}

export interface ProviderContextMetrics extends ContextByteCounts {
	providerRequests: number;
	providerPayloadBytes: number;
	activeToolResultContextBytes: number;
	peakActiveToolResultBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, stableValue(nested)]),
		);
	}
	return value;
}

export function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function stableHash(value: unknown): string {
	return sha256(JSON.stringify(stableValue(value)));
}

export function normalizeFrozenSystemPrompt(
	systemPrompt: string,
	contractRoot: string,
	workspaceRoot: string,
	referenceWorkspaceRoot: string,
): string {
	if (!contractRoot || !workspaceRoot || !referenceWorkspaceRoot) {
		throw new Error("Frozen system-prompt normalization roots must not be empty");
	}
	return systemPrompt.replaceAll(workspaceRoot, referenceWorkspaceRoot).replaceAll(contractRoot, "$CONTRACT_ROOT");
}

function requirePositiveInteger(value: unknown, name: string): asserts value is number {
	if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} must be a positive integer`);
}

function requireSha256(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be SHA-256`);
}

export function loadV2BoundedRealEvalManifest(): V2BoundedRealEvalManifest {
	const url = new URL("./v2-bounded-real-eval-manifest.json", import.meta.url);
	const bytes = readFileSync(url);
	if (sha256(bytes) !== V2_BOUNDED_REAL_EVAL_MANIFEST_SHA256) {
		throw new Error("The sealed v2 bounded evaluation manifest hash changed");
	}
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	if (!isRecord(value) || value.version !== 1 || value.baselineCommit !== "51a6534c9") {
		throw new Error("The sealed v2 bounded evaluation manifest is invalid");
	}
	if (!Array.isArray(value.cases) || value.cases.length !== 4) {
		throw new Error("The sealed v2 bounded evaluation manifest must contain four cases");
	}
	const cases = value.cases;
	for (const [index, entry] of cases.entries()) {
		if (!isRecord(entry)) throw new Error(`case ${index} must be an object`);
		if (typeof entry.id !== "string" || !/^[DH]-0[12]$/.test(entry.id))
			throw new Error(`case ${index} id is invalid`);
		requireSha256(entry.promptHash, `${entry.id}.promptHash`);
		requireSha256(entry.originalSha256, `${entry.id}.originalSha256`);
		requireSha256(entry.mutatedSha256, `${entry.id}.mutatedSha256`);
		requireSha256(entry.expectedSha256, `${entry.id}.expectedSha256`);
		requirePositiveInteger(entry.maxChatRequests, `${entry.id}.maxChatRequests`);
	}
	const manifest = value as unknown as V2BoundedRealEvalManifest;
	if (manifest.provider.frozenToolContract.toolNames.join(",") !== "search,read,edit,run") {
		throw new Error("The sealed model-visible tool set must be exactly search/read/edit/run");
	}
	if (manifest.budgets.worstCaseAllocatedChatRequests > manifest.budgets.maxChatRequests) {
		throw new Error("The sealed chat allocation exceeds its global cap");
	}
	if (manifest.budgets.worstCaseAllocatedEmbeddingRequests > manifest.budgets.maxEmbeddingRequests) {
		throw new Error("The sealed embedding allocation exceeds its global cap");
	}
	return manifest;
}

export function initialBudgetState(startedAtMs: number): V2BoundedEvalBudgetState {
	if (!Number.isSafeInteger(startedAtMs) || startedAtMs <= 0)
		throw new Error("startedAtMs must be a positive integer");
	return {
		version: 1,
		contractHash: V2_BOUNDED_REAL_EVAL_MANIFEST_SHA256,
		startedAtMs,
		chatRequests: 0,
		embeddingRequests: 0,
		sessionsStarted: 0,
		attemptIds: [],
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		embeddingTokens: 0,
		knownCostUsd: 0,
	};
}

function nonNegativeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}

function reportedModelTokens(state: V2BoundedEvalBudgetState): number {
	return state.inputTokens + state.outputTokens + state.cacheReadTokens + state.cacheWriteTokens;
}

export class V2BoundedEvalBudgetLedger {
	private readonly manifest: V2BoundedRealEvalManifest;
	private readonly state: V2BoundedEvalBudgetState;
	private readonly persist: (state: V2BoundedEvalBudgetState) => void;

	constructor(
		manifest: V2BoundedRealEvalManifest,
		state: V2BoundedEvalBudgetState,
		persist: (state: V2BoundedEvalBudgetState) => void = () => undefined,
	) {
		if (state.contractHash !== V2_BOUNDED_REAL_EVAL_MANIFEST_SHA256) {
			throw new Error("Budget state belongs to a different sealed contract");
		}
		this.manifest = manifest;
		this.state = structuredClone(state);
		this.persist = persist;
		this.validateState();
	}

	snapshot(): V2BoundedEvalBudgetState {
		return structuredClone(this.state);
	}

	assertElapsed(nowMs: number): void {
		if (!Number.isSafeInteger(nowMs) || nowMs < this.state.startedAtMs)
			throw new Error("Evaluation clock is invalid");
		if (nowMs - this.state.startedAtMs >= this.manifest.budgets.maxEvaluationElapsedMs) {
			throw new Error("evaluation_time_budget_exhausted");
		}
	}

	startSession(attemptId: string, nowMs: number): void {
		this.assertUsable(nowMs);
		if (!/^(?:baseline-D-0[12]|iteration_[12]-D-0[12]|held_out-H-0[12])$/.test(attemptId)) {
			throw new Error("Attempt id is not content-free or is outside the frozen phases");
		}
		if (this.state.attemptIds.includes(attemptId)) throw new Error("evaluation_attempt_already_started");
		if (this.state.sessionsStarted >= this.manifest.budgets.maxSessions) {
			throw new Error("evaluation_session_budget_exhausted");
		}
		this.state.sessionsStarted += 1;
		this.state.attemptIds.push(attemptId);
		this.flush();
	}

	reserveChat(id: string, estimatedInputTokens: number, maxOutputTokens: number, nowMs: number): void {
		this.assertUsable(nowMs);
		nonNegativeInteger(estimatedInputTokens, "estimatedInputTokens");
		nonNegativeInteger(maxOutputTokens, "maxOutputTokens");
		if (this.state.chatRequests >= this.manifest.budgets.maxChatRequests) {
			throw new Error("chat_request_budget_exhausted");
		}
		this.assertCombinedRequestCapacity();
		const reservedTokens = estimatedInputTokens + maxOutputTokens;
		const prices = this.manifest.provider.chat.usdPerMillionTokens;
		const reservedCostUsd = (estimatedInputTokens * prices.input + maxOutputTokens * prices.output) / 1_000_000;
		this.assertProjectedBudget(reservedTokens, reservedCostUsd);
		this.state.chatRequests += 1;
		this.state.pending = { kind: "chat", id, reservedTokens, reservedCostUsd };
		this.flush();
	}

	commitChat(id: string, usage: V2BoundedEvalUsage): void {
		this.requirePending("chat", id);
		for (const [name, value] of [
			["inputTokens", usage.inputTokens],
			["outputTokens", usage.outputTokens],
			["cacheReadTokens", usage.cacheReadTokens],
			["cacheWriteTokens", usage.cacheWriteTokens],
		] as const) {
			nonNegativeInteger(value, name);
		}
		if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0) throw new Error("costUsd must be non-negative");
		this.state.inputTokens += usage.inputTokens;
		this.state.outputTokens += usage.outputTokens;
		this.state.cacheReadTokens += usage.cacheReadTokens;
		this.state.cacheWriteTokens += usage.cacheWriteTokens;
		this.state.knownCostUsd += usage.costUsd;
		this.state.pending = undefined;
		this.validateActualCaps();
		this.flush();
	}

	reserveEmbedding(id: string, estimatedTokens: number, nowMs: number): void {
		this.assertUsable(nowMs);
		nonNegativeInteger(estimatedTokens, "estimatedTokens");
		if (this.state.embeddingRequests >= this.manifest.budgets.maxEmbeddingRequests) {
			throw new Error("embedding_request_budget_exhausted");
		}
		this.assertCombinedRequestCapacity();
		if (this.state.embeddingTokens + estimatedTokens > this.manifest.budgets.maxEmbeddingTokens) {
			throw new Error("embedding_token_budget_exhausted");
		}
		const reservedCostUsd = (estimatedTokens * this.manifest.provider.embedding.usdPerMillionTokens) / 1_000_000;
		this.assertProjectedBudget(estimatedTokens, reservedCostUsd);
		this.state.embeddingRequests += 1;
		this.state.pending = { kind: "embedding", id, reservedTokens: estimatedTokens, reservedCostUsd };
		this.flush();
	}

	commitEmbedding(id: string, tokens: number, costUsd: number): void {
		this.requirePending("embedding", id);
		nonNegativeInteger(tokens, "embeddingTokens");
		if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("embeddingCostUsd must be non-negative");
		this.state.embeddingTokens += tokens;
		this.state.knownCostUsd += costUsd;
		this.state.pending = undefined;
		this.validateActualCaps();
		this.flush();
	}

	markPendingUsageUnknown(category: string): void {
		if (!this.state.pending) return;
		this.markIntegrityFailure(category);
	}

	markIntegrityFailure(category: string): void {
		if (!/^[a-z0-9_]{1,128}$/.test(category)) throw new Error("Integrity failure category is invalid");
		this.state.integrityFailure = category;
		this.flush();
	}

	resolveInitialNoDispatchBoundaryFalsePositive(nowMs: number): void {
		this.assertElapsed(nowMs);
		if (this.state.integrityFailure !== "chat_usage_reservation_missing") {
			throw new Error("The expected no-dispatch integrity failure is not active");
		}
		if (
			this.state.pending ||
			this.state.sessionsStarted !== 1 ||
			this.state.attemptIds.length !== 1 ||
			this.state.attemptIds[0] !== "baseline-D-01" ||
			this.state.chatRequests !== 0 ||
			this.state.embeddingRequests !== 0 ||
			reportedModelTokens(this.state) !== 0 ||
			this.state.embeddingTokens !== 0 ||
			this.state.knownCostUsd !== 0 ||
			(this.state.integrityResolutions?.length ?? 0) !== 0
		) {
			throw new Error("No-dispatch integrity resolution preconditions failed");
		}
		this.state.integrityResolutions = [
			{
				category: "chat_usage_reservation_missing",
				resolution: "allowed_static_documentation_lines",
				attemptId: "baseline-D-01",
				resolvedAtMs: nowMs,
			},
		];
		this.state.integrityFailure = undefined;
		this.flush();
	}

	private assertUsable(nowMs: number): void {
		this.assertElapsed(nowMs);
		if (this.state.integrityFailure) throw new Error(`evaluation_integrity_failure:${this.state.integrityFailure}`);
		if (this.state.pending) throw new Error("evaluation_usage_reconciliation_pending");
	}

	private assertCombinedRequestCapacity(): void {
		if (this.state.chatRequests + this.state.embeddingRequests >= this.manifest.budgets.maxPaidRequests) {
			throw new Error("paid_request_budget_exhausted");
		}
	}

	private assertProjectedBudget(reservedTokens: number, reservedCostUsd: number): void {
		const currentTokens = reportedModelTokens(this.state) + this.state.embeddingTokens;
		if (currentTokens + reservedTokens > this.manifest.budgets.maxCombinedReportedTokens) {
			throw new Error("combined_token_budget_exhausted");
		}
		if (this.state.knownCostUsd + reservedCostUsd > this.manifest.budgets.maxKnownCostUsd) {
			throw new Error("known_cost_budget_exhausted");
		}
	}

	private requirePending(kind: PendingReservation["kind"], id: string): void {
		if (!this.state.pending || this.state.pending.kind !== kind || this.state.pending.id !== id) {
			throw new Error("evaluation_usage_reservation_mismatch");
		}
	}

	private validateActualCaps(): void {
		if (
			reportedModelTokens(this.state) + this.state.embeddingTokens >
			this.manifest.budgets.maxCombinedReportedTokens
		) {
			throw new Error("combined_token_budget_exceeded_after_response");
		}
		if (this.state.embeddingTokens > this.manifest.budgets.maxEmbeddingTokens) {
			throw new Error("embedding_token_budget_exceeded_after_response");
		}
		if (this.state.knownCostUsd > this.manifest.budgets.maxKnownCostUsd) {
			throw new Error("known_cost_budget_exceeded_after_response");
		}
	}

	private validateState(): void {
		for (const [name, value] of [
			["chatRequests", this.state.chatRequests],
			["embeddingRequests", this.state.embeddingRequests],
			["sessionsStarted", this.state.sessionsStarted],
			["inputTokens", this.state.inputTokens],
			["outputTokens", this.state.outputTokens],
			["cacheReadTokens", this.state.cacheReadTokens],
			["cacheWriteTokens", this.state.cacheWriteTokens],
			["embeddingTokens", this.state.embeddingTokens],
		] as const) {
			nonNegativeInteger(value, name);
		}
		if (!Number.isFinite(this.state.knownCostUsd) || this.state.knownCostUsd < 0) {
			throw new Error("knownCostUsd must be non-negative");
		}
		if (new Set(this.state.attemptIds).size !== this.state.attemptIds.length) {
			throw new Error("Budget state contains duplicate attempts");
		}
		if (
			this.state.attemptIds.some(
				(attemptId) => !/^(?:baseline-D-0[12]|iteration_[12]-D-0[12]|held_out-H-0[12])$/.test(attemptId),
			)
		) {
			throw new Error("Budget state contains an invalid attempt id");
		}
		if (this.state.sessionsStarted !== this.state.attemptIds.length) {
			throw new Error("Budget state session and attempt counts disagree");
		}
		if (this.state.sessionsStarted > this.manifest.budgets.maxSessions) {
			throw new Error("Budget state exceeds the session cap");
		}
		if (this.state.chatRequests > this.manifest.budgets.maxChatRequests) {
			throw new Error("Budget state exceeds the chat-request cap");
		}
		if (this.state.embeddingRequests > this.manifest.budgets.maxEmbeddingRequests) {
			throw new Error("Budget state exceeds the embedding-request cap");
		}
		if (this.state.chatRequests + this.state.embeddingRequests > this.manifest.budgets.maxPaidRequests) {
			throw new Error("Budget state exceeds the paid-request cap");
		}
		if (this.state.pending && this.state.pending.kind === "chat" && this.state.chatRequests === 0) {
			throw new Error("Budget state has a chat reservation without a request");
		}
		if (this.state.pending && this.state.pending.kind === "embedding" && this.state.embeddingRequests === 0) {
			throw new Error("Budget state has an embedding reservation without a request");
		}
		for (const resolution of this.state.integrityResolutions ?? []) {
			if (
				resolution.category !== "chat_usage_reservation_missing" ||
				resolution.resolution !== "allowed_static_documentation_lines" ||
				resolution.attemptId !== "baseline-D-01" ||
				!Number.isSafeInteger(resolution.resolvedAtMs) ||
				resolution.resolvedAtMs < this.state.startedAtMs
			) {
				throw new Error("Budget state contains an invalid integrity resolution");
			}
		}
		if ((this.state.integrityResolutions?.length ?? 0) > 1) {
			throw new Error("Budget state contains duplicate integrity resolutions");
		}
		this.validateActualCaps();
	}

	private flush(): void {
		this.persist(this.snapshot());
	}
}

function replaceWorkspaceAndHandles(value: string, workspaceRoot: string, normalizeHandles: boolean): string {
	let normalized = value.replaceAll("\\", "/").replaceAll(workspaceRoot.replaceAll("\\", "/"), "$WORKSPACE");
	if (normalizeHandles) {
		normalized = normalized.replace(/\b(?:loc|view|patch|snap|node)_[A-Za-z0-9_-]+\b/g, "$HANDLE");
	}
	return normalized;
}

function normalizeFingerprintValue(value: unknown, workspaceRoot: string, normalizeHandles: boolean): unknown {
	if (typeof value === "string") return replaceWorkspaceAndHandles(value, workspaceRoot, normalizeHandles);
	if (Array.isArray(value))
		return value.map((item) => normalizeFingerprintValue(item, workspaceRoot, normalizeHandles));
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [
				key,
				normalizeFingerprintValue(nested, workspaceRoot, normalizeHandles),
			]),
		);
	}
	return value;
}

export function toolRequestFingerprint(
	toolName: string,
	args: unknown,
	workspaceRoot: string,
	normalizeHandles: boolean,
): string {
	return stableHash({
		toolName,
		args: normalizeFingerprintValue(args, workspaceRoot, normalizeHandles),
	});
}

export function statusEntriesTouchOnlyTarget(entries: readonly string[], targetPath: string): boolean {
	return entries.every((entry) => entry.length > 3 && entry.slice(3) === targetPath);
}

function textSegments(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function classifyToolResultText(text: string, evalCase: V2BoundedEvalCase): ContextByteCounts {
	const counts: ContextByteCounts = { useful: 0, duplicate: 0, irrelevant: 0, ambiguous: 0 };
	const targetName = evalCase.targetPath.split("/").at(-1) ?? evalCase.targetPath;
	const requiredFragments = [
		...evalCase.oldText.split(/\r?\n/),
		...evalCase.mutatedText.split(/\r?\n/),
		evalCase.fault?.marker ?? "",
	]
		.map((line) => line.trim())
		.filter((line) => line.length >= 4);
	for (const segment of textSegments(text)) {
		const normalized = segment.trim();
		const bytes = byteLength(segment);
		if (
			normalized === "PASS" ||
			normalized === "exit 0" ||
			normalized.includes(evalCase.targetPath) ||
			normalized.includes(targetName) ||
			requiredFragments.some((fragment) => normalized.includes(fragment))
		) {
			counts.useful += bytes;
		} else if (
			/\b(?:locator|locator_id|view_id|snapshot_id|file_hash|file_version|patch|patch_id|coverage|generation|range|byte_range|matched|complete|partial|approximate|truncated|exit|signal|timed out)\b/i.test(
				normalized,
			) ||
			/^(?:STALE_|INVALID_INPUT|SEARCH_|READ_|EDIT_|PATCH_|PREIMAGE_|RANGE_|BUDGET_|NO_MATCH)/.test(normalized)
		) {
			counts.ambiguous += bytes;
		} else {
			counts.irrelevant += bytes;
		}
	}
	return counts;
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

function toolResultTexts(context: unknown): string[] {
	if (!isRecord(context) || !Array.isArray(context.messages)) return [];
	return context.messages.flatMap((message) => {
		if (!isRecord(message) || message.role !== "toolResult") return [];
		const text = textFromContent(message.content);
		return text ? [text] : [];
	});
}

export class ProviderContextMetricsAccumulator {
	private readonly evalCase: V2BoundedEvalCase;
	private readonly seenSegments = new Set<string>();
	private readonly metrics: ProviderContextMetrics = {
		providerRequests: 0,
		providerPayloadBytes: 0,
		activeToolResultContextBytes: 0,
		peakActiveToolResultBytes: 0,
		useful: 0,
		duplicate: 0,
		irrelevant: 0,
		ambiguous: 0,
	};

	constructor(evalCase: V2BoundedEvalCase) {
		this.evalCase = evalCase;
	}

	observe(context: unknown): void {
		this.metrics.providerRequests += 1;
		this.metrics.providerPayloadBytes += byteLength(JSON.stringify(stableValue(context)));
		let activeBytes = 0;
		for (const text of toolResultTexts(context)) {
			const bytes = byteLength(text);
			activeBytes += bytes;
			const newSegments = new Set<string>();
			for (const segment of textSegments(text)) {
				const fingerprint = sha256(
					segment
						.trim()
						.replace(/\b(?:loc|view|patch|snap|node)_[A-Za-z0-9_-]+\b/g, "$HANDLE")
						.replace(/\s+/g, " "),
				);
				if (this.seenSegments.has(fingerprint)) {
					this.metrics.duplicate += byteLength(segment);
				} else {
					const labels = classifyToolResultText(segment, this.evalCase);
					this.metrics.useful += labels.useful;
					this.metrics.irrelevant += labels.irrelevant;
					this.metrics.ambiguous += labels.ambiguous;
				}
				newSegments.add(fingerprint);
			}
			for (const fingerprint of newSegments) this.seenSegments.add(fingerprint);
		}
		this.metrics.activeToolResultContextBytes += activeBytes;
		this.metrics.peakActiveToolResultBytes = Math.max(this.metrics.peakActiveToolResultBytes, activeBytes);
	}

	snapshot(): ProviderContextMetrics {
		return { ...this.metrics };
	}
}

const FORBIDDEN_CONTENT_KEYS = new Set([
	"path",
	"prompt",
	"command",
	"content",
	"message",
	"messages",
	"args",
	"response",
	"credentials",
	"apiKey",
	"source",
	"output",
]);

export function assertContentFreeRecord(value: unknown): void {
	const visit = (nested: unknown, key?: string): void => {
		if (key && FORBIDDEN_CONTENT_KEYS.has(key)) throw new Error(`Content-bearing record key is forbidden: ${key}`);
		if (typeof nested === "string") {
			if (nested.length > 128 || nested.includes("\n") || nested.includes("/") || nested.includes("\\")) {
				throw new Error("Evaluation record contains a content-like string");
			}
			return;
		}
		if (Array.isArray(nested)) {
			for (const item of nested) visit(item);
			return;
		}
		if (isRecord(nested)) {
			for (const [nestedKey, nestedValue] of Object.entries(nested)) visit(nestedValue, nestedKey);
		}
	};
	visit(value);
}

function replaceAllowedForbiddenRootLines(value: unknown, allowedLines: ReadonlySet<string>): unknown {
	if (typeof value === "string") {
		return value
			.split("\n")
			.map((line) => (allowedLines.has(line) ? "$ALLOWED_STATIC_REFERENCE" : line))
			.join("\n");
	}
	if (Array.isArray(value)) return value.map((entry) => replaceAllowedForbiddenRootLines(entry, allowedLines));
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [key, replaceAllowedForbiddenRootLines(nested, allowedLines)]),
		);
	}
	return value;
}

export function assertProviderContextBoundary(
	context: unknown,
	options: {
		publicRoot: string;
		forbiddenRoots: string[];
		forbiddenValues: string[];
		allowedForbiddenRootLines?: string[];
	},
): void {
	const serialized = JSON.stringify(context);
	const rootChecked = JSON.stringify(
		replaceAllowedForbiddenRootLines(context, new Set(options.allowedForbiddenRootLines ?? [])),
	);
	for (const root of options.forbiddenRoots.filter(Boolean)) {
		if (rootChecked.includes(root)) throw new Error("provider_context_forbidden_root");
	}
	for (const secret of options.forbiddenValues.filter((value) => value.length >= 8)) {
		if (serialized.includes(secret)) throw new Error("provider_context_secret_value");
	}
	const absolutePaths = rootChecked.match(/\/(?:Users|private|tmp)\/[^\s"']+/g) ?? [];
	const normalizedPublicRoot = options.publicRoot.replaceAll("\\", "/");
	for (const path of absolutePaths) {
		const normalized = path.replaceAll("\\", "/");
		if (!normalized.startsWith(normalizedPublicRoot) && !normalized.startsWith("/tmp/")) {
			throw new Error("provider_context_unapproved_absolute_path");
		}
	}
}
