import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	contentText,
	isContextOverflow,
	isRecoverableLength,
	type RetryCallbacks,
	type RetryPolicy,
} from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, Tool } from "@earendil-works/pi-ai/compat";
import { createCompactionSummaryMessage } from "../../messages.ts";
import {
	buildSessionContext,
	getLatestCompactionEntry,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "../../session-manager.ts";
import { completeSummarization, estimateContextTokens, estimateTokens } from "../compaction.ts";
import type { ProviderContextObservation } from "./context-identity.ts";
import {
	estimateLocalCompactionTriggerTokens,
	generateCompactionItem,
	validateCompactionSummary,
} from "./narrative.ts";
import { AuditTrail } from "./observability.ts";
import { evaluateTriggers, type TriggerDecision } from "./trigger.ts";
import type { CompleteFn, TokenStats } from "./types.ts";

export type HfCompactionMode = "off" | "full_pipeline";
const DEFAULT_OUTPUT_RESERVE_TOKENS = 4_096;
const DEFAULT_RECENT_USER_TOKENS = 8_192;
/** Slack kept below the feasibility ceiling for provider-side rounding above local estimates. */
const TRIGGER_FEASIBILITY_MARGIN_TOKENS = 1_024;
/** Calibration samples smaller than this are dominated by fixed per-request overhead. */
const MIN_CALIBRATION_LOCAL_TOKENS = 500;
const MIN_CALIBRATION_PROVIDER_TOKENS = 1_000;
/** Measured providers tokenize CJK and digit-dense text 1.7-2.4x denser than chars/4. */
const MAX_ESTIMATE_CALIBRATION = 4;

/**
 * Most recent provider measurement of a prompt, paired with the local estimate of the same prefix.
 * `usage.input` excludes cache reads and writes for every supported provider, so the measured prompt
 * is the sum of the three; the assistant message carrying the usage is itself the response, not part
 * of the prompt.
 */
function lastPromptMeasurement(
	messages: readonly AgentMessage[],
): { providerPromptTokens: number; localPrefixTokens: number; messageIndex: number } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason === "aborted" || assistant.stopReason === "error") continue;
		const usage = assistant.usage;
		if (!usage) continue;
		const providerPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (providerPromptTokens <= 0) continue;
		let localPrefixTokens = 0;
		for (let i = 0; i < index; i++) localPrefixTokens += estimateTokens(messages[i]!);
		return { providerPromptTokens, localPrefixTokens, messageIndex: index };
	}
	return undefined;
}

export function getHfCompactionModeFromEnv(
	env: Record<string, string | undefined> = process.env,
): HfCompactionMode | undefined {
	const raw = env.PI_HF_COMPACTION;
	if (raw === undefined || raw === "") return undefined;
	if (raw === "off" || raw === "full_pipeline") return raw;
	throw new Error(`Invalid PI_HF_COMPACTION value ${JSON.stringify(raw)}; expected "off" or "full_pipeline"`);
}

export interface HfTriggerEvaluation {
	decision: TriggerDecision;
	predictedNextRequestTokens: number;
	tokenEstimateProvenance: "provider_projection" | "provider_projection_with_recent_usage_floor";
	sameProviderContextAsLastCompaction: boolean;
}

export interface ContextInspection {
	mode: HfCompactionMode;
	checkpointEntryId: string;
	replacementMessageCount: number;
	tailMessageCount: number;
	toolsTokenEstimate: number;
	tokenStats: TokenStats;
	/** Provider-to-local token ratio applied to the reported zone sizes. */
	estimateCalibration: number;
	checkpointMessages: AgentMessage[];
	providerContext?: ProviderContextObservation;
	systemPrompt?: { text: string; tokens: number };
}

export interface HfCompactionConfig {
	mode: HfCompactionMode;
	complete?: CompleteFn;
	outputReserveTokens?: number;
	recentUserTokens?: number;
}

export interface CheckpointCandidate {
	replacementHistory: AgentMessage[];
	tokensBefore: number;
	tokensAfter: number;
	modelUsage?: { input: number; output: number };
}

export interface CompactResult {
	status: "activated" | "rejected";
	reason?: string;
}

function estimateText(text: string): number {
	return Math.ceil(text.length / 4);
}

