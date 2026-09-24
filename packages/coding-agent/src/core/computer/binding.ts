import { AgentToolError, type ResourceScheduler } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ComputerNativeSession, ComputerSession } from "./host.ts";

/** Explicit SDK injection. No default tools, native import, discovery, or persistent authority. */
export interface ComputerSessionBinding {
	/** Independent renderer availability, never input/result/terminal proof. */
	readonly rendererHealth?: ComputerRendererHealth;
	/** Synchronous latched notification; late subscribers receive the existing stop. */
	subscribeStop?(listener: (reason: ComputerStopReason) => void): () => void;
	readonly scheduler: ResourceScheduler;
	readonly tools: readonly ToolDefinition[];
	readonly revoked: boolean;
	/** Canonical model context after transforms/image filtering. Invalidate first: observer errors are swallowed. */
	observeContext?(imagesEnabled: boolean, messages: readonly Message[]): void;
	fork(): ComputerSessionBinding;
	renew(): ComputerSessionBinding;
	cancel(): void;
	revoke(): void;
	close(): Promise<void>;
}

export type ComputerStopReason =
	| { readonly status: "emergency_stopped" }
	| { readonly status: "failed"; readonly code: string };
export type ComputerRendererHealth =
	| { readonly status: "not_started" }
	| { readonly status: "ready"; readonly pid: number; readonly windowId: number }
	| ComputerStopReason;

/** One host-lifetime latch shared by every renewed/forked binding. */
export class ComputerStopSignal {
	private value: ComputerRendererHealth = Object.freeze({ status: "not_started" });
	private readonly listeners = new Set<(reason: ComputerStopReason) => void>();
	get health(): ComputerRendererHealth {
		return this.value;
	}
	get stopped(): boolean {
		return this.value.status === "failed" || this.value.status === "emergency_stopped";
	}
	update(health: ComputerRendererHealth): void {
		if (this.stopped) return;
		this.value = Object.freeze({ ...health });
		if (health.status !== "failed" && health.status !== "emergency_stopped") return;
		const listeners = [...this.listeners];
		this.listeners.clear();
		for (const listener of listeners) {
			try {
				listener(health);
			} catch {
				/* One observer cannot prevent revocation of others. */
			}
		}
	}
	subscribe(listener: (reason: ComputerStopReason) => void): () => void {
		if (this.value.status === "failed" || this.value.status === "emergency_stopped") {
			listener(this.value);
			return () => {};
		}
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

/** Preserve the delegate's authority clearing and native result/terminal ownership. */
export function withComputerStop(binding: ComputerSessionBinding, stop: ComputerStopSignal): ComputerSessionBinding {
	const unsubscribe = stop.subscribe(() => binding.revoke());
	const stoppedError = (cause?: unknown) => {
		const health = stop.health;
		const code = health.status === "failed" ? health.code : health.status;
		const guidance =
			code === "desktop_lease_unavailable"
				? "Desktop ownership is busy, quarantined after an unclean shutdown, or its storage is unsafe. Inspect the owner and lease; do not delete the lock or automatically retry. A new session alone may not resolve this."
				: "Create an explicitly new feature after resolving the stop; do not replay input.";
		return new AgentToolError(`Computer stopped: ${code}. ${guidance}`, {
			...(cause instanceof AgentToolError && typeof cause.details === "object" && cause.details !== null
				? cause.details
				: {}),
			stopReason: health,
		});
	};
	return {
		...binding,
		tools: Object.freeze(
			binding.tools.map((tool) => ({
				...tool,
				async execute(...args: Parameters<typeof tool.execute>) {
					if (stop.stopped) throw stoppedError();
					try {
						return await tool.execute(...args);
					} catch (error) {
						if (stop.stopped) throw stoppedError(error);
						throw error;
					}
				},
			})),
		),
		get revoked() {
			return stop.stopped || binding.revoked;
		},
		get rendererHealth() {
			return stop.health;
		},
		subscribeStop: (listener) => stop.subscribe(listener),
		fork() {
			if (stop.stopped) throw stoppedError();
			return withComputerStop(binding.fork(), stop);
		},
		renew() {
			if (stop.stopped) throw stoppedError();
			return withComputerStop(binding.renew(), stop);
		},
		close() {
			unsubscribe();
			return binding.close();
		},
	};
}

/** Rebuild tool closures for every capability; a child never inherits its parent's live handle. */
export function createComputerSessionBinding<S extends ComputerNativeSession>(
	session: ComputerSession<S>,
	createTools: (session: ComputerSession<S>) => readonly ToolDefinition[],
): ComputerSessionBinding {
	const tools = createTools(session);
	const names = new Set<string>();
	for (const tool of tools) {
		if (names.has(tool.name)) throw new Error("Duplicate Computer binding tool");
		names.add(tool.name);
		if (
			tool.executionResource?.key !== `desktop:${session.host.desktopId}` ||
			tool.executionResource.mode !== "exclusive"
		) {
			throw new Error("Computer binding tools require the host's exclusive desktop resource");
		}
	}
	return {
		scheduler: session.host.scheduler,
		tools: Object.freeze([...tools]),
		get revoked() {
			return session.revoked;
		},
		fork: () => createComputerSessionBinding(session.fork(), createTools),
		renew: () => createComputerSessionBinding(session.renew(), createTools),
		cancel: () => session.cancel(),
		revoke: () => session.revoke(),
		close: () => session.close(),
	};
}
