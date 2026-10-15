import type { CodexServiceTierStatus } from "../../core/codex-service-tier.ts";

/** Compact preference indicator; detailed upstream and cost observations belong in /fast status. */
export function formatCodexServiceTierLabel(status: CodexServiceTierStatus | undefined): string {
	return status?.preference === "fast" && status.available ? "fast" : "";
}

export function formatCodexServiceTierStatus(status: CodexServiceTierStatus): string {
	const upstream =
		status.reported === "default"
			? "latest upstream Standard"
			: status.reported === "fast" || status.reported === "priority"
				? "latest upstream Fast"
				: "upstream tier unknown";
	return [
		`Codex service tier: ${status.preference === "fast" ? "Fast requested" : status.preference === "default" ? "Standard requested" : "unspecified"}`,
		`Source: ${status.source}; Fast available for model: ${status.available ? "yes (account eligibility not checked)" : "no (unsupported or unknown capability)"}`,
		`Latest matching response — sent: ${status.sent == null ? "unknown" : JSON.stringify(status.sent)}; reported: ${status.reported == null ? "unknown" : JSON.stringify(status.reported)}`,
		upstream,
		"Fast uses extra usage, including same-session compaction and branch summaries. Costs are estimates, not an exact bill; actual Fast service is not guaranteed.",
	].join("\n");
}