function selectLatestUnansweredUserMessage(messages: readonly AgentMessage[], tokenBudget: number): AgentMessage[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		for (let laterIndex = index + 1; laterIndex < messages.length; laterIndex++) {
			const laterRole = messages[laterIndex].role;
			if (laterRole === "assistant" || laterRole === "toolResult") return [];
		}
		return estimateTokens(message) <= Math.max(0, tokenBudget) ? [structuredClone(message)] : [];
	}
	return [];
}

function tokenStats(options: {
	systemPrompt: string;
	tools: number;
	messages: readonly AgentMessage[];
	currentInput: string;
	currentInputExtraTokens: number;
	outputReserve: number;
	/** Provider-to-local token ratio; 1 keeps the raw chars/4 estimate. */
	calibration?: number;
}): TokenStats {
	const calibration = options.calibration ?? 1;
	const scale = (tokens: number): number => Math.ceil(tokens * calibration);
	const compactionItem = options.messages
		.filter((message) => message.role === "compactionSummary")
		.reduce((sum, message) => sum + estimateTokens(message), 0);
	const recentUsers = options.messages
		.filter((message) => message.role === "user")
		.reduce((sum, message) => sum + estimateTokens(message), 0);
	const otherHistory = options.messages
		.filter((message) => message.role !== "compactionSummary" && message.role !== "user")
		.reduce((sum, message) => sum + estimateTokens(message), 0);
	const currentInput = estimateText(options.currentInput) + options.currentInputExtraTokens;
	const system = estimateText(options.systemPrompt);
	return {
		system: scale(system),
		tools: scale(options.tools),
		compactionItem: scale(compactionItem),
		recentUsers: scale(recentUsers),
		postCheckpointHistory: scale(otherHistory),
		currentInput: scale(currentInput),
		outputReserve: options.outputReserve,
		total:
			scale(system) +
			scale(options.tools) +
			scale(compactionItem) +
			scale(recentUsers) +
			scale(otherHistory) +
			scale(currentInput) +
			options.outputReserve,
	};
}

function formatSummary(candidate: CheckpointCandidate): string {
	const change =
		candidate.tokensBefore > 0
			? ((candidate.tokensBefore - candidate.tokensAfter) / candidate.tokensBefore) * 100
			: 0;
	const changeLabel = change >= 0 ? `${change.toFixed(1)}% reduction` : `${Math.abs(change).toFixed(1)}% increase`;
	return [
		"[compaction checkpoint created]",
		`tokens: ${candidate.tokensBefore.toLocaleString()} → ${candidate.tokensAfter.toLocaleString()} (${changeLabel})`,
		"",
		candidate.replacementHistory.find((message) => message.role === "compactionSummary")?.summary ??
			"[compaction item]",
	].join("\n");
}

export class HfCompactionHost {
	readonly audit = new AuditTrail();
	private readonly sessionId: string;
	private readonly getSystemPrompt: () => string;
	private readonly config: HfCompactionConfig;
	private readonly getToolsTokenEstimate: (() => number) | undefined;
	private readonly getTools: (() => Tool[]) | undefined;
	private readonly getToolEvidenceSummary: (() => string | undefined) | undefined;
	private branchEntries: SessionEntry[] = [];
	private latestProviderContext?: ProviderContextObservation;
	private compactionInFlight = false;
	/** Provider-to-local token ratio learned from the most recent provider measurement. */
	private calibrationFactor?: number;

	constructor(options: {
		sessionId: string;
		getSystemPrompt: () => string;
		config: HfCompactionConfig;
		getToolsTokenEstimate?: () => number;
		getTools?: () => Tool[];
		getToolEvidenceSummary?: () => string | undefined;
	}) {
		this.sessionId = options.sessionId;
		this.getSystemPrompt = options.getSystemPrompt;
		this.config = options.config;
		this.getToolsTokenEstimate = options.getToolsTokenEstimate;
		this.getTools = options.getTools;
		this.getToolEvidenceSummary = options.getToolEvidenceSummary;
	}

	get configComplete(): CompleteFn | undefined {
		return this.config.complete;
	}

	get mode(): HfCompactionMode {
		return this.config.mode;
	}

	syncFromEntries(entries: SessionEntry[]): void {
		if (this.compactionInFlight && this.branchEntries.at(-1)?.id !== entries.at(-1)?.id) {
			throw new Error(`Cannot change the session path while compaction is in progress for ${this.sessionId}`);
		}
		this.branchEntries = entries.slice();
	}

	private activeMessages(entries = this.branchEntries): AgentMessage[] {
		return buildSessionContext(entries).messages;
	}

