import assert from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it, type TestContext } from "node:test";
import { isKittyProtocolActive } from "../src/keys.ts";
import { ProcessTerminal, refreshTerminalDimensions } from "../src/terminal.ts";

function mockProcessProperty(t: TestContext, property: "platform" | "pid", value: NodeJS.Platform | number): void {
	const descriptor = Object.getOwnPropertyDescriptor(process, property);
	assert.ok(descriptor);
	Object.defineProperty(process, property, { value });
	t.after(() => Object.defineProperty(process, property, descriptor));
}

describe("refreshTerminalDimensions", () => {
	for (const platform of ["darwin", "linux"] as const) {
		it(`sends SIGWINCH to the current process on ${platform}`, (t) => {
			mockProcessProperty(t, "platform", platform);
			const kill = t.mock.method(process, "kill", () => true);

			refreshTerminalDimensions();

			assert.deepEqual(
				kill.mock.calls.map((call) => call.arguments),
				[[process.pid, "SIGWINCH"]],
			);
		});
	}

	it("skips signal delivery on Windows", (t) => {
		mockProcessProperty(t, "platform", "win32");
		const kill = t.mock.method(process, "kill", () => true);

		refreshTerminalDimensions();

		assert.equal(kill.mock.callCount(), 0);
	});

	for (const pid of [0, -1]) {
		it(`does not signal a process group for pid ${pid}`, (t) => {
			mockProcessProperty(t, "platform", "linux");
			mockProcessProperty(t, "pid", pid);
			const kill = t.mock.method(process, "kill", () => true);

			refreshTerminalDimensions();

			assert.equal(kill.mock.callCount(), 0);
		});
	}

	it("does not throw when SIGWINCH is unavailable", (t) => {
		mockProcessProperty(t, "platform", "linux");
		const kill = t.mock.method(process, "kill", () => {
			throw Object.assign(new Error("Unknown signal: SIGWINCH"), { code: "ERR_UNKNOWN_SIGNAL" });
		});

		assert.doesNotThrow(refreshTerminalDimensions);
		assert.equal(kill.mock.callCount(), 1);
	});
});

function setupTerminal(t: TestContext, { wasRaw = false, isTTY = true } = {}) {
	mockProcessProperty(t, "platform", "linux");
	const writes: string[] = [];
	const rawModes: boolean[] = [];
	const stdin = Object.assign(new EventEmitter(), {
		isTTY,
		isRaw: wasRaw,
		setRawMode: (mode: boolean): void => {
			rawModes.push(mode);
			stdin.isRaw = mode;
		},
		setEncoding: (): void => {},
		resume: (): void => {},
		pause: (): void => {},
	});
	if (!isTTY) Reflect.deleteProperty(stdin, "setRawMode");
	const stdout = Object.assign(new EventEmitter(), {
		isTTY,
		write: (data: string) => {
			writes.push(data);
			return true;
		},
	});
	t.mock.getter(process, "stdin", () => stdin);
	t.mock.getter(process, "stdout", () => stdout);
	const terminal = new ProcessTerminal();
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		terminal.stop();
	};
	t.after(cleanup);
	return { terminal, stdin, stdout, writes, rawModes, cleanup };
}

