import type { AgentSession } from "../core/agent-session.ts";
import type { ReadonlySessionManager } from "../core/session-manager.ts";

// Exact manager identity, not cwd/session-ID lookup. Independent managers cannot
// accidentally attach to each other. The weak binding survives extension reload
// on the same session and is collectible with its manager.
const sessions = new WeakMap<ReadonlySessionManager, AgentSession>();
export function bindNativeSession(session: AgentSession): void {
	sessions.set(session.sessionManager, session);
}
export function getNativeSession(manager: ReadonlySessionManager): AgentSession {
	const session = sessions.get(manager);
	if (!session) throw new Error("Native session host is not bound");
	return session;
}
