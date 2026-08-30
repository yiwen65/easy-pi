import { describe, expect, it } from "vitest";
import { type NodeProcessExecutionOptions, NodeProcessExecutor } from "../../src/harness/env/node-process-executor.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

function nodeExecutionOptions(
	cwd: string,
	overrides: Partial<NodeProcessExecutionOptions> = {},
): NodeProcessExecutionOptions {
	return {
		shell: { shell: process.execPath, args: ["-e"] },
		cwd,
		env: { ...process.env },
		...overrides,
	};
}

describe("NodeProcessExecutor", () => {
	it("streams raw channel bytes and balances lifecycle notifications", async () => {
		const startedPids: number[] = [];
		const endedPids: number[] = [];
		const stdout: number[] = [];
		const stderr: number[] = [];
		const executor = new NodeProcessExecutor({
			onProcessStart: (pid) => startedPids.push(pid),
			onProcessEnd: (pid) => endedPids.push(pid),
		});

		const result = getOrThrow(
			await executor.execute(
				"process.stdout.write(Buffer.from([0, 255, 65])); process.stderr.write(Buffer.from([66, 0]));",
				nodeExecutionOptions(createTempDir(), {
					onStdout: (chunk) => stdout.push(...chunk),
					onStderr: (chunk) => stderr.push(...chunk),
				}),
			),
		);

		expect(result).toEqual({ exitCode: 0, signal: null });
		expect(stdout).toEqual([0, 255, 65]);
		expect(stderr).toEqual([66, 0]);
		expect(startedPids).toHaveLength(1);
		expect(endedPids).toEqual(startedPids);
	});

	it("returns timeout and abort failures after terminating the process", async () => {
		const executor = new NodeProcessExecutor();
		const timeoutResult = await executor.execute(
			"setTimeout(() => {}, 60_000);",
			nodeExecutionOptions(createTempDir(), { timeoutMs: 10 }),
		);
		expect(timeoutResult).toMatchObject({ ok: false, error: { code: "timeout" } });

		const controller = new AbortController();
		const abortedExecution = executor.execute(
			"setTimeout(() => {}, 60_000);",
			nodeExecutionOptions(createTempDir(), { abortSignal: controller.signal }),
		);
		controller.abort();
		await expect(abortedExecution).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
	});

	it("returns callback failures after terminating the process", async () => {
		const executor = new NodeProcessExecutor();
		const result = await executor.execute(
			"process.stdout.write('out'); setTimeout(() => {}, 60_000);",
			nodeExecutionOptions(createTempDir(), {
				onStdout: () => {
					throw new Error("callback failed");
				},
			}),
		);
		expect(result).toMatchObject({ ok: false, error: { code: "callback_error", message: "callback failed" } });
	});

	it.skipIf(process.platform === "win32")("preserves null exit codes and process signals", async () => {
		const executor = new NodeProcessExecutor();
		const result = getOrThrow(
			await executor.execute("process.kill(process.pid, 'SIGTERM');", nodeExecutionOptions(createTempDir())),
		);
		expect(result).toEqual({ exitCode: null, signal: "SIGTERM" });
	});

	it("cleanup terminates active processes without duplicating lifecycle completion", async () => {
		let startedPid: number | undefined;
		const endedPids: number[] = [];
		const executor = new NodeProcessExecutor({
			onProcessStart: (pid) => {
				startedPid = pid;
			},
			onProcessEnd: (pid) => endedPids.push(pid),
		});
		const execution = executor.execute(
			"setTimeout(() => {}, 60_000);",
			nodeExecutionOptions(createTempDir(), { timeoutMs: 2000 }),
		);
		expect(startedPid).toBeTypeOf("number");

		await executor.cleanup();
		await expect(execution).resolves.toMatchObject({ ok: true });
		expect(endedPids).toEqual([startedPid]);
	});
});