describe("ProcessTerminal best-effort SIGWINCH refresh", () => {
	for (const [code, wasRaw] of [
		["EACCES", false],
		["EPERM", true],
	] as const) {
		it(`continues startup after ${code} and restores terminal state`, (t) => {
			const harness = setupTerminal(t, { wasRaw });
			const kill = t.mock.method(process, "kill", () => {
				throw Object.assign(new Error(`kill ${code}`), { code });
			});
			const inputs: string[] = [];
			let resizes = 0;

			assert.doesNotThrow(() =>
				harness.terminal.start(
					(data) => inputs.push(data),
					() => resizes++,
				),
			);
			assert.deepEqual(
				kill.mock.calls.map((call) => call.arguments),
				[[process.pid, "SIGWINCH"]],
			);
			assert.deepEqual(harness.rawModes, [true]);
			assert.deepEqual(harness.writes, ["\x1b[?2004h", "\x1b[>7u\x1b[?u\x1b[c"]);
			assert.equal(harness.stdin.listenerCount("data"), 1);
			assert.equal(harness.stdout.listenerCount("resize"), 1);

			harness.stdin.emit("data", "\x1b[?7u");
			assert.equal(harness.terminal.kittyProtocolActive, true);
			assert.equal(isKittyProtocolActive(), true);
			harness.stdin.emit("data", "a");
			harness.stdout.emit("resize");
			assert.deepEqual(inputs, ["a"]);
			assert.equal(resizes, 1);

			harness.cleanup();
			assert.deepEqual(harness.rawModes, [true, wasRaw]);
			assert.equal(harness.stdin.isRaw, wasRaw);
			assert.equal(harness.terminal.kittyProtocolActive, false);
			assert.equal(isKittyProtocolActive(), false);
			assert.deepEqual(harness.writes.slice(-2), ["\x1b[?2004l", "\x1b[<u"]);
			assert.equal(harness.stdin.listenerCount("data"), 0);
			assert.equal(harness.stdout.listenerCount("resize"), 0);
			harness.stdin.emit("data", "b");
			harness.stdout.emit("resize");
			assert.deepEqual(inputs, ["a"]);
			assert.equal(resizes, 1);
		});
	}

	it("sends the self-signal after attaching the resize handler", (t) => {
		const harness = setupTerminal(t);
		let resizes = 0;
		const kill = t.mock.method(process, "kill", () => {
			harness.stdout.emit("resize");
			return true;
		});

		harness.terminal.start(
			() => {},
			() => resizes++,
		);

		assert.deepEqual(
			kill.mock.calls.map((call) => call.arguments),
			[[process.pid, "SIGWINCH"]],
		);
		assert.equal(resizes, 1);
		assert.deepEqual(harness.writes, ["\x1b[?2004h", "\x1b[>7u\x1b[?u\x1b[c"]);
	});

	it("works without TTY raw-mode support", (t) => {
		const harness = setupTerminal(t, { isTTY: false });
		const kill = t.mock.method(process, "kill", () => true);
		const inputs: string[] = [];

		assert.doesNotThrow(() =>
			harness.terminal.start(
				(data) => inputs.push(data),
				() => {},
			),
		);
		harness.stdin.emit("data", "a");
		assert.deepEqual(inputs, ["a"]);
		assert.equal(kill.mock.callCount(), 1);
		harness.cleanup();
		assert.deepEqual(harness.rawModes, []);
		assert.equal(harness.stdin.listenerCount("data"), 0);
		assert.equal(harness.stdout.listenerCount("resize"), 0);
	});

	it("does not suppress an unrelated raw-mode failure", (t) => {
		const harness = setupTerminal(t);
		const kill = t.mock.method(process, "kill", () => true);
		const error = new Error("raw mode failed");
		const setRawMode = t.mock.method(harness.stdin, "setRawMode", () => {
			throw error;
		});

		assert.throws(
			() =>
				harness.terminal.start(
					() => {},
					() => {},
				),
			(caught) => caught === error,
		);
		assert.equal(kill.mock.callCount(), 0);
		setRawMode.mock.restore();
	});

	it("does not suppress an unrelated keyboard-query write failure", (t) => {
		const harness = setupTerminal(t);
		t.mock.method(process, "kill", () => true);
		const error = new Error("keyboard query failed");
		t.mock.method(harness.stdout, "write", (data: string) => {
			if (data === "\x1b[>7u\x1b[?u\x1b[c") throw error;
			return true;
		});

		assert.throws(
			() =>
				harness.terminal.start(
					() => {},
					() => {},
				),
			(caught) => caught === error,
		);
	});
});
