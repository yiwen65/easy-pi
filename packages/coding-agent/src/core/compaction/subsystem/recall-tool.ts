/**
 * recall_exact tool definition (CCTX-031): the model-facing entry point for
 * exact recall of content moved out of the active context by compaction.
 * Unknown IDs, tenant mismatches, and hash mismatches throw (fail closed).
 */

import { Type } from "typebox";
import type { ToolDefinition } from "../../extensions/types.ts";
import { RECALL_SEARCH_MAX_QUERY_CHARS, RECALL_SEARCH_MAX_RESULTS } from "./recall-catalog.ts";
import type { HfCompactionHost } from "./session-integration.ts";

export function createRecallExactToolDefinition(host: HfCompactionHost): ToolDefinition {
	return {
		name: "recall_exact",
		label: "Recall exact",
		description:
			"Restore content that compaction moved out of the active context, byte-exact, by its stable reference id (rc-...). Use recall_search first when the reference id is unknown.",
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

export function createRecallSearchToolDefinition(host: HfCompactionHost): ToolDefinition {
	return {
		name: "recall_search",
		label: "Search recalled content",
		description:
			"Search bounded previews of content published by the active branch snapshot. Returns stable refId values; pass one to recall_exact to restore the verified content.",
		promptSnippet: "recall_search: find an active recall ref by query and optional kind, then use recall_exact",
		parameters: Type.Object({
			query: Type.String({
				minLength: 1,
				maxLength: RECALL_SEARCH_MAX_QUERY_CHARS,
				description: "Keyword or phrase to match against bounded recall previews",
			}),
			kind: Type.Optional(
				Type.Union([
					Type.Literal("tool_result"),
					Type.Literal("message"),
					Type.Literal("artifact"),
					Type.Literal("event_range"),
				]),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: RECALL_SEARCH_MAX_RESULTS,
					description: `Maximum results (hard-capped at ${RECALL_SEARCH_MAX_RESULTS})`,
				}),
			),
		}),
		async execute(_toolCallId, { query, kind, limit }) {
			const results = host.recallSearch({ query, kind, limit });
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
				details: undefined,
			};
		},
	};
}
