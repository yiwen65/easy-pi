import type { Message, Tool } from "@earendil-works/pi-ai/compat";

/** Minimal contracts for local Codex Remote V2-style compaction. */

export interface TokenStats {
	system: number;
	tools: number;
	compactionItem: number;
	recentUsers: number;
	postCheckpointHistory: number;
	currentInput: number;
	outputReserve: number;
	total: number;
}

export interface CompactionLLMRequest {
	systemPrompt: string;
	messages: Message[];
	tools?: Tool[];
	signal?: AbortSignal;
	promptVersion: string;
}

export interface CompactionLLMResponse {
	text: string;
	/** "length" means the provider stopped at an output limit; the handoff is incomplete. */
	stopReason: "stop" | "length" | "error" | "aborted";
	errorMessage?: string;
	usage?: { input: number; output: number };
}

export type CompleteFn = (request: CompactionLLMRequest) => Promise<CompactionLLMResponse>;
