import type { UiDimensions } from "./state.ts";

export type UiAction =
	| { type: "lifecycle.started"; dimensions: UiDimensions }
	| { type: "lifecycle.stopped" }
	| { type: "terminal.resized"; dimensions: UiDimensions }
	| { type: "terminal.input"; data: string }
	| { type: "view.invalidated"; components: boolean; force: boolean };

export type UiEffect =
	| { type: "terminal.deliver-input"; data: string }
	| { type: "terminal.deliver-resize" }
	| { type: "view.invalidate-components" }
	| { type: "view.render"; force: boolean };

/**
 * Collapse render-only churn without dropping input or crossing lifecycle
 * boundaries. The latest resize wins because Terminal dimensions are sampled
 * when the batch is drained, not when an intermediate frame is rendered.
 */
export function coalesceUiActions(actions: readonly UiAction[]): UiAction[] {
	const result: UiAction[] = [];
	let segmentStart = 0;

	for (const action of actions) {
		if (action.type === "lifecycle.started" || action.type === "lifecycle.stopped") {
			result.push(action);
			segmentStart = result.length;
			continue;
		}

		if (action.type === "terminal.resized") {
			for (let index = result.length - 1; index >= segmentStart; index -= 1) {
				if (result[index]?.type === "terminal.resized") result.splice(index, 1);
			}
			result.push(action);
			continue;
		}

		if (action.type === "view.invalidated") {
			let components = action.components;
			let force = action.force;
			for (let index = result.length - 1; index >= segmentStart; index -= 1) {
				const pending = result[index];
				if (pending?.type !== "view.invalidated") continue;
				components ||= pending.components;
				force ||= pending.force;
				result.splice(index, 1);
			}
			result.push({ type: "view.invalidated", components, force });
			continue;
		}

		result.push(action);
	}

	return result;
}
