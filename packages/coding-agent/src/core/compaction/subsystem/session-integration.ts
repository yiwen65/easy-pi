import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	contentText,
	isContextOverflow,
	isRecoverableLength,
	type RetryCallbacks,
	type RetryPolicy,
} from "@earendil-works/pi-ai";
import type { Model, Tool } from "@earendil-works/pi-ai/compat";
import { createCompactionSummaryMessage } from "../../messages.ts";
import {
	buildSessionContext,
	getLatestCompactionEntry,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "../../session-manager.ts";
import { completeSummarization, estimateTokens } from "../compaction.ts";
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
}): TokenStats {
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
		system,
		tools: options.tools,
		compactionItem,
		recentUsers,
		postCheckpointHistory: otherHistory,
		currentInput,
		outputReserve: options.outputReserve,
		total:
			system + options.tools + compactionItem + recentUsers + otherHistory + currentInput + options.outputReserve,
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
		const stats = tokenStats({
			systemPrompt: this.getSystemPrompt(),
			tools: this.getToolsTokenEstimate?.() ?? 0,
			messages,
			currentInput: input.currentInput ?? "",
			currentInputExtraTokens: input.currentInputExtraTokens ?? 0,
			outputReserve: input.outputReserveTokens,
		});
		const recentUsageFloor = Math.max(
			0,
			(input.recentProviderContextTokens ?? 0) +
				estimateText(input.currentInput ?? "") +
				(input.currentInputExtraTokens ?? 0),
		);
		const predictedNextRequestTokens = Math.max(stats.total, recentUsageFloor);
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
				previousCallOverflowed: input.previousCallOverflowed,
				sameProviderContextAsLastCompaction,
			}),
			predictedNextRequestTokens,
			tokenEstimateProvenance:
				recentUsageFloor > stats.total ? "provider_projection_with_recent_usage_floor" : "provider_projection",
			sameProviderContextAsLastCompaction,
		};
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
		const stats = tokenStats({
			systemPrompt,
			tools: this.getToolsTokenEstimate?.() ?? 0,
			messages,
			currentInput: "",
			currentInputExtraTokens: 0,
			outputReserve: this.config.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS,
		});
		return {
			mode: this.config.mode,
			checkpointEntryId: checkpoint.id,
			replacementMessageCount: checkpoint.replacementHistory.length,
			tailMessageCount: tailMessages.length,
			toolsTokenEstimate: stats.tools,
			tokenStats: stats,
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
			const outputReserve =
				options.outputReserveTokens ?? this.config.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
			const messageTokenBudget =
				options.modelContextLimit === undefined
					? undefined
					: Math.max(
							0,
							options.modelContextLimit -
								estimateText(systemPrompt) -
								toolsTokenEstimate -
								outputReserve -
								estimateLocalCompactionTriggerTokens(options.customInstructions),
						);
			const tools = toolsTokenEstimate;
			const before = tokenStats({
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
			const replacedTokens = before.compactionItem + before.recentUsers + before.postCheckpointHistory;
			const summaryIssue = validateCompactionSummary(summary, replacedTokens);
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
