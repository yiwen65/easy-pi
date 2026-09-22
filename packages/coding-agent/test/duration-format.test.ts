import { describe, expect, test } from "vitest";
import { formatElapsedDuration, formatWorkedDuration } from "../src/utils/duration.ts";

describe("duration formatting", () => {
	test("formats whole-second elapsed time with automatic units", () => {
		expect(formatElapsedDuration(0)).toBe("0s");
		expect(formatElapsedDuration(1_400)).toBe("1s");
		expect(formatElapsedDuration(59_900)).toBe("59s");
		expect(formatElapsedDuration(60_000)).toBe("1m 0s");
		expect(formatElapsedDuration(754_000)).toBe("12m 34s");
		expect(formatElapsedDuration(3_661_000)).toBe("1h 1m 1s");
	});

	test("never reports negative elapsed time", () => {
		expect(formatElapsedDuration(-5_000)).toBe("0s");
		expect(formatWorkedDuration(-5_000)).toBe("0.0s");
	});

	test("formats worked durations with sub-second precision under ten seconds", () => {
		expect(formatWorkedDuration(800)).toBe("0.8s");
		expect(formatWorkedDuration(9_940)).toBe("9.9s");
		expect(formatWorkedDuration(12_500)).toBe("13s");
		expect(formatWorkedDuration(65_000)).toBe("1m 5s");
		expect(formatWorkedDuration(3_661_000)).toBe("1h 1m 1s");
	});
});
