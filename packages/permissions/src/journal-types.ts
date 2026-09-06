export type ExternalMutationPostState =
	| {
			status: "confirmed";
			fileType: "regular";
			size: number;
			mode: number;
			modifiedAtMs: number;
			sha256: string;
	  }
	| {
			status: "unavailable";
			reason: "missing" | "not_regular_file" | "changed_during_observation" | "read_error";
	  };

/** Controller-authorized host mutation. Authorization alone never implies that the tool succeeded. */
export interface ExternalMutationRecord {
	mutationId: string;
	runId: string;
	taskId: string;
	attemptId: string;
	attemptNumber: number;
	authorizationSequence: number;
	toolCallId: string;
	operation: "write" | "edit";
	path: string;
	authorizationStatus: "authorized";
	authorizedAt: number;
	toolResult?: "succeeded" | "failed";
	observedAt?: number;
	postState?: ExternalMutationPostState;
}
