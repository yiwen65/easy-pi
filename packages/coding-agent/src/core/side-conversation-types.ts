import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type SideConversationState = "empty" | "starting" | "idle" | "running" | "closing" | "closed" | "cleanup-failed";

export interface SideConversationSnapshot {
	readonly state: SideConversationState;
	/** Only messages after the inherited boundary; never the parent's transcript. */
	readonly messages: readonly AgentMessage[];
	readonly parentRunning: boolean;
	readonly error?: string;
	/** Observed provider usage, not a cache-hit guarantee. */
	readonly usage: {
		readonly input: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	};
}

/** Presentation boundary. Hiding a view must not close its conversation. */
export interface SideConversation {
	readonly snapshot: SideConversationSnapshot;
	subscribe(listener: () => void): () => void;
	/** Create the conversation without starting inference. May reopen an explicitly closed side. */
	open(): Promise<void>;
	/** Submit plain text without shell escapes, slash execution, or prompt expansion. */
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	/** Close only this side, waiting for owned resources. Idempotent while closing. */
	close(): Promise<void>;
	/** Permanent owner shutdown; no subsequent admission is allowed. */
	shutdown(): Promise<void>;
}
