/**
 * Process-isolated child-agent control surface.
 *
 * Implementations own transport framing and child lifecycle. Callers own durable
 * scheduling state and persist `metadata` after every accepted event/state read.
 */

export type ChildStreamingBehavior = "steer" | "followUp";

export interface ChildAgentRuntimeMetadata {
	sessionId: string;
	sessionFile?: string;
	runtimeGeneration: number;
	lastEventSeq: number;
}

export interface ChildAgentRuntimeState extends ChildAgentRuntimeMetadata {
	model: unknown | null;
	thinkingLevel: string;
	isStreaming: boolean;
	isCompacting: boolean;
	pendingMessageCount: number;
}

export interface ChildAgentRuntimeEvent {
	/** Monotonic within one runtime generation. */
	seq: number;
	runtimeGeneration: number;
	payload: Readonly<Record<string, unknown>>;
}

export interface ChildAgentRuntimeWaitOptions {
	/** Ignore settled events at or before this sequence number. */
	afterSeq?: number;
	/** Maximum inactivity between accepted runtime events while waiting. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type ChildAgentRuntimeEventListener = (event: ChildAgentRuntimeEvent) => void;

export interface ChildAgentRuntime {
	readonly metadata: ChildAgentRuntimeMetadata;
	readonly closed: boolean;

	prompt(message: string, streamingBehavior?: ChildStreamingBehavior): Promise<void>;
	steer(message: string): Promise<void>;
	followUp(message: string): Promise<void>;
	abort(): Promise<void>;
	getState(): Promise<ChildAgentRuntimeState>;
	/** Subscribe to ordered, non-response RPC events. */
	onEvent(listener: ChildAgentRuntimeEventListener): () => void;
	/** Resolve only on the session-level `agent_settled` event. */
	waitForSettled(options?: ChildAgentRuntimeWaitOptions): Promise<ChildAgentRuntimeEvent>;
	shutdown(): Promise<void>;
}

export interface ChildAgentRuntimeFactory<SpawnOptions, ConnectOptions> {
	spawn(options: SpawnOptions): Promise<ChildAgentRuntime>;
	/** Launch a new isolated process attached to an existing durable session. */
	connect(options: ConnectOptions): Promise<ChildAgentRuntime>;
}
