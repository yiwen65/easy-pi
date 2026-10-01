/**
 * Pure selection logic for user-prompt navigation in the transcript.
 *
 * Given the content-row offsets of user prompt components and the current
 * scroll position, pick the next jump target. Navigation wraps around at
 * both ends so repeated presses cycle through all prompts.
 */

export type PromptJumpDirection = -1 | 1;

/**
 * Return the index into `promptStarts` to jump to, or undefined when there
 * are no prompts. `scrollTop` is the transcript's current top content row.
 * `selectedIndex` advances an uninterrupted component-identity navigation
 * sequence; the caller must invalidate it after manual scroll or geometry changes.
 *
 * - direction -1: nearest prompt strictly above the current top; wraps to
 *   the last prompt when already above the first one.
 * - direction +1: nearest prompt strictly below the current top; wraps to
 *   the first prompt when at or past the last one.
 */
export function findPromptJumpTarget(
	promptStarts: readonly number[],
	scrollTop: number,
	direction: PromptJumpDirection,
	selectedIndex?: number,
): number | undefined {
	if (promptStarts.length === 0) return undefined;
	// A requested prompt may lie beyond the viewport's clamped scrollTop.
	if (selectedIndex !== undefined && selectedIndex >= 0 && selectedIndex < promptStarts.length) {
		return (selectedIndex + direction + promptStarts.length) % promptStarts.length;
	}
	if (promptStarts.length === 1) return 0;
	if (direction < 0) {
		for (let i = promptStarts.length - 1; i >= 0; i--) {
			const start = promptStarts[i];
			if (start !== undefined && start < scrollTop) return i;
		}
		return promptStarts.length - 1;
	}
	for (let i = 0; i < promptStarts.length; i++) {
		const start = promptStarts[i];
		if (start !== undefined && start > scrollTop) return i;
	}
	return 0;
}
