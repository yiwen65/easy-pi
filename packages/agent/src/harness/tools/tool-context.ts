import type { ExecutionEnv } from "../types.ts";
import type { ReadProvider, ResourceReader } from "./read-provider.ts";
import type { SearchProvider } from "./search-provider.ts";
import type { WorkspacePolicy } from "./workspace-policy.ts";

/** Filesystem, shell, and optional v2 service context required by built-in execution tools. */
export interface ExecutionToolContext {
	env: ExecutionEnv;
	searchProvider?: SearchProvider;
	search?: {
		scopeId?: string;
	};
	readProvider?: ReadProvider;
	resourceReaders?: ResourceReader[];
	read?: {
		scopeId?: string;
	};
	workspacePolicy?: WorkspacePolicy;
	run?: {
		commandPrefix?: string;
		env?: Record<string, string>;
		inheritEnv?: boolean;
	};
}
