import { describe, expect, test } from "vitest";
import { validateDelegation, validateDelegationResult } from "../src/collaboration-contract.ts";
import { delegation } from "./delegation-fixture.ts";

describe("explicit delegation contract", () => {
	test("requires all task boundaries and clones mutable input", () => {
		const input = delegation();
		const parsed = validateDelegation(input);
		input.task.material.push("later");
		expect(parsed.task.material).toEqual([]);
		for (const key of ["version", "task", "context", "capabilities"] as const) {
			const invalid: Record<string, unknown> = { ...delegation() };
			delete invalid[key];
			expect(() => validateDelegation(invalid)).toThrow(/Invalid delegation/);
		}
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
	test.each(["artifacts", "evidence", "checks", "risks"])(
		"keeps %s as bounded nonblank string citations, not structured objects",
		(field) => {
			const result = { summary: "Done", outcome: "succeeded", artifacts: [], evidence: [], checks: [], risks: [] };
			const verdict = (items: unknown[]) =>
				validateDelegationResult(JSON.stringify({ ...result, [field]: items }), "completed");
			expect(verdict(["evidence.txt:1 sha256=verified; 8+9=17"])).toMatchObject({
				contract: "valid",
				acceptance: "not_reviewed",
			});
			for (const value of [
				{ path: "evidence.txt", sha256: "a".repeat(64), observation: "8+9=17" },
				17,
				null,
				[],
				"",
				"   ",
			])
				expect(verdict([value])).toEqual({ contract: "invalid", acceptance: "not_reviewed" });
			expect(verdict(Array(16).fill("observed"))).toMatchObject({ contract: "valid" });
			expect(verdict(Array(17).fill("observed"))).toMatchObject({ contract: "invalid" });
			expect(verdict(["a".repeat(2048)])).toMatchObject({ contract: "valid" });
			expect(verdict(["a".repeat(2049)])).toMatchObject({ contract: "invalid" });
			// Each string fits its schema bound, but the final UTF-8 JSON exceeds the turn-result budget.
			expect(verdict(["界".repeat(2000), "界".repeat(2000)])).toMatchObject({ contract: "invalid" });
		},
	);
	test("validates output format without certifying claims or discarding text", () => {
		const text = JSON.stringify({
			summary: "Done",
			outcome: "succeeded",
			artifacts: [],
			evidence: [],
			checks: [],
			risks: [],
		});
		expect(validateDelegationResult(text, "completed")).toEqual({
			contract: "valid",
			outcome: "succeeded",
			acceptance: "not_reviewed",
		});
		// Markdown fences and prose around the object are tolerated by extractResultJson;
		// see the fence-tolerance cases in collaboration-contract.test.ts.
		for (const output of ["plain output", "{}"])
			expect(validateDelegationResult(output, "completed").contract).toBe("invalid");
		expect(validateDelegationResult(text, "interrupted").contract).toBe("not_completed");
	});
});
