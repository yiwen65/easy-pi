import type { ResourceScheduler } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ComputerNativeSession, ComputerSession } from "./host.ts";

/** Explicit SDK injection. No default tools, native import, discovery, or persistent authority. */
export interface ComputerSessionBinding {
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
