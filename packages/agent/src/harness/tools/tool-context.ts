import type { ExecutionEnv } from "../types.ts";
import type { SearchProvider } from "./search-provider.ts";
import type { WorkspacePolicy } from "./workspace-policy.ts";

/** Filesystem, shell, and optional v2 service context required by built-in execution tools. */
export interface ExecutionToolContext {
	env: ExecutionEnv;
	searchProvider?: SearchProvider;
	workspacePolicy?: WorkspacePolicy;
	run?: {
		commandPrefix?: string;
		env?: Record<string, string>;
		inheritEnv?: boolean;
	};
}
