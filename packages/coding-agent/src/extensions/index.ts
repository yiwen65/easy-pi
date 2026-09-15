import webSearchExtension from "@easy-pi/web-search";
import type { InlineExtension } from "../core/extensions/types.ts";
import { createEasyPiHarness } from "./easy-pi.ts";
import llamaExtension from "./llama/index.ts";
import { registerPiBackgroundTasks } from "./pi-background-tasks.ts";

/** Instance-bound product features. Custom ResourceLoaders remain host-owned. */
export function createBuiltInExtensions(agentDir: string, options?: { collaboration?: boolean }): InlineExtension[] {
	return [
		{ name: "llama.cpp", factory: llamaExtension, hidden: true },
		{ name: "background-tasks", factory: registerPiBackgroundTasks, hidden: true },
		{ name: "web-search", factory: webSearchExtension, hidden: true },
		{
			name: "easy-pi",
			factory: createEasyPiHarness({ agentDir, collaboration: options?.collaboration }),
			hidden: true,
		},
	];
}
