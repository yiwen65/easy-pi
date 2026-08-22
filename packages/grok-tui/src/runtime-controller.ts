import type { ActionTerminal } from "./action-terminal.ts";
import { coalesceUiActions, type UiAction, type UiEffect } from "./actions.ts";
import { reduceUiState } from "./reducer.ts";
import { createInitialUiState, type UiState } from "./state.ts";

export interface RuntimeEffectHandlers {
	invalidateComponents(): void;
	render(force: boolean): void;
}

export class RuntimeController {
	private readonly terminal: ActionTerminal;
	private readonly handlers: RuntimeEffectHandlers;
	private currentState: UiState;
	private pendingActions: UiAction[] = [];
	private pendingEffects: UiEffect[] = [];
	private drainScheduled = false;
	private draining = false;

	constructor(terminal: ActionTerminal, handlers: RuntimeEffectHandlers) {
		this.terminal = terminal;
		this.handlers = handlers;
		this.currentState = createInitialUiState({ columns: terminal.columns, rows: terminal.rows });
		this.terminal.setActionSink((action) => this.dispatch(action));
	}

	get state(): UiState {
		return this.currentState;
	}

	dispatch(action: UiAction): void {
		this.pendingActions = coalesceUiActions([...this.pendingActions, action]);
		if (this.drainScheduled || this.draining) return;
		this.drainScheduled = true;
		queueMicrotask(() => {
			if (!this.drainScheduled) return;
			this.drainScheduled = false;
			this.flush();
		});
	}

	start(): void {
		this.dispatch({
			type: "lifecycle.started",
			dimensions: { columns: this.terminal.columns, rows: this.terminal.rows },
		});
		this.flush();
	}

	stop(): void {
		this.pendingActions = [{ type: "lifecycle.stopped" }];
		this.pendingEffects = [];
		this.drainScheduled = false;
		this.flush();
	}

	invalidate(components: boolean, force: boolean): void {
		this.dispatch({ type: "view.invalidated", components, force });
	}

	flush(): void {
		if (this.draining) return;
		this.draining = true;
		this.drainScheduled = false;
		try {
			while (this.pendingActions.length > 0 || this.pendingEffects.length > 0) {
				if (this.pendingEffects.length > 0) {
					const effect = this.pendingEffects.shift();
					if (effect) this.runEffect(effect);
					continue;
				}

				const actions = this.pendingActions;
				this.pendingActions = [];
				for (const action of actions) {
					const transition = reduceUiState(this.currentState, action);
					this.currentState = transition.state;
					this.pendingEffects.push(...transition.effects);
				}
			}
		} finally {
			this.draining = false;
		}
	}

	private runEffect(effect: UiEffect): void {
		switch (effect.type) {
			case "terminal.deliver-input":
				this.terminal.deliverInput(effect.data);
				return;
			case "terminal.deliver-resize":
				this.terminal.deliverResize();
				return;
			case "view.invalidate-components":
				this.handlers.invalidateComponents();
				return;
			case "view.render":
				this.handlers.render(effect.force);
				return;
		}
	}
}
