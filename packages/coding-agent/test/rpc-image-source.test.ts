import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { getImageSourceMetadata } from "../src/core/images/storage-codec.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { createImagePng } from "./helpers/image-fixtures.ts";

const io = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../src/core/output-guard.ts", () => ({
	takeOverStdout: vi.fn(),
	writeRawStdout: (line: string) => io.lines.push(line),
	flushRawStdout: async () => {},
	waitForRawStdoutBackpressure: async () => {},
}));
vi.mock("../src/modes/interactive/theme/theme.ts", () => ({ theme: {} }));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const inputs: PassThrough[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const input of inputs.splice(0)) {
		input.end();
		await tick();
		input.destroy();
	}
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function start(manager: SessionManager) {
	io.lines.length = 0;
	const input = new PassThrough();
	inputs.push(input);
	vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
	vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
	const session = {
		sessionManager: manager,
		getImageSelection: () => ({}),
		getImageDecisions: () => [],
		bindExtensions: async () => {},
		subscribe: () => () => {},
		agent: { subscribe: () => () => {} },
		isIdle: true,
	};
	void runRpcMode({ session, setRebindSession: () => {}, dispose: async () => {} } as unknown as AgentSessionRuntime);
	await tick();
	return {
		input,
		response: async (id: string) => {
			await vi.waitFor(() =>
				expect(io.lines.some((line) => (JSON.parse(line) as RpcResponse).id === id)).toBe(true),
			);
			return io.lines.map((line) => JSON.parse(line) as RpcResponse).find((record) => record.id === id)!;
		},
	};
}
function attached(manager: SessionManager) {
	const source = { type: "image" as const, mimeType: "image/png", data: createImagePng(8, 4).toString("base64") };
	const image = manager.attachImageSource({ ...source, data: createImagePng().toString("base64") }, source, {
		originalWidth: 8,
		originalHeight: 4,
		width: 4,
		height: 4,
	});
	const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
	manager.appendCustomMessageEntry("attachment", [image], true);
	return { source, ref: getImageSourceMetadata(image)!.asset, root };
}

describe("RPC original-image JSONL consumer", () => {
	it.each([false, true])(
		"returns only requested branch summaries and explicit bounded bytes (persistent=%s)",
		async (persistent) => {
			const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-rpc-source-")));
			dirs.push(dir);
			const manager = persistent ? SessionManager.create(dir, dir) : SessionManager.inMemory();
			const { source, ref } = attached(manager);
			const { input, response } = await start(manager);
			const id = "images\u2028not-a-newline\u2029";
			const commands = `${JSON.stringify({ id: "default", type: "get_images" })}\r\n${JSON.stringify({ id, type: "get_images", includeSources: true })}\n`;
			// Exercise the actual LF parser across chunks, including valid JSON Unicode separators.
			input.write(commands.slice(0, 31));
			input.write(commands.slice(31));
			expect(await response("default")).toMatchObject({ data: { selection: {}, decisions: [] } });
			expect(JSON.stringify(await response("default"))).not.toContain("sources");
			const summary = await response(id);
			expect(summary).toMatchObject({
				success: true,
				data: {
					sources: [
						{
							sourceId: ref.sha256,
							mimeType: source.mimeType,
							byteLength: ref.byteLength,
							dimensions: { originalWidth: 8, width: 4 },
						},
					],
				},
			});
			for (const forbidden of [source.data, dir, "imageSource", '"data":"'])
				expect(JSON.stringify(summary)).not.toContain(forbidden);
			input.write(`${JSON.stringify({ id: "source", type: "get_image_source", sourceId: ref.sha256 })}\n`);
			expect(await response("source")).toMatchObject({
				command: "get_image_source",
				success: true,
				data: { sourceId: ref.sha256, data: source.data, mimeType: source.mimeType, byteLength: ref.byteLength },
			});
			for (const line of io.lines) {
				expect(line.endsWith("\n")).toBe(true);
				expect(line.split("\n")).toHaveLength(2);
			}
		},
	);

	it("rejects arbitrary/wrong-branch hashes, malformed source arguments, and corrupt sources; later commands still work", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-rpc-source-")));
		dirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		const { root, ref } = attached(manager);
		const leaf = manager.getLeafId()!;
		const { input, response } = await start(manager);
		const send = (id: string, sourceId: unknown) =>
			input.write(`${JSON.stringify({ id, type: "get_image_source", sourceId })}\n`);
		manager.branch(root);
		send("wrong-branch", ref.sha256);
		expect(await response("wrong-branch")).toMatchObject({ success: false, code: "storage_missing" });
		send("arbitrary", "a".repeat(64));
		expect(await response("arbitrary")).toMatchObject({ success: false, code: "storage_missing" });
		send("malformed", { sha256: ref.sha256 });
		expect(await response("malformed")).toMatchObject({ success: false, code: "invalid_image" });
		manager.branch(leaf);
		writeFileSync(manager.getImageSourcePath(ref)!, Buffer.alloc(ref.byteLength));
		send("corrupt", ref.sha256);
		expect(await response("corrupt")).toMatchObject({ success: false, code: "storage_invalid" });
		input.write('{"id":"still-usable","type":"get_images","includeSources":true}\n');
		expect(await response("still-usable")).toMatchObject({
			success: true,
			data: { sources: [{ sourceId: ref.sha256 }] },
		});
		expect(io.lines.join("")).not.toContain(dir);
	});
});
