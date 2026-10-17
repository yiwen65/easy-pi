import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";
import { MAX_STORE_TOTAL_CHARS } from "../src/runtime/prelude-source.ts";

const sandboxes: CodemodeSandbox[] = [];
afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
});

describe("host resource budgets", () => {
	it.each([
		["one oversized deletion key", `store("x".repeat(${MAX_STORE_TOTAL_CHARS + 1}), undefined);`],
		["many deletions", 'for (let i = 0; i < 1024; i++) store(i + "x".repeat(1024), undefined);'],
		[
			"set/delete churn",
			'for (let i = 0; i < 1024; i++) { const key = i + "x".repeat(1024); store(key, 1); store(key, undefined); }',
		],
		["escaped deletion keys", 'for (let i = 0; i < 256; i++) store(i + "\\0".repeat(1024), undefined);'],
	])("bounds store mutations for %s", async (label, code) => {
		const sandbox = new CodemodeSandbox();
		sandboxes.push(sandbox);
		const result = await sandbox.execute(`store("first", 1); ${code}`);
		const committedBytes = result.ok ? Buffer.byteLength(JSON.stringify(result.storeWrites)) : 0;
		console.log(`${label}: committedBytes=${committedBytes}`);
		expect(result).toMatchObject({ ok: false, error: { kind: "script", name: "RangeError" } });
		expect(result).not.toHaveProperty("storeWrites");
	});

	it("includes JSON framing at the exact mutation limit and leaves state unchanged on a caught refusal", async () => {
		const sandbox = new CodemodeSandbox();
		sandboxes.push(sandbox);
		const exact = await sandbox.execute(`store("x".repeat(${MAX_STORE_TOTAL_CHARS - 6}), undefined);`);
		expect(exact.ok).toBe(true);
		const over = await sandbox.execute(`store("x".repeat(${MAX_STORE_TOTAL_CHARS - 5}), undefined);`);
		expect(over).toMatchObject({ ok: false, error: { name: "RangeError" } });
		const caught = await sandbox.execute(`
			store("kept", 1);
			try { store("x".repeat(${MAX_STORE_TOTAL_CHARS - 6}), undefined); } catch {}
			return load("kept");
		`);
		expect(caught).toMatchObject({ ok: true, value: 1, storeWrites: { set: { kept: 1 }, delete: [] } });
	});

	it("replaces repeated writes without spending the mutation budget twice", async () => {
		const sandbox = new CodemodeSandbox();
		sandboxes.push(sandbox);
		const result = await sandbox.execute(`
			for (let i = 0; i < 32; i++) { store("k", "x".repeat(200000)); store("k", undefined); }
			store("kept", { ok: true });
		`);
		expect(result).toMatchObject({ ok: true, storeWrites: { set: { kept: { ok: true } }, delete: ["k"] } });
	});

	it("bounds sequential host call records even with a small VM and no deadline", async () => {
		let dispatched = 0;
		const sandbox = new CodemodeSandbox({
			timeoutMs: Number.POSITIVE_INFINITY,
			memoryLimitBytes: 8 * 1024 * 1024,
			tools: [{ name: "noop", execute: () => void dispatched++ }],
		});
		sandboxes.push(sandbox);
		const result = await sandbox.execute(
			'store("uncommitted", true); for (let i = 0; i < 2048; i++) { try { await tools.noop(); } catch {} }',
		);
		console.log(`sequential calls: dispatched=${dispatched}, retained=${result.calls.length}`);
		expect(result).toMatchObject({ ok: false, error: { kind: "script", name: "RangeError" } });
		expect(result).not.toHaveProperty("storeWrites");
		expect(dispatched).toBe(1024);
		expect(result.calls).toHaveLength(dispatched);
		expect(result.calls.every((call) => call.status === "ok")).toBe(true);
	});

	it("allows exactly the call budget and starts a fresh one for the next execution", async () => {
		const sandbox = new CodemodeSandbox({
			tools: [
				{
					name: "fail",
					execute: () => {
						throw new Error("known failure");
					},
				},
			],
		});
		sandboxes.push(sandbox);
		for (const count of [1024, 1]) {
			const result = await sandbox.execute(
				`for (let i = 0; i < ${count}; i++) { try { await tools.fail(); } catch {} }`,
			);
			expect(result.ok).toBe(true);
			expect(result.calls).toHaveLength(count);
			expect(result.calls.every((call) => call.status === "error")).toBe(true);
		}
	});

	it("counts globals in the host-call budget without adding tool records", async () => {
		let dispatched = 0;
		const sandbox = new CodemodeSandbox({
			globals: [{ name: "lookup", execute: () => void dispatched++ }],
		});
		sandboxes.push(sandbox);
		const result = await sandbox.execute("for (let i = 0; i < 2048; i++) await lookup();");
		expect(result).toMatchObject({ ok: false, error: { kind: "script", name: "RangeError" }, calls: [] });
		expect(dispatched).toBe(1024);
	});

	it("refuses excess in-flight dispatch and retains every admitted call on cancellation", async () => {
		let dispatched = 0;
		let cancelled = 0;
		const sandbox = new CodemodeSandbox({
			tools: [
				{
					name: "hold",
					execute: (_args, { signal }) => {
						dispatched++;
						return new Promise<void>((resolve) =>
							signal.addEventListener(
								"abort",
								() => {
									cancelled++;
									resolve();
								},
								{ once: true },
							),
						);
					},
				},
			],
		});
		sandboxes.push(sandbox);
		const result = await sandbox.execute('store("uncommitted", true); for (let i = 0; i < 1025; i++) tools.hold();');
		console.log(`parallel calls: dispatched=${dispatched}, cancelled=${cancelled}, retained=${result.calls.length}`);
		expect(result).toMatchObject({ ok: false, error: { kind: "script", name: "RangeError" } });
		expect(dispatched).toBe(1024);
		expect(cancelled).toBe(dispatched);
		expect(result.calls).toHaveLength(dispatched);
		expect(result.calls.every((call) => call.status === "cancelled")).toBe(true);
		expect(result).not.toHaveProperty("storeWrites");
	});
});
