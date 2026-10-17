import { SessionManager } from "../../coding-agent/dist/core/session-manager.js";

/** A real host path with a capture anchor; an empty/malformed manager cannot own a snapshot. */
export function snapshotHost() {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({ role: "user", content: "capture anchor", timestamp: Date.now() });
	return { sessionManager };
}
