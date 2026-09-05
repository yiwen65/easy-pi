import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditV2Dialect, ReadV2Details } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createV2ToolRuntime } from "../src/core/tools/tool-profile.ts";

describe("production v2 Read/Edit boundaries", () => {
	let cwd: string;
	let runtime: ReturnType<typeof createV2ToolRuntime>;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "pi-v2-boundary-"));
		runtime = createV2ToolRuntime(cwd, { codeIndexProvider: false });
	});
	afterEach(async () => {
		await runtime.close();
		await rm(cwd, { recursive: true, force: true });
	});
	const read = async (input: object): Promise<ReadV2Details> => {
		const tool = runtime.definitions.read;
		return (await tool.execute("read", input, undefined, undefined, {} as Parameters<typeof tool.execute>[4]))
			.details as ReadV2Details;
	};
	const edit = async (dialect: EditV2Dialect, viewId: string | undefined, oldText: string, newText: string) => {
		const tool = runtime.definitions.edit;
		const operation = { kind: "update", path: "file.txt", oldText, newText, viewId };
		const input =
			dialect === "replacement"
				? { path: "file.txt", edits: [{ oldText, newText }], viewId }
				: dialect === "patch"
					? { patch: `*** Pi Edit Patch v1\n${JSON.stringify(operation)}\n*** End Pi Edit Patch` }
					: { operations: [operation] };
		return tool.execute("edit", input, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
	};

	it("reports the actual byte-offset line and edits only the second duplicate", async () => {
		await writeFile(join(cwd, "file.txt"), "duplicate\nduplicate\n");
		const view = await read({ path: "file.txt", byteOffset: 10, maxBytes: 512 });
		expect(view.range).toEqual([2, 2]);
		await edit("operations", view.viewId, "duplicate", "changed");
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("duplicate\nchanged\n");
	});

	it.each(["operations", "replacement", "patch"] as const)(
		"%s rejects an unseen suffix but allows a displayed partial-line edit",
		async (dialect) => {
			await runtime.close();
			runtime = createV2ToolRuntime(cwd, { editDialect: dialect, codeIndexProvider: false });
			const original = `visible ${"x".repeat(500)} HIDDEN\n`;
			await writeFile(join(cwd, "file.txt"), original);
			const view = await read({ path: "file.txt", maxBytes: 512 });
			expect(view.lines?.join("\n")).not.toContain("HIDDEN");
			await expect(edit(dialect, view.viewId, "HIDDEN", "wrong")).rejects.toMatchObject({
				code: dialect === "patch" ? "PATCH_CONTEXT_NOT_FOUND" : "PREIMAGE_MISMATCH",
			});
			expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(original);
			await edit(dialect, view.viewId, "visible", "changed");
			expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(original.replace("visible", "changed"));
		},
	);

	it.each([12, 5])("does not skip budget-clipped entries across %i directory entries", async (count) => {
		const names = Array.from({ length: count }, (_, i) => `${String(i).padStart(2, "0")}-${"n".repeat(150)}`);
		await Promise.all(names.map((name) => writeFile(join(cwd, name), "")));
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 20; page++) {
			const details = await read({ path: ".", limit: 10, maxBytes: 512, ...(cursor ? { cursor } : {}) });
			seen.push(...(details.entries ?? []).map((entry) => entry.name));
			expect(details.outputBytes).toBeLessThanOrEqual(512);
			cursor = details.nextCursor;
			if (!cursor) break;
		}
		expect(cursor).toBeUndefined();
		expect(seen).toEqual(names);
	});
});
