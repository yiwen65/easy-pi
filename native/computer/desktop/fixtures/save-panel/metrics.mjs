export function percentile(values, fraction) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function summarize(samples) {
	const passed = (row) =>
		row.passed === true &&
		row.exitCode === 0 &&
		row.closed === true &&
		row.fixtureExit?.code === 0 &&
		/^pi-computer-desktop-v1 C /.test(row.lease ?? "") &&
		Number.isFinite(row.taskMs) &&
		row.taskMs >= 0;
	const groups = [];
	for (const scenario of new Set(samples.map((row) => row.scenario))) {
		for (const strategy of ["split", "combined"]) {
			const rows = samples.filter((row) => row.scenario === scenario && row.strategy === strategy);
			const good = rows.filter(passed);
			groups.push({
				scenario,
				strategy,
				attempts: rows.length,
				passed: good.length,
				failed: rows.length - good.length,
				successfulTaskP50Ms: percentile(
					good.map((row) => row.taskMs),
					0.5,
				),
				successfulTaskP95Ms: percentile(
					good.map((row) => row.taskMs),
					0.95,
				),
				closeP95Ms: percentile(
					rows.filter((row) => Number.isFinite(row.closeMs)).map((row) => row.closeMs),
					0.95,
				),
				callsP50: percentile(
					good.map((row) => row.calls.length),
					0.5,
				),
			});
		}
	}
	return {
		groups,
		allPassed: samples.length > 0 && samples.every(passed),
		interpretation:
			"Screening only; successful-task latency excludes failures, which remain in attempts. No model latency or statistical non-inferiority claim.",
	};
}
