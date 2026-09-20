import {
	type ComputerSessionBinding,
	createComputerSessionBinding,
} from "../../../packages/coding-agent/src/core/computer/binding.ts";
import type { ComputerSession } from "../../../packages/coding-agent/src/core/computer/host.ts";
import type { ControlledComputerSession } from "../controlled/adapter.ts";
import { createDesktopTool, type DesktopApi } from "./tool.ts";

/** Explicit optional composition. Every fork/renew gets empty, non-persisted view authority. */
export function createDesktopBinding(
	session: ComputerSession<ControlledComputerSession>,
	getApi: () => DesktopApi,
): ComputerSessionBinding {
	const desktop = createDesktopTool(session, getApi);
	const binding = createComputerSessionBinding(session, () => [desktop.tool]);
	return {
		...binding,
		get revoked() {
			return session.revoked;
		},
		observeContext: desktop.observeContext,
		fork: () => createDesktopBinding(session.fork(), getApi),
		renew: () => createDesktopBinding(session.renew(), getApi),
		cancel() {
			desktop.clear();
			binding.cancel();
		},
		revoke() {
			desktop.clear();
			binding.revoke();
		},
		close() {
			desktop.clear();
			return binding.close();
		},
	};
}
