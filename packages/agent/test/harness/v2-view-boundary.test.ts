import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createEditV2Tool } from "../../src/harness/tools/edit-v2.ts";
import { ExecutionEnvReadProvider } from "../../src/harness/tools/read-provider.ts";
import { createReadV2Tool, type ReadV2Input } from "../../src/harness/tools/read-v2.ts";
import { ToolStateLedger } from "../../src/harness/tools/tool-state.ts";
import { getOrThrow } from "../../src/harness/types.ts";

describe("v2 final view boundaries", () => {
	let env: NodeExecutionEnv;
	let toolState: ToolStateLedger;
	beforeEach(async () => {
		env = new NodeExecutionEnv({ cwd: await mkdtemp(join(tmpdir(), "pi-view-boundary-")) });
		toolState = new ToolStateLedger();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await env.cleanup();
		await rm(env.cwd, { recursive: true, force: true });
	});
	const read = async (input: ReadV2Input) =>
		(await createReadV2Tool().execute("read", input, undefined, undefined, { env, toolState })).details;
	const edit = (binding: object, oldText: string, newText = "changed") =>
		createEditV2Tool().execute(
			"edit",
			{ operations: [{ kind: "update", path: "file.txt", oldText, newText, ...binding }] },
			undefined,
			undefined,
			{ env, toolState },
		);

	it.each(["\n", "\r\n"])("binds UTF-8 byte fragments with BOM and %j endings", async (ending) => {
		const prefix = `\ufeffé duplicate${ending}é `;
		const original = `${prefix}duplicate ${"界".repeat(200)} HIDDEN${ending}`;
		getOrThrow(await env.writeFile("file.txt", original));
		const byteOffset = new TextEncoder().encode(prefix).length;
		const view = await read({ path: "file.txt", byteOffset, maxBytes: 512 });
		expect(view.range).toEqual([2, 2]);
		expect(view.lines?.[0]).toMatch(/^duplicate /);
		expect(view.lines?.[0]).not.toContain("�");
		const stored = toolState.getView(view.viewId!, env.cwd)!;
		expect(stored.byteRange).toEqual([byteOffset, byteOffset + new TextEncoder().encode(view.lines![0]).length]);
		await expect(edit({ viewId: view.viewId }, "HIDDEN")).rejects.toMatchObject({ code: "PREIMAGE_MISMATCH" });
		await edit({ viewId: view.viewId }, "duplicate");
		expect(getOrThrow(await env.readTextFile("file.txt"))).toBe(
			original.slice(0, prefix.length) + original.slice(prefix.length).replace("duplicate", "changed"),
		);
	});

	it("matches only the visible occurrence when a byte fragment hides the same text earlier on its line", async () => {
		const prefix = "duplicate prefix ";
		getOrThrow(await env.writeFile("file.txt", `${prefix}duplicate suffix\n`));
		const view = await read({ path: "file.txt", byteOffset: prefix.length, maxBytes: 512 });
		await edit({ viewId: view.viewId }, "duplicate");
		expect(getOrThrow(await env.readTextFile("file.txt"))).toBe(`${prefix}changed suffix\n`);
	});

	it("intersects explicit line narrowing with the displayed bytes and preserves hash+range", async () => {
		const original = `\ufefffirst\r\nsecond\r\n${"x".repeat(500)} HIDDEN\r\n`;
		getOrThrow(await env.writeFile("file.txt", original));
		const view = await read({ path: "file.txt", maxBytes: 512 });
		await expect(edit({ viewId: view.viewId, range: { startLine: 2, endLine: 2 } }, "first")).rejects.toMatchObject({
			code: "PREIMAGE_MISMATCH",
		});
		await expect(edit({ viewId: view.viewId }, "HIDDEN")).rejects.toMatchObject({ code: "PREIMAGE_MISMATCH" });
		await edit({ expectedFileHash: view.fileHash, range: { startLine: 3, endLine: 3 } }, "HIDDEN");
		expect(getOrThrow(await env.readTextFile("file.txt"))).toBe(original.replace("HIDDEN", "changed"));
	});

	it("keeps multiline BOM/CRLF replacements inside the verified fragment", async () => {
		getOrThrow(await env.writeFile("file.txt", "\ufefffirst\r\nsecond\r\nthird\r\n"));
		const view = await read({ path: "file.txt", maxLines: 2 });
		await edit({ viewId: view.viewId }, "first\nsecond", "new\nlines");
		expect(getOrThrow(await env.readTextFile("file.txt"))).toBe("\ufeffnew\r\nlines\r\nthird\r\n");
	});

	it("binds after final formatting drops provider lines, not before", async () => {
		getOrThrow(await env.writeFile("file.txt", `visible\n${"x".repeat(400)} HIDDEN\n`));
		const provider = new ExecutionEnvReadProvider(env);
		vi.spyOn(provider, "readText").mockResolvedValue({
			lines: ["visible", `${"x".repeat(400)} HIDDEN`],
			startLine: 1,
			endLine: 2,
			eof: true,
			partialLine: false,
		});
		const view = (
			await createReadV2Tool().execute("read", { path: "file.txt", maxBytes: 512 }, undefined, undefined, {
				env,
				toolState,
				readProvider: provider,
			})
		).details;
		expect(view.lines).toEqual(["visible"]);
		expect(toolState.getView(view.viewId!, env.cwd)?.byteRange).toEqual([0, 7]);
		await expect(edit({ viewId: view.viewId }, "HIDDEN")).rejects.toMatchObject({ code: "PREIMAGE_MISMATCH" });
		await edit({ viewId: view.viewId }, "visible");
	});

	it("does not authorize provider text that disagrees with the hashed bytes or an empty display", async () => {
		getOrThrow(await env.writeFile("file.txt", "actual\n"));
		const provider = new ExecutionEnvReadProvider(env);
		for (const lines of [["other"], []]) {
			vi.spyOn(provider, "readText").mockResolvedValue({
				lines,
				startLine: 1,
				endLine: 1,
				eof: true,
				partialLine: false,
			});
			const view = (
				await createReadV2Tool().execute("read", { path: "file.txt" }, undefined, undefined, {
					env,
					toolState,
					readProvider: provider,
				})
			).details;
			expect(view.editable).toBe(false);
			await expect(edit({ viewId: view.viewId }, "actual")).rejects.toMatchObject({ code: "STALE_VIEW" });
		}
	});

	it("counts actual byte lines in the Node range API rather than trusting startLine", async () => {
		getOrThrow(await env.writeFile("file.txt", "\ufeffé\r\ntarget\r\n"));
		const range = getOrThrow(
			await env.readTextRange("file.txt", { startByte: 7, startLine: 99, maxBytes: 512, maxLines: 1 }),
		);
		expect(range).toMatchObject({ startLine: 2, endLine: 2, lines: ["target"] });
	});

	it("drains clipped entries before using the provider continuation and its generation", async () => {
		const provider = new ExecutionEnvReadProvider(env);
		const entries = Array.from({ length: 4 }, (_, index) => ({
			name: `${index}-${"n".repeat(180)}`,
			kind: "file" as const,
		}));
		const listing = vi
			.spyOn(provider, "readDirectory")
			.mockResolvedValueOnce({
				entries,
				nextCursor: "provider-next",
				generation: "g1",
				stable: true,
				partial: false,
			})
			.mockResolvedValueOnce({
				entries: [{ name: "last", kind: "file" }],
				generation: "g1",
				stable: true,
				partial: false,
			});
		const tool = createReadV2Tool();
		const context = { env, readProvider: provider };
		let cursor: string | undefined;
		const seen: string[] = [];
		for (let index = 0; index < 5; index++) {
			const result = await tool.execute(
				"read",
				{ path: ".", limit: 4, maxBytes: 512, cursor },
				undefined,
				undefined,
				context,
			);
			seen.push(...result.details.entries!.map((entry) => entry.name));
			cursor = result.details.nextCursor;
			if (!cursor) break;
		}
		expect(seen).toEqual([...entries.map((entry) => entry.name), "last"]);
		expect(listing).toHaveBeenCalledTimes(2);
		expect(listing.mock.calls[1][0]).toMatchObject({ cursor: "provider-next", expectedGeneration: "g1", limit: 4 });
	});

	it("retains a zero-fit final directory page and binds cursors to scope, provider, limit and expiry", async () => {
		const provider = new ExecutionEnvReadProvider(env);
		const entries = [{ name: "n".repeat(600), kind: "file" as const }];
		const listing = vi
			.spyOn(provider, "readDirectory")
			.mockResolvedValue({ entries, generation: "g1", stable: true, partial: false });
		const tool = createReadV2Tool();
		const context = { env, toolState, readProvider: provider, read: { scopeId: "a" } };
		const first = (await tool.execute("read", { path: ".", limit: 10, maxBytes: 512 }, undefined, undefined, context))
			.details;
		expect(first.entries).toEqual([]);
		expect(first.nextCursor).toBeDefined();
		const input = { path: ".", limit: 10, maxBytes: 1024, cursor: first.nextCursor };
		await expect(
			tool.execute("scope", input, undefined, undefined, { ...context, read: { scopeId: "b" } }),
		).rejects.toMatchObject({ code: "STALE_DIRECTORY" });
		await expect(tool.execute("limit", { ...input, limit: 9 }, undefined, undefined, context)).rejects.toMatchObject({
			code: "STALE_DIRECTORY",
		});
		await expect(
			tool.execute("provider", input, undefined, undefined, {
				...context,
				readProvider: {
					...provider,
					id: "other",
					capabilities: provider.capabilities,
					stat: provider.stat.bind(provider),
					readDirectory: provider.readDirectory.bind(provider),
					readText: provider.readText.bind(provider),
					readBinary: provider.readBinary.bind(provider),
					close: provider.close.bind(provider),
				},
			}),
		).rejects.toMatchObject({ code: "STALE_DIRECTORY" });
		const final = (await tool.execute("continue", input, undefined, undefined, context)).details;
		expect(final.entries).toEqual(entries);
		expect(final.nextCursor).toBeUndefined();
		expect(listing).toHaveBeenCalledTimes(1);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 1000);
		await expect(tool.execute("expired", input, undefined, undefined, context)).rejects.toMatchObject({
			code: "STALE_DIRECTORY",
		});
	});
});
