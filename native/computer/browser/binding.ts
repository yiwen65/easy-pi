import {
	type ComputerSessionBinding,
	createComputerSessionBinding,
} from "../../../packages/coding-agent/src/core/computer/binding.ts";
import type { ComputerSession } from "../../../packages/coding-agent/src/core/computer/host.ts";
import type { ControlledComputerSession } from "../controlled/adapter.ts";
import type { ComputerPlanApi } from "../controlled/tool.ts";
import { createControlledBrowserTool } from "./tool.ts";

/** Fresh tool/observation closures for root, child and renewed capabilities. */
export function createControlledBrowserBinding(
	session: ComputerSession<ControlledComputerSession>,
	getApi: () => ComputerPlanApi,
): ComputerSessionBinding {
	return createComputerSessionBinding(session, (capability) => [createControlledBrowserTool(capability, getApi)]);
}