	private latestCheckpoint(entries = this.branchEntries) {
		const latest = getLatestCompactionEntry(entries);
		if (!latest?.replacementHistory) return undefined;
		return latest;
	}

	evaluateCompactionTrigger(input: {
		branchEntries: SessionEntry[];
		modelContextLimit: number;
		outputReserveTokens: number;
		currentInput?: string;
		currentInputExtraTokens?: number;
		recentProviderContextTokens?: number;
		previousCallOverflowed?: boolean;
	}): HfTriggerEvaluation {
		this.syncFromEntries(input.branchEntries);
		const messages = this.activeMessages(input.branchEntries);
		const calibration = this.estimateCalibration(messages);
		const stats = tokenStats({
			systemPrompt: this.getSystemPrompt(),
			tools: this.getToolsTokenEstimate?.() ?? 0,
			messages,
			currentInput: input.currentInput ?? "",
			currentInputExtraTokens: input.currentInputExtraTokens ?? 0,
			outputReserve: input.outputReserveTokens,
			calibration,
		});
		const recentUsageFloor = Math.max(
			0,
			(input.recentProviderContextTokens ?? 0) +
				estimateText(input.currentInput ?? "") +
				(input.currentInputExtraTokens ?? 0),
		);
		const calibratedProjection = Math.max(
			stats.total,
			this.predictedPromptTokens({
				messages,
				calibration,
				unscaledSystemTokens: estimateText(this.getSystemPrompt()),
				unscaledToolsTokens: this.getToolsTokenEstimate?.() ?? 0,
				unscaledCurrentInputTokens: estimateText(input.currentInput ?? "") + (input.currentInputExtraTokens ?? 0),
			}) + stats.outputReserve,
		);
		const predictedNextRequestTokens = Math.max(calibratedProjection, recentUsageFloor);
		const checkpoint = this.latestCheckpoint(input.branchEntries);
		const checkpointIndex = checkpoint ? input.branchEntries.findIndex((entry) => entry.id === checkpoint.id) : -1;
		const hasVisibleTail =
			checkpointIndex >= 0 &&
			input.branchEntries
				.slice(checkpointIndex + 1)
				.some((entry) => sessionEntryToContextMessages(entry).length > 0);
		const sameProviderContextAsLastCompaction =
			checkpoint !== undefined &&
			!hasVisibleTail &&
			(input.currentInput?.length ?? 0) === 0 &&
			(input.currentInputExtraTokens ?? 0) === 0;
		return {
			decision: evaluateTriggers({
				predictedNextRequestTokens,
				modelContextLimit: input.modelContextLimit,
				maxFeasibleTokens: this.compactionFeasibilityCeiling(input.modelContextLimit),
				previousCallOverflowed: input.previousCallOverflowed,
				sameProviderContextAsLastCompaction,
			}),
			predictedNextRequestTokens,
			tokenEstimateProvenance:
				recentUsageFloor > calibratedProjection
					? "provider_projection_with_recent_usage_floor"
					: "provider_projection",
			sameProviderContextAsLastCompaction,
		};
	}

	/** Compaction output space. The main-response reserve is not reserved here: a handoff is small. */
	private compactionOutputReserveTokens(): number {
		return this.config.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
	}

	/**
	 * Ratio between provider-measured prompt tokens and the local character estimate of the same
	 * prefix. Local estimates assume ~4 characters per token; providers tokenize CJK and digit-dense
	 * text 1.7-2.4x denser, which made every locally derived number that much too small.
	 */
	private estimateCalibration(messages: readonly AgentMessage[]): number {
		const measurement = lastPromptMeasurement(messages);
		if (!measurement) return this.calibrationFactor ?? 1;
		const localPrompt =
			estimateText(this.getSystemPrompt()) + (this.getToolsTokenEstimate?.() ?? 0) + measurement.localPrefixTokens;
		if (
			localPrompt < MIN_CALIBRATION_LOCAL_TOKENS ||
			measurement.providerPromptTokens < MIN_CALIBRATION_PROVIDER_TOKENS
		) {
			return this.calibrationFactor ?? 1;
		}
		const sample = Math.min(MAX_ESTIMATE_CALIBRATION, Math.max(1, measurement.providerPromptTokens / localPrompt));
		this.calibrationFactor = this.calibrationFactor === undefined ? sample : (this.calibrationFactor + sample) / 2;
		return this.calibrationFactor;
	}

