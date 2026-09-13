export type RunScopeState = "reserved" | "active" | "settling" | "settled";

export interface RunScopeOptions {
	runId: string;
	generation: number;
}

/**
 * Owns one agent run's cancellation and effect-admission state.
 *
 * Preparation may await, but effect admission is synchronous: callers must
 * re-check this scope immediately before starting a provider, tool, or process.
 */
export class RunScope {
	readonly runId: string;
	readonly generation: number;
	readonly controller: AbortController;

	private _state: RunScopeState = "reserved";
	private _cancelRequested = false;
	private _resolveSettled: () => void = () => {};
	private readonly _settledPromise: Promise<void>;

	constructor(options: RunScopeOptions) {
		this.runId = options.runId;
		this.generation = options.generation;
		this.controller = new AbortController();
		this._settledPromise = new Promise((resolve) => {
			this._resolveSettled = resolve;
		});
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get state(): RunScopeState {
		return this._state;
	}

	get cancelRequested(): boolean {
		return this._cancelRequested;
	}

	activate(): void {
		if (this._state !== "reserved") {
			throw new Error(`Cannot activate run scope in state ${this._state}`);
		}
		this._state = "active";
	}

	requestCancel(): void {
		if (this._state === "settled") return;
		this._cancelRequested = true;
		this.controller.abort();
	}

	/** Return true only at the synchronous linearization point before an effect starts. */
	canAdmit(generation = this.generation): boolean {
		return (
			this._state === "active" &&
			!this._cancelRequested &&
			!this.controller.signal.aborted &&
			generation === this.generation
		);
	}

	settle(): void {
		if (this._state === "settled") return;
		this._state = "settling";
		this._state = "settled";
		this._resolveSettled();
	}

	waitForSettled(): Promise<void> {
		return this._settledPromise;
	}
}
