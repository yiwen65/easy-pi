import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_ITEMS } from "../src/runtime/prelude-source.ts";

const sandboxes: CodemodeSandbox[] = [];
afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
});
function createSandbox(): CodemodeSandbox {
	const sandbox = new CodemodeSandbox({ timeoutMs: 10_000, memoryLimitBytes: 256 * 1024 * 1024 });
	sandboxes.push(sandbox);
	return sandbox;
}

describe("terminal result shares the hard output budget", () => {
	it("rejects an oversized returned value before transferring it to the host", async () => {
		const result = await createSandbox().execute(
			`store("unsafe", true); return "x".repeat(${MAX_OUTPUT_CHARS + 1});`,
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Oversized return was accepted");
		expect(result.error.message).toContain("script output exceeded");
		expect(result).not.toHaveProperty("storeWrites");
	});
	it("counts prior output and the returned value together", async () => {
		const result = await createSandbox().execute(
			`text("x".repeat(${8 * 1024 * 1024})); return "y".repeat(${9 * 1024 * 1024});`,
		);
		expect(result.ok).toBe(false);
		expect(result.output[0]).toMatchObject({ type: "text" });
		if (result.output[0]?.type !== "text") throw new Error("Missing partial output");
		expect(result.output[0].text.length).toBe(8 * 1024 * 1024);
	});
	it("counts a returned value as an output item", async () => {
		const result = await createSandbox().execute(
			`for (let i = 0; i < ${MAX_OUTPUT_ITEMS}; i++) text(""); return "extra";`,
		);
		expect(result.ok).toBe(false);
		expect(result.output).toHaveLength(MAX_OUTPUT_ITEMS);
	});
	it("does not transfer an oversized terminal error payload either", async () => {
		const result = await createSandbox().execute(`throw new Error("x".repeat(${MAX_OUTPUT_CHARS + 1}));`);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Error unexpectedly succeeded");
		expect(result.error.message.length).toBeLessThan(1000);
		expect(result.error.message).toContain("script output exceeded");
	});
});
