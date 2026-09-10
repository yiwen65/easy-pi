import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
	EasyPiStartupHeader,
	type EasyPiStartupHeaderOptions,
} from "../src/modes/interactive/components/easy-pi-startup-header.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const telemetry = {
	skills: 15,
	prompts: 5,
	extensions: 9,
};

function createHeader(overrides: Partial<EasyPiStartupHeaderOptions> = {}): EasyPiStartupHeader {
	return new EasyPiStartupHeader({
		getExpandedHints: () => [
			"Ctrl+C to interrupt",
			"Ctrl+D to exit",
			"/ for commands",
			"! to run shell",
			"Ctrl+V to paste an image with a text fallback",
		],
		getTelemetry: () => telemetry,
		...overrides,
	});
}

function plain(lines: string[]): string {
	return stripTerminalSequences(lines.join("\n"));
}

describe("EasyPiStartupHeader", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());

	test("renders a restrained static landing page with a readable wordmark", () => {
		const lines = createHeader().render(120);
		const output = plain(lines);

		expect(output).toContain("easy-pi");
		expect(output).toContain("The deepest truths are often the simplest");
		expect(output).toContain("15 skills  ·  9 extensions  ·  5 prompts");
		expect(output.match(/easy-pi/gu)).toHaveLength(1);
		expect(output).not.toContain("interrupt");
		expect(output).not.toContain("details");
		expect(output).not.toContain("commands");
		expect(output).not.toContain("shell");
		expect(output).not.toContain("v1.2.3");
		expect(output).not.toContain("gpt-5.6-sol");
		expect(output).not.toContain("reasoning");
		expect(output).not.toContain("% context");
		expect(output).not.toMatch(/[█▄▀◆◦◉]/u);
		expect(output).not.toContain("Eπ // CORE");
		expect(lines.filter((line) => stripTerminalSequences(line).trim().length > 0)).toHaveLength(3);
	});

	test("only shows the tagline when it fits in full", () => {
		expect(plain(createHeader().render(40))).not.toContain("The deepest truths");
		expect(plain(createHeader().render(41))).toContain("The deepest truths are often the simplest");
	});

	test("wraps resources without duplicating runtime telemetry", () => {
		const output = plain(createHeader().render(44));
		expect(output).toContain("15 skills");
		expect(output).toContain("9 extensions");
		expect(output.match(/easy-pi/gu)).toHaveLength(1);
		expect(output).not.toContain("gpt-5.6-sol");
		expect(output).not.toContain("high reasoning");
		expect(output).not.toContain("12.5% context");
		expect(output).not.toContain("[ MODEL");
		expect(output).not.toContain("LOADOUT");
	});

	test("expands into a quick-key guide and resource-details handoff", () => {
		const header = createHeader({ expanded: true });
		const output = plain(header.render(100));
		expect(output).toContain("shortcuts");
		expect(output).toContain("Ctrl+C to interrupt");
		expect(output).toContain("! to run shell");
		expect(output).toContain("resources");
	});

	test("stays within narrow and wide terminal widths", () => {
		for (const expanded of [false, true]) {
			const header = createHeader({ expanded });
			for (const width of [1, 2, 8, 15, 16, 24, 31, 32, 40, 51, 52, 64, 80, 100, 120, 160]) {
				for (const line of header.render(width)) {
					expect(visibleWidth(line), `${stripTerminalSequences(line)} at ${width} columns`).toBeLessThanOrEqual(
						width,
					);
				}
			}
		}
	});

	test("omits version metadata at every width", () => {
		const header = createHeader();
		for (const width of [16, 24, 40, 120]) {
			expect(plain(header.render(width))).not.toMatch(/\beasy-pi v|interrupt|commands|shell|details/u);
		}
	});

	test("never schedules animation or changes over time", () => {
		vi.useFakeTimers();
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const header = createHeader();
		const initialFrame = plain(header.render(120));

		vi.advanceTimersByTime(10_000);
		expect(plain(header.render(120))).toBe(initialFrame);
		expect(intervalSpy).not.toHaveBeenCalled();
		expect(timeoutSpy).not.toHaveBeenCalled();
		intervalSpy.mockRestore();
		timeoutSpy.mockRestore();
	});
});
