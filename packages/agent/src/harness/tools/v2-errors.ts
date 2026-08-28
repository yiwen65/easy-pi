export type V2ToolErrorCode =
	| "INVALID_INPUT"
	| "NOT_FOUND"
	| "NOT_A_FILE"
	| "NOT_A_DIRECTORY"
	| "UNSUPPORTED_BINARY_FILE"
	| "RANGE_READ_UNSUPPORTED"
	| "DIRECTORY_TOO_LARGE"
	| "STALE_DIRECTORY"
	| "READ_PROVIDER_FAILED"
	| "PERMISSION_DENIED"
	| "OUTSIDE_WORKSPACE"
	| "SYMLINK_ESCAPE"
	| "INVALID_REGEX"
	| "STALE_CURSOR"
	| "SEARCH_CAPABILITY_UNSUPPORTED"
	| "SEARCH_PROVIDER_FAILED"
	| "EDIT_CONTEXT_NOT_FOUND"
	| "EDIT_CONTEXT_AMBIGUOUS"
	| "EDIT_CONFLICT"
	| "EDIT_MOVE_NOT_SUPPORTED"
	| "EDIT_PARTIAL_COMMIT"
	| "SPAWN_FAILED"
	| "SHELL_UNAVAILABLE"
	| "ABORTED";

/** Stable failure returned by v2 tools. Throwing marks the tool result as an error. */
export class V2ToolError<TDetails = unknown> extends Error {
	readonly code: V2ToolErrorCode;
	readonly details?: TDetails;

	constructor(code: V2ToolErrorCode, message: string, details?: TDetails, cause?: Error) {
		super(`${code}\n\n${message}`, cause === undefined ? undefined : { cause });
		this.name = "V2ToolError";
		this.code = code;
		this.details = details;
	}
}
