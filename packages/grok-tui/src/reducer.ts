import type { UiAction, UiEffect } from "./actions.ts";
import { normalizeUiDimensions, type UiState } from "./state.ts";

export interface UiTransition {
	readonly state: UiState;
	readonly effects: readonly UiEffect[];
}

const NO_EFFECTS: readonly UiEffect[] = [];

export function reduceUiState(state: UiState, action: UiAction): UiTransition {
	switch (action.type) {
		case "lifecycle.started": {
			if (state.lifecycle === "running") return { state, effects: NO_EFFECTS };
			return {
				state: {
					...state,
					lifecycle: "running",
					dimensions: normalizeUiDimensions(action.dimensions),
					revision: state.revision + 1,
				},
				effects: [{ type: "view.render", force: true }],
			};
		}
		case "lifecycle.stopped": {
			if (state.lifecycle === "stopped") return { state, effects: NO_EFFECTS };
			return {
				state: { ...state, lifecycle: "stopped", revision: state.revision + 1 },
				effects: NO_EFFECTS,
			};
		}
		case "terminal.resized": {
			if (state.lifecycle !== "running") return { state, effects: NO_EFFECTS };
			const dimensions = normalizeUiDimensions(action.dimensions);
			if (dimensions.columns === state.dimensions.columns && dimensions.rows === state.dimensions.rows) {
				return { state, effects: NO_EFFECTS };
			}
			return {
				state: {
					...state,
					dimensions,
					revision: state.revision + 1,
					resizeSequence: state.resizeSequence + 1,
				},
				effects: [{ type: "terminal.deliver-resize" }],
			};
		}
		case "terminal.input": {
			if (state.lifecycle !== "running") return { state, effects: NO_EFFECTS };
			return {
				state: {
					...state,
					revision: state.revision + 1,
					inputSequence: state.inputSequence + 1,
				},
				effects: [{ type: "terminal.deliver-input", data: action.data }],
			};
		}
		case "view.invalidated": {
			const effects: UiEffect[] = [];
			if (action.components) effects.push({ type: "view.invalidate-components" });
			if (state.lifecycle === "running") effects.push({ type: "view.render", force: action.force });
			return {
				state: {
					...state,
					revision: state.revision + 1,
					invalidationSequence: state.invalidationSequence + 1,
				},
				effects,
			};
		}
	}
}
