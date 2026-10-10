/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	isRetryableAssistantError,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { fingerprintAssistantTurn, fingerprintToolResult, NO_PROGRESS_REPEAT_LIMIT } from "./no-progress.ts";
import { createStepSnapshot } from "./step-snapshot.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import { getToolErrorOutcome } from "./tool-outcome.ts";
import { cloneToolSchema } from "./tool-schema.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	PrepareNextTurnContext,
	StreamFn,
	ToolExecutionOutcome,
} from "./types.ts";
import { AgentToolError } from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

type ExecutionEvent = Parameters<NonNullable<AgentLoopConfig["onExecutionEvent"]>>[0];

function reportExecution(config: AgentLoopConfig, event: ExecutionEvent): void {
	reportExecutionObserver(config.onExecutionEvent, event);
}

function reportExecutionObserver(observer: AgentLoopConfig["onExecutionEvent"], event: ExecutionEvent): void {
	try {
		observer?.(event);
	} catch {
		// Diagnostics cannot change execution.
	}
}

function monotonicNow(): number {
	return globalThis.performance?.now() ?? Date.now();
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * A completed response cannot be continued. A text-only response checkpoint
 * may be continued because the enclosing response failed before completion.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	const lastMessage = context.messages[context.messages.length - 1];
	if (lastMessage.role === "assistant" && !(lastMessage.isResponseCheckpoint && lastMessage.stopReason === "stop")) {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}
	currentContext.systemPrompt = resolveSystemPrompt(currentContext.systemPrompt, config);

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	const lastMessage = context.messages[context.messages.length - 1];
	if (lastMessage.role === "assistant" && !(lastMessage.isResponseCheckpoint && lastMessage.stopReason === "stop")) {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

/** Execute only unresolved calls from a persisted assistant, then continue with ordered results. */
export async function runAgentLoopResumeTools(
	context: AgentContext,
	assistant: AssistantMessage,
	completedResults: ToolResultMessage[],
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const calls = assistant.content.filter((block) => block.type === "toolCall");
	const assistantIndex = context.messages.indexOf(assistant);
	if (assistantIndex < 0 || calls.length === 0 || new Set(calls.map((call) => call.id)).size !== calls.length) {
		throw new Error("Invalid recovery assistant");
	}
	const completed = new Map(completedResults.map((result) => [result.toolCallId, result]));
	if (
		completed.size !== completedResults.length ||
		completedResults.some(
			(result) => !calls.some((call) => call.id === result.toolCallId && call.name === result.toolName),
		)
	) {
		throw new Error("Invalid recovered tool results");
	}
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted" || assistant.stopReason === "length") {
		throw new Error("Cannot execute tools from an incomplete assistant response");
	}
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	const batch = await executeToolCalls(
		context,
		assistant,
		config,
		signal,
		emit,
		calls.filter((call) => !completed.has(call.id)),
	);
	for (const result of batch.messages) completed.set(result.toolCallId, result);
	const ordered = calls.flatMap((call) => {
		const result = completed.get(call.id);
		return result ? [result] : [];
	});
	const currentContext = { ...context, messages: [...context.messages.slice(0, assistantIndex + 1), ...ordered] };
	const newMessages: AgentMessage[] = [...batch.messages];
	await emit({ type: "turn_end", message: assistant, toolResults: ordered });
	if (
		signal?.aborted ||
		batch.terminate ||
		(await config.shouldStopAfterTurn?.({
			message: assistant,
			toolResults: ordered,
			context: currentContext,
			newMessages,
		}))
	) {
		await emit({ type: "agent_end", messages: newMessages });
		return newMessages;
	}
	await runLoop(currentContext, newMessages, config, signal, emit, streamFn, {
		message: assistant,
		toolResults: ordered,
		context: currentContext,
		newMessages,
	});
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
	recoveredTurn?: PrepareNextTurnContext,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined = recoveredTurn;
	/** Progress fingerprints of consecutive tool-call turns in this run. */
	let lastTurnFingerprint: string | undefined;
	let turnFingerprintRepeats = 0;
	let stepNumber = 0;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (lastCompletedTurn) {
				const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					config = {
						...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning:
							nextTurnSnapshot.thinkingLevel === undefined
								? config.reasoning
								: nextTurnSnapshot.thinkingLevel === "off"
									? undefined
									: nextTurnSnapshot.thinkingLevel,
					};
				}
				// Preparation can be long-running (for example, compaction). Pick up steering
				// queued while it ran. Only poll again if the earlier poll returned nothing;
				// otherwise one-at-a-time mode would deliver two messages in this turn.
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getSteeringMessages?.()) || [];
				}
				await emit({ type: "turn_start" });
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
				currentContext.systemPrompt = resolveSystemPrompt(currentContext.systemPrompt, config);
			}

			// Bind the exact context, model, and tool handlers for this provider step.
			const stepSnapshot = createStepSnapshot(currentContext, config, ++stepNumber);
			currentContext = stepSnapshot.context;
			config = {
				...config,
				model: stepSnapshot.model,
				stepId: stepSnapshot.stepId,
				toolPlanRevision: stepSnapshot.toolPlan.revision,
			};
			// Stream assistant response
			const streamed = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			let message = streamed.message;
			const recoveredToolResults: ToolResultMessage[] = [];
			if (streamed.checkpoint) {
				const checkpoint = streamed.checkpoint;
				currentContext.messages.push(checkpoint);
				newMessages.push(checkpoint);
				// Await persistence/listeners before admitting any recovered tool effects.
				await emit({ type: "message_end", message: checkpoint });
				let terminate = false;
				if (checkpoint.content.some((block) => block.type === "toolCall")) {
					const batch = await executeToolCalls(currentContext, checkpoint, config, signal, emit);
					recoveredToolResults.push(...batch.messages);
					terminate = batch.terminate;
					currentContext.messages.push(...batch.messages);
					newMessages.push(...batch.messages);
				}
				if (signal?.aborted || terminate) {
					message = { ...message, stopReason: "aborted", errorMessage: "Interrupted response recovery stopped" };
				}
				await emit({ type: "message_start", message });
			}
			currentContext.messages.push(message);
			newMessages.push(message);
			await emit({ type: "message_end", message });

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: recoveredToolResults });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, message, config, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			lastCompletedTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};

			// No-progress guard: a tool-call turn whose action and outcomes are
			// byte-identical to the two preceding turns is a stuck loop (e.g. the
			// model repeating `bash true`). End the run with an explicit error
			// instead of burning tokens until the user aborts.
			if (hasMoreToolCalls && toolCalls.length > 0) {
				const fingerprint = [fingerprintAssistantTurn(message), ...toolResults.map(fingerprintToolResult)].join(
					"\n",
				);
				if (fingerprint === lastTurnFingerprint) turnFingerprintRepeats += 1;
				else {
					lastTurnFingerprint = fingerprint;
					turnFingerprintRepeats = 1;
				}
				if (turnFingerprintRepeats >= NO_PROGRESS_REPEAT_LIMIT) {
					const stopMessage = noProgressStopMessage(config, toolCalls);
					currentContext.messages.push(stopMessage);
					newMessages.push(stopMessage);
					await emit({ type: "message_start", message: stopMessage });
					await emit({ type: "message_end", message: stopMessage });
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}
			}

			if (await config.shouldStopAfterTurn?.(lastCompletedTurn)) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/** Build the provider context using the same transform and conversion pipeline as an agent request. */
