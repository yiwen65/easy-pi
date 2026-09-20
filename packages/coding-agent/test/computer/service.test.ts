import { Buffer } from "node:buffer";
import { AgentToolError } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
	COMPUTER_MAX_INPUT_BYTES,
	COMPUTER_MAX_OBSERVATION_BYTES,
	type ComputerBackend,
	type ComputerExecutionResult,
	type ComputerInput,
	ComputerInputSchema,
	parseComputerInput,
} from "../../src/core/computer/contracts.ts";
import { ComputerService } from "../../src/core/computer/service.ts";
import { createComputerTool } from "../../src/core/computer/tool.ts";
import { FakeComputerBackend } from "./fake-backend.ts";

const observe: ComputerInput = { request: { op: "observe" } };
const fill: ComputerInput = {
	request: { op: "execute", ref: "snapshot-1", steps: [{ op: "fill", target: "field-1", text: "Ada" }] },
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function fixture() {
	const backend = new FakeComputerBackend();
	const factory = vi.fn(() => backend);
	const service = new ComputerService({ desktopId: "fixture", backendFactory: factory });
	return { backend, factory, service, tool: createComputerTool(service) };
}

describe("Computer P01 host protocol", () => {
	it("accepts only the bounded request/step variants and rejects unknown properties", async () => {
		const { service, factory, tool } = fixture();
		expect(Value.Check(ComputerInputSchema, observe)).toBe(true);
		expect(Value.Check(ComputerInputSchema, fill)).toBe(true);
		const invalid: unknown[] = [
			null,
			{},
			{ request: { op: "click" } },
			{ request: { op: "observe", target: "field-1" } },
			{ ...observe, desktopId: "untrusted" },
			{ request: { op: "execute", ref: "snapshot-1", steps: [], timeout: 1 } },
			{ request: { op: "execute", ref: "snapshot-1", steps: [] } },
			{ request: { op: "execute", ref: "", steps: [{ op: "fill", target: "field-1", text: "x" }] } },
			{ request: { op: "execute", ref: "snapshot-1", steps: [{ op: "click", target: "field-1" }] } },
			{
				request: {
					op: "execute",
					ref: "snapshot-1",
					steps: [{ op: "fill", target: "field-1", text: "INPUT-SECRET", retries: 2 }],
				},
			},
			{ request: { op: "execute", ref: "snapshot-1", steps: [{ op: "fill", target: "field-1", text: 42 }] } },
			{ request: { op: "execute", ref: "snapshot-1", steps: [{ op: "assert_value", target: "field-1" }] } },
		];
		for (const input of invalid) {
			expect(Value.Check(ComputerInputSchema, input)).toBe(false);
			expect(() => tool.prepareArguments?.(input)).toThrow("Invalid computer request");
			expect(await service.run(input)).toEqual({ status: "failed", completedSteps: 0, error: "invalid_request" });
		}
		expect(factory).not.toHaveBeenCalled();
	});

	it("enforces eight steps and aggregate 16 KiB UTF-8 across fill and assertions", () => {
		const steps = Array.from({ length: 8 }, (_, index) =>
			index % 2 === 0
				? { op: "fill", target: "field-1", text: "é".repeat(1024) }
				: { op: "assert_value", target: "field-1", value: "é".repeat(1024) },
		);
		const input = { request: { op: "execute", ref: "snapshot-1", steps } };
		expect(parseComputerInput(input)).toEqual(input);
		expect(() => parseComputerInput({ request: { ...input.request, steps: [...steps, steps[0]] } })).toThrow();
		steps[0].text += "é";
		expect(Value.Check(ComputerInputSchema, input)).toBe(true);
		expect(() => parseComputerInput(input)).toThrow("Computer request text exceeds 16 KiB");
		expect(() =>
			parseComputerInput({
				request: {
					op: "execute",
					ref: "snapshot-1",
					steps: [{ op: "fill", target: "field-1", text: "x".repeat(COMPUTER_MAX_INPUT_BYTES + 1) }],
				},
			}),
		).toThrow("Invalid computer request");
	});

	it("declares an external non-idempotent exclusive host resource without initializing the backend", () => {
		const { tool, factory } = fixture();
		expect(factory).not.toHaveBeenCalled();
		expect(tool.contract).toEqual({
			sideEffects: "external",
			readOnly: false,
			idempotent: false,
			reversible: false,
			approval: "never",
		});
		expect(tool.contract).not.toHaveProperty("timeoutMs");
		expect(tool.contract).not.toHaveProperty("retry");
		expect(tool.executionResource).toEqual({ key: "desktop:fixture", mode: "exclusive" });
		expect(tool.executionMode).toBeUndefined();
	});

	it("observes then fills and asserts deterministic fields without copying input into details", async () => {
		const { tool, backend, factory } = fixture();
		const observation = await tool.execute("observe", observe);
		expect(observation.details).toEqual({
			status: "completed",
			completedSteps: 0,
			observationRef: "snapshot-1",
			observationTruncated: false,
		});
		expect(observation.content).toEqual([
			{ type: "text", text: expect.stringContaining("Name [field-1], Note [field-2]") },
		]);
		const result = await tool.execute("execute", {
			request: {
				op: "execute",
				ref: "snapshot-1",
				steps: [
					{ op: "fill", target: "field-1", text: "INPUT-SECRET" },
					{ op: "assert_value", target: "field-1", value: "INPUT-SECRET" },
				],
			},
		});
		expect(result.details).toEqual({ status: "completed", completedSteps: 2 });
		expect(JSON.stringify(result)).not.toContain("INPUT-SECRET");
		expect(backend.values.get("field-1")).toBe("INPUT-SECRET");
		expect(factory).toHaveBeenCalledTimes(1);
		expect(backend.executeCalls).toBe(1);
	});

	it("rejects stale refs and never reinterprets an unknown opaque target", async () => {
		const { service, backend } = fixture();
		await service.run(observe);
		await service.run(observe);
		expect(await service.run(fill)).toEqual({
			status: "failed",
			completedSteps: 0,
			firstUncompletedStep: 0,
			error: "stale_observation",
		});
		expect(
			await service.run({
				request: { op: "execute", ref: "snapshot-2", steps: [{ op: "fill", target: "Name", text: "x" }] },
			}),
		).toMatchObject({ status: "failed", completedSteps: 0, error: "target_ambiguous" });
		expect(backend.values.get("field-1")).toBe("");
	});

	it("returns a failed assertion as an error with the exact completed prefix and does not run later steps", async () => {
		const { tool, backend } = fixture();
		await tool.execute("observe", observe);
		const execution = tool.execute("execute", {
			request: {
				op: "execute",
				ref: "snapshot-1",
				steps: [
					{ op: "fill", target: "field-1", text: "INPUT-SECRET" },
					{ op: "assert_value", target: "field-1", value: "WRONG-SECRET" },
					{ op: "fill", target: "field-2", text: "must not run" },
				],
			},
		});
		await expect(execution).rejects.toBeInstanceOf(AgentToolError);
		await expect(execution).rejects.toMatchObject({
			details: { status: "partial", completedSteps: 1, firstUncompletedStep: 1, error: "condition_unsatisfied" },
			message: expect.not.stringContaining("SECRET"),
		});
		expect(backend.values.get("field-1")).toBe("INPUT-SECRET");
		expect(backend.values.get("field-2")).toBe("");
		await expect(tool.execute("replay", fill)).rejects.toMatchObject({ details: { error: "stale_observation" } });
		expect(backend.values.get("field-1")).toBe("INPUT-SECRET");
	});

	it("reports unexpected execute failures as unknown, never success or an automatic replay", async () => {
		const { tool, backend } = fixture();
		const execute = vi.spyOn(backend, "execute").mockImplementation(async () => {
			backend.values.set("field-1", "effect happened");
			throw new Error("RAW-BACKEND-SECRET");
		});
		await expect(tool.execute("execute", fill)).rejects.toMatchObject({
			details: { status: "outcome_unknown", completedSteps: 0, firstUncompletedStep: 0, error: "outcome_unknown" },
			message: expect.not.stringContaining("RAW-BACKEND-SECRET"),
		});
		expect(execute).toHaveBeenCalledTimes(1);
		expect(backend.values.get("field-1")).toBe("effect happened");
	});

	it("preserves a confirmed prefix when the backend reports an unknown later effect", async () => {
		const { service, backend } = fixture();
		const execute = vi.spyOn(backend, "execute").mockResolvedValue({
			status: "outcome_unknown",
			completedSteps: 1,
			error: "outcome_unknown",
		});
		expect(
			await service.run({
				request: {
					op: "execute",
					ref: "snapshot-1",
					steps: [
						{ op: "fill", target: "field-1", text: "first" },
						{ op: "fill", target: "field-2", text: "second" },
					],
				},
			}),
		).toEqual({ status: "outcome_unknown", completedSteps: 1, firstUncompletedStep: 1, error: "outcome_unknown" });
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("does not promote inconsistent backend completion to success", async () => {
		const { service, backend } = fixture();
		const execute = vi.spyOn(backend, "execute");
		const invalid: ComputerExecutionResult[] = [
			{ status: "completed", completedSteps: 0 },
			{ status: "completed", completedSteps: 1, error: "condition_unknown" },
			{ status: "partial", completedSteps: 0, error: "condition_unsatisfied" },
			{ status: "failed", completedSteps: 1, error: "native_fault" },
			{ status: "outcome_unknown", completedSteps: 0, error: "condition_unsatisfied" },
		];
		for (const result of invalid) {
			execute.mockResolvedValueOnce(result);
			expect(await service.run(fill)).toMatchObject({ status: "outcome_unknown", error: "outcome_unknown" });
		}
	});

	it("caps observation text at 4 KiB without splitting UTF-8, and excludes it from diagnostics", async () => {
		const { service, tool, backend } = fixture();
		vi.spyOn(backend, "observe").mockResolvedValue({
			ref: "snapshot-1",
			text: `${"a".repeat(COMPUTER_MAX_OBSERVATION_BYTES - 1)}🙂tail`,
		});
		const observed = await service.run(observe);
		expect(observed.observation?.truncated).toBe(true);
		expect(observed.observation?.text).toBe("a".repeat(COMPUTER_MAX_OBSERVATION_BYTES - 1));
		expect(Buffer.byteLength(observed.observation?.text ?? "", "utf8")).toBeLessThanOrEqual(4096);
		vi.spyOn(backend, "observe").mockResolvedValue({ ref: "snapshot-2", text: "OBSERVATION-SECRET" });
		const result = await tool.execute("observe", observe);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("OBSERVATION-SECRET") }]);
		expect(JSON.stringify(result.details)).not.toContain("OBSERVATION-SECRET");
	});
});

