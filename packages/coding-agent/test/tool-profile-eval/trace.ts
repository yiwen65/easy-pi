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
	"STALE_CURSOR",
	"QUERY_TOO_BROAD",
	"SEARCH_INCOMPLETE",
	"RESULTS_TRUNCATED",
	"NO_MATCH_COMPLETE",
	"SYMBOL_INDEX_UNAVAILABLE",
	"FILE_SKIPPED",
	"BUDGET_EXCEEDED",
	"STALE_LOCATOR",
	"STALE_VIEW",
	"STALE_PATCH",
	"STALE_SNAPSHOT",
	"SEARCH_CAPABILITY_UNSUPPORTED",
	"SEARCH_PROVIDER_FAILED",
	"AMBIGUOUS_MATCH",
	"PREIMAGE_MISMATCH",
	"RANGE_MISMATCH",
	"VALIDATION_FAILED",
	"READ_PROVIDER_FAILED",
	"EDIT_CONTEXT_NOT_FOUND",
	"EDIT_CONTEXT_AMBIGUOUS",
	"EDIT_CONFLICT",
	"EDIT_MOVE_NOT_SUPPORTED",
	"EDIT_PARTIAL_COMMIT",
	"EDIT_PLAN_TOO_LARGE",
	"EDIT_ROLLED_BACK",
	"EDIT_INDETERMINATE",
	"RANGE_READ_UNSUPPORTED",
	"DIRECTORY_TOO_LARGE",
	"STALE_FILE",
	"STALE_DIRECTORY",
	"PATCH_PARSE_ERROR",
	"PATCH_CONTEXT_NOT_FOUND",
	"PATCH_AMBIGUOUS",
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
	schemaErrorCount: number;
	runMisuseCount: number;
	targetFirstRead: boolean | null;
	firstSearchTargetRank: number | null;
	approximateSearchCount: number;
	approximateEditWithoutTargetReadCount: number;
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
	} else if (message.startsWith("Provide exactly one of path or locatorId")) {
		errorReason = "path_locator_conflict";
	} else if (message.startsWith("mode conflicts with queryTemplate")) {
		errorReason = "mode_template_conflict";
	} else if (message.startsWith("targetKind conflicts with the structured search mode")) {
		errorReason = "target_kind_conflict";
	} else if (message.startsWith("Structured search returns AST-backed locators and requires context=0")) {
		errorReason = "structured_context_conflict";
	} else if (message.startsWith("ranking is only valid for file or structured search")) {
		errorReason = "ranking_mode_conflict";
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
	if ("truncation" in details && details.truncation !== undefined) return true;
	if (!("coverage" in details) || !details.coverage || typeof details.coverage !== "object") return false;
	return "truncated" in details.coverage && details.coverage.truncated === true;
}

function normalizedPath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function runMisusesStructuredTools(args: unknown): boolean {
	if (!args || typeof args !== "object" || !("command" in args) || typeof args.command !== "string") return false;
	return /(^|[;&|\s])(rg|grep|find|fd|cat|sed|awk|perl|mv|cp|rm)([;&|\s]|$)|(^|[;&|\s])(echo|printf|tee)([;&|\s]|$)[^\n]*>{1,2}/i.test(
		args.command,
	);
}

function targetRead(args: unknown, targetPath: string | undefined): boolean | undefined {
	if (!targetPath || !args || typeof args !== "object" || !("path" in args) || typeof args.path !== "string") {
		return undefined;
	}
	return normalizedPath(args.path) === normalizedPath(targetPath);
}

function resultDetails(result: unknown): Record<string, unknown> | undefined {
	if (!result || typeof result !== "object" || !("details" in result)) return undefined;
	return result.details && typeof result.details === "object"
		? (result.details as Record<string, unknown>)
		: undefined;
}

function searchTargetRank(result: unknown, targetPath: string | undefined): number | undefined {
	if (!targetPath) return undefined;
	const hits = resultDetails(result)?.hits;
	if (!Array.isArray(hits)) return undefined;
	const target = normalizedPath(targetPath);
	const index = hits.findIndex(
		(hit) =>
			!!hit &&
			typeof hit === "object" &&
			"path" in hit &&
			typeof hit.path === "string" &&
			normalizedPath(hit.path) === target,
	);
	return index < 0 ? 0 : index + 1;
}

function contextTokens(event: AgentSessionEvent): number | undefined {
	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
	const usage = event.message.usage;
	if (!usage) return undefined;
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Collects behavior-only event metrics without retaining arguments, paths, commands, content, or responses. */
export function createSanitizedToolTraceCollector(
	now: () => number = Date.now,
	options: { targetPath?: string } = {},
): {
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
	let schemaErrorCount = 0;
	let runMisuseCount = 0;
	let targetFirstRead: boolean | null = null;
	let firstSearchTargetRank: number | null = null;
	let approximateSearchCount = 0;
	let approximateSearchAwaitingTargetRead = false;
	let approximateEditWithoutTargetReadCount = 0;

	return {
		handle(event) {
			const tokens = contextTokens(event);
			if (tokens !== undefined) peakContextTokens = Math.max(peakContextTokens, tokens);

			if (event.type === "tool_execution_start") {
				const startedAt = now();
				if ((event.toolName === "run" || event.toolName === "bash") && runMisusesStructuredTools(event.args)) {
					runMisuseCount += 1;
				}
				if (event.toolName === "read") {
					const isTarget = targetRead(event.args, options.targetPath);
					if (targetFirstRead === null && isTarget !== undefined) targetFirstRead = isTarget;
					if (isTarget) approximateSearchAwaitingTargetRead = false;
				}
				if (event.toolName === "edit" && approximateSearchAwaitingTargetRead) {
					approximateEditWithoutTargetReadCount += 1;
				}
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
			if (error.errorCode === "INVALID_INPUT") schemaErrorCount += 1;
			if (started.toolName === "search" && !event.isError) {
				const details = resultDetails(event.result);
				if (firstSearchTargetRank === null) {
					firstSearchTargetRank = searchTargetRank(event.result, options.targetPath) ?? null;
				}
				if (details?.approximate === true) {
					approximateSearchCount += 1;
					approximateSearchAwaitingTargetRead = true;
				}
			}
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
				schemaErrorCount,
				runMisuseCount,
				targetFirstRead,
				firstSearchTargetRank,
				approximateSearchCount,
				approximateEditWithoutTargetReadCount,
			};
		},
	};
}
