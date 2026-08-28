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
	operationKinds?: string[];
	durationMs: number;
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

function errorCode(result: unknown): string | undefined {
	let firstLine: string | undefined;
	if (typeof result === "string") {
		firstLine = result.split("\n", 1)[0];
	} else if (result && typeof result === "object" && "content" in result && Array.isArray(result.content)) {
		const firstText = result.content.find(
			(part: unknown): part is { type: "text"; text: string } =>
				!!part &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string",
		);
		firstLine = firstText?.text.split("\n", 1)[0];
	}
	return firstLine && V2_ERROR_CODES.has(firstLine) ? firstLine : undefined;
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
			calls.push({
				sequence: started.sequence,
				toolName: started.toolName,
				status: event.isError ? "error" : "success",
				...(event.isError && errorCode(event.result) ? { errorCode: errorCode(event.result) } : {}),
				...(started.operationKinds ? { operationKinds: started.operationKinds } : {}),
				durationMs: Math.max(0, endedAt - started.startedAt),
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
				toolElapsedMs,
				peakContextTokens,
			};
		},
	};
}
