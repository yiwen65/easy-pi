import type { CodexServiceTierStatus } from "../../core/codex-service-tier.ts";

/** Do not infer the served tier from the request or the compatibility cost estimate. */
export function formatCodexServiceTierLabel(status: CodexServiceTierStatus | undefined): string {
	if (!status?.preference) return "";
	const requested = status.preference === "fast" ? "Fast requested" : "Standard requested";
	const upstream =
		status.reported === "default"
			? "latest upstream Standard"
			: status.reported === "fast" || status.reported === "priority"
				? "latest upstream Fast"
				: "upstream tier unknown";
	return [
		requested,
		...(status.preference === "fast" && !status.available ? ["unavailable for this model"] : []),
		upstream,
		...(status.preference === "fast" || status.costEstimated ? ["costs estimated"] : []),
	].join(" · ");
}

export function formatCodexServiceTierStatus(status: CodexServiceTierStatus): string {
	return [
		`Codex service tier: ${status.preference === "fast" ? "Fast requested" : status.preference === "default" ? "Standard requested" : "unspecified"}`,
		`Source: ${status.source}; Fast available for model: ${status.available ? "yes (account eligibility not checked)" : "no (unsupported or unknown capability)"}`,
		`Latest matching response — sent: ${status.sent == null ? "unknown" : JSON.stringify(status.sent)}; reported: ${status.reported == null ? "unknown" : JSON.stringify(status.reported)}`,
		...(status.preference ? [formatCodexServiceTierLabel(status)] : []),
		"Fast uses extra usage, including same-session compaction and branch summaries. Costs are estimates, not an exact bill; actual Fast service is not guaranteed.",
	].join("\n");
}
