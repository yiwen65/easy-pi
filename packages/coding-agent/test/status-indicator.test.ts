import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): { ui: TUI; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return { requestRender, ui: { requestRender } as unknown as TUI };
}

function indicatorLine(indicator: WorkingStatusIndicator): string {
	return stripAnsi(indicator.render(80).join("\n"));
}

describe("WorkingStatusIndicator", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		vi.useRealTimers();
	});

	test("appends an elapsed time that switches from seconds to minutes and hours", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const { ui } = createFakeTui();
		const indicator = new WorkingStatusIndicator(ui, "Working...");
		try {
			expect(indicatorLine(indicator)).toContain("Working... 0s");
			vi.advanceTimersByTime(59_000);
			expect(indicatorLine(indicator)).toContain("Working... 59s");
			vi.advanceTimersByTime(6_000);
			expect(indicatorLine(indicator)).toContain("Working... 1m 5s");
			vi.advanceTimersByTime(3_600_000);
			expect(indicatorLine(indicator)).toContain("Working... 1h 1m 5s");
		} finally {
			indicator.dispose();
		}
	});

	test("keeps the elapsed suffix when an extension replaces the working message", () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_000_000);
		const { ui } = createFakeTui();
		const indicator = new WorkingStatusIndicator(ui, "Working...");
		try {
			vi.advanceTimersByTime(12_000);
			indicator.setMessage("Working... (esc to interrupt)");
			expect(indicatorLine(indicator)).toContain("Working... (esc to interrupt) 12s");
			vi.advanceTimersByTime(1_000);
			expect(indicatorLine(indicator)).toContain("Working... (esc to interrupt) 13s");
			indicator.setMessage("");
			expect(indicatorLine(indicator).trim().endsWith("13s")).toBe(true);
		} finally {
			indicator.dispose();
		}
	});

	test("continues counting from the elapsed offset of a recreated indicator", () => {
		vi.useFakeTimers();
		vi.setSystemTime(3_000_000);
		const { ui } = createFakeTui();
		const first = new WorkingStatusIndicator(ui, "Working...");
		vi.advanceTimersByTime(30_000);
		expect(indicatorLine(first)).toContain("Working... 30s");
		first.dispose();

		const resumed = new WorkingStatusIndicator(ui, "Working...", undefined, 30_000);
		try {
			expect(indicatorLine(resumed)).toContain("Working... 30s");
			vi.advanceTimersByTime(2_000);
			expect(indicatorLine(resumed)).toContain("Working... 32s");
		} finally {
			resumed.dispose();
		}
	});

	test("stops updating the elapsed time once disposed", () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000_000);
		const { ui, requestRender } = createFakeTui();
		const indicator = new WorkingStatusIndicator(ui, "Working...");
		vi.advanceTimersByTime(5_000);
		expect(indicatorLine(indicator)).toContain("Working... 5s");

		indicator.dispose();
		requestRender.mockClear();
		vi.advanceTimersByTime(120_000);
		expect(requestRender).not.toHaveBeenCalled();
		expect(indicatorLine(indicator)).toContain("Working... 5s");
	});
});
