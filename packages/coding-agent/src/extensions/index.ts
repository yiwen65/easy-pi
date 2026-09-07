import type { InlineExtension } from "../core/extensions/types.ts";
import { createEasyPiHarness } from "./easy-pi.ts";
import llamaExtension from "./llama/index.ts";
import { registerPiCollaborationRoot } from "./pi-collaboration-root.ts";

/** Instance-bound product features. Custom ResourceLoaders remain host-owned. */
export function createBuiltInExtensions(agentDir: string): InlineExtension[] {
	return [
		{ name: "llama.cpp", factory: llamaExtension, hidden: true },
		{
			name: "easy-pi",
			factory: createEasyPiHarness({
				nativeRoot: (pi, permissions) => registerPiCollaborationRoot(pi, agentDir, permissions),
			}),
			hidden: true,
		},
	];
}
