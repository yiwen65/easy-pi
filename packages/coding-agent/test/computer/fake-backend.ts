import type {
	ComputerBackend,
	ComputerExecuteRequest,
	ComputerExecutionResult,
	ComputerObservation,
} from "../../src/core/computer/contracts.ts";

/** Deterministic in-memory fixture only. Never loads a native library or touches a desktop. */
export class FakeComputerBackend implements ComputerBackend {
	readonly values = new Map([
		["field-1", ""],
		["field-2", ""],
	]);
	observeCalls = 0;
	executeCalls = 0;
	closeCalls = 0;
	private ref: string | undefined;
	private closed = false;

	async observe(signal?: AbortSignal): Promise<ComputerObservation> {
		signal?.throwIfAborted();
		if (this.closed) throw new Error("Fixture is closed");
		this.observeCalls++;
		this.ref = `snapshot-${this.observeCalls}`;
		return { ref: this.ref, text: "Test form: Name [field-1], Note [field-2]." };
	}

	async execute(request: ComputerExecuteRequest, signal?: AbortSignal): Promise<ComputerExecutionResult> {
		this.executeCalls++;
		if (this.closed) throw new Error("Fixture is closed");
		if (signal?.aborted) return { status: "cancelled", completedSteps: 0, error: "cancelled_before_dispatch" };
		if (request.ref !== this.ref) return { status: "failed", completedSteps: 0, error: "stale_observation" };
		// A ref is valid for this segment only. Even a failed segment requires a fresh observation.
		this.ref = undefined;
		let completedSteps = 0;
		for (const step of request.steps) {
			if (signal?.aborted) return { status: "cancelled", completedSteps, error: "cancelled" };
			const status = completedSteps === 0 ? "failed" : "partial";
			if (!this.values.has(step.target)) return { status, completedSteps, error: "target_ambiguous" };
			if (step.op === "fill") {
				this.values.set(step.target, step.text);
			} else if (this.values.get(step.target) !== step.value) {
				return { status, completedSteps, error: "condition_unsatisfied" };
			}
			completedSteps++;
		}
		return { status: "completed", completedSteps };
	}

	async close(): Promise<void> {
		this.closeCalls++;
		this.closed = true;
		this.ref = undefined;
	}
}
