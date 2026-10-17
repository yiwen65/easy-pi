import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import { createBashToolDefinition } from "../../../src/core/tools/bash.ts";
import { createEasyPiHarness } from "../../../src/extensions/easy-pi.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.shutdown();
		harness.cleanup();
	}
});

it.each([false, true])("checks invocation cwd before injected Bash execution (relative=%s)", async (relative) => {
	const calls: Array<{ command: string; cwd: string }> = [];
	const harness = await createHarness({
		hfCompaction: { mode: "off" },
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		initialActiveToolNames: ["bash"],
		allowedToolNames: ["bash"],
		extensionFactories: [
			createEasyPiHarness({
				nativeSession: {
					getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: ["/tmp/inherited"] }),
					registerTools: () => {},
				},
			}),
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					pi.registerTool(
						createBashToolDefinition(ctx.cwd, {
							// The backend only records arguments: no shell or deletion is executed.
							operations: {
								exec: async (command, cwd) => {
									calls.push({ command, cwd: resolve(ctx.cwd, cwd) });
									return { exitCode: 0 };
								},
							},
						}),
					);
				});
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "rpc" });
	const parentCwd = relative ? ".." : dirname(harness.tempDir);
	const scratchCwd = relative ? "./scratch" : `${harness.tempDir}-scratch`;
	const inputs = [
		{ command: `rm -rf ${basename(harness.tempDir)}`, cwd: parentCwd },
		{ command: "rm -rf inherited", cwd: "/tmp" },
		{ command: "rm -rf .", cwd: scratchCwd },
	];
	harness.setResponses([
		fauxAssistantMessage(
			inputs.map((input) => fauxToolCall("bash", input)),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("Exercise synthetic cleanup decisions without launching a shell");
	const results = harness.session.messages.filter((message) => message.role === "toolResult");
	expect(results).toHaveLength(3);
	expect(getMessageText(results[0])).toContain("protected root");
	expect(getMessageText(results[1])).toContain("protected root");
	expect(results[2]).toMatchObject({ isError: false });
	expect(calls).toEqual([{ command: "rm -rf .", cwd: resolve(harness.tempDir, scratchCwd) }]);
});

it.each(["pwd", "rm -rf ."])("blocks parent deletion via symlink cwd (%s first)", async (firstCommand) => {
	const calls: Array<{ command: string; physicalCwd: string }> = [];
	const firstFinished = Promise.withResolvers<void>();
	const harness = await createHarness({
		hfCompaction: { mode: "off" },
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		initialActiveToolNames: ["bash"],
		allowedToolNames: ["bash"],
		extensionFactories: [
			createEasyPiHarness({
				nativeSession: {
					getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
					registerTools: () => {},
				},
			}),
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					pi.registerTool(
						createBashToolDefinition(ctx.cwd, {
							operations: {
								// Resolve the directory a spawned process would enter, but never run the command.
								exec: async (command, cwd) => {
									const physicalCwd = await realpath(resolve(ctx.cwd, cwd));
									if (command !== firstCommand) await firstFinished.promise;
									calls.push({ command, physicalCwd });
									if (command === firstCommand) firstFinished.resolve();
									return { exitCode: 0 };
								},
							},
						}),
					);
				});
			},
		],
	});
	harnesses.push(harness);
	const outside = await mkdtemp(join(tmpdir(), "pi-cwd-outside-"));
	try {
		const subdirectory = join(harness.tempDir, "sub");
		const entry = join(outside, "entry");
		await mkdir(subdirectory);
		await symlink(subdirectory, entry);
		await harness.session.bindExtensions({ mode: "rpc" });
		harness.setResponses([
			fauxAssistantMessage(
				["rm -rf ../*", "rm -rf .", "pwd"].map((command) => fauxToolCall("bash", { command, cwd: entry })),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Assess symlink cwd cleanup using only the injected recorder");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(3);
		expect(getMessageText(results[0])).toContain("protected root");
		expect(results.slice(1)).toMatchObject([{ isError: false }, { isError: false }]);
		const physicalCwd = await realpath(subdirectory);
		// Parallel fake executions may finish their realpath reads in either order.
		expect(calls).toHaveLength(2);
		expect(calls[0]?.command).toBe(firstCommand);
		expect(calls).toEqual(
			expect.arrayContaining([
				{ command: "rm -rf .", physicalCwd },
				{ command: "pwd", physicalCwd },
			]),
		);
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
});
