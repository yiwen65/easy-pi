import type { NewRecord, ProvisionedEntry } from "./types.ts";

function requireValue(valid: boolean, field: string): asserts valid {
	if (!valid) throw new Error(`Invalid durable ${field}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
	requireValue(typeof value === "object" && value !== null && !Array.isArray(value), field);
	return value as Record<string, unknown>;
}

function string(value: unknown, field: string): void {
	requireValue(typeof value === "string", field);
}

function number(value: unknown, field: string): void {
	requireValue(typeof value === "number" && Number.isFinite(value), field);
}

function integer(value: unknown, minimum: number, field: string): void {
	requireValue(Number.isSafeInteger(value) && (value as number) >= minimum, field);
}

function boolean(value: unknown, field: string): void {
	requireValue(typeof value === "boolean", field);
}

function nullableId(value: unknown, field: string): void {
	if (value !== null) string(value, field);
}

function oneOf(value: unknown, values: readonly string[], field: string): void {
	requireValue(typeof value === "string" && values.includes(value), field);
}

function array(value: unknown, field: string, validate: (item: unknown, field: string) => void): void {
	requireValue(Array.isArray(value), field);
	for (const item of value) validate(item, field);
}

function optional(value: unknown, field: string, validate: (value: unknown, field: string) => void): void {
	if (value !== undefined) validate(value, field);
}

function usage(value: unknown, field: string): void {
	const data = object(value, field);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
		number(data[key], `${field}.${key}`);
	for (const key of ["cacheWrite1h", "reasoning"]) optional(data[key], `${field}.${key}`, number);
	const cost = object(data.cost, `${field}.cost`);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) number(cost[key], `${field}.cost.${key}`);
}

function content(value: unknown, allowed: readonly string[]): void {
	array(value, "message.content", (item) => {
		const block = object(item, "content block");
		oneOf(block.type, allowed, "content type");
		switch (block.type) {
			case "text":
				string(block.text, "text");
				break;
			case "image":
				string(block.data, "image data");
				string(block.mimeType, "image mimeType");
				break;
			case "thinking":
				string(block.thinking, "thinking");
				break;
			case "toolCall":
				string(block.id, "tool call id");
				string(block.name, "tool call name");
				object(block.arguments, "tool call arguments");
				break;
		}
	});
}

function userContent(value: unknown): void {
	if (typeof value !== "string") content(value, ["text", "image"]);
}

function message(value: unknown): void {
	const data = object(value, "message");
	string(data.role, "message role");
	switch (data.role) {
		case "user":
			userContent(data.content);
			break;
		case "assistant":
			content(data.content, ["text", "thinking", "toolCall"]);
			for (const key of ["api", "provider", "model"]) string(data[key], key);
			usage(data.usage, "message usage");
			oneOf(data.stopReason, ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"], "stopReason");
			if (data.isResponseCheckpoint !== undefined)
				requireValue(data.isResponseCheckpoint === true, "isResponseCheckpoint");
			if (data.deferred !== undefined) {
				const deferred = object(data.deferred, "deferred handle");
				for (const key of ["provider", "modelId", "api", "id"]) string(deferred[key], `deferred.${key}`);
				optional(deferred.expiresAt, "deferred.expiresAt", number);
				optional(deferred.pollAfterMs, "deferred.pollAfterMs", number);
			}
			break;
		case "toolResult":
			string(data.toolCallId, "toolCallId");
			string(data.toolName, "toolName");
			content(data.content, ["text", "image"]);
			boolean(data.isError, "isError");
			optional(data.usage, "tool usage", usage);
			break;
		case "bashExecution":
			string(data.command, "command");
			string(data.output, "output");
			optional(data.exitCode, "exitCode", number);
			boolean(data.cancelled, "cancelled");
			boolean(data.truncated, "truncated");
			break;
		case "custom":
			string(data.customType, "customType");
			userContent(data.content);
			boolean(data.display, "display");
			break;
		case "branchSummary":
			string(data.summary, "summary");
			string(data.fromId, "fromId");
			break;
		case "compactionSummary":
			string(data.summary, "summary");
			number(data.tokensBefore, "tokensBefore");
			break;
		default:
			// Declaration-merged application messages have no core-owned payload schema.
			return;
	}
	number(data.timestamp, "message timestamp");
}

/** Validate core-owned entry fields, not opaque custom data or details. */
export function assertDurableEntry(value: unknown): asserts value is ProvisionedEntry {
	const entry = object(value, "entry");
	string(entry.id, "entry id");
	switch (entry.type) {
		case "message":
			message(entry.message);
			if (entry.terminate !== undefined) requireValue(entry.terminate === true, "terminate");
			break;
		case "model_change":
			string(entry.provider, "provider");
			string(entry.modelId, "modelId");
			break;
		case "thinking_level_change":
			string(entry.thinkingLevel, "thinkingLevel");
			break;
		case "active_tools_change":
			array(entry.activeToolNames, "activeToolNames", string);
			break;
		case "compaction":
			string(entry.summary, "summary");
			array(entry.retainedTail, "retainedTail", message);
			number(entry.tokensBefore, "tokensBefore");
			optional(entry.usage, "compaction usage", usage);
			break;
		case "branch_summary":
			string(entry.fromId, "fromId");
			string(entry.summary, "summary");
			optional(entry.usage, "branch summary usage", usage);
			break;
		case "custom":
			string(entry.customType, "customType");
			break;
		default:
			throw new Error("Invalid durable entry type");
	}
}

/** Validate the current journal record union before recovery or query publication. */
export function assertDurableRecord(value: unknown): asserts value is NewRecord {
	const record = object(value, "record");
	string(record.id, "record id");
	string(record.lane, "record lane");
	if (
		record.type !== "operation_started" &&
		record.type !== "queue_enqueued" &&
		record.type !== "queue_cancelled" &&
		record.type !== "usage"
	) {
		string(record.runId, "runId");
	}
	switch (record.type) {
		case "operation_started": {
			nullableId(record.sourceLeafId, "sourceLeafId");
			const intent = object(record.intent, "intent");
			switch (intent.kind) {
				case "run":
					array(intent.originalPrompt, "originalPrompt", message);
					array(intent.initialMessages, "initialMessages", assertDurableEntry);
					optional(intent.systemPromptOverride, "systemPromptOverride", string);
					optional(intent.resumeData, "resumeData", object);
					break;
				case "compaction":
					string(intent.resultEntryId, "resultEntryId");
					optional(intent.customInstructions, "customInstructions", string);
					break;
				case "navigation":
					nullableId(intent.targetId, "targetId");
					boolean(intent.summarize, "summarize");
					for (const key of ["customInstructions", "label", "summaryEntryId"]) optional(intent[key], key, string);
					break;
				default:
					throw new Error("Invalid durable operation kind");
			}
			break;
		}
		case "abort_requested":
		case "pause_requested":
		case "pause_cleared":
			break;
		case "operation_finished":
			oneOf(record.outcome, ["completed", "aborted", "failed", "declined"], "outcome");
			if (record.error !== undefined) {
				const error = object(record.error, "operation error");
				string(error.code, "error code");
				string(error.message, "error message");
			}
			break;
		case "step_attempt":
			oneOf(record.step, ["assistant", "branch_summary", "compaction"], "step");
			integer(record.attempt, 1, "attempt");
			string(record.resultEntryId, "resultEntryId");
			if (record.step === "compaction")
				oneOf(record.compactionReason, ["manual", "threshold", "overflow"], "compactionReason");
			break;
		case "tool_started":
			for (const key of ["assistantEntryId", "toolCallId", "toolName", "resultEntryId"]) string(record[key], key);
			integer(record.toolIndex, 0, "toolIndex");
			object(record.effectiveArgs, "effectiveArgs");
			optional(record.operationId, "operationId", string);
			oneOf(record.replay, ["never", "safe"], "replay");
			break;
		case "tool_reconciliation":
		case "tool_reconciled":
			string(record.toolCallId, "toolCallId");
			string(record.resultEntryId, "resultEntryId");
			if (record.type === "tool_reconciliation") {
				string(record.reason, "reason");
				if (record.diagnostic !== undefined) {
					message(record.diagnostic);
					const diagnostic = object(record.diagnostic, "diagnostic");
					requireValue(
						diagnostic.role === "toolResult" && diagnostic.toolCallId === record.toolCallId,
						"tool diagnostic identity",
					);
				}
			}
			break;
		case "assistant_checkpoint":
			string(record.resultEntryId, "resultEntryId");
			integer(record.attempt, 1, "attempt");
			message(record.message);
			{
				const checkpoint = object(record.message, "checkpoint");
				requireValue(
					checkpoint.role === "assistant" && checkpoint.isResponseCheckpoint === true,
					"assistant checkpoint",
				);
			}
			if (record.continuationFailure !== undefined) {
				message(record.continuationFailure);
				requireValue(
					object(record.continuationFailure, "continuationFailure").role === "assistant",
					"continuationFailure role",
				);
			}
			if (record.retryAttempt !== undefined) integer(record.retryAttempt, 1, "retryAttempt");
			break;
		case "queue_enqueued":
			oneOf(record.queue, ["nextRun", "steer", "followUp"], "queue");
			if (record.queue === "nextRun") requireValue(record.runId === undefined, "nextRun runId");
			else string(record.runId, "runId");
			assertDurableEntry(record.target);
			break;
		case "queue_cancelled":
			optional(record.runId, "runId", string);
			string(record.entryId, "entryId");
			break;
		case "write_deferred":
			assertDurableEntry(record.target);
			break;
		case "usage":
			usage(record.usage, "usage");
			oneOf(
				record.cause,
				["assistant", "compaction", "branch_summary", "deferred_fetch", "tool", "hook", "adjustment"],
				"usage cause",
			);
			if (record.cause === "adjustment") {
				optional(record.runId, "runId", string);
				optional(record.entryId, "entryId", string);
			} else {
				string(record.runId, "runId");
				string(record.entryId, "entryId");
				if (record.cause === "tool") string(record.toolCallId, "toolCallId");
				else if (record.cause !== "hook") {
					integer(record.attempt, 1, "attempt");
					oneOf(
						record.stopReason,
						["stop", "length", "toolUse", "error", "aborted", "deferred"],
						"usage stopReason",
					);
				}
			}
			break;
		default:
			throw new Error("Invalid durable record type");
	}
}
