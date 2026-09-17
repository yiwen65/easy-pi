import { describe, expect, it } from "vitest";
import { formatTaskDuration } from "../../src/harness/utils/duration.ts";

describe("formatTaskDuration", () => {
	it("formats seconds, minutes, and hours, rounding and clamping", () => {
		expect(formatTaskDuration(0)).toBe("0s");
		expect(formatTaskDuration(999)).toBe("1s");
		expect(formatTaskDuration(59_400)).toBe("59s");
		expect(formatTaskDuration(60_000)).toBe("1m0s");
		expect(formatTaskDuration(65_000)).toBe("1m5s");
		expect(formatTaskDuration(3_599_000)).toBe("59m59s");
		expect(formatTaskDuration(3_600_000)).toBe("1h0m");
		expect(formatTaskDuration(3_900_000)).toBe("1h5m");
		expect(formatTaskDuration(-5)).toBe("0s");
	});
});
