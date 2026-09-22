/**
 * Compaction Control Extension
 *
 * Pi's compaction subsystem owns the handoff summary. Summary text returned through
 * `session_before_compact` (`compaction`) is deprecated and ignored, so an extension
 * controls compaction only by cancelling it and by observing the persisted checkpoint.
 *
 * This example:
 * 1. cancels compaction while the history is too small for a summary to pay off;
 * 2. reports every checkpoint the subsystem persists.
 *
 * Usage:
 *   pi --extension examples/extensions/compaction-control.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Rewrite this policy (or the condition) to control compaction your own way. */
const MIN_COMPACTION_TOKENS = 50_000;

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, reason } = event;
		if (preparation.tokensBefore >= MIN_COMPACTION_TOKENS) return;

		ctx.ui.notify(
			`Skipping ${reason} compaction: ${preparation.tokensBefore.toLocaleString()} tokens is below ${MIN_COMPACTION_TOKENS.toLocaleString()}`,
			"info",
		);
		return { cancel: true };
	});

	pi.on("session_compact", async (event, ctx) => {
		ctx.ui.notify(`Compaction checkpoint ${event.compactionEntry.id} saved (${event.reason})`, "info");
	});
}
