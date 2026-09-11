import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunLedger } from "./ledger.ts";
import type { SubagentDagRunDetails } from "./types.ts";

export function registerDeliveryCleanup(
	pi: ExtensionAPI,
	options: {
		host: DeliveryCleanupHost;
		ledger: RunLedger;
		checkScope: (runId: string, ctx: ExtensionCommandContext) => Promise<void>;
		authorize: (runId: string, ctx: ExtensionCommandContext) => Promise<boolean>;
		authorizeRead?: (ctx: ExtensionCommandContext) => Promise<boolean>;
	},
): void {
	pi.registerCommand("subagent-cleanup", {
		description:
			"Explicitly acknowledge delivery, discard, or keep a Subagent run: <run-id> [delivered|discard|keep]",
		async handler(args, ctx) {
			try {
				if (options.authorizeRead && !(await options.authorizeRead(ctx)))
					throw new Error("Subagent operator access denied");
				const [runId, value, ...extra] = args.trim().split(/\s+/);
				if (!runId || extra.length) throw new Error("Usage: /subagent-cleanup <run-id> [delivered|discard|keep]");
				await options.checkScope(runId, ctx);
				let disposition = value;
				if (!disposition && ctx.mode === "tui" && ctx.hasUI) {
					const choices = [
						"Keep — do not delete",
						"Delivered — clean task resources",
						"Discard undelivered results — clean task resources",
					];
					const selected = await ctx.ui.select("Confirm Subagent result disposition", choices);
					disposition = selected === choices[1] ? "delivered" : selected === choices[2] ? "discard" : "keep";
				}
				if (disposition !== "delivered" && disposition !== "discard" && disposition !== "keep")
					throw new Error("An explicit delivered, discard, or keep disposition is required");
				if (disposition === "keep") {
					ctx.ui.notify("Subagent results retained; no cleanup performed", "info");
					return;
				}
				if (!(await options.authorize(runId, ctx))) throw new Error("Subagent cleanup denied");
				await cleanupConfirmedRun(options.host, runId, disposition, (id, intent) =>
					options.ledger.confirmDagCleanup(id, intent),
				);
				const report = options.ledger.pruneConfirmedHistory();
				ctx.ui.notify(
					report.overBudget
						? "Task resources released; retained history exceeds the budget. Unconfirmed work was not deleted."
						: "Task resources released; confirmed history is retained for up to 7 days within the 256 MiB budget.",
					report.overBudget ? "warning" : "info",
				);
			} catch {
				// Do not reflect arbitrary repository paths, terminal controls or exception payloads.
				ctx.ui.notify(
					"Subagent cleanup did not complete. Check the run scope, terminal state, explicit disposition and permissions; retained results are not automatically discarded. Retry the explicit command after resolving the cause.",
					"error",
				);
			}
		},
	});
}

export type CleanupDisposition = "delivered" | "discard" | "keep";

export interface DeliveryCleanupHost {
	inspect(runId: string): SubagentDagRunDetails;
	cancel?(options: { runId: string }): Promise<SubagentDagRunDetails>;
	releaseCandidate?(options: { runId: string }): Promise<SubagentDagRunDetails>;
	gc?(options: { runId: string }): Promise<SubagentDagRunDetails>;
}

/** Called only after the product has obtained an explicit user disposition and authorization. */
export async function cleanupConfirmedRun(
	host: DeliveryCleanupHost,
	runId: string,
	disposition: CleanupDisposition,
	confirm: (runId: string, disposition: "delivered" | "discard") => void,
): Promise<SubagentDagRunDetails> {
	let details = host.inspect(runId);
	if (disposition === "keep") return details;
	if (disposition !== "delivered" && disposition !== "discard") throw new Error("Unknown cleanup disposition");
	if (!host.gc || (details.integration && !host.releaseCandidate))
		throw new Error("Cleanup is unavailable in this embedding");
	if (details.status === "created" || details.status === "running") {
		if (disposition !== "discard") throw new Error("A non-terminal run cannot be acknowledged as delivered");
		if (!host.cancel) throw new Error("Cancellation is unavailable in this embedding");
		details = await host.cancel({ runId });
	}
	if (!["succeeded", "failed", "cancelled"].includes(details.status))
		throw new Error("Run must be terminal before cleanup");
	if (details.integration && !host.releaseCandidate)
		throw new Error("Candidate release is unavailable in this embedding");
	// Persist intent before destructive work. An interruption never implies delivery,
	// and a partial cleanup is retried only on another explicit user command.
	confirm(runId, disposition);
	if (details.integration && details.resources.candidate !== "released") {
		await host.releaseCandidate!({ runId });
	}
	return host.gc({ runId });
}
