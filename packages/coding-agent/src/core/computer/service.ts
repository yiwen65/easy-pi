import { Buffer } from "node:buffer";
import { Value } from "typebox/value";
import {
	COMPUTER_MAX_OBSERVATION_BYTES,
	type ComputerBackend,
	type ComputerBackendFactory,
	type ComputerErrorCode,
	ComputerExecutionResultSchema,
	type ComputerInput,
	type ComputerObservation,
	type ComputerResult,
	parseComputerInput,
} from "./contracts.ts";

export interface ComputerServiceOptions {
	/** Trusted host identity: services controlling the same desktop must use the same id and scheduler. */
	desktopId?: string;
	/** No default native loader. Merely constructing the service or tool does not call this factory. */
	backendFactory?: ComputerBackendFactory;
}

function failure(error: ComputerErrorCode): ComputerResult {
	return {
		status: error === "cancelled_before_dispatch" || error === "cancelled" ? "cancelled" : "failed",
		completedSteps: 0,
		error,
	};
}

function boundObservation(observation: ComputerObservation): ComputerObservation {
	if (
		typeof observation.ref !== "string" ||
		observation.ref.length === 0 ||
		observation.ref.length > 128 ||
		typeof observation.text !== "string"
	) {
		throw new Error("Invalid computer observation");
	}
	const bytes = Buffer.from(observation.text, "utf8");
	let end = Math.min(bytes.length, COMPUTER_MAX_OBSERVATION_BYTES);
	// Never split a UTF-8 code point. The truncation marker is metadata, not added text.
	if (end < bytes.length) {
		while ((bytes[end] & 0xc0) === 0x80) end--;
	}
	return {
		ref: observation.ref,
		text: bytes.subarray(0, end).toString("utf8"),
		truncated: observation.truncated === true || end < bytes.length,
	};
}

/** Minimal lazy host capability. Scheduling/ownership belongs to the existing host, not this service. */
export class ComputerService {
	readonly desktopId: string;
	private readonly backendFactory: ComputerBackendFactory | undefined;
	private backendPromise: Promise<ComputerBackend | undefined> | undefined;
	private readonly pending = new Set<Promise<ComputerResult>>();
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(options: ComputerServiceOptions = {}) {
		this.desktopId = options.desktopId ?? "local";
		if (!this.desktopId || this.desktopId.length > 128) throw new Error("Invalid computer desktop identity");
		this.backendFactory = options.backendFactory;
	}

	run(input: unknown, signal?: AbortSignal): Promise<ComputerResult> {
		if (this.closed) return Promise.resolve(failure("session_closed"));
		const operation = this.perform(input, signal);
		this.pending.add(operation);
		void operation.then(
			() => this.pending.delete(operation),
			() => this.pending.delete(operation),
		);
		return operation;
	}

	/** Reject new work, await admitted operations, then close once. Does not initialize an unused backend. */
	close(): Promise<void> {
		if (!this.closePromise) {
			this.closed = true;
			this.closePromise = (async () => {
				await Promise.allSettled([...this.pending]);
				const backend = await this.backendPromise;
				try {
					await backend?.close();
				} catch {
					throw new Error("Computer backend close failed");
				}
			})();
		}
		return this.closePromise;
	}

	private async perform(input: unknown, signal?: AbortSignal): Promise<ComputerResult> {
		if (signal?.aborted) return failure("cancelled_before_dispatch");
		let validated: ComputerInput;
		try {
			validated = parseComputerInput(input);
		} catch {
			return failure("invalid_request");
		}
		const factory = this.backendFactory;
		this.backendPromise ??= factory
			? Promise.resolve()
					.then(factory)
					.catch(() => undefined)
			: Promise.resolve(undefined);
		const backend = await this.backendPromise;
		if (this.closed) return failure("session_closed");
		if (signal?.aborted) return failure("cancelled_before_dispatch");
		if (!backend) return failure("native_unavailable");

		const request = validated.request;
		if (request.op === "observe") {
			try {
				const observation = await backend.observe(signal);
				if (signal?.aborted) return failure("cancelled");
				return { status: "completed", completedSteps: 0, observation: boundObservation(observation) };
			} catch {
				return failure(signal?.aborted ? "cancelled" : "native_fault");
			}
		}

		const unknown: ComputerResult = {
			status: "outcome_unknown",
			completedSteps: 0,
			firstUncompletedStep: 0,
			error: "outcome_unknown",
		};
		try {
			// Await terminal settlement even after abort. A rejected promise cannot prove no effect occurred.
			const result = await backend.execute(request, signal);
			if (!Value.Check(ComputerExecutionResultSchema, result)) return unknown;
			const { status, completedSteps, error } = result;
			if (completedSteps > request.steps.length) return unknown;
			if (status === "completed") {
				if (completedSteps !== request.steps.length || error !== undefined) return unknown;
				return { status, completedSteps };
			}
			if (completedSteps === request.steps.length || error === undefined) return unknown;
			if (status === "partial" && completedSteps === 0) return unknown;
			if (status === "failed" && completedSteps !== 0) return unknown;
			if ((status === "outcome_unknown") !== (error === "outcome_unknown")) return unknown;
			if ((status === "cancelled") !== (error === "cancelled" || error === "cancelled_before_dispatch"))
				return unknown;
			if (error === "cancelled_before_dispatch" && completedSteps !== 0) return unknown;
			return { status, completedSteps, firstUncompletedStep: completedSteps, error };
		} catch {
			return unknown;
		}
	}
}
