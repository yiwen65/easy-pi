import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
let client: RpcClient;
let child: EventEmitter & {
	stdin: PassThrough;
	stdout: PassThrough;
	stderr: PassThrough;
	exitCode: null;
	signalCode: null;
};
let commands: Array<{ id: string; type: string; includeSources?: boolean; sourceId?: string; omitImageIds?: string[] }>;
beforeEach(async () => {
	vi.useFakeTimers();
	commands = [];
	child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		signalCode: null,
	});
	child.stdin.on("data", (chunk: Buffer) => commands.push(JSON.parse(chunk.toString())));
	vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
	client = new RpcClient();
	const starting = client.start();
	await vi.advanceTimersByTimeAsync(100);
	await starting;
});
afterEach(() => {
	child.stdin.destroy();
	child.stdout.destroy();
	child.stderr.destroy();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
function respond(data: unknown, success = true) {
	const command = commands.at(-1)!;
	child.stdout.write(
		`${JSON.stringify({ id: command.id, type: "response", command: command.type, success, data, error: success ? undefined : "Image source is not attached on the active branch.", code: success ? undefined : "storage_missing" })}\n`,
	);
}

describe("RpcClient image commands", () => {
	it("requests summaries without bytes by default and reads originals only explicitly", async () => {
		const reports = { selection: {}, decisions: [] };
		const pending = client.getImages();
		expect(commands.at(-1)).toMatchObject({ type: "get_images", includeSources: false });
		respond(reports);
		expect(await pending).toEqual(reports);
		const sourceId = "a".repeat(64);
		const summaries = client.getImages(true);
		expect(commands.at(-1)).toMatchObject({ type: "get_images", includeSources: true });
		respond({ ...reports, sources: [{ sourceId, byteLength: 3, mimeType: "image/png" }] });
		expect((await summaries).sources).toHaveLength(1);
		const read = client.getImageSource(sourceId);
		expect(commands.at(-1)).toMatchObject({ type: "get_image_source", sourceId });
		const source = { sourceId, byteLength: 3, mimeType: "image/png", data: "AQID" };
		respond(source);
		expect(await read).toEqual(source);
		const selection = client.setImageSelection([]);
		expect(commands.at(-1)).toMatchObject({ type: "set_image_selection", omitImageIds: [] });
		respond(undefined);
		await selection;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects unavailable source reads without leaving a pending request", async () => {
		const read = client.getImageSource("b".repeat(64));
		const rejected = expect(read).rejects.toMatchObject({
			code: "storage_missing",
			message: expect.stringContaining("not attached on the active branch"),
			imageIds: [],
		});
		respond(undefined, false);
		await rejected;
		expect(vi.getTimerCount()).toBe(0);
	});
});
