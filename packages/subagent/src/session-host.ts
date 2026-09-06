import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { PermissionMode } from "@easy-pi/permissions";
import type { CollaborationMessage, CollaborationStatus, ForkSelection } from "./collaboration-contract.ts";

/** Trusted, live parent authority. This capability is never accepted in model tool input. */
export interface ChildSessionPermissions {
	mode: PermissionMode;
	sessionGrants: readonly string[];
	protectedRoots: readonly string[];
}

export interface ChildSessionIdentity {
	rootSessionId: string;
	agentPath: string;
}

export interface ChildSessionModel {
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel;
}

export interface ChildSessionCreateOptions extends ChildSessionIdentity {
	cwd: string;
	agentDir: string;
	model: ChildSessionModel;
	/** Prepared effective context for a new session only; never a raw transcript. */
	fork?: AgentMessage[];
	/** Storage ownership and historical session validation belong to the team store. */
	storage: { kind: "memory" } | { kind: "file"; directory: string; sessionFile?: string };
	getPermissions: () => ChildSessionPermissions;
}

export interface ChildTurnResult {
	status: Extract<CollaborationStatus, "completed" | "failed" | "interrupted">;
	text: string;
	/** Absent means no reliable provider usage was observed, not zero consumption. */
	usage?: Usage;
}

/**
 * One logical Pi session. run resolves when its turn settles; creation/loading never starts a turn.
 * The controller owns mailbox scheduling and quotas. The host owns native lifecycle and tool authority.
 */
export interface ChildSession {
	readonly identity: Readonly<ChildSessionIdentity>;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	context(): AgentMessage[];
	/** N may only count complete turns whose original boundaries remain available. */
	forkContext(selection: ForkSelection): AgentMessage[];
	run(text: string, task?: CollaborationMessage): Promise<ChildTurnResult>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
}

/** Injected by coding-agent; the control plane does not import its SDK at runtime. */
export interface ChildSessionHost {
	create(options: ChildSessionCreateOptions): Promise<ChildSession>;
}
