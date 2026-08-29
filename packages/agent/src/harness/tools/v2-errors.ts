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
	| "QUERY_TOO_BROAD"
	| "SEARCH_INCOMPLETE"
	| "RESULTS_TRUNCATED"
	| "NO_MATCH_COMPLETE"
	| "SYMBOL_INDEX_UNAVAILABLE"
	| "FILE_SKIPPED"
	| "BUDGET_EXCEEDED"
	| "STALE_LOCATOR"
	| "STALE_VIEW"
	| "STALE_PATCH"
	| "STALE_SNAPSHOT"
	| "SEARCH_CAPABILITY_UNSUPPORTED"
	| "SEARCH_PROVIDER_FAILED"
	| "AMBIGUOUS_MATCH"
	| "PREIMAGE_MISMATCH"
	| "RANGE_MISMATCH"
	| "VALIDATION_FAILED"
	| "EDIT_CONTEXT_NOT_FOUND"
	| "EDIT_CONTEXT_AMBIGUOUS"
	| "EDIT_CONFLICT"
	| "EDIT_MOVE_NOT_SUPPORTED"
	| "STALE_FILE"
	| "PATCH_PARSE_ERROR"
	| "PATCH_CONTEXT_NOT_FOUND"
	| "PATCH_AMBIGUOUS"
	| "EDIT_PLAN_TOO_LARGE"
	| "EDIT_ROLLED_BACK"
	| "EDIT_INDETERMINATE"
	| "EDIT_PARTIAL_COMMIT"
	| "SPAWN_FAILED"
	| "SHELL_UNAVAILABLE"
	| "ABORTED";

export interface V2RecoveryAction {
	kind:
		| "retry_without_cursor"
		| "narrow_scope"
		| "read_again"
		| "split_edit"
		| "inspect_paths"
		| "configure_capability"
		| "use_text_fallback"
		| "read_locator"
		| "prepare_edit"
		| "commit_patch"
		| "verify_change";
	paths?: string[];
}

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
