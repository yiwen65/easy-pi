import type { ModelCost, ModelCostRates, ModelCostTier } from "../src/types.ts";

export interface ModelsDevCost {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
	tiers?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		tier?: { type?: string; size?: number };
	}[];
}

export interface OpenRouterPricingOverride {
	min_prompt_tokens?: number;
	utc_start?: number;
	utc_end?: number;
	utc_days?: string[];
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
}

/** OpenRouter prices are dollars per token; prompt-length thresholds are exclusive. */
export interface OpenRouterPricing {
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
	overrides?: OpenRouterPricingOverride[];
}

/** Gateway brackets use inclusive minima and exclusive maxima, in prompt tokens. */
export interface AiGatewayPriceTier {
	cost?: string | number;
	min?: number;
	max?: number;
}

/** Vercel AI Gateway prices are dollars per token. */
export interface AiGatewayPricing {
	input?: string | number;
	output?: string | number;
	input_cache_read?: string | number;
	input_cache_write?: string | number;
	input_tiers?: AiGatewayPriceTier[];
	output_tiers?: AiGatewayPriceTier[];
	input_cache_read_tiers?: AiGatewayPriceTier[];
	input_cache_write_tiers?: AiGatewayPriceTier[];
}

function rate(value: unknown, fallback = 0, multiplier = 1): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
	const scaled = parsed * multiplier;
	if (!Number.isFinite(scaled) || scaled < 0) return fallback;
	return multiplier === 1 ? scaled : Number(scaled.toFixed(6));
}

function tokenCount(value: number | undefined): value is number {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

export function getModelsDevCost(cost: ModelsDevCost | undefined): ModelCost {
	const base = {
		input: rate(cost?.input),
		output: rate(cost?.output),
		cacheRead: rate(cost?.cache_read),
		cacheWrite: rate(cost?.cache_write),
	};
	const tiers = cost?.tiers?.flatMap((tier): ModelCostTier[] => {
		if (tier.tier?.type !== "context" || !tokenCount(tier.tier.size)) return [];
		return [{
			inputTokensAbove: tier.tier.size,
			input: rate(tier.input, base.input),
			output: rate(tier.output, base.output),
			cacheRead: rate(tier.cache_read, base.cacheRead),
			cacheWrite: rate(tier.cache_write, base.cacheWrite),
		}];
	});
	return tiers?.length ? { ...base, tiers } : base;
}

export function getOpenRouterCost(pricing: OpenRouterPricing | undefined): ModelCost {
	const base = {
		input: rate(pricing?.prompt, 0, 1000000),
		output: rate(pricing?.completion, 0, 1000000),
		cacheRead: rate(pricing?.input_cache_read, 0, 1000000),
		cacheWrite: rate(pricing?.input_cache_write, 0, 1000000),
	};
	const tiers = pricing?.overrides?.flatMap((override): ModelCostTier[] => {
		// ModelCost cannot express time-of-day or weekday overlays.
		if (!tokenCount(override.min_prompt_tokens) || override.utc_start !== undefined ||
			override.utc_end !== undefined || override.utc_days !== undefined) return [];
		return [{
			inputTokensAbove: override.min_prompt_tokens,
			input: rate(override.prompt, base.input, 1000000),
			output: rate(override.completion, base.output, 1000000),
			cacheRead: rate(override.input_cache_read, base.cacheRead, 1000000),
			cacheWrite: rate(override.input_cache_write, base.cacheWrite, 1000000),
		}];
	});
	return tiers?.length ? { ...base, tiers } : base;
}

const GATEWAY_RATE_FIELDS = [
	{ rate: "input", tiers: "input_tiers" },
	{ rate: "output", tiers: "output_tiers" },
	{ rate: "cacheRead", tiers: "input_cache_read_tiers" },
	{ rate: "cacheWrite", tiers: "input_cache_write_tiers" },
] as const;

export function getAiGatewayCost(pricing: AiGatewayPricing | undefined): ModelCost {
	const base: ModelCostRates = {
		input: rate(pricing?.input, 0, 1000000),
		output: rate(pricing?.output, 0, 1000000),
		cacheRead: rate(pricing?.input_cache_read, 0, 1000000),
		cacheWrite: rate(pricing?.input_cache_write, 0, 1000000),
	};
	const brackets = GATEWAY_RATE_FIELDS.map((field) => ({
		...field,
		values: (pricing?.[field.tiers] ?? []).filter((bracket) =>
			tokenCount(bracket.min ?? 0) && (bracket.max === undefined ||
				(tokenCount(bracket.max) && bracket.max > (bracket.min ?? 0)))),
	}));
	const ratesAt = (start: number): ModelCostRates => {
		const rates = { ...base };
		for (const field of brackets) {
			const bracket = field.values.find((value) => (value.min ?? 0) <= start &&
				(value.max === undefined || start < value.max));
			rates[field.rate] = rate(bracket?.cost, base[field.rate], 1000000);
		}
		return rates;
	};
	const starts = new Set<number>();
	for (const field of brackets) {
		for (const bracket of field.values) {
			if (bracket.min !== undefined && bracket.min > 0) starts.add(bracket.min);
			// Ending a bounded bracket restores the base rate unless another bracket begins there.
			if (bracket.max !== undefined) starts.add(bracket.max);
		}
	}
	const tiers = [...starts].sort((a, b) => a - b).map((start): ModelCostTier => ({
		inputTokensAbove: start - 1, ...ratesAt(start),
	}));
	const initialRates = ratesAt(0);
	return tiers.length ? { ...initialRates, tiers } : initialRates;
}
