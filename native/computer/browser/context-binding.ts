import { AgentToolError } from "@earendil-works/pi-agent-core";
import {
	type ComputerSessionBinding,
	createComputerSessionBinding,
} from "../../../packages/coding-agent/src/core/computer/binding.ts";
import type { ComputerSession } from "../../../packages/coding-agent/src/core/computer/host.ts";
import type { ControlledComputerSession } from "../controlled/adapter.ts";
import type { ComputerPlanApi } from "../controlled/tool.ts";
import { DesktopView } from "../desktop/view.ts";
import { parseControlledBrowserInput } from "./contracts.ts";
import { createControlledBrowserTool } from "./tool.ts";

/** Browser refs, like native/image refs, require the actual canonical provider view. */
export function createContextBrowserBinding(
	session: ComputerSession<ControlledComputerSession>,
	getApi: () => ComputerPlanApi,
): ComputerSessionBinding {
	const view = new DesktopView<string>();
	const delegate = createControlledBrowserTool(session, getApi);
	let generation = 0;
	const clear = () => {
		generation++;
		view.clear();
	};
	const tool: typeof delegate = {
		...delegate,
		async execute(id, input, signal, onUpdate) {
			const current = ++generation;
			const visible = view.consume();
			const { request } = parseControlledBrowserInput(input);
			if (request.op === "execute" && visible !== request.ref) {
				throw new AgentToolError("Computer observation is not in the current model view; observe again.", {
					status: "paused",
					completedSteps: 0,
					code: "stale_observation",
				});
			}
			const result = await delegate.execute(id, input, signal, onUpdate);
			if (
				request.op === "observe" &&
				current === generation &&
				!session.revoked &&
				!signal?.aborted &&
				result.details.status === "observed" &&
				result.details.observationRef
			) {
				view.publish(id, result.content, result.details.observationRef);
			}
			return result;
		},
	};
	const binding = createComputerSessionBinding(session, () => [tool]);
	return {
		...binding,
		get revoked() {
			return session.revoked;
		},
		observeContext: (imagesEnabled, messages) => view.observeContext(imagesEnabled, messages),
		fork: () => createContextBrowserBinding(session.fork(), getApi),
		renew: () => createContextBrowserBinding(session.renew(), getApi),
		cancel() {
			clear();
			binding.cancel();
		},
		revoke() {
			clear();
			binding.revoke();
		},
		close() {
			clear();
			return binding.close();
		},
	};
}
