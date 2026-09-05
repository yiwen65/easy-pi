import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	AgentToolError,
	createBashTool as createCoreBashTool,
	ok,
	type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool, createBashToolDefinition } from "../src/core/tools/bash.ts";

class RecordingEnv extends NodeExecutionEnv {
	command: string | undefined;
	options: ShellExecOptions | undefined;
	override async exec(command: string, options?: ShellExecOptions): ReturnType<NodeExecutionEnv["exec"]> {
		this.command = command;
		this.options = options;
		options?.onStdout?.("from environment\n");
		return ok({ stdout: "", stderr: "", exitCode: 0 });
	}
}

describe("shared Bash host contract", () => {
	let cwd: string;
	const artifacts: string[] = [];
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-bash-contract-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		for (const artifact of artifacts.splice(0)) rmSync(artifact, { force: true });
	});

	it("uses the core schema and keeps default scheduling unchanged", () => {
		const definition = createBashToolDefinition(cwd);
		expect(definition.parameters).toEqual(createCoreBashTool().parameters);
		expect(definition.parameters.properties.cwd).toBeDefined();
		expect(definition.executionMode).toBeUndefined();
	});

	it.each(["absolute", "relative"])("resolves local cwd from a %s-bound tool", async (binding) => {
		mkdirSync(join(cwd, "sub"));
		const tool = createBashTool(binding === "absolute" ? cwd : relative(process.cwd(), cwd));
		const initial = await tool.execute("initial-cwd", { command: "pwd" });
		expect(initial.details).toMatchObject({ cwd, exitCode: 0 });
		const result = await tool.execute("local-cwd", { command: "pwd", cwd: "sub" });
		expect(result.details).toMatchObject({ cwd: join(cwd, "sub"), exitCode: 0 });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("/sub") });
	});

	it("keeps opaque remote Operations paths and spawn hooks out of local filesystem validation", async () => {
		let calls = 0;
		const tool = createBashTool("/not-present-locally", {
			exposeSessionEnvironment: false,
			commandPrefix: "prefix",
			spawnHook: (execution) => ({
				...execution,
				cwd: "/remote/work",
				command: `${execution.command}\nhook`,
				env: { HOOK: "present" },
			}),
			operations: {
				exec: async (command, actualCwd, options) => {
					calls++;
					expect(command).toBe("prefix\ncommand\nhook");
					expect(actualCwd).toBe("/remote/work");
					expect(options.env).toEqual({ HOOK: "present" });
					options.onData(Buffer.from("remote\n"));
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute("remote", { command: "command", cwd: "nested" });
		expect(calls).toBe(1);
		expect(result.details).toMatchObject({ cwd: "/remote/work", exitCode: 0 });
	});

	it.each(["/remote/work", "~/remote-work", "remote-root"])(
		"preserves opaque Operations cwd without local path normalization (%s)",
		async (remoteCwd) => {
			const directories: string[] = [];
			const tool = createBashTool(remoteCwd, {
				operations: {
					exec: async (_command, actualCwd) => {
						directories.push(actualCwd);
						return { exitCode: 0 };
					},
				},
			});
			await tool.execute("default", { command: "verify" });
			await tool.execute("explicit", { command: "verify", cwd: "~/other-remote" });
			expect(directories).toEqual([remoteCwd, "~/other-remote"]);
		},
	);

	it("uses an injected environment with the same core result contract", async () => {
		const env = new RecordingEnv({ cwd });
		const tool = createBashTool(cwd, {
			executionEnv: env,
			exposeSessionEnvironment: false,
			commandPrefix: "prefix",
			spawnHook: (execution) => ({ ...execution, env: { ONLY: "explicit" } }),
		});
		const result = await tool.execute("env", { command: "command", timeout: 3 });
		expect(env.command).toBe("prefix\ncommand");
		expect(env.options).toMatchObject({
			cwd,
			env: { ONLY: "explicit" },
			inheritEnv: false,
			timeout: 3,
			captureOutput: false,
		});
		expect(result.details).toMatchObject({ exitCode: 0, terminationReason: "exit" });
		expect(result.content[0]).toMatchObject({ text: "from environment\n" });
		await env.cleanup();
	});

	it.each([
		{ signal: "SIGTERM", code: "SIGNAL", reason: "signal" },
		{ signal: undefined, code: "UNKNOWN_TERMINATION", reason: null },
	])("never treats a null exit as success ($code)", async ({ signal, code, reason }) => {
		const tool = createBashTool(cwd, { operations: { exec: async () => ({ exitCode: null, signal }) } });
		await expect(tool.execute("terminated", { command: "terminate" })).rejects.toMatchObject({
			code,
			details: { exitCode: null, signal: signal ?? null, terminationReason: reason, terminationRequested: false },
		});
	});

	it("preserves native raw log bytes rather than persisting decoded replacement characters", async () => {
		const raw = Buffer.from([0xff, 0, 0xf0, 0x9f, 0x98, 0x80]);
		const bytes = Buffer.concat(Array.from({ length: 10_000 }, () => raw));
		const tool = createBashTool(cwd, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(bytes.subarray(0, 3));
					onData(bytes.subarray(3));
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute("bytes", { command: "emit bytes" });
		const path = result.details?.fullOutputPath;
		if (!path) throw new Error("Expected a persisted full output artifact");
		artifacts.push(path);
		expect(readFileSync(path)).toEqual(bytes);
	});

	it("throws the shared structured tool error for native nonzero exits", async () => {
		const tool = createBashTool(cwd, { operations: { exec: async () => ({ exitCode: 4 }) } });
		await expect(tool.execute("failed", { command: "fail" })).rejects.toBeInstanceOf(AgentToolError);
	});

	it("rejects ambiguous host transport configuration", () => {
		const env = new RecordingEnv({ cwd });
		expect(() =>
			createBashTool(cwd, { executionEnv: env, operations: { exec: async () => ({ exitCode: 0 }) } }),
		).toThrow("Choose BashOperations or executionEnv");
	});
});