	/**
	 * Predicted prompt size for the next provider request: the measured prefix plus the locally
	 * estimated growth since it, both expressed in provider terms.
	 */
	private predictedPromptTokens(options: {
		messages: readonly AgentMessage[];
		calibration: number;
		unscaledSystemTokens: number;
		unscaledToolsTokens: number;
		unscaledCurrentInputTokens: number;
	}): number {
		const measurement = lastPromptMeasurement(options.messages);
		if (!measurement) {
			let localPrompt =
				options.unscaledSystemTokens + options.unscaledToolsTokens + options.unscaledCurrentInputTokens;
			for (const message of options.messages) localPrompt += estimateTokens(message);
			return Math.ceil(localPrompt * options.calibration);
		}
		let growth = options.unscaledCurrentInputTokens;
		for (let index = measurement.messageIndex + 1; index < options.messages.length; index++) {
			growth += estimateTokens(options.messages[index]!);
		}
		return measurement.providerPromptTokens + Math.ceil(growth * options.calibration);
	}

	/**
	 * Largest predicted next request a compaction request can still carry. Returns undefined when
	 * fixed compaction costs (trigger prompt + output reserve) leave no room at all.
	 */
	private compactionFeasibilityCeiling(modelContextLimit: number): number | undefined {
		const ceiling =
			modelContextLimit -
			this.compactionOutputReserveTokens() -
			estimateLocalCompactionTriggerTokens(undefined) -
			TRIGGER_FEASIBILITY_MARGIN_TOKENS;
		return ceiling > 0 ? ceiling : undefined;
	}

	getActiveTriggerBoundary(): { eventId: string; timestamp: string } | undefined {
		const checkpoint = this.latestCheckpoint();
		return checkpoint ? { eventId: checkpoint.id, timestamp: checkpoint.timestamp } : undefined;
	}

	recordProviderContextObservation(observation: ProviderContextObservation): void {
		this.latestProviderContext = { ...observation };
		this.audit.record("provider_context", this.sessionId, { ...observation });
	}

	inspectActiveContext(options: { includeSystemPrompt?: boolean } = {}): ContextInspection | undefined {
		const checkpoint = this.latestCheckpoint();
		if (!checkpoint?.replacementHistory) return undefined;
		const checkpointIndex = this.branchEntries.findIndex((entry) => entry.id === checkpoint.id);
		const tailMessages = this.branchEntries.slice(checkpointIndex + 1).flatMap(sessionEntryToContextMessages);
		const messages = [...checkpoint.replacementHistory, ...tailMessages];
		const systemPrompt = this.getSystemPrompt();
		const calibration = this.estimateCalibration(messages);
		const stats = tokenStats({
			systemPrompt,
			tools: this.getToolsTokenEstimate?.() ?? 0,
			messages,
			currentInput: "",
			currentInputExtraTokens: 0,
			outputReserve: this.compactionOutputReserveTokens(),
			calibration,
		});
		return {
			mode: this.config.mode,
			checkpointEntryId: checkpoint.id,
			replacementMessageCount: checkpoint.replacementHistory.length,
			tailMessageCount: tailMessages.length,
			toolsTokenEstimate: stats.tools,
			tokenStats: stats,
			estimateCalibration: calibration,
			checkpointMessages: structuredClone(checkpoint.replacementHistory),
			...(this.latestProviderContext ? { providerContext: { ...this.latestProviderContext } } : {}),
			...(options.includeSystemPrompt ? { systemPrompt: { text: systemPrompt, tokens: stats.system } } : {}),
		};
	}

