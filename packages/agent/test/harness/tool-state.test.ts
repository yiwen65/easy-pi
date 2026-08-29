import { describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { resolveToolState, ToolStateLedger } from "../../src/harness/tools/tool-state.ts";
import { createTempDir } from "./session-test-utils.ts";

function locator(scopeId: string, path: string) {
	return {
		scopeId,
		snapshotId: "snapshot-1",
		path,
		kind: "text" as const,
		startLine: 4,
		endLine: 4,
		startColumn: 2,
		endColumn: 8,
		match: "target",
	};
}

describe("v2 tool state", () => {
	it("binds opaque locators and views to scope", () => {
		const ledger = new ToolStateLedger();
		const storedLocator = ledger.addLocator(locator("scope-a", "/repo/a.ts"));
		expect(storedLocator.id).toMatch(/^loc_/);
		expect(ledger.getLocator(storedLocator.id, "scope-a")).toEqual(storedLocator);
		expect(ledger.getLocator(storedLocator.id, "scope-b")).toBeUndefined();

		const storedView = ledger.addView({
			scopeId: "scope-a",
			snapshotId: storedLocator.snapshotId,
			locatorId: storedLocator.id,
			path: storedLocator.path,
			range: [2, 6],
			lines: ["two", "three", "four", "five", "six"],
			fileVersion: { identity: "1", size: 30, mtimeMs: 10 },
			fileHash: "sha256:test",
			editable: true,
		});
		expect(storedView.id).toMatch(/^view_/);
		expect(ledger.getView(storedView.id, "scope-a")).toEqual(storedView);
		expect(ledger.getView(storedView.id, "scope-b")).toBeUndefined();

		const patch = ledger.addPatch({
			scopeId: "scope-a",
			plan: {
				observations: [],
				operations: [{ kind: "create", path: "/repo/new.ts", content: "new" }],
				limits: { maxOperations: 1, maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 10 },
			},
			data: { status: "prepared" },
		});
		expect(patch.id).toMatch(/^patch_/);
		expect(ledger.takePatch(patch.id, "scope-b")).toBeUndefined();
		expect(ledger.takePatch(patch.id, "scope-a")).toEqual(patch);
		expect(ledger.takePatch(patch.id, "scope-a")).toBeUndefined();
	});

	it("expires and bounds records", () => {
		vi.useFakeTimers();
		try {
			const ledger = new ToolStateLedger({ ttlMs: 10, maxLocators: 2, maxViews: 1 });
			const first = ledger.addLocator(locator("scope", "/repo/first.ts"));
			ledger.addLocator(locator("scope", "/repo/second.ts"));
			const third = ledger.addLocator(locator("scope", "/repo/third.ts"));
			expect(ledger.getLocator(first.id, "scope")).toBeUndefined();
			expect(ledger.getLocator(third.id, "scope")).toBeDefined();
			vi.advanceTimersByTime(11);
			expect(ledger.getLocator(third.id, "scope")).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("shares fallback state per execution environment", () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const first = resolveToolState({ env });
		const second = resolveToolState({ env });
		expect(second).toBe(first);
		expect(resolveToolState({ env, toolState: new ToolStateLedger() })).not.toBe(first);
	});
});
