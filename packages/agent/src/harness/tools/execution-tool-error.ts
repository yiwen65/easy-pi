export type ExecutionToolErrorCode =
	| "INVALID_INPUT"
	| "NOT_FOUND"
	| "NOT_A_DIRECTORY"
	| "PERMISSION_DENIED"
	| "OUTSIDE_WORKSPACE"
	| "SYMLINK_ESCAPE"
	| "UNSUPPORTED"
	| "SPAWN_ERROR"
	| "ABORTED";

/** Stable errors from execution tools and their optional path policy. */
export class ExecutionToolError<TDetails = unknown> extends Error {
	readonly code: ExecutionToolErrorCode;
	readonly details?: TDetails;
	constructor(code: ExecutionToolErrorCode, message: string, details?: TDetails, cause?: Error) {
		super(`${code}\n\n${message}`, cause === undefined ? undefined : { cause });
		this.name = "ExecutionToolError";
		this.code = code;
		this.details = details;
	}
}
