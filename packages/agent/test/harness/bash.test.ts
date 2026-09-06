import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { type BashToolDetails, createBashTool } from "../../src/harness/tools/bash.ts";
import { createEditTool } from "../../src/harness/tools/edit.ts";
import { createReadTool } from "../../src/harness/tools/read.ts";
import { ExecutionError, err, getOrThrow, ok, type Result, type ShellExecOptions } from "../../src/harness/types.ts";
import { DEFAULT_MAX_LINES } from "../../src/harness/utils/truncate.ts";
import { AgentToolError } from "../../src/types.ts";
import { createTempDir } from "./session-test-utils.ts";

async function commandError(execution: Promise<unknown>): Promise<AgentToolError<BashToolDetails>> {
	try {
		await execution;
	} catch (error) {
		expect(error).toBeInstanceOf(AgentToolError);
		return error as AgentToolError<BashToolDetails>;
	}
	throw new Error("Expected command failure");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

class StreamingExecutionEnv extends NodeExecutionEnv {
	readonly firstChunkWritten = deferred();
	readonly finishExecution = deferred();
	command: string | undefined;
	options: ShellExecOptions | undefined;

	override async exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		this.command = command;
		this.options = options;
		options?.onStdout?.("first\n");
		this.firstChunkWritten.resolve();
		await this.finishExecution.promise;
		options?.onStdout?.("last\n");
		return ok({ stdout: "first\nlast\n", stderr: "", exitCode: 0 });
	}
}

class AbortingExecutionEnv extends NodeExecutionEnv {
	readonly executionStarted = deferred();

	override async exec(
		_command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		this.executionStarted.resolve();
		await new Promise<void>((resolve) =>
			options?.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
		);
		return err(new ExecutionError("aborted", "aborted"));
	}
}

class TruncatingExecutionEnv extends NodeExecutionEnv {
	override async exec(
		_command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		const output = `${Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, index) => `line-${index}`).join("\n")}\n`;
		options?.onStdout?.(output);
		return ok({ stdout: output, stderr: "", exitCode: 0 });
	}
}

