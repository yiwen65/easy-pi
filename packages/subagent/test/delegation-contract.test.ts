import { describe, expect, test } from "vitest";
import { validateDelegation, validateDelegationResult } from "../src/collaboration-contract.ts";
import { delegation } from "./delegation-fixture.ts";

describe("explicit delegation contract", () => {
	test("requires only the task objective and clones mutable input; optional layers default", () => {
		const input = delegation();
		const parsed = validateDelegation(input);
		input.task.objective = "mutated after";
		expect(parsed.task.objective).toBe("Inspect parser");
		// Optional layers are filled with canonical defaults rather than rejected.
		for (const key of ["version", "context", "capabilities"] as const) {
			const relaxed: Record<string, unknown> = { ...delegation() };
			delete relaxed[key];
			expect(() => validateDelegation(relaxed)).not.toThrow();
		}
		// The objective remains required.
		const noTask: Record<string, unknown> = { ...delegation() };
		delete noTask.task;
		expect(() => validateDelegation(noTask)).toThrow(/Invalid delegation/);
		expect(() => validateDelegation({ message: "Old task" })).toThrow();
	});
	test("independent judgment cannot inherit parent conversation", () => {
		for (const relationship of ["verify", "explore"] as const) {
			const input = delegation({ context: { mode: "fork", turns: "all", prefix: "preserve" } });
			input.task.relationship = relationship;
			expect(() => validateDelegation(input)).toThrow(/Independent/);
			input.context = { mode: "isolated" };
			expect(validateDelegation(input)).toEqual(input);
		}
	});
	test("does not silently promise prefix preservation for a suffix", () => {
		expect(() =>
			validateDelegation(delegation({ context: { mode: "fork", turns: "2", prefix: "preserve" } })),
		).toThrow(/complete effective/);
		expect(
			validateDelegation(delegation({ context: { mode: "fork", turns: "2", prefix: "rebuild" } })).context.mode,
		).toBe("fork");
	});
	test("bounds UTF-8 contract bytes, NUL, capability names and evidence ranges", () => {
		const input = delegation();
		input.task.material = ["界".repeat(2000), "界".repeat(2000)];
		expect(() => validateDelegation(input)).toThrow(/budget/);
		input.task.material = ["a\0b"];
		expect(() => validateDelegation(input)).toThrow(/NUL/);
		expect(() => validateDelegation(delegation({ capabilities: { tools: ["bash", "bash"] } }))).toThrow();
		expect(() =>
			validateDelegation(
				delegation({
					context: {
						mode: "curated",
						references: [{ path: "src/a.ts", sha256: "a".repeat(64), start_line: 5, end_line: 2 }],
					},
				}),
			),
		).toThrow(/range/);
	});
	test("the result contract is summary + outcome; removed sections are rejected", () => {
		const valid = { summary: "Done with findings inline", outcome: "succeeded" };
		expect(validateDelegationResult(JSON.stringify(valid), "completed")).toMatchObject({
			contract: "valid",
		});
		for (const field of ["artifacts", "evidence", "checks", "risks"]) {
			expect(validateDelegationResult(JSON.stringify({ ...valid, [field]: ["observed"] }), "completed")).toEqual({
				contract: "invalid",
			});
		}
		// The byte budget still applies to the complete result text.
		expect(
			validateDelegationResult(JSON.stringify({ ...valid, summary: "界".repeat(4000) }), "completed"),
		).toMatchObject({ contract: "invalid" });
	});
	test("validates output format without certifying claims or discarding text", () => {
		const text = JSON.stringify({
			summary: "Done",
			outcome: "succeeded",
		});
		expect(validateDelegationResult(text, "completed")).toEqual({
			contract: "valid",
			outcome: "succeeded",
		});
		// Markdown fences and prose around the object are tolerated by extractResultJson;
		// see the fence-tolerance cases in collaboration-contract.test.ts.
		for (const output of ["plain output", "{}"])
			expect(validateDelegationResult(output, "completed").contract).toBe("invalid");
		expect(validateDelegationResult(text, "interrupted").contract).toBe("not_completed");
	});
});
