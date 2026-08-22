import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coalesceUiActions, type UiAction } from "../src/actions.ts";
import { reduceUiState } from "../src/reducer.ts";
import { createInitialUiState } from "../src/state.ts";

describe("Grok TUI reducer", () => {
	it("is deterministic and does not mutate its input", () => {
		const state = createInitialUiState({ columns: 80, rows: 24 });
		const snapshot = structuredClone(state);
		const action: UiAction = {
			type: "lifecycle.started",
			dimensions: { columns: 100, rows: 30 },
		};

		const first = reduceUiState(state, action);
		const second = reduceUiState(state, action);

		assert.deepEqual(first, second);
		assert.deepEqual(state, snapshot);
		assert.equal(first.state.lifecycle, "running");
		assert.deepEqual(first.effects, [{ type: "view.render", force: true }]);
	});

	it("keeps ordered input while coalescing invalidations and the latest resize", () => {
		const actions: UiAction[] = [
			{ type: "terminal.resized", dimensions: { columns: 90, rows: 20 } },
			{ type: "terminal.input", data: "a" },
			{ type: "view.invalidated", components: false, force: false },
			{ type: "terminal.resized", dimensions: { columns: 120, rows: 40 } },
			{ type: "view.invalidated", components: true, force: true },
			{ type: "terminal.input", data: "b" },
		];

		assert.deepEqual(coalesceUiActions(actions), [
			{ type: "terminal.input", data: "a" },
			{ type: "terminal.resized", dimensions: { columns: 120, rows: 40 } },
			{ type: "view.invalidated", components: true, force: true },
			{ type: "terminal.input", data: "b" },
		]);
	});

	it("does not coalesce across lifecycle boundaries", () => {
		const actions: UiAction[] = [
			{ type: "terminal.resized", dimensions: { columns: 80, rows: 20 } },
			{ type: "lifecycle.stopped" },
			{ type: "terminal.resized", dimensions: { columns: 100, rows: 30 } },
		];

		assert.deepEqual(coalesceUiActions(actions), actions);
	});

	it("keeps raw input out of persistent state", () => {
		const initial = createInitialUiState({ columns: 80, rows: 24 });
		const started = reduceUiState(initial, {
			type: "lifecycle.started",
			dimensions: { columns: 80, rows: 24 },
		}).state;
		const transition = reduceUiState(started, { type: "terminal.input", data: "secret prompt" });

		assert.equal(transition.state.inputSequence, 1);
		assert.equal(JSON.stringify(transition.state).includes("secret prompt"), false);
		assert.deepEqual(transition.effects, [{ type: "terminal.deliver-input", data: "secret prompt" }]);
	});
});