	async attemptCompaction(options: {
		complete?: CompleteFn;
		manual?: boolean;
		triggerReasons?: readonly string[];
		currentInput?: string;
		currentInputExtraTokens?: number;
		branchEntries: SessionEntry[];
		signal?: AbortSignal;
		outputReserveTokens?: number;
		recentUserTokens?: number;
		customInstructions?: string;
		modelContextLimit?: number;
	}): Promise<{
		activated: boolean;
		checkpoint?: CheckpointCandidate;
		summaryText: string;
		result?: CompactResult;
		tokensBefore?: number;
		tokensAfter?: number;
	}> {
		if (this.compactionInFlight) throw new Error(`Compaction is already in progress for session ${this.sessionId}`);
		this.syncFromEntries(options.branchEntries);
		this.compactionInFlight = true;
		try {
			const activeMessages = this.activeMessages(options.branchEntries);
			if (activeMessages.length === 0) {
				return { activated: false, summaryText: "no messages to compact", result: { status: "rejected" } };
			}
			const systemPrompt = this.getSystemPrompt();
			const toolsTokenEstimate = this.getToolsTokenEstimate?.() ?? 0;
			const currentInput = options.currentInput ?? "";
			const currentInputExtraTokens = options.currentInputExtraTokens ?? 0;
			const outputReserve = options.outputReserveTokens ?? this.compactionOutputReserveTokens();
			const estimatedMessageTokens = activeMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
			const estimatedCurrentInputTokens = estimateText(currentInput) + currentInputExtraTokens;
			const recentContext = estimateContextTokens(activeMessages);
			// A recent provider usage block is the strongest measurement of the same prefix the
			// compactor will receive. Carry any shortfall in the local chars/4 estimate into the
			// trimming budget so the handoff request does not repeat the overflow it is meant to fix.
			const providerProjectionCorrection =
				recentContext.lastUsageIndex === null
					? 0
					: Math.max(
							0,
							recentContext.tokens +
								estimatedCurrentInputTokens -
								(estimateText(systemPrompt) +
									toolsTokenEstimate +
									estimatedMessageTokens +
									estimatedCurrentInputTokens),
						);
			const messageTokenBudget =
				options.modelContextLimit === undefined
					? undefined
					: Math.max(
							0,
							options.modelContextLimit -
								estimateText(systemPrompt) -
								toolsTokenEstimate -
								outputReserve -
								estimateLocalCompactionTriggerTokens(options.customInstructions) -
								providerProjectionCorrection,
						);
			const tools = toolsTokenEstimate;
			const calibration = this.estimateCalibration(activeMessages);
			const before = tokenStats({
				systemPrompt: this.getSystemPrompt(),
				tools,
				messages: activeMessages,
				currentInput,
				currentInputExtraTokens,
				outputReserve,
				calibration,
			});
			// Local units for the summary-proportionality gate: it compares two locally estimated sizes,
			// so scaling only one side would change the ratio it is meant to check.
			const beforeLocal = tokenStats({
				systemPrompt: this.getSystemPrompt(),
				tools,
				messages: activeMessages,
				currentInput,
				currentInputExtraTokens,
				outputReserve,
			});
			if (!options.complete) {
				const reason = "No local compaction model is configured";
				return { activated: false, summaryText: reason, result: { status: "rejected", reason } };
			}
			const generated = await generateCompactionItem({
				messages: activeMessages,
				systemPrompt,
				tools: this.getTools?.(),
				complete: options.complete,
				signal: options.signal,
				customInstructions: options.customInstructions,
				messageTokenBudget,
			});
			if (generated.rejected) {
				return {
					activated: false,
					summaryText: generated.reason ?? "compaction item generation failed",
					result: { status: "rejected", reason: generated.reason },
				};
			}
			const modelUsage = generated.modelUsage;
			const toolEvidence = this.getToolEvidenceSummary?.()?.trim();
			const summary = toolEvidence ? `${generated.text}\n\n${toolEvidence}` : generated.text;
			const summaryMessage = createCompactionSummaryMessage(summary, before.total, new Date().toISOString());
			const recentUserBudget = Math.min(
				options.recentUserTokens ?? this.config.recentUserTokens ?? DEFAULT_RECENT_USER_TOKENS,
				DEFAULT_RECENT_USER_TOKENS,
			);
			const recentUsers = selectLatestUnansweredUserMessage(activeMessages, recentUserBudget);
			const replacementHistory = [summaryMessage, ...recentUsers];
			if (options.signal?.aborted) {
				return { activated: false, summaryText: "compaction aborted", result: { status: "rejected" } };
			}
			const after = tokenStats({
				systemPrompt: this.getSystemPrompt(),
				tools,
				messages: replacementHistory,
				currentInput,
				currentInputExtraTokens,
				outputReserve,
				calibration,
			});
			summaryMessage.estimatedTokensAfter = after.total;
			const compactedInputTokens = after.total - outputReserve;
			const fixedInputTokens = after.system + after.tools + after.currentInput;
			if (
				options.modelContextLimit !== undefined &&
				fixedInputTokens < options.modelContextLimit &&
				compactedInputTokens >= options.modelContextLimit
			) {
				const reason = `Compacted context input would exceed the model context limit (${compactedInputTokens} >= ${options.modelContextLimit} tokens)`;
				return {
					activated: false,
					summaryText: reason,
					result: { status: "rejected", reason },
					tokensBefore: before.total,
					tokensAfter: after.total,
				};
			}
			if (after.total >= before.total) {
				const reason = `Compaction would not reduce context (${before.total} -> ${after.total} tokens)`;
				return {
					activated: false,
					summaryText: reason,
					result: { status: "rejected", reason },
					tokensBefore: before.total,
					tokensAfter: after.total,
				};
			}
			// Guard the artifact that actually replaces the branch: a handoff that is trivially small
			// relative to the history it stands in for means the summarizing model never saw that history.
			const replacedTokens =
				beforeLocal.compactionItem + beforeLocal.recentUsers + beforeLocal.postCheckpointHistory;
			const summaryIssue = validateCompactionSummary(summary, replacedTokens, {
				truncatedInput: generated.truncatedInput === true,
			});
			if (summaryIssue) {
				this.audit.record("checkpoint_rejected", this.sessionId, {
					reason: summaryIssue,
					tokensBefore: before.total,
					tokensAfter: after.total,
					summaryChars: summary.length,
					usageInput: modelUsage?.input,
					usageOutput: modelUsage?.output,
				});
				return {
					activated: false,
					summaryText: summaryIssue,
					result: { status: "rejected", reason: summaryIssue },
					tokensBefore: before.total,
					tokensAfter: after.total,
				};
			}
			const checkpoint: CheckpointCandidate = {
				replacementHistory,
				tokensBefore: before.total,
				tokensAfter: after.total,
				modelUsage,
			};
			this.audit.record("checkpoint_validated", this.sessionId, {
				tokensBefore: before.total,
				tokensAfter: after.total,
				replacementMessages: replacementHistory.length,
				reasons: options.triggerReasons?.join("; ") ?? (options.manual ? "manual" : ""),
			});
			return {
				activated: true,
				checkpoint,
				summaryText: formatSummary(checkpoint),
				result: { status: "activated" },
				tokensBefore: before.total,
				tokensAfter: after.total,
			};
		} finally {
			this.compactionInFlight = false;
		}
	}

