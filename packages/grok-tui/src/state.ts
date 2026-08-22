export type UiLifecycle = "stopped" | "running";

export interface UiDimensions {
	readonly columns: number;
	readonly rows: number;
}

export interface UiState {
	readonly lifecycle: UiLifecycle;
	readonly dimensions: UiDimensions;
	readonly revision: number;
	readonly resizeSequence: number;
	readonly inputSequence: number;
	readonly invalidationSequence: number;
}

export function normalizeUiDimensions(dimensions: UiDimensions): UiDimensions {
	return {
		columns: Math.max(1, Math.trunc(dimensions.columns)),
		rows: Math.max(1, Math.trunc(dimensions.rows)),
	};
}

export function createInitialUiState(dimensions: UiDimensions): UiState {
	return {
		lifecycle: "stopped",
		dimensions: normalizeUiDimensions(dimensions),
		revision: 0,
		resizeSequence: 0,
		inputSequence: 0,
		invalidationSequence: 0,
	};
}
