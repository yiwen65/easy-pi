import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createEditV2Tool } from "../../src/harness/tools/edit-v2.ts";
import { createReadV2Tool } from "../../src/harness/tools/read-v2.ts";
import { createRunV2Tool } from "../../src/harness/tools/run-v2.ts";
import { createSearchV2Tool } from "../../src/harness/tools/search-v2.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("v2 run", () => {
	it("declares conservative scheduling and replay metadata", () => {
		expect(createSearchV2Tool()).toMatchObject({ executionMode: "parallel", replay: "safe" });
		expect(createReadV2Tool()).toMatchObject({ executionMode: "parallel", replay: "safe" });
		expect(createEditV2Tool()).toMatchObject({ executionMode: "sequential", replay: "never" });
		expect(createRunV2Tool()).toMatchObject({ executionMode: "sequential", replay: "never" });
	});

	it("returns a nonzero exit as a normal result", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const result = await createRunV2Tool().execute(
			"id",
			{ command: "printf failure; exit 1" },
			undefined,
			undefined,
			{ env },
		);
		expect(result.details).toMatchObject({ exitCode: 1, timedOut: false });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("failure") });
	});

	it("returns timeout output as a normal result", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const result = await createRunV2Tool().execute(
			"id",
			{ command: "printf before; sleep 5", timeout: 0.05 },
			undefined,
			undefined,
			{ env },
		);
		expect(result.details).toMatchObject({ exitCode: null, timedOut: true, managedProcessesTerminated: false });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("before") });
	});

	it("terminates the managed process group before a timeout result on Unix", async () => {
		if (process.platform === "win32") return;
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		await createRunV2Tool().execute(
			"id",
			{ command: "sh -c 'echo $$ > managed.pid; sleep 5'", timeout: 0.05 },
			undefined,
			undefined,
			{ env },
		);
		const pid = Number(getOrThrow(await env.readTextFile("managed.pid")));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it("validates cwd as a directory before execution", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		await expect(
			createRunV2Tool().execute("id", { command: "pwd", cwd: "missing" }, undefined, undefined, { env }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("rejects an empty command and describes cwd as non-sandboxing", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir() });
		const tool = createRunV2Tool();
		expect(tool.description).toContain("not a sandbox");
		await expect(tool.execute("id", { command: " " }, undefined, undefined, { env })).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
	});
});
