/** Deterministic, fail-closed primitives for bounded active-context projection. */

export interface ProjectionCandidate<T> {
	id: string;
	value: T;
	tokens: number;
	priority: number;
	/** Protected candidates must fit as a set; they are never silently dropped. */
	protected: boolean;
	/** Stable source order. Larger values win ties so recent items are preferred. */
	order: number;
}

export interface BudgetedSelection<T> {
	selected: T[];
	usedTokens: number;
	droppedItems: number;
	protectedItems: number;
}

export class PromptBudgetExceededError extends Error {
	readonly zone: string;
	readonly budgetTokens: number;
	readonly requiredTokens: number;

	constructor(zone: string, budgetTokens: number, requiredTokens: number) {
		super(`${zone} protected content requires ${requiredTokens} tokens, exceeding its ${budgetTokens}-token budget`);
		this.name = "PromptBudgetExceededError";
		this.zone = zone;
		this.budgetTokens = budgetTokens;
		this.requiredTokens = requiredTokens;
	}
}

/**
 * Select complete items under a hard budget. Protected items are admitted first;
 * optional items are ranked by lifecycle priority and recency, then emitted in
 * their original order for deterministic reading.
 */
export function selectBudgetedItems<T>(
	zone: string,
	candidates: ProjectionCandidate<T>[],
	budgetTokens: number,
): BudgetedSelection<T> {
	if (!Number.isFinite(budgetTokens) || budgetTokens < 0) {
		throw new Error(`${zone} budget must be a finite non-negative number`);
	}
	const protectedCandidates = candidates.filter((candidate) => candidate.protected);
	const protectedTokens = protectedCandidates.reduce((sum, candidate) => sum + candidate.tokens, 0);
	if (protectedTokens > budgetTokens) {
		throw new PromptBudgetExceededError(zone, budgetTokens, protectedTokens);
	}

	const selectedIds = new Set(protectedCandidates.map((candidate) => candidate.id));
	let usedTokens = protectedTokens;
	const optionalCandidates = candidates
		.filter((candidate) => !candidate.protected)
		.sort(
			(left, right) => right.priority - left.priority || right.order - left.order || left.id.localeCompare(right.id),
		);
	for (const candidate of optionalCandidates) {
		if (usedTokens + candidate.tokens > budgetTokens) continue;
		selectedIds.add(candidate.id);
		usedTokens += candidate.tokens;
	}

	return {
		selected: candidates
			.filter((candidate) => selectedIds.has(candidate.id))
			.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
			.map((candidate) => candidate.value),
		usedTokens,
		droppedItems: candidates.length - selectedIds.size,
		protectedItems: protectedCandidates.length,
	};
}

/** Deterministically truncate lossy prose without ever exceeding its zone budget. */
export function truncateTextToBudget(
	text: string,
	budgetTokens: number,
	estimateTokens: (text: string) => number,
): { text: string; tokens: number; truncated: boolean } {
	if (budgetTokens <= 0 || text.length === 0) return { text: "", tokens: 0, truncated: text.length > 0 };
	const fullTokens = estimateTokens(text);
	if (fullTokens <= budgetTokens) return { text, tokens: fullTokens, truncated: false };

	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (estimateTokens(text.slice(0, middle)) <= budgetTokens) low = middle;
		else high = middle - 1;
	}
	const prefix = text.slice(0, low).trimEnd();
	const lastLineBreak = prefix.lastIndexOf("\n");
	const bounded = lastLineBreak >= Math.floor(prefix.length / 2) ? prefix.slice(0, lastLineBreak).trimEnd() : prefix;
	return { text: bounded, tokens: estimateTokens(bounded), truncated: true };
}
