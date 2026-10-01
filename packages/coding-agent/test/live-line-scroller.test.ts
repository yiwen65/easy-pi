import { afterEach, describe, expect, test, vi } from "vitest";
import { LiveLineScroller } from "../src/modes/interactive/components/live-line-scroller.ts";

const COMMAND = 'rg -n "live-line-scroller" packages/coding-agent/src | head -20';
const WIDTH = 20;

function createScroller(): { scroller: LiveLineScroller; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return { requestRender, scroller: new LiveLineScroller({ requestRender }) };
}

function createScrollerForTail(): { scroller: LiveLineScroller; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return { requestRender, scroller: new LiveLineScroller({ requestRender }, "tail") };
}

/** Tick the scroll forward until `needle` enters the window; returns whether it ever did. */
function advanceUntilVisible(scroller: LiveLineScroller, needle: string, ticks = 80): boolean {
	for (let tick = 0; tick < ticks; tick++) {
		vi.advanceTimersByTime(120);
		if (scroller.window(WIDTH).includes(needle)) return true;
	}
	return false;
}

describe("LiveLineScroller", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("shows the head while the text keeps changing", () => {
		vi.useFakeTimers();
		const { scroller, requestRender } = createScroller();
		try {
			scroller.setText(COMMAND);
			expect(scroller.window(WIDTH)).toBe(COMMAND.slice(0, WIDTH));
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			scroller.dispose();
		}
	});

	test("scrolls the truncated part into view once the row went idle and cycles it", () => {
		vi.useFakeTimers();
		const { scroller, requestRender } = createScroller();
		try {
			scroller.setText(COMMAND);
			expect(scroller.window(WIDTH)).toBe(COMMAND.slice(0, WIDTH));

			// The idle delay only arms the scroll; the first column moves on the next tick.
			vi.advanceTimersByTime(1_000);
			expect(requestRender).not.toHaveBeenCalled();
			expect(advanceUntilVisible(scroller, "head -20")).toBe(true);
			expect(requestRender).toHaveBeenCalled();

			// The cycle wraps: the head comes back around after the hidden tail.
			expect(advanceUntilVisible(scroller, 'rg -n "live')).toBe(true);
		} finally {
			scroller.dispose();
		}
	});

	test("returns to the head when new text arrives", () => {
		vi.useFakeTimers();
		const { scroller } = createScroller();
		try {
			scroller.setText(COMMAND);
			vi.advanceTimersByTime(1_000);
			expect(advanceUntilVisible(scroller, "head -20")).toBe(true);

			scroller.setText("npm run check");
			expect(scroller.window(WIDTH)).toBe("npm run check");
		} finally {
			scroller.dispose();
		}
	});

	test("does not scroll text that fits the row", () => {
		vi.useFakeTimers();
		const { scroller, requestRender } = createScroller();
		try {
			scroller.setText("npm run check");
			expect(scroller.window(WIDTH)).toBe("npm run check");
			vi.advanceTimersByTime(1_000 + 120 * 100);
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			scroller.dispose();
		}
	});

	test("never scrolls without a renderer", () => {
		vi.useFakeTimers();
		const scroller = new LiveLineScroller();
		try {
			scroller.setText(COMMAND);
			vi.advanceTimersByTime(1_000 + 120 * 60);
			expect(scroller.window(WIDTH)).toBe(COMMAND.slice(0, WIDTH));
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			scroller.dispose();
		}
	});

	test("tail-anchored rows show the newest text while it keeps changing", () => {
		vi.useFakeTimers();
		const scroller = new LiveLineScroller({ requestRender: vi.fn() }, "tail");
		try {
			scroller.setText(COMMAND);
			expect(scroller.window(WIDTH)).toBe(COMMAND.slice(-WIDTH));
			expect(scroller.window(WIDTH)).not.toContain("rg -n");

			// Streaming text keeps the newest part in view instead of the head.
			scroller.setText(`${COMMAND} && echo done`);
			expect(scroller.window(WIDTH)).toBe(`${COMMAND} && echo done`.slice(-WIDTH));
		} finally {
			scroller.dispose();
		}
	});

	test("tail-anchored rows hold their place when going idle, then cycle the hidden head in", () => {
		vi.useFakeTimers();
		const { scroller, requestRender } = createScrollerForTail();
		try {
			scroller.setText(COMMAND);
			const tail = scroller.window(WIDTH);

			vi.advanceTimersByTime(1_000);
			expect(scroller.window(WIDTH)).toBe(tail);
			expect(advanceUntilVisible(scroller, 'rg -n "live')).toBe(true);
			expect(requestRender).toHaveBeenCalled();
		} finally {
			scroller.dispose();
		}
	});

	test.each(["head", "tail"] as const)("completed %s rows never restart scrolling", (anchor) => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const scroller = new LiveLineScroller({ requestRender }, anchor);
		try {
			scroller.setText(COMMAND);
			scroller.window(WIDTH);
			vi.advanceTimersByTime(2_000);
			expect(requestRender).toHaveBeenCalled();
			scroller.completeTurn();
			requestRender.mockClear();
			const settled = scroller.window(WIDTH);
			vi.advanceTimersByTime(10_000);
			expect(scroller.window(WIDTH)).toBe(settled);
			expect(requestRender).not.toHaveBeenCalled();
			// Later text changes and resize must not rearm a completed turn.
			scroller.setText(`${COMMAND} && echo updated`);
			const updated = scroller.window(WIDTH - 5);
			vi.advanceTimersByTime(10_000);
			expect(scroller.window(WIDTH - 5)).toBe(updated);
			expect(requestRender).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			scroller.dispose();
		}
	});

	test("completion cancels a pending idle delay", () => {
		vi.useFakeTimers();
		const { scroller, requestRender } = createScroller();
		try {
			scroller.setText(COMMAND);
			scroller.window(WIDTH);
			scroller.completeTurn();
			vi.advanceTimersByTime(10_000);
			expect(requestRender).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			scroller.dispose();
		}
	});

	test("stops repainting after dispose", () => {
		vi.useFakeTimers();
		const { scroller, requestRender } = createScroller();
		scroller.setText(COMMAND);
		vi.advanceTimersByTime(1_000 + 120 * 10);
		expect(requestRender).toHaveBeenCalled();

		scroller.dispose();
		requestRender.mockClear();
		vi.advanceTimersByTime(120 * 100);
		expect(requestRender).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
