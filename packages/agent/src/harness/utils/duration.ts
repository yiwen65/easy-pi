/**
 * Human-readable task duration shared by task tools, completion notifications, and TUI surfaces:
 * `45s`, `12m3s`, `1h5m`. Sub-second spans round to `0s`; negative spans clamp to `0s`.
 */
export function formatTaskDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