describe("unified bash", () => {
	it("declares conservative scheduling and replay metadata", () => {
		expect(createBashTool()).toMatchObject({ name: "bash", replay: "never" });
		expect(createBashTool().executionMode).toBeUndefined();
	});

	it("streams bounded output before settlement and forwards shell execution settings", async () => {
		const env = new StreamingExecutionEnv({ cwd: createTempDir() });
		const updates: string[] = [];
		let settled = false;
		const execution = createBashTool({
			commandPrefix: "export PREFIXED=yes",
			prepare: (execution) => {
				execution.env = { SESSION_VALUE: "current" };
				execution.inheritEnv = false;
			},
		})
			.execute(
				"id",
				{ command: "printf test" },
				undefined,
				(update) => {
					updates.push(update.content[0]?.type === "text" ? update.content[0].text : "");
				},
				{ env },
			)
			.finally(() => {
				settled = true;
			});

		await Promise.race([env.firstChunkWritten.promise, execution]);
		expect(settled).toBe(false);
		expect(updates[0]).toBe("");
		expect(updates).toContain("first\n");
		expect(env.command).toBe("export PREFIXED=yes\nprintf test");
		expect(env.options).toMatchObject({
			env: { SESSION_VALUE: "current" },
			inheritEnv: false,
			captureOutput: false,
		});

		env.finishExecution.resolve();
		const result = await execution;
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("first\nlast") });
		expect(updates.at(-1)).toBe("first\nlast\n");
	});

	it("throws nonzero exits with captured output and structured status", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const result = await commandError(
			createBashTool().execute("id", { command: "printf failure; exit 1" }, undefined, undefined, { env }),
		);
		expect(result.details).toMatchObject({
			exitCode: 1,
			signal: null,
			terminationReason: "exit",
			terminationRequested: false,
			timedOut: false,
		});
		expect(result.message).toContain("failure");
	});

	it("throws timeouts with captured output and structured status", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const result = await commandError(
			createBashTool().execute("id", { command: "printf before; sleep 5", timeout: 0.05 }, undefined, undefined, {
				env,
			}),
		);
		expect(result.details).toMatchObject({
			exitCode: null,
			signal: null,
			terminationReason: "timeout",
			terminationRequested: true,
			timedOut: true,
		});
		expect(result.message).toContain("before");
	});

	it.skipIf(process.platform === "win32")("reports signal termination instead of exit zero", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const result = await commandError(
			createBashTool().execute("id", { command: "kill -TERM $$" }, undefined, undefined, { env }),
		);
		expect(result.details).toMatchObject({
			exitCode: null,
			signal: "SIGTERM",
			terminationReason: "signal",
			terminationRequested: false,
			timedOut: false,
		});
		expect(result.message).toContain("signal SIGTERM");
		expect(result.message).not.toContain("exit 0");
	});

	it("terminates the managed process group before a timeout result on Unix", async () => {
		if (process.platform === "win32") return;
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		await commandError(
			createBashTool().execute(
				"id",
				{ command: "sh -c 'echo $$ > managed.pid; sleep 5'", timeout: 0.05 },
				undefined,
				undefined,
				{ env },
			),
		);
		const pid = Number(getOrThrow(await env.readTextFile("managed.pid")));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it("makes post-edit syntax failures visible and supports read-edit-bash recovery", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		getOrThrow(await env.writeFile("module.js", "function value() { return 1; }\n"));
		const context = { env };
		const read = createReadTool();
		const edit = createEditTool();
		const bash = createBashTool();
		await read.execute("read-valid", { path: "module.js", limit: 1 }, undefined, undefined, context);
		await edit.execute(
			"break-syntax",
			{
				path: "module.js",
				edits: [
					{
						oldText: "function value() { return 1; }",
						newText: "function value( { return 1; }",
					},
				],
			},
			undefined,
			undefined,
			context,
		);
		const failed = await commandError(
			bash.execute(
				"verify-failed",
				{ command: `${JSON.stringify(process.execPath)} --check module.js` },
				undefined,
				undefined,
				context,
			),
		);
		expect(failed.details.exitCode).not.toBe(0);
		expect(failed.message).toContain("SyntaxError");

		await read.execute("read-broken", { path: "module.js", limit: 1 }, undefined, undefined, context);
		await edit.execute(
			"repair-syntax",
			{
				path: "module.js",
				edits: [
					{
						oldText: "function value( { return 1; }",
						newText: "function value() { return 2; }",
					},
				],
			},
			undefined,
			undefined,
			context,
		);
		const passed = await bash.execute(
			"verify-passed",
			{ command: `${JSON.stringify(process.execPath)} --check module.js` },
			undefined,
			undefined,
			context,
		);
		expect(passed.details).toMatchObject({ exitCode: 0, timedOut: false });
	});

	it("keeps truncated output bounded and exposes the full output path", async () => {
		const env = new TruncatingExecutionEnv({ cwd: createTempDir() });
		const result = await createBashTool().execute("id", { command: "generate output" }, undefined, undefined, {
			env,
		});
		expect(result.details.truncation).toMatchObject({ truncated: true, truncatedBy: "lines" });
		expect(result.details.fullOutputPath).toBeTypeOf("string");
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Showing lines") });
	});

	it("returns cancellation as the stable ABORTED error", async () => {
		const env = new AbortingExecutionEnv({ cwd: createTempDir() });
		const controller = new AbortController();
		const execution = createBashTool().execute("id", { command: "wait" }, controller.signal, undefined, { env });
		await Promise.race([env.executionStarted.promise, execution]);
		controller.abort();
		await expect(execution).rejects.toMatchObject({ code: "ABORTED" });
	});

	it("executes in an explicit cwd and reports the effective directory", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		getOrThrow(await env.createDir("sub"));
		const result = await createBashTool().execute("cwd", { command: "pwd", cwd: "sub" }, undefined, undefined, {
			env,
		});
		expect(result.details).toMatchObject({ exitCode: 0, cwd: `${env.cwd}/sub`, terminationReason: "exit" });
		expect(result.content[0]).toMatchObject({ text: `${getOrThrow(await env.canonicalPath("sub"))}\n` });
	});

	it("validates cwd as a directory before execution", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		await expect(
			createBashTool().execute("id", { command: "pwd", cwd: "missing" }, undefined, undefined, { env }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("rejects an empty command and describes cwd as non-sandboxing", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const tool = createBashTool();
		expect(tool.description).toContain("not a sandbox");
		await expect(tool.execute("id", { command: " " }, undefined, undefined, { env })).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
	});
});
