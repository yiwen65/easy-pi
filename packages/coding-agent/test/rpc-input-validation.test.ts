import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

const io = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../src/core/output-guard.ts", () => ({
	takeOverStdout: vi.fn(),
	writeRawStdout: (line: string) => io.lines.push(line),
	flushRawStdout: async () => {},
	waitForRawStdoutBackpressure: async () => {},
}));
vi.mock("../src/modes/interactive/theme/theme.ts", () => ({ theme: {} }));

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const records = () => io.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
let input: PassThrough;

beforeEach(async () => {
	io.lines.length = 0;
	input = new PassThrough();
	vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
	vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
	const runtimeHost = {
		session: {
			isIdle: true,
			messages: [],
			bindExtensions: async () => {},
			subscribe: () => () => {},
			agent: { subscribe: () => () => {} },
		},
		setRebindSession: () => {},
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
	void runRpcMode(runtimeHost);
	await tick();
});

afterEach(async () => {
	input.end();
	await tick();
	input.destroy();
	vi.restoreAllMocks();
});

describe("RPC envelope validation", () => {
	it.each([
		"null",
		"true",
		"42",
		'"command"',
		"[]",
		'[{"type":"get_state"}]',
		"{}",
		'{"id":"bad-type","type":null}',
		'{"id":"empty-type","type":""}',
		'{"id":12,"type":"get_state"}',
		'{"id":{},"type":"get_state"}',
		'{"type":"extension_ui_response"}',
		'{"type":"extension_ui_response","id":"dialog","confirmed":"yes"}',
	])("rejects malformed envelope %s and accepts the next command", async (line) => {
		input.write(`${line}\n`);
		await tick();
		expect(records()).toHaveLength(1);
		expect(records()[0]).toMatchObject({ type: "response", command: "parse", success: false });
		expect(records()[0].error).toEqual(expect.any(String));
		input.write('{"id":"next","type":"get_state"}\n');
		await tick();
		expect(records()).toContainEqual(expect.objectContaining({ id: "next", command: "get_state", success: true }));
	});

	it("preserves valid ids in malformed-object errors and unknown-command responses", async () => {
		input.write('{"id":"invalid","type":5}\n{"id":"unknown","type":"not_a_command"}\n');
		await tick();
		expect(records()).toContainEqual(expect.objectContaining({ id: "invalid", command: "parse", success: false }));
		expect(records()).toContainEqual({
			id: "unknown",
			type: "response",
			command: "not_a_command",
			success: false,
			error: "Unknown command: not_a_command",
		});
	});

	it("reports JSON syntax and command execution errors without poisoning later input", async () => {
		input.write(
			'invalid json\n{"id":"bad-name","type":"set_session_name","name":null}\n{"id":"next","type":"get_state"}\n',
		);
		await tick();
		expect(records()).toContainEqual(expect.objectContaining({ command: "parse", success: false }));
		expect(records()).toContainEqual(
			expect.objectContaining({ id: "bad-name", command: "set_session_name", success: false }),
		);
		expect(records()).toContainEqual(expect.objectContaining({ id: "next", command: "get_state", success: true }));
	});
});
