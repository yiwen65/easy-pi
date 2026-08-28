import type { AgentSessionEvent } from "../../src/core/agent-session.ts";

const EDIT_OPERATION_KINDS = new Set(["create", "update", "move", "delete"]);
const V2_ERROR_CODES = new Set([
	"INVALID_INPUT",
	"NOT_FOUND",
	"NOT_A_FILE",
	"NOT_A_DIRECTORY",
	"UNSUPPORTED_BINARY_FILE",
	"PERMISSION_DENIED",
	"OUTSIDE_WORKSPACE",
	"SYMLINK_ESCAPE",
	"INVALID_REGEX",
	"SEARCH_PROVIDER_FAILED",
	"EDIT_CONTEXT_NOT_FOUND",
	"EDIT_CONTEXT_AMBIGUOUS",
	"EDIT_CONFLICT",
	"EDIT_MOVE_NOT_SUPPORTED",
	"EDIT_PARTIAL_COMMIT",
	"SPAWN_FAILED",
	"SHELL_UNAVAILABLE",
	"ABORTED",
]);

export interface SanitizedToolCallTrace {
	sequence: number;
	toolName: string;
	status: "success" | "error";
	errorCode?: string;
	errorReason?: string;
	operationKinds?: string[];
	durationMs: number;
	truncated: boolean;
	recovery: boolean;
	postEditRead: boolean;
}

export interface SanitizedToolTrace {
	calls: SanitizedToolCallTrace[];
	toolCallCount: number;
	toolErrorCount: number;
	firstEditSuccess: boolean | null;
	postEditReadCount: number;
	recoveryCallCount: number;
	truncationCount: number;
	toolElapsedMs: number;
	peakContextTokens: number;
}

interface PendingToolCall {
	sequence: number;
	toolName: string;
	operationKinds?: string[];
	startedAt: number;
	recovery: boolean;
	postEditRead: boolean;
}

function operationKinds(args: unknown): string[] | undefined {
	if (!args || typeof args !== "object" || !("operations" in args) || !Array.isArray(args.operations))
		return undefined;
	const kinds = args.operations.flatMap((operation: unknown) => {
		if (!operation || typeof operation !== "object" || !("kind" in operation)) return [];
		return typeof operation.kind === "string" && EDIT_OPERATION_KINDS.has(operation.kind) ? [operation.kind] : [];
	});
	return kinds.length > 0 ? kinds : undefined;
}

function errorText(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content))
		return undefined;
	return result.content.find(
		(part: unknown): part is { type: "text"; text: string } =>
			!!part &&
			typeof part === "object" &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string",
	)?.text;
}

function classifyError(result: unknown): { errorCode?: string; errorReason?: string } {
	const text = errorText(result);
	const firstLine = text?.split("\n", 1)[0];
	if (!firstLine || !V2_ERROR_CODES.has(firstLine)) return {};
	if (firstLine !== "INVALID_INPUT") return { errorCode: firstLine };
	const message = text?.split("\n\n", 2)[1] ?? "";
	let errorReason = "other_invalid_input";
	if (message.startsWith("offset must be a positive safe integer")) {
		errorReason = "offset_not_positive_integer";
	} else if (message.startsWith("limit must be a positive safe integer")) {
		errorReason = "limit_not_positive_integer";
	} else if (message.startsWith("byteOffset must be a non-negative safe integer")) {
		errorReason = "byte_offset_invalid";
	} else if (message.startsWith("byteOffset cannot be combined")) {
		errorReason = "byte_offset_with_line_range";
	} else if (message.startsWith("byteOffset is invalid for a directory")) {
		errorReason = "byte_offset_for_directory";
	} else if (message.startsWith("offset ") && message.includes(" is beyond ")) {
		errorReason = "offset_beyond_directory";
	} else if (message.startsWith("This execution environment does not support bounded text reads")) {
		errorReason = "bounded_read_unsupported";
	} else if (message.startsWith("offset, limit, and byteOffset are invalid for images")) {
		errorReason = "range_for_image";
	}
	return { errorCode: firstLine, errorReason };
}

function resultWasTruncated(result: unknown): boolean {
	if (!result || typeof result !== "object" || !("details" in result)) return false;
	const details = result.details;
	if (!details || typeof details !== "object") return false;
	if ("truncated" in details && details.truncated === true) return true;
	return "truncation" in details && details.truncation !== undefined;
}

function contextTokens(event: AgentSessionEvent): number | undefined {
	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
	const usage = event.message.usage;
	if (!usage) return undefined;
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Collects behavior-only event metrics without retaining arguments, paths, commands, content, or responses. */
export function createSanitizedToolTraceCollector(now: () => number = Date.now): {
	handle: (event: AgentSessionEvent) => void;
	snapshot: () => SanitizedToolTrace;
} {
	const pending = new Map<string, PendingToolCall>();
	const calls: SanitizedToolCallTrace[] = [];
	let sequence = 0;
	let toolErrorCount = 0;
	let firstEditSuccess: boolean | null = null;
	let successfulEditSeen = false;
	let awaitingRecovery = false;
	let recoveryCallCount = 0;
	let postEditReadCount = 0;
	let truncationCount = 0;
	let peakContextTokens = 0;
	let activeTools = 0;
	let activeIntervalStartedAt = 0;
	let toolElapsedMs = 0;

	return {
		handle(event) {
			const tokens = contextTokens(event);
			if (tokens !== undefined) peakContextTokens = Math.max(peakContextTokens, tokens);

			if (event.type === "tool_execution_start") {
				const startedAt = now();
				if (activeTools === 0) activeIntervalStartedAt = startedAt;
				activeTools += 1;
				const recovery = awaitingRecovery;
				if (recovery) {
					recoveryCallCount += 1;
					awaitingRecovery = false;
				}
				const postEditRead = successfulEditSeen && event.toolName === "read";
				if (postEditRead) postEditReadCount += 1;
				pending.set(event.toolCallId, {
					sequence: sequence++,
					toolName: event.toolName,
					operationKinds: event.toolName === "edit" ? operationKinds(event.args) : undefined,
					startedAt,
					recovery,
					postEditRead,
				});
				return;
			}

			if (event.type !== "tool_execution_end") return;
			const endedAt = now();
			const started = pending.get(event.toolCallId);
			if (!started) return;
			pending.delete(event.toolCallId);
			activeTools = Math.max(0, activeTools - 1);
			if (activeTools === 0) toolElapsedMs += Math.max(0, endedAt - activeIntervalStartedAt);
			if (event.isError) {
				toolErrorCount += 1;
				awaitingRecovery = true;
			}
			if (started.toolName === "edit") {
				if (firstEditSuccess === null) firstEditSuccess = !event.isError;
				if (!event.isError) successfulEditSeen = true;
			}
			const truncated = resultWasTruncated(event.result);
			if (truncated) truncationCount += 1;
			const error = event.isError ? classifyError(event.result) : {};
			calls.push({
				sequence: started.sequence,
				toolName: started.toolName,
				status: event.isError ? "error" : "success",
				...error,
				...(started.operationKinds ? { operationKinds: started.operationKinds } : {}),
				durationMs: Math.max(0, endedAt - started.startedAt),
				truncated,
				recovery: started.recovery,
				postEditRead: started.postEditRead,
			});
		},
		snapshot() {
			return {
				calls: [...calls].sort((left, right) => left.sequence - right.sequence),
				toolCallCount: calls.length,
				toolErrorCount,
				firstEditSuccess,
				postEditReadCount,
				recoveryCallCount,
				truncationCount,
				toolElapsedMs,
				peakContextTokens,
			};
		},
	};
}
