import {
	type ComputerSessionBinding,
	createComputerSessionBinding,
} from "../../../packages/coding-agent/src/core/computer/binding.ts";
import type { ComputerSession } from "../../../packages/coding-agent/src/core/computer/host.ts";
import type { ControlledComputerSession } from "./adapter.ts";
import { type ComputerPlanApi, createControlledComputerTool } from "./tool.ts";

/** Optional SDK composition; fork/renew rebuild all tool closures and observation grants. */
export function createControlledComputerBinding(
	session: ComputerSession<ControlledComputerSession>,
	getApi: () => ComputerPlanApi,
): ComputerSessionBinding {
	return createComputerSessionBinding(session, (capability) => [createControlledComputerTool(capability, getApi)]);
}
