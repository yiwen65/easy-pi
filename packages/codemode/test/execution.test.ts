import { describe, expect, it } from "vitest";
import { CodemodeSandboxBase, type VmLauncher } from "../src/runtime/execution.ts";
import { MAX_STORE_TOTAL_CHARS, MAX_STORE_VALUE_CHARS } from "../src/runtime/prelude-source.ts";
import type { VmStartData } from "../src/runtime/protocol.ts";

/** Exercises the host's JSON boundary without launching a VM. */
function successfulLauncher(onStart: (data: VmStartData) => void): VmLauncher {
	return (data, events) => {
		onStart(data);
		queueMicrotask(() =>
			events.message({
				type: "done",
				ok: true,
				value: undefined,
				writes: JSON.stringify([["__proto__", '{"marker":"stored"}']]),
			}),
		);
		return { post: () => {}, stop: async () => {} };
	};
}

describe("host store boundary", () => {
	it.each([
		["oversized deletion payload", JSON.stringify([["x".repeat(MAX_STORE_TOTAL_CHARS)]])],
		["oversized value", JSON.stringify([["k", JSON.stringify("x".repeat(MAX_STORE_VALUE_CHARS))]])],
	])("rejects %s before accepting VM writes", async (_label, writes) => {
		const sandbox = new CodemodeSandboxBase({}, (_data, events) => {
			queueMicrotask(() => events.message({ type: "done", ok: true, writes }));
			return { post: () => {}, stop: async () => {} };
		});
		try {
			const result = await sandbox.execute("");
			expect(result).toMatchObject({ ok: false, error: { kind: "sandbox" } });
			expect(result).not.toHaveProperty("storeWrites");
		} finally {
			await sandbox.close();
		}
	});

	it("preserves prototype-like snapshot keys as own data", async () => {
		let start: VmStartData | undefined;
		const sandbox = new CodemodeSandboxBase(
			{},
			successfulLauncher((data) => {
				start = data;
			}),
		);
		try {
			const store = Object.fromEntries([["__proto__", { marker: "saved" }]]);
			expect((await sandbox.execute("", { store })).ok).toBe(true);
			expect(start?.store).toEqual(Object.fromEntries([["__proto__", '{"marker":"saved"}']]));
			expect(Object.getPrototypeOf(start?.store)).toBe(Object.prototype);
		} finally {
			await sandbox.close();
		}
	});

	it("decodes prototype-like writes as own data without changing host prototypes", async () => {
		const sandbox = new CodemodeSandboxBase(
			{},
			successfulLauncher(() => {}),
		);
		try {
			const result = await sandbox.execute("");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(Object.hasOwn(result.storeWrites.set, "__proto__")).toBe(true);
			expect(result.storeWrites.set.__proto__).toEqual({ marker: "stored" });
			expect(Object.getPrototypeOf(result.storeWrites.set)).toBe(Object.prototype);
		} finally {
			await sandbox.close();
		}
	});
});
