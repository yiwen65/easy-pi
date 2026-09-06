import type { ExecutionEnv } from "../types.ts";
import type { WorkspacePolicy } from "./workspace-policy.ts";

/** Host filesystem/shell and an optional best-effort Bash working-directory policy. */
export interface ExecutionToolContext {
	env: ExecutionEnv;
	workspacePolicy?: WorkspacePolicy;
}
