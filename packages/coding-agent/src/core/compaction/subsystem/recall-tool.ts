/**
 * recall_exact tool definition (CCTX-031): the model-facing entry point for
 * exact recall of content moved out of the active context by compaction.
 * Unknown IDs, tenant mismatches, and hash mismatches throw (fail closed).
 */

import { Type } from "typebox";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { HfCompactionHost } from "./session-integration.ts";

export function createRecallExactToolDefinition(host: HfCompactionHost): ToolDefinition {
	return {
		name: "recall_exact",
		label: "Recall exact",
		description:
			"Restore content that compaction moved out of the active context, byte-exact, by its stable reference id (rc-...). Reference ids are listed in the verified snapshot's recallable section.",
		promptSnippet: "recall_exact: restore offloaded content byte-exact by stable ref id",
		parameters: Type.Object({
			refId: Type.String({ description: "Stable recall reference id (rc-...) from the snapshot's recallable list" }),
		}),
		async execute(_toolCallId, { refId }) {
			const text = host.recallExact(refId);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	};
}
