import type { InlineExtension } from "../core/extensions/types.ts";
import { createEasyPiHarness } from "./easy-pi.ts";
import llamaExtension from "./llama/index.ts";

/** Instance-bound product features. Custom ResourceLoaders remain host-owned. */
export function createBuiltInExtensions(agentDir: string, options?: { collaboration?: boolean }): InlineExtension[] {
	return [
		{ name: "llama.cpp", factory: llamaExtension, hidden: true },
		{
			name: "easy-pi",
			factory: createEasyPiHarness({ agentDir, collaboration: options?.collaboration }),
			hidden: true,
		},
	];
}