describe("Computer lazy lifecycle", () => {
	it("reports native_unavailable with no host backend and never installs or loads one", async () => {
		const service = new ComputerService();
		await expect(createComputerTool(service).execute("observe", observe)).rejects.toMatchObject({
			details: { status: "failed", completedSteps: 0, error: "native_unavailable" },
		});
		await service.close();
	});

	it("caches initialization failure without retries or raw exception diagnostics", async () => {
		const factory = vi.fn(() => {
			throw new Error("INITIALIZATION-SECRET");
		});
		const service = new ComputerService({ backendFactory: factory });
		for (let index = 0; index < 2; index++) {
			expect(await service.run(observe)).toEqual({
				status: "failed",
				completedSteps: 0,
				error: "native_unavailable",
			});
		}
		expect(factory).toHaveBeenCalledTimes(1);
		await service.close();
	});

	it("sanitizes observation and close failures without hiding close rejection", async () => {
		const { service, backend, tool } = fixture();
		vi.spyOn(backend, "observe").mockRejectedValue(new Error("OBSERVATION-FAILURE-SECRET"));
		await expect(tool.execute("observe", observe)).rejects.toMatchObject({
			message: expect.not.stringContaining("SECRET"),
			details: { status: "failed", completedSteps: 0, error: "native_fault" },
		});
		const close = vi.spyOn(backend, "close").mockRejectedValue(new Error("CLOSE-FAILURE-SECRET"));
		await expect(service.close()).rejects.toThrow("Computer backend close failed");
		await expect(service.close()).rejects.toThrow("Computer backend close failed");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("rejects pre-aborted work without initializing or dispatching", async () => {
		const { service, factory } = fixture();
		const controller = new AbortController();
		controller.abort();
		expect(await service.run(fill, controller.signal)).toEqual({
			status: "cancelled",
			completedSteps: 0,
			error: "cancelled_before_dispatch",
		});
		expect(factory).not.toHaveBeenCalled();
	});

	it("does not dispatch after abort during lazy initialization", async () => {
		const opening = deferred<ComputerBackend>();
		const backend = new FakeComputerBackend();
		const service = new ComputerService({ backendFactory: () => opening.promise });
		const controller = new AbortController();
		const operation = service.run(fill, controller.signal);
		controller.abort();
		opening.resolve(backend);
		expect(await operation).toMatchObject({ status: "cancelled", error: "cancelled_before_dispatch" });
		expect(backend.executeCalls).toBe(0);
		await service.close();
		expect(backend.closeCalls).toBe(1);
	});

	it("closes once and rejects later calls without initializing an unused backend", async () => {
		const unused = fixture();
		await unused.service.close();
		await unused.service.close();
		expect(await unused.service.run(observe)).toMatchObject({ error: "session_closed" });
		expect(unused.factory).not.toHaveBeenCalled();
		const active = fixture();
		await active.service.run(observe);
		await active.service.close();
		await active.service.close();
		expect(await active.service.run(fill)).toMatchObject({ error: "session_closed" });
		expect(active.backend.closeCalls).toBe(1);
		expect(active.backend.executeCalls).toBe(0);
	});

	it("awaits backend terminal settlement on abort and close, retaining confirmed completion", async () => {
		const { service, backend } = fixture();
		const entered = deferred<void>();
		const terminal = deferred<ComputerExecutionResult>();
		vi.spyOn(backend, "execute").mockImplementation(async (_request, signal) => {
			expect(signal).toBe(controller.signal);
			entered.resolve();
			return terminal.promise;
		});
		const controller = new AbortController();
		let settled = false;
		const operation = service.run(fill, controller.signal).then((result) => {
			settled = true;
			return result;
		});
		await entered.promise;
		controller.abort();
		const closing = service.close();
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(backend.closeCalls).toBe(0);
		terminal.resolve({ status: "completed", completedSteps: 1 });
		expect(await operation).toEqual({ status: "completed", completedSteps: 1 });
		await closing;
		expect(backend.closeCalls).toBe(1);
	});
});
