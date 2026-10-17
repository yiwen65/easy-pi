import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManager } from "../src/main.ts";

vi.mock("node:readline", () => ({
	createInterface: vi.fn(() => ({
		question: (_prompt: string, answer: (text: string) => void) => answer("n"),
		close: vi.fn(),
	})),
}));

const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTty(stdin: boolean, stdout = stdin): void {
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdin });
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdout });
}

function args(overrides: Partial<Args> = {}): Args {
	return { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [], session: "global-id", ...overrides };
}

beforeEach(() => {
	vi.mocked(createInterface).mockClear();
	vi.spyOn(SessionManager, "list").mockResolvedValue([]);
	vi.spyOn(SessionManager, "listAll").mockResolvedValue([
		{
			id: "global-id",
			path: "/other/session.jsonl",
			cwd: "/other",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 1,
			firstMessage: "previous task",
			allMessagesText: "previous task",
		},
	]);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`exit:${code}`);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const [stream, descriptor] of [
		[process.stdin, stdinTty],
		[process.stdout, stdoutTty],
	] as const) {
		if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
		else Reflect.deleteProperty(stream, "isTTY");
	}
});

describe("cross-project session confirmation", () => {
	it.each([{ print: true }, { mode: "json" as const }, { mode: "rpc" as const }])(
		"rejects non-interactive options %j without consuming protocol input",
		async (options) => {
			setTty(true);
			await expect(
				createSessionManager(args(options), "/current", undefined, SettingsManager.inMemory()),
			).rejects.toThrow("exit:1");
			expect(createInterface).not.toHaveBeenCalled();
			expect(console.log).not.toHaveBeenCalled();
			expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--fork"));
		},
	);

	it.each([
		[false, true],
		[true, false],
		[false, false],
	])("rejects unavailable TTYs (%s, %s)", async (stdin, stdout) => {
		setTty(stdin, stdout);
		await expect(createSessionManager(args(), "/current", undefined, SettingsManager.inMemory())).rejects.toThrow(
			"exit:1",
		);
		expect(createInterface).not.toHaveBeenCalled();
	});

	it("keeps interactive confirmation and cancellation", async () => {
		setTty(true);
		await expect(createSessionManager(args(), "/current", undefined, SettingsManager.inMemory())).rejects.toThrow(
			"exit:0",
		);
		expect(createInterface).toHaveBeenCalledOnce();
	});

	it("opens an explicit path without a cross-project prompt", async () => {
		setTty(false);
		const session = SessionManager.inMemory("/other");
		vi.spyOn(SessionManager, "open").mockReturnValue(session);
		await expect(
			createSessionManager(
				args({ session: "/other/session.jsonl", mode: "rpc" }),
				"/current",
				undefined,
				SettingsManager.inMemory(),
			),
		).resolves.toBe(session);
		expect(createInterface).not.toHaveBeenCalled();
	});

	it("allows an explicit fork without confirmation", async () => {
		setTty(false);
		const session = SessionManager.inMemory("/current");
		vi.spyOn(SessionManager, "forkFrom").mockReturnValue(session);
		await expect(
			createSessionManager(
				args({ session: undefined, fork: "global-id", print: true }),
				"/current",
				undefined,
				SettingsManager.inMemory(),
			),
		).resolves.toBe(session);
		expect(createInterface).not.toHaveBeenCalled();
	});
});
