/**
 * Verify the documentation example from extensions.md compiles and works.
 */

import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionCompactEvent } from "../src/core/extensions/index.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	convertToLlm: (messages: unknown) => messages,
	serializeConversation: () => "conversation",
}));

const { default: compactionControlExtension } = await import("../examples/extensions/compaction-control.ts");

describe("Documentation example", () => {
	it("compaction control example should type-check correctly", () => {
		// This is the contract documented in extensions.md - verify the supported fields compile.
		const exampleExtension = (pi: ExtensionAPI) => {
			pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
				// All these should be accessible on the event
				const { preparation, branchEntries, reason, willRetry, signal } = event;
				const { messagesToSummarize, turnPrefixMessages, tokensBefore, isSplitTurn } = preparation;

				// Verify types
				expect(Array.isArray(messagesToSummarize)).toBe(true);
				expect(Array.isArray(turnPrefixMessages)).toBe(true);
				expect(typeof isSplitTurn).toBe("boolean");
				expect(typeof tokensBefore).toBe("number");
				expect(Array.isArray(branchEntries)).toBe(true);
				expect(typeof reason).toBe("string");
				expect(typeof willRetry).toBe("boolean");
				expect(signal).toBeInstanceOf(AbortSignal);
				expect(typeof ctx.ui.notify).toBe("function");

				// Cancellation is the only supported control; summary text is deprecated.
				if (tokensBefore < 1_000) return { cancel: true };
				return undefined;
			});

			pi.on("session_compact", async (event: SessionCompactEvent) => {
				expect(event.compactionEntry.type).toBe("compaction");
				expect(typeof event.compactionEntry.tokensBefore).toBe("number");
			});
		};

		// Just verify the function exists and is callable
		expect(typeof exampleExtension).toBe("function");
	});

	it("compaction control example cancels small compactions and reports checkpoints", async () => {
		const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
		compactionControlExtension({
			on(event: string, fn: (event: any, ctx: any) => Promise<any>) {
				handlers.set(event, fn);
			},
		} as unknown as ExtensionAPI);

		const notify = vi.fn();
		const ctx = { ui: { notify } };
		const smallEvent = {
			preparation: { tokensBefore: 42 },
			reason: "manual",
			branchEntries: [],
		};

		const cancelled = await handlers.get("session_before_compact")!(smallEvent, ctx);
		expect(cancelled).toEqual({ cancel: true });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Skipping manual compaction"), "info");

		// At or above the threshold the subsystem compacts normally.
		notify.mockClear();
		const allowed = await handlers.get("session_before_compact")!(
			{ ...smallEvent, preparation: { tokensBefore: 50_000 } },
			ctx,
		);
		expect(allowed).toBeUndefined();
		expect(notify).not.toHaveBeenCalled();

		// The persisted checkpoint is reported.
		const saved = await handlers.get("session_compact")!(
			{ compactionEntry: { id: "entry-9", type: "compaction", tokensBefore: 50_000 }, reason: "threshold" },
			ctx,
		);
		expect(saved).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Compaction checkpoint entry-9 saved"), "info");
	});

	it("compact event should have correct fields", () => {
		const checkCompactEvent = (pi: ExtensionAPI) => {
			pi.on("session_compact", async (event: SessionCompactEvent) => {
				// These should all be accessible
				const entry = event.compactionEntry;
				const fromExtension = event.fromExtension;

				expect(entry.type).toBe("compaction");
				expect(typeof entry.tokensBefore).toBe("number");
				// Modern checkpoints carry replacementHistory; only legacy checkpoints carry summary text.
				expect(Array.isArray(entry.replacementHistory) || typeof entry.summary === "string").toBe(true);
				expect(typeof fromExtension).toBe("boolean");
			});
		};

		expect(typeof checkCompactEvent).toBe("function");
	});
});
