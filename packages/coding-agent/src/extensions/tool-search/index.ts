/**
 * The `tool_search` tool as an extension. The CLI loads it as a built-in extension; SDK users add
 * `createToolSearchExtension()` to their extension factories.
 *
 * The host owns the initial active set. MCP activates discovery when deferred servers exist.
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { createToolSearchToolDefinition } from "./tool.ts";

export function createToolSearchExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool(createToolSearchToolDefinition({ tools: pi }));
	};
}

export default createToolSearchExtension();
