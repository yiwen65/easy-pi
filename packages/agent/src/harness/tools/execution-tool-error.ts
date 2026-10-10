import { AgentToolError, type AgentToolErrorOptions } from "../../types.ts";

export type ExecutionToolErrorCode =
	| "INVALID_INPUT"
	| "NOT_FOUND"
	| "NOT_A_DIRECTORY"
	| "PERMISSION_DENIED"
	| "OUTSIDE_WORKSPACE"
	| "SYMLINK_ESCAPE"
	| "UNSUPPORTED"
	| "LIMIT_REACHED"
	| "SPAWN_ERROR"
	| "ABORTED";

/** Stable errors from execution tools and their optional path policy. */
export class ExecutionToolError<TDetails = unknown> extends AgentToolError<TDetails | undefined> {
	readonly code: ExecutionToolErrorCode;
	constructor(
		code: ExecutionToolErrorCode,
		message: string,
		details?: TDetails,
		cause?: Error,
		options?: AgentToolErrorOptions,
	) {
		super(`${code}\n\n${message}`, details, { ...options, ...(cause ? { cause } : {}) });
		this.name = "ExecutionToolError";
		this.code = code;
	}
}
