import * as childProcesses from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { pathExists } from "../src/core/tools/path-utils.ts";
import { ensureTool } from "../src/utils/tools-manager.ts";

vi.mock("child_process", async (original) => ({ ...(await original<typeof childProcesses>()), spawn: vi.fn() }));
vi.mock("../src/utils/tools-manager.ts", () => ({ ensureTool: vi.fn() }));
vi.mock("../src/core/tools/path-utils.ts", async (original) => {
	const values = await original<Record<string, unknown>>();
	return { ...values, pathExists: vi.fn() };
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fakeChild() {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
		killed: false,
	}) as unknown as childProcesses.ChildProcessWithoutNullStreams;
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("search cancellation before dispatch (F13)", () => {
	it.each(["ensureTool", "isDirectory"] as const)(
		"does not launch grep after cancellation during %s",
		async (stage) => {
			const entered = deferred<void>();
			const release = deferred<void>();
			vi.mocked(ensureTool).mockImplementation(async () => {
				if (stage === "ensureTool") {
					entered.resolve();
					await release.promise;
				}
				return "faux-rg";
			});
			const child = fakeChild();
			vi.mocked(childProcesses.spawn).mockImplementation(() => {
				setImmediate(() => child.emit("close", 1));
				return child;
			});
			const controller = new AbortController();
			const result = createGrepTool(process.cwd(), {
				operations: {
					isDirectory: async () => {
						if (stage === "isDirectory") {
							entered.resolve();
							await release.promise;
						}
						return true;
					},
					readFile: async () => "",
				},
			})
				.execute("grep", { pattern: "test" }, controller.signal)
				.catch((error: unknown) => error);
			await entered.promise;
			controller.abort();
			release.resolve();
			expect(await result).toMatchObject({ message: "Operation aborted" });
			expect(childProcesses.spawn).not.toHaveBeenCalled();
		},
	);

	it.each(["ancestor", "probe"] as const)("does not launch find after cancellation during %s", async (stage) => {
		const entered = deferred<void>();
		const release = deferred<boolean>();
		vi.mocked(ensureTool).mockResolvedValue(`faux-fd-${stage}`);
		vi.mocked(pathExists).mockImplementation(async () => {
			if (stage === "ancestor") {
				entered.resolve();
				return release.promise;
			}
			return false;
		});
		const probe = fakeChild();
		vi.mocked(childProcesses.spawn).mockImplementation((_file, args) => {
			if (args?.[0] === "--help") {
				entered.resolve();
				return probe;
			}
			const child = fakeChild();
			setImmediate(() => child.emit("close", 0));
			return child;
		});
		const controller = new AbortController();
		const result = createFindTool(process.cwd())
			.execute("find", { pattern: "*.ts" }, controller.signal)
			.catch((error: unknown) => error);
		await entered.promise;
		controller.abort();
		if (stage === "ancestor") release.resolve(true);
		else {
			probe.stdout.emit("data", Buffer.from("--no-require-git"));
			probe.emit("close", 0);
		}
		expect(await result).toMatchObject({ message: "Operation aborted" });
		// Drain the released preparation/probe continuation without a timing sleep.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(vi.mocked(childProcesses.spawn).mock.calls.filter(([, args]) => args?.[0] !== "--help")).toHaveLength(0);
		if (stage === "ancestor") expect(childProcesses.spawn).not.toHaveBeenCalled();
	});
});