	buildActiveMessages(branchEntries?: SessionEntry[]): AgentMessage[] | undefined {
		const entries = branchEntries ?? this.branchEntries;
		return this.latestCheckpoint(entries) ? this.activeMessages(entries) : undefined;
	}
}

export function createPiAiCompleteFn(options: {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	streamFn?: StreamFn;
	retry?: RetryPolicy;
	callbacks?: RetryCallbacks;
	promptCacheKey?: string;
	sessionId?: string;
}): CompleteFn {
	return async (request) => {
		const response = await completeSummarization(
			options.model,
			{
				systemPrompt: request.systemPrompt,
				messages: request.messages,
				tools: request.tools,
			},
			{
				signal: request.signal,
				cacheRetention: "short",
				promptCacheKey: options.promptCacheKey,
				sessionId: options.sessionId,
				apiKey: options.apiKey,
				headers: options.headers,
				env: options.env,
			},
			options.streamFn,
			options.retry,
			options.callbacks,
		);
		const usage = { input: response.usage.input, output: response.usage.output };
		if (response.stopReason === "error") {
			return { text: "", stopReason: "error", errorMessage: response.errorMessage ?? "unknown", usage };
		}
		if (response.stopReason === "aborted") return { text: "", stopReason: "aborted", usage };
		const text = contentText(response.content);
		// A gateway can accept an oversized request and answer anyway, either by truncating the input or
		// by reporting usage above its own window. Passing that off as "stop" lets a degenerate handoff
		// replace the whole branch, so overflow and length stops stay visible to the caller.
		if (isContextOverflow(response, options.model.contextWindow)) {
			const inputTokens = response.usage.input + response.usage.cacheRead;
			return {
				text: "",
				stopReason: "error",
				errorMessage: `context overflow while summarizing (${inputTokens} input tokens reported against a ${options.model.contextWindow} token window)`,
				contextOverflow: true,
				usage,
			};
		}
		if (response.stopReason === "length") {
			return {
				text,
				stopReason: "length",
				errorMessage: isRecoverableLength(response, options.model.maxTokens)
					? `summarization was truncated below the ${options.model.maxTokens} token output limit after ${usage.output} output tokens`
					: `summarization reached the ${options.model.maxTokens} token output limit after ${usage.output} output tokens`,
				usage,
			};
		}
		if (response.stopReason !== "stop") {
			return {
				text: "",
				stopReason: "error",
				errorMessage: `summarization stopped with unsupported reason "${response.stopReason}"`,
				usage,
			};
		}
		return { text, stopReason: "stop", usage };
	};
}
