import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

/** User preference; the Codex adapter maps Fast to the wire value `priority`. */
export type CodexServiceTier = "default" | "fast";

export interface CodexServiceTierPreference {
	preference?: CodexServiceTier;
	source: "session" | "settings" | "none";
}

export interface CodexServiceTierStatus extends CodexServiceTierPreference {
	/** Model capability, not a guarantee of account eligibility or upstream acceptance. */
	available: boolean;
	sent?: string | null;
	reported?: string | null;
	costEstimated?: boolean;
}

// Internal request-boundary marker, consumed by the SDK before entering ModelRuntime.
// A resolved omission must not be confused with an ordinary request inheriting defaults.
export const CODEX_SERVICE_TIER_SNAPSHOT = Symbol("codex-service-tier-snapshot");
export type CodexServiceTierSnapshotOptions = SimpleStreamOptions & { [CODEX_SERVICE_TIER_SNAPSHOT]?: true };

/** Pin one summary operation's tier, including omission, across all of its retries. */
export function withCodexServiceTierSnapshot(
	streamFn: StreamFn,
	serviceTier: SimpleStreamOptions["serviceTier"],
): StreamFn {
	return (model, context, options) => {
		const snapshot: CodexServiceTierSnapshotOptions = { ...options, [CODEX_SERVICE_TIER_SNAPSHOT]: true };
		if (serviceTier === undefined) delete snapshot.serviceTier;
		else snapshot.serviceTier = serviceTier;
		return streamFn(model, context, snapshot);
	};
}

export function parseCodexServiceTier(value: unknown): CodexServiceTier | undefined {
	if (value === undefined || value === "default" || value === "fast") return value;
	throw new Error(`Invalid codexServiceTier: ${String(value)}. Expected "default", "fast", or undefined.`);
}

export function isCodexFastModeAvailable(model: Model<Api> | undefined): boolean {
	return (
		model?.provider === "openai-codex" &&
		model.api === "openai-codex-responses" &&
		model.compat !== undefined &&
		"supportsFastMode" in model.compat &&
		model.compat.supportsFastMode === true
	);
}

/** Resolve once at the request boundary, before asynchronous auth/hooks/transport work. */
export function resolveCodexServiceTierRequest(
	model: Model<Api>,
	preference: CodexServiceTier | undefined,
	explicitTier?: SimpleStreamOptions["serviceTier"],
): SimpleStreamOptions["serviceTier"] {
	// Preserve direct low-level options on other providers; never inject product defaults there.
	if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") return explicitTier;
	if (explicitTier !== undefined) {
		if ((explicitTier === "fast" || explicitTier === "priority") && !isCodexFastModeAvailable(model)) {
			throw new Error(
				`Fast mode is unavailable for ${model.provider}/${model.id}: model capability is not enabled.`,
			);
		}
		return explicitTier;
	}
	if (preference === "fast" && !isCodexFastModeAvailable(model)) return undefined;
	return preference;
}
