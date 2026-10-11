import { describe, expect, it } from "vitest";
import { CodemodeSandboxBase, type VmLauncher } from "../src/runtime/execution.ts";
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