function resolveSystemPrompt(snapshot: string, config: Pick<AgentLoopConfig, "getSystemPrompt">): string {
	try {
		return config.getSystemPrompt?.() ?? snapshot;
	} catch {
		return snapshot;
	}
}

export async function buildProviderContext(
	context: AgentContext,
	config: Pick<AgentLoopConfig, "convertToLlm" | "transformContext">,
	signal?: AbortSignal,
): Promise<Context> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	return {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
function createAbortedAssistantMessage(config: AgentLoopConfig): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		errorMessage: "Operation aborted",
		timestamp: Date.now(),
	};
}

type StreamedAssistantResponse = { message: AssistantMessage; checkpoint?: AssistantMessage };

async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<StreamedAssistantResponse> {
	const llmContext = await buildProviderContext(context, config, signal);
	// transformContext may atomically activate a new compaction projection. Resolve
	// the authoritative system layer afterwards so messages and directives switch
	// at the same provider-request boundary.
	llmContext.systemPrompt = resolveSystemPrompt(llmContext.systemPrompt ?? "", config);
	try {
		config.onProviderContext?.(config.model, {
			systemPrompt: llmContext.systemPrompt,
			messages: structuredClone(llmContext.messages),
			tools: llmContext.tools?.map((tool) => {
				const agentTool = tool as AgentTool;
				return {
					...tool,
					parameters: cloneToolSchema(tool.parameters),
					...(agentTool.contract ? { contract: cloneToolSchema(agentTool.contract) } : {}),
				};
			}),
		});
	} catch {
		// Observability must never block or mutate a provider request.
	}

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const reportProviderResult = (message: AssistantMessage, startedAt: number): void => {
		const outcome =
			message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "failed" : "succeeded";
		reportExecution(config, {
			phase: "provider_request",
			runId: config.runId,
			stepId: config.stepId,
			toolPlanRevision: config.toolPlanRevision,
			outcome,
			reason: outcome === "cancelled" ? "provider aborted" : outcome === "failed" ? "provider error" : undefined,
			durationMs: monotonicNow() - startedAt,
		});
	};

	if (signal?.aborted || (config.admitEffect && !config.admitEffect())) {
		const abortedMessage = createAbortedAssistantMessage(config);
		reportExecution(config, {
			phase: "provider_request",
			runId: config.runId,
			stepId: config.stepId,
			toolPlanRevision: config.toolPlanRevision,
			outcome: "cancelled",
			reason: "cancelled before provider request",
		});
		await emit({ type: "message_start", message: abortedMessage });
		return { message: abortedMessage };
	}

	const providerStartedAt = monotonicNow();
	reportExecution(config, {
		phase: "provider_request",
		runId: config.runId,
		stepId: config.stepId,
		toolPlanRevision: config.toolPlanRevision,
		outcome: "started",
	});
	let response: Awaited<ReturnType<StreamFn>>;
	try {
		response = await streamFunction(config.model, llmContext, {
			...config,
			apiKey: resolvedApiKey,
			signal,
		});
	} catch (error) {
		reportExecution(config, {
			phase: "provider_request",
			runId: config.runId,
			stepId: config.stepId,
			toolPlanRevision: config.toolPlanRevision,
			outcome: "failed",
			reason: "provider request failed",
			durationMs: monotonicNow() - providerStartedAt,
		});
		throw error;
	}

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;
	const completedBlocks = new Map<number, AssistantMessage["content"][number]>();

	readResponse: for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (
					(event.type === "text_end" || event.type === "thinking_end" || event.type === "toolcall_end") &&
					event.itemComplete === true
				) {
					const block = event.type === "toolcall_end" ? event.toolCall : event.partial.content[event.contentIndex];
					if (block) {
						const completed = structuredClone(block);
						await config.onCompletedOutputItem?.({
							stepId: config.stepId,
							contentIndex: event.contentIndex,
							block: completed,
							message: structuredClone(event.partial),
						});
						completedBlocks.set(event.contentIndex, completed);
					}
				}
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error":
				break readResponse;
		}
	}

	const finalResult = await response.result();
	// Cancellation can arrive after the provider queued its terminal error.
	// The run's abort signal still wins over a stale retryable stream failure.
	const finalMessage: AssistantMessage =
		signal?.aborted && finalResult.stopReason === "error"
			? { ...finalResult, stopReason: "aborted", errorMessage: "Operation aborted" }
			: finalResult;
	reportProviderResult(finalMessage, providerStartedAt);
	if (addedPartial) {
		context.messages.pop();
	} else {
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	if (!signal?.aborted && isRetryableAssistantError(finalMessage)) {
		const completed = [...completedBlocks].sort(([left], [right]) => left - right);
		// Responses reasoning without a following completed message/call is not
		// replayable. Keep that trailing reasoning in the failure artifact instead.
		while (completed.at(-1)?.[1].type === "thinking") completed.pop();
		if (completed.length > 0) {
			const content = completed.map(([, block]) => block);
			const retainedIndexes = new Set(completed.map(([index]) => index));
			const checkpoint: AssistantMessage = {
				...finalMessage,
				content,
				isResponseCheckpoint: true,
				stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
				responseId: undefined,
				deferred: undefined,
				errorMessage: undefined,
				rawStopReason: undefined,
				endTurn: undefined,
				diagnostics: undefined,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			return {
				checkpoint,
				message: {
					...finalMessage,
					content: finalMessage.content.filter((_, index) => !retainedIndexes.has(index)),
				},
			};
		}
	}
	return { message: finalMessage };
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
			executionOutcome: "not_started",
		};
		const toolResultMessage = await persistToolResult(finalized, assistantMessage, config);
		await emitToolExecutionEnd(finalized, emit);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	recoveredCalls?: AgentToolCall[],
): Promise<ExecutedToolCallBatch> {
	const toolCalls = recoveredCalls ?? assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) =>
			(currentContext.toolPlan?.bindings[tc.name] ?? currentContext.tools?.find((t) => t.name === tc.name))
				?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
				executionOutcome: "not_started",
			};
		} else {
			const executed = await executePreparedToolCall(
				preparation,
				signal,
				emit,
				config.admitEffect,
				config.admitToolCall,
				config.runId,
				config.stepId,
				config.toolPlanRevision,
				config.executionScheduler,
				config.onExecutionEvent,
				config.beforeToolDispatch,
			);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		const toolResultMessage = await persistToolResult(finalized, assistantMessage, config);
		await emitToolExecutionEnd(finalized, emit);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
				executionOutcome: "not_started",
			} satisfies FinalizedToolCallOutcome;
			await persistToolResult(finalized, assistantMessage, config);
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(
				preparation,
				signal,
				emit,
				config.admitEffect,
				config.admitToolCall,
				config.runId,
				config.stepId,
				config.toolPlanRevision,
				config.executionScheduler,
				config.onExecutionEvent,
				config.beforeToolDispatch,
			);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await persistToolResult(finalized, assistantMessage, config);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const outcomes = await Promise.allSettled(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const orderedFinalizedCalls: FinalizedToolCallOutcome[] = [];
	for (const outcome of outcomes) {
		if (outcome.status === "rejected") throw outcome.reason;
		orderedFinalizedCalls.push(outcome.value);
	}
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	executionOutcome: ToolExecutionOutcome;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
	executionOutcome: ToolExecutionOutcome;
	message?: ToolResultMessage;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool =
		currentContext.toolPlan?.bindings[toolCall.name] ?? currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
			// Hooks may mutate args in place; re-validate so only schema-conforming
			// arguments reach execution.
			const revalidatedArgs = validateToolArguments(tool, { ...toolCall, arguments: validatedArgs });
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			return {
				kind: "prepared",
				toolCall,
				tool,
				args: revalidatedArgs,
			};
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	admitEffect?: () => boolean,
	admitToolCall?: AgentLoopConfig["admitToolCall"],
	runId?: string,
	stepId?: string,
	toolPlanRevision?: number,
	executionScheduler?: AgentLoopConfig["executionScheduler"],
	onExecutionEvent?: AgentLoopConfig["onExecutionEvent"],
	beforeToolDispatch?: AgentLoopConfig["beforeToolDispatch"],
): Promise<ExecutedToolCallOutcome> {
	const startedAt = monotonicNow();
	if (admitToolCall) {
		reportExecutionObserver(onExecutionEvent, {
			phase: "tool_admission",
			runId,
			stepId,
			toolPlanRevision,
			toolCallId: prepared.toolCall.id,
			toolName: prepared.toolCall.name,
			outcome: "started",
		});
		let admission: Awaited<ReturnType<NonNullable<AgentLoopConfig["admitToolCall"]>>>;
		try {
			admission = await admitToolCall({
				runId,
				toolCall: prepared.toolCall,
				tool: prepared.tool,
				args: prepared.args,
				signal,
			});
		} catch (error) {
			reportExecutionObserver(onExecutionEvent, {
				phase: "tool_admission",
				runId,
				stepId,
				toolPlanRevision,
				toolCallId: prepared.toolCall.id,
				toolName: prepared.toolCall.name,
				outcome: "failed",
				reason: "tool admission failed",
				durationMs: monotonicNow() - startedAt,
			});
			throw error;
		}
		if (admission?.allow === false) {
			const reason = admission.reason ?? "Tool execution was denied";
			reportExecutionObserver(onExecutionEvent, {
				phase: "tool_admission",
				runId,
				stepId,
				toolPlanRevision,
				toolCallId: prepared.toolCall.id,
				toolName: prepared.toolCall.name,
				outcome: "denied",
				reason,
				durationMs: monotonicNow() - startedAt,
			});
			reportExecutionObserver(onExecutionEvent, {
				phase: "execution_result",
				runId,
				stepId,
				toolPlanRevision,
				toolCallId: prepared.toolCall.id,
				toolName: prepared.toolCall.name,
				outcome: "denied",
				reason,
				durationMs: monotonicNow() - startedAt,
			});
			return {
				result: createErrorToolResult(reason),
				isError: true,
				executionOutcome: "not_started",
			};
		}
		reportExecutionObserver(onExecutionEvent, {
			phase: "tool_admission",
			runId,
			stepId,
			toolPlanRevision,
			toolCallId: prepared.toolCall.id,
			toolName: prepared.toolCall.name,
			outcome: "succeeded",
			durationMs: monotonicNow() - startedAt,
		});
	}

	const schedulerStartedAt = monotonicNow();
	if (executionScheduler) {
		reportExecutionObserver(onExecutionEvent, {
			phase: "scheduler_wait",
			runId,
			stepId,
			toolPlanRevision,
			toolCallId: prepared.toolCall.id,
			toolName: prepared.toolCall.name,
			outcome: "started",
		});
	}
	const lease = await executionScheduler?.acquire(prepared.tool.executionResource, signal);
	if (executionScheduler && !lease) {
		reportExecutionObserver(onExecutionEvent, {
			phase: "scheduler_wait",
			runId,
			stepId,
			toolPlanRevision,
			toolCallId: prepared.toolCall.id,
			toolName: prepared.toolCall.name,
			outcome: "cancelled",
			reason: "cancelled while waiting for execution resources",
			durationMs: monotonicNow() - schedulerStartedAt,
		});
		reportExecutionObserver(onExecutionEvent, {
			phase: "execution_result",
			runId,
			stepId,
			toolPlanRevision,
			toolCallId: prepared.toolCall.id,
			toolName: prepared.toolCall.name,
			outcome: "cancelled",
			reason: "cancelled while waiting for execution resources",
			durationMs: monotonicNow() - startedAt,
		});
		return {
			result: createErrorToolResult("Operation aborted"),
			isError: true,
			executionOutcome: "not_started",
		};
	}
	if (executionScheduler) {
		reportExecutionObserver(onExecutionEvent, {
			phase: "scheduler_wait",
			runId,
			stepId,
			toolPlanRevision,
			toolCallId: prepared.toolCall.id,
			toolName: prepared.toolCall.name,
			outcome: "succeeded",
			durationMs: monotonicNow() - schedulerStartedAt,
		});
	}

	try {
		if (!signal?.aborted) {
			await beforeToolDispatch?.({
				runId,
				toolCall: prepared.toolCall,
				tool: prepared.tool,
				args: prepared.args,
				signal,
			});
		}
	} catch (error) {
		lease?.release();
		throw error;
	}
	const admitted = admitEffect ? admitEffect() : true;
	if (signal?.aborted || !admitted) {
		lease?.release();
		const reason = signal?.aborted ? "Operation aborted" : "Execution admission denied";
		reportExecutionObserver(onExecutionEvent, {
			phase: "execution_result",
			runId,
			stepId,
			toolPlanRevision,
			toolCallId: prepared.toolCall.id,
			toolName: prepared.toolCall.name,
			outcome: "cancelled",
			reason,
			durationMs: monotonicNow() - startedAt,
		});
		return {
			result: createErrorToolResult("Operation aborted"),
			isError: true,
			executionOutcome: "not_started",
		};
	}

	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;
	const executionStartedAt = monotonicNow();
	reportExecutionObserver(onExecutionEvent, {
		phase: "tool_execution",
		runId,
		stepId,
		toolPlanRevision,
		toolCallId: prepared.toolCall.id,
		toolName: prepared.toolCall.name,
		outcome: "started",
	});

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		reportExecutionObserver(onExecutionEvent, {
			phase: "execution_result",
			runId,
			stepId,
			toolPlanRevision,
			toolCallId: prepared.toolCall.id,
			toolName: prepared.toolCall.name,
			outcome: "succeeded",
			durationMs: monotonicNow() - executionStartedAt,
		});
		return { result, isError: false, executionOutcome: "confirmed" };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		reportExecutionObserver(onExecutionEvent, {
			phase: "execution_result",
			runId,
			stepId,
			toolPlanRevision,
			toolCallId: prepared.toolCall.id,
			toolName: prepared.toolCall.name,
			outcome: "failed",
			reason: "tool execution failed",
			durationMs: monotonicNow() - executionStartedAt,
		});
		return {
			result: createErrorToolResult(
				error instanceof Error ? error.message : String(error),
				error instanceof AgentToolError ? error.details : undefined,
			),
			isError: true,
			executionOutcome: getToolErrorOutcome(error, prepared.toolCall.name, prepared.args),
		};
	} finally {
		acceptingUpdates = false;
		lease?.release();
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
		executionOutcome: executed.executionOutcome,
	};
}

function createErrorToolResult(message: string, details: unknown = {}): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

/**
 * Terminal assistant message for a run stopped by the no-progress guard.
 * stopReason "error" routes through the existing failure surfacing path; the
 * wording matches no retryable provider-error pattern, so AgentSession will
 * not auto-retry it.
 */
function noProgressStopMessage(config: AgentLoopConfig, toolCalls: AgentToolCall[]): AssistantMessage {
	const names = [...new Set(toolCalls.map((call) => call.name))].join(", ");
	const text = `Stopped: no progress. ${names} returned identical results to identical arguments ${NO_PROGRESS_REPEAT_LIMIT} turns in a row. The agent is stuck in a loop; change the approach or the arguments.`;
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: text,
		timestamp: Date.now(),
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	if (finalized.message) return finalized.message;
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function persistToolResult(
	finalized: FinalizedToolCallOutcome,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
): Promise<ToolResultMessage> {
	const message = createToolResultMessage(finalized);
	await config.onToolResult?.(message, {
		assistantMessage,
		toolCall: finalized.toolCall,
		terminate: finalized.result.terminate === true,
		executionOutcome: finalized.executionOutcome,
	});
	finalized.message = message;
	return message;
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
