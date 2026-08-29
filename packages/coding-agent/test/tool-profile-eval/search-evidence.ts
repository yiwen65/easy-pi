export interface SearchEvidenceTrial {
	targetPath: string;
	firstHitPaths: string[];
	allHitPaths: string[];
	modelVisibleResults: string[];
	searchCalls: number;
	selectedRank: number | null;
	elapsedMs: number;
}

export interface SearchEvidenceSummary {
	queries: number;
	recallAt5: number;
	meanReciprocalRank: number;
	firstRankRate: number;
	meanSearchCalls: number;
	meanDiscoveryToolCalls: number;
	meanElapsedMs: number;
	totalModelVisibleBytes: number;
	estimatedResultTokens: number;
	irrelevantHitRate: number;
	duplicateHitCount: number;
	peakRetainedResultTokens: number;
	cumulativeVisibleResultTokens: number;
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function estimatedTokens(value: string): number {
	return Math.ceil(value.length / 4);
}

/** Summarizes actual Search outputs; token values use the repository's deterministic chars/4 estimate. */
export function summarizeSearchEvidence(trials: SearchEvidenceTrial[]): SearchEvidenceSummary {
	let totalHits = 0;
	let irrelevantHits = 0;
	let duplicateHitCount = 0;
	let retainedTokens = 0;
	let cumulativeVisibleResultTokens = 0;
	for (const trial of trials) {
		const seen = new Set<string>();
		for (const path of trial.allHitPaths) {
			totalHits++;
			if (path !== trial.targetPath) irrelevantHits++;
			if (seen.has(path)) duplicateHitCount++;
			seen.add(path);
		}
		for (const result of trial.modelVisibleResults) {
			retainedTokens += estimatedTokens(result);
			cumulativeVisibleResultTokens += retainedTokens;
		}
	}
	const firstRanks = trials.map((trial) => {
		const index = trial.firstHitPaths.indexOf(trial.targetPath);
		return index < 0 ? null : index + 1;
	});
	return {
		queries: trials.length,
		recallAt5: mean(firstRanks.map((rank) => (rank !== null && rank <= 5 ? 1 : 0))),
		meanReciprocalRank: mean(firstRanks.map((rank) => (rank === null ? 0 : 1 / rank))),
		firstRankRate: mean(firstRanks.map((rank) => (rank === 1 ? 1 : 0))),
		meanSearchCalls: mean(trials.map((trial) => trial.searchCalls)),
		meanDiscoveryToolCalls: mean(
			trials.map((trial) => trial.searchCalls + (trial.selectedRank ?? trial.firstHitPaths.length + 1)),
		),
		meanElapsedMs: mean(trials.map((trial) => trial.elapsedMs)),
		totalModelVisibleBytes: trials.reduce(
			(sum, trial) =>
				sum + trial.modelVisibleResults.reduce((trialSum, result) => trialSum + Buffer.byteLength(result), 0),
			0,
		),
		estimatedResultTokens: retainedTokens,
		irrelevantHitRate: totalHits === 0 ? 0 : irrelevantHits / totalHits,
		duplicateHitCount,
		peakRetainedResultTokens: retainedTokens,
		cumulativeVisibleResultTokens,
	};
}
