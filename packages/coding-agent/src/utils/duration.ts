interface DurationParts {
	hours: number;
	minutes: number;
	seconds: number;
}

function splitDuration(totalSeconds: number): DurationParts {
	return {
		hours: Math.floor(totalSeconds / 3600),
		minutes: Math.floor((totalSeconds % 3600) / 60),
		seconds: totalSeconds % 60,
	};
}

/** Elapsed time in whole seconds: "45s", "12m 34s", "1h 2m 5s". */
export function formatElapsedDuration(ms: number): string {
	const { hours, minutes, seconds } = splitDuration(Math.floor(Math.max(0, ms) / 1000));
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** Elapsed time with sub-second precision under 10s: "0.8s", "13s", "1m 5s", "1h 1m 1s". */
export function formatWorkedDuration(ms: number): string {
	const totalSeconds = Math.max(0, ms) / 1000;
	if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;
	if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
	const { hours, minutes, seconds } = splitDuration(Math.round(totalSeconds));
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	return `${minutes}m ${seconds}s`;
}
