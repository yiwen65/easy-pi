import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { mapAgentSessionEvent, type PiSessionUiEvent } from "./pi-session-events.ts";

export interface PiSessionRuntimeHost {
	readonly session: AgentSession;
	switchSession: AgentSessionRuntime["switchSession"];
	newSession: AgentSessionRuntime["newSession"];
	fork: AgentSessionRuntime["fork"];
}

export interface PiSessionHydration {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly sessionName: string | undefined;
	readonly cwd: string;
	readonly contextEntries: readonly SessionEntry[];
	readonly steering: readonly string[];
	readonly followUp: readonly string[];
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly isRetrying: boolean;
	readonly isBashRunning: boolean;
	readonly thinkingLevel: AgentSession["thinkingLevel"];
	readonly model: AgentSession["model"];
}

/**
 * The source event is retained as a compatibility payload while InteractiveMode
 * still owns Pi's established component state. New views should consume the
 * presentation-neutral event and leave the source event unused.
 */
export type PiSessionUiEventListener = (event: PiSessionUiEvent, sourceEvent: AgentSessionEvent) => void;

/**
 * Narrow presentation port over the current Pi AgentSessionRuntime.
 *
 * It delegates commands to the existing runtime/session so provider, tool,
 * extension and persistence semantics stay in their current owners.
 */
export class PiSessionPort {
	private readonly runtimeHost: PiSessionRuntimeHost;
	private readonly listeners = new Set<PiSessionUiEventListener>();
	private boundSession: AgentSession | undefined;
	private unsubscribeSession: (() => void) | undefined;
	private nextSequence = 0;

	constructor(runtimeHost: PiSessionRuntimeHost) {
		this.runtimeHost = runtimeHost;
	}

	private get session(): AgentSession {
		return this.runtimeHost.session;
	}

	/** Subscribe to the current session. Call rebind() from the runtime replacement hook. */
	subscribe(listener: PiSessionUiEventListener): () => void {
		this.listeners.add(listener);
		this.bindCurrentSession();
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) {
				this.unsubscribeSession?.();
				this.unsubscribeSession = undefined;
				this.boundSession = undefined;
			}
		};
	}

	/** Move event subscription to runtimeHost.session after a session replacement. */
	rebind(): void {
		if (this.boundSession === this.session) return;
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		this.boundSession = undefined;
		this.bindCurrentSession();
	}

	dispose(): void {
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		this.boundSession = undefined;
		this.listeners.clear();
	}

	private bindCurrentSession(): void {
		if (this.listeners.size === 0 || this.boundSession === this.session) return;
		this.boundSession = this.session;
		this.unsubscribeSession = this.boundSession.subscribe((event) => {
			const mapped = mapAgentSessionEvent(event, this.nextSequence++);
			for (const listener of [...this.listeners]) {
				listener(mapped, event);
			}
		});
	}

	/** Read the active, compaction-aware branch without appending or persisting entries. */
	hydrate(): PiSessionHydration {
		const session = this.session;
		const sessionManager = session.sessionManager;
		return {
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			sessionName: session.sessionName,
			cwd: sessionManager.getCwd(),
			contextEntries: sessionManager.buildContextEntries(),
			steering: [...session.getSteeringMessages()],
			followUp: [...session.getFollowUpMessages()],
			isStreaming: session.isStreaming,
			isCompacting: session.isCompacting,
			isRetrying: session.isRetrying,
			isBashRunning: session.isBashRunning,
			thinkingLevel: session.thinkingLevel,
			model: session.model,
		};
	}

	prompt(text: string, options?: PromptOptions): Promise<void> {
		return this.session.prompt(text, options);
	}

	steer(...args: Parameters<AgentSession["steer"]>): ReturnType<AgentSession["steer"]> {
		return this.session.steer(...args);
	}

	followUp(...args: Parameters<AgentSession["followUp"]>): ReturnType<AgentSession["followUp"]> {
		return this.session.followUp(...args);
	}

	abort(): Promise<void> {
		return this.session.abort();
	}

	clearQueue(): ReturnType<AgentSession["clearQueue"]> {
		return this.session.clearQueue();
	}

	executeBash(...args: Parameters<AgentSession["executeBash"]>): ReturnType<AgentSession["executeBash"]> {
		return this.session.executeBash(...args);
	}

	abortBash(): void {
		this.session.abortBash();
	}

	abortCompaction(): void {
		this.session.abortCompaction();
	}

	compact(...args: Parameters<AgentSession["compact"]>): ReturnType<AgentSession["compact"]> {
		return this.session.compact(...args);
	}

	abortRetry(): void {
		this.session.abortRetry();
	}

	setModel(...args: Parameters<AgentSession["setModel"]>): ReturnType<AgentSession["setModel"]> {
		return this.session.setModel(...args);
	}

	cycleModel(...args: Parameters<AgentSession["cycleModel"]>): ReturnType<AgentSession["cycleModel"]> {
		return this.session.cycleModel(...args);
	}

	setThinkingLevel(...args: Parameters<AgentSession["setThinkingLevel"]>): void {
		this.session.setThinkingLevel(...args);
	}

	cycleThinkingLevel(): ReturnType<AgentSession["cycleThinkingLevel"]> {
		return this.session.cycleThinkingLevel();
	}

	async switchSession(
		...args: Parameters<AgentSessionRuntime["switchSession"]>
	): Promise<Awaited<ReturnType<AgentSessionRuntime["switchSession"]>>> {
		const result = await this.runtimeHost.switchSession(...args);
		if (!result.cancelled) this.rebind();
		return result;
	}

	async newSession(
		...args: Parameters<AgentSessionRuntime["newSession"]>
	): Promise<Awaited<ReturnType<AgentSessionRuntime["newSession"]>>> {
		const result = await this.runtimeHost.newSession(...args);
		if (!result.cancelled) this.rebind();
		return result;
	}

	async fork(
		...args: Parameters<AgentSessionRuntime["fork"]>
	): Promise<Awaited<ReturnType<AgentSessionRuntime["fork"]>>> {
		const result = await this.runtimeHost.fork(...args);
		if (!result.cancelled) this.rebind();
		return result;
	}
}
