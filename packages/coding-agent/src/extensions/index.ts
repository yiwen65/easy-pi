import webSearchExtension from "@easy-pi/web-search";
import type { InlineExtension } from "../core/extensions/types.ts";
import { createCodemodeExtension } from "./codemode/index.ts";
import { createEasyPiHarness } from "./easy-pi.ts";
import llamaExtension from "./llama/index.ts";
import { createMcpExtension } from "./mcp/index.ts";
import { registerPiBackgroundTasks } from "./pi-background-tasks.ts";
import toolSearchExtension from "./tool-search/index.ts";

/** Instance-bound product features. Custom ResourceLoaders remain host-owned. */
export function createBuiltInExtensions(
	agentDir: string,
	options?: { collaboration?: boolean; mcp?: boolean; codemode?: boolean },
): InlineExtension[] {
	return [
		{ name: "llama.cpp", factory: llamaExtension, hidden: true },
		{ name: "background-tasks", factory: registerPiBackgroundTasks, hidden: true },
		{ name: "web-search", factory: webSearchExtension, hidden: true },
		...(options?.codemode === false
			? []
			: [{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true }]),
		...(options?.mcp === false
			? []
			: [
					{ name: "tool-search", factory: toolSearchExtension, builtin: true, replaceable: true },
					{ name: "mcp", factory: createMcpExtension({ agentDir }), builtin: true, replaceable: true },
				]),
		{
			name: "easy-pi",
			factory: createEasyPiHarness({ agentDir, collaboration: options?.collaboration }),
			hidden: true,
		},
	];
}
