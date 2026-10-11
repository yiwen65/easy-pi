import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentTool,
	type BashToolInput,
	type BashToolOptions,
	createBashTool as createCoreBashTool,
	getToolErrorOutcome,
	ok,
	truncateTail,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv, NodeProcessExecutor } from "@earendil-works/pi-agent-core/node";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createBashTool } from "../../../src/core/tools/bash.ts";
import { createEditTool } from "../../../src/core/tools/edit.ts";
import { withFileMutationQueue } from "../../../src/core/tools/file-mutation-queue.ts";
import { createWriteTool } from "../../../src/core/tools/write.ts";
import { createHarness, type Harness } from "../harness.ts";

const directories: string[] = [];
const harnesses: Harness[] = [];
function directory() {
	const dir = mkdtempSync(join(tmpdir(), "pi-b824-io-"));
	directories.push(dir);
	return dir;
}
async function fixture(tool: AgentTool, args: Record<string, unknown>, dir?: string) {
	const h = await createHarness({
		tools: [tool],
		sessionManager: dir ? SessionManager.create(dir, join(dir, "sessions")) : undefined,
		hfCompaction: { mode: "off" },
		settings: { retry: { enabled: false } },
	});
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage(fauxToolCall(tool.name, args, { id: "io" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("continue only if not cancelled"),
	]);
	return h;
}
function persistedResult(h: Harness) {
	return h.sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "io",
		);
}
function expectKnownFailure(h: Harness) {
	expect(h.eventsOfType("agent_start")).toHaveLength(1);
	expect(h.session.suspendedTaskRecovery).toEqual([]);
	expect(h.session.taskRecovery?.status).toBe("completed");
	expect(persistedResult(h)).toMatchObject({ type: "message", message: { isError: true } });
}
function expectAcknowledgedCancellation(h: Harness, name: string) {
	expect(h.eventsOfType("agent_start")).toHaveLength(1);
	expect(h.getPendingResponseCount()).toBe(1);
	expect(h.session.suspendedTaskRecovery).toEqual([]);
	expect(h.session.taskRecovery?.status).toBe("cancelled");
	expect(h.session.taskRecovery?.tools.find((tool) => tool.call.id === "io")?.result).toMatchObject({
		toolName: name,
		isError: false,
	});
	expect(persistedResult(h)).toMatchObject({ type: "message", message: { toolName: name, isError: false } });
	const file = h.sessionManager.getSessionFile();
	if (!file) throw new Error("Expected a durable private session");
	const entries: unknown[] = readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(entries).toContainEqual(
		expect.objectContaining({
			type: "message",
			message: expect.objectContaining({ role: "toolResult", toolCallId: "io", toolName: name, isError: false }),
		}),
	);
}
afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.session.shutdown();
		h.cleanup();
	}
	vi.restoreAllMocks();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session b824062c: I/O execution certainty", () => {
	it("preserves the actual foreground local cwd rejection with executor count zero", async () => {
		const dir = directory();
		const executor = vi.spyOn(NodeProcessExecutor.prototype, "execute");
		const missing = join(dir, "missing");
		const h = await fixture(createBashTool(dir), { command: "printf must-not-run", cwd: missing });
		await h.session.prompt("run");
		expect(executor).not.toHaveBeenCalled();
		expect(existsSync(missing)).toBe(false);
		expectKnownFailure(h);
	});

	it("keeps explicit adapter cancellation unknown and blocks the next planned tool call", async () => {
		const dir = directory();
		const env = new NodeExecutionEnv({ cwd: dir });
		const capture = vi.fn<NonNullable<BashToolOptions["capture"]>>(async () =>
			ok({
				output: "partial",
				truncation: truncateTail("partial"),
				lastLineBytes: 7,
				exitCode: 0,
				cancelled: true,
				truncated: false,
			}),
		);
		const core = createCoreBashTool({ capture });
		const tool: AgentTool = {
			...core,
			// The agent loop validates core.parameters before invoking this fixture facade.
			execute: (id, args, signal) => core.execute(id, args as BashToolInput, signal, undefined, { env }),
		};
		const h = await fixture(tool, { command: "first" });
		h.session.agent.toolExecution = "sequential";
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "first" }, { id: "io" }),
					fauxToolCall("bash", { command: "must-not-run" }, { id: "later" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Investigate the cancelled adapter without repeating the effect."),
		]);
		try {
			await h.session.prompt("run");
			expect(capture).toHaveBeenCalledOnce();
			expect(h.session.suspendedTaskRecovery[0]?.state.status).toBe("needs_reconciliation");
			expect(
				h.session.suspendedTaskRecovery[0]?.state.tools.find((slot) => slot.call.id === "io")?.result,
			).toBeUndefined();
			expect(capture.mock.calls.map(([execution]) => execution.command)).toEqual(["first"]);
			// Lifecycle start events precede admission; actual capture calls prove no later dispatch.
			expect(
				h.eventsOfType("tool_execution_end").filter((event) => event.toolCallId === "later" && !event.isError),
			).toEqual([]);
		} finally {
			await env.cleanup();
		}
	});

	it("preserves regular-file cwd rejection in the actual foreground host with no executor dispatch", async () => {
		const dir = directory();
		const path = join(dir, "file.txt");
		await writeFile(path, "unchanged");
		const executor = vi.spyOn(NodeProcessExecutor.prototype, "execute");
		const h = await fixture(createBashTool(dir), { command: "printf must-not-run", cwd: path });
		await h.session.prompt("run");
		expectKnownFailure(h);
		expect(executor).not.toHaveBeenCalled();
		expect(await readFile(path, "utf8")).toBe("unchanged");
	});

	it("keeps a valid directory symlink usable by the actual foreground host", async () => {
		const dir = directory();
		const target = join(dir, "directory");
		const alias = join(dir, "alias");
		await mkdir(target);
		await symlink(target, alias);
		const h = await fixture(createBashTool(dir), { command: "printf acknowledged", cwd: alias });
		await h.session.prompt("run");
		expect(h.eventsOfType("agent_start")).toHaveLength(1);
		expect(h.session.suspendedTaskRecovery).toEqual([]);
		expect(persistedResult(h)).toMatchObject({ message: { isError: false, details: { exitCode: 0 } } });
	});

	it("preserves the executor's prelaunch cancellation proof through the local Operations adapter", async () => {
		const dir = directory();
		const controller = new AbortController();
		const execute = NodeProcessExecutor.prototype.execute;
		vi.spyOn(NodeProcessExecutor.prototype, "execute").mockImplementation(async function (
			this: NodeProcessExecutor,
			command,
			options,
		) {
			controller.abort();
			return execute.call(this, command, options);
		});
		const args = { command: "printf must-not-run" };
		const error = await createBashTool(dir)
			.execute("cancel-before-launch", args, controller.signal)
			.catch((failure: unknown) => failure);
		expect(getToolErrorOutcome(error, "bash", args)).toBe("not_started");
	});

	it.each(["outside", "symlink"])("preserves pure workspace policy rejection (%s)", async (kind) => {
		const dir = directory();
		const outside = directory();
		const alias = join(dir, "alias");
		await symlink(outside, alias);
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const h = await fixture(
			createBashTool(dir, {
				operations: { exec },
				workspacePolicy: {
					roots: [dir],
					allowOutsideWorkspaceRead: false,
					allowOutsideWorkspaceWrite: false,
					followSymlinks: kind === "outside",
				},
			}),
			{ command: "pwd", cwd: kind === "outside" ? outside : alias },
		);
		await h.session.prompt("run");
		expect(exec).not.toHaveBeenCalled();
		expectKnownFailure(h);
	});

	it("catches an ELOOP queue-key rejection before either mutation callback", async () => {
		const dir = directory();
		const loop = join(dir, "loop");
		await symlink(loop, loop);
		const operations = { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
		const h = await fixture(createWriteTool(dir, { operations }), { path: loop, content: "after" });
		await h.session.prompt("write");
		expect(operations.mkdir).not.toHaveBeenCalled();
		expect(operations.writeFile).not.toHaveBeenCalled();
		expectKnownFailure(h);
	});

	it("classifies cancellation while waiting for a mutation queue as not started", async () => {
		const dir = directory();
		const path = join(dir, "queued.txt");
		let enter = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const owner = withFileMutationQueue(path, async () => {
			enter();
			await gate;
		});
		await entered;
		const operations = { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
		const tool = createWriteTool(dir, { operations });
		const controller = new AbortController();
		const execution = tool.execute("queued", { path, content: "after" }, controller.signal);
		controller.abort();
		release();
		await owner;
		const error = await execution.catch((failure: unknown) => failure);
		expect(getToolErrorOutcome(error, "write", { path })).toBe("not_started");
		expect(operations.mkdir).not.toHaveBeenCalled();
		expect(operations.writeFile).not.toHaveBeenCalled();
	});

	it.each(["write", "edit"] as const)(
		"persists an acknowledged %s result even when the user cancels at the ack boundary",
		async (name) => {
			const dir = directory();
			const path = join(dir, "target.txt");
			await writeFile(path, "before");
			let h: Harness;
			let cancellation: Promise<void> | undefined;
			const ackWrite = async (target: string, content: string) => {
				await writeFile(target, content);
				cancellation = h.session.abort();
			};
			const tool =
				name === "write"
					? createWriteTool(dir, {
							operations: {
								mkdir: async (parent) => {
									await mkdir(parent, { recursive: true });
								},
								writeFile: ackWrite,
							},
						})
					: createEditTool(dir, { operations: { access, readFile, writeFile: ackWrite } });
			const args =
				name === "write" ? { path, content: "after" } : { path, edits: [{ oldText: "before", newText: "after" }] };
			h = await fixture(tool, args, dir);
			h.session.agent.toolExecution = "sequential";
			h.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall(name, args, { id: "io" }),
						fauxToolCall(name, { ...args, path: join(dir, "must-not-run.txt") }, { id: "later" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("must not request a later model step"),
			]);
			await h.session.prompt(name);
			await cancellation;
			expect(await readFile(path, "utf8")).toBe("after");
			expect(existsSync(join(dir, "must-not-run.txt"))).toBe(false);
			expect(h.eventsOfType("tool_execution_start").map((event) => event.toolCallId)).toEqual(["io"]);
			expectAcknowledgedCancellation(h, name);
			if (name === "edit")
				expect(persistedResult(h)).toMatchObject({
					message: { details: { diff: expect.stringContaining("after") } },
				});
		},
	);

	it("persists the actual local executor exit0 despite cancellation after its acknowledgement", async () => {
		const dir = directory();
		const path = join(dir, "marker.txt");
		let h: Harness;
		let cancellation: Promise<void> | undefined;
		const execute = NodeProcessExecutor.prototype.execute;
		const observed: unknown[] = [];
		vi.spyOn(NodeProcessExecutor.prototype, "execute").mockImplementation(async function (
			this: NodeProcessExecutor,
			command,
			options,
		) {
			const result = await execute.call(this, command, options);
			observed.push(result);
			if (result.ok && result.value.exitCode === 0 && result.value.signal === null) cancellation = h.session.abort();
			return result;
		});
		h = await fixture(
			createBashTool(dir, { exposeSessionEnvironment: false }),
			{ command: `printf after > ${JSON.stringify(path)}; printf acknowledged` },
			dir,
		);
		await h.session.prompt("bash");
		await cancellation;
		expect(observed).toEqual([{ ok: true, value: { exitCode: 0, signal: null } }]);
		expect(await readFile(path, "utf8")).toBe("after");
		expectAcknowledgedCancellation(h, "bash");
		expect(persistedResult(h)).toMatchObject({
			message: { details: { exitCode: 0, terminationReason: "exit", signal: null } },
		});
	});

	it.each(["write", "edit"] as const)(
		"keeps a rejected %s acknowledgement unknown even if target bytes changed",
		async (name) => {
			const dir = directory();
			const path = join(dir, "lost.txt");
			await writeFile(path, "before");
			const lostWrite = async (target: string, content: string) => {
				await writeFile(target, content);
				throw new Error("write acknowledgement lost");
			};
			const tool =
				name === "write"
					? createWriteTool(dir, { operations: { mkdir: async () => {}, writeFile: lostWrite } })
					: createEditTool(dir, { operations: { access, readFile, writeFile: lostWrite } });
			const h = await fixture(
				tool,
				name === "write" ? { path, content: "after" } : { path, edits: [{ oldText: "before", newText: "after" }] },
			);
			await h.session.prompt(name);
			expect(await readFile(path, "utf8")).toBe("after");
			expect(h.eventsOfType("agent_start")).toHaveLength(2);
			expect(h.session.suspendedTaskRecovery[0]?.state.status).toBe("needs_reconciliation");
			expect(h.session.suspendedTaskRecovery[0]?.state.tools[0].result).toBeUndefined();
		},
	);

	it("keeps cancellation after mkdir acknowledgement unknown and never invokes the target write", async () => {
		const dir = directory();
		const parent = join(dir, "created");
		const target = join(parent, "target.txt");
		const controller = new AbortController();
		const write = vi.fn(async () => {});
		const tool = createWriteTool(dir, {
			operations: {
				mkdir: async (path) => {
					await mkdir(path);
					controller.abort();
				},
				writeFile: write,
			},
		});
		const args = { path: target, content: "after" };
		const error = await tool.execute("mkdir-only", args, controller.signal).catch((failure: unknown) => failure);
		expect(existsSync(parent)).toBe(true);
		expect(existsSync(target)).toBe(false);
		expect(write).not.toHaveBeenCalled();
		expect(getToolErrorOutcome(error, "write", args)).toBe("unknown");
	});

	it.each(["write", "edit"] as const)("keeps an in-flight %s rejection after cancellation unknown", async (name) => {
		const dir = directory();
		const path = join(dir, "target.txt");
		await writeFile(path, "before");
		const controller = new AbortController();
		let started = () => {};
		const entering = new Promise<void>((resolve) => {
			started = resolve;
		});
		let reject = (_error: Error) => {};
		const gate = new Promise<void>((_resolve, rejectPromise) => {
			reject = rejectPromise;
		});
		const pendingWrite = async () => {
			started();
			await gate;
		};
		const tool: AgentTool =
			name === "write"
				? createWriteTool(dir, { operations: { mkdir: async () => {}, writeFile: pendingWrite } })
				: createEditTool(dir, { operations: { access, readFile, writeFile: pendingWrite } });
		const args =
			name === "write" ? { path, content: "after" } : { path, edits: [{ oldText: "before", newText: "after" }] };
		let settled = false;
		const result = tool
			.execute("in-flight", args, controller.signal)
			.catch((failure: unknown) => failure)
			.finally(() => {
				settled = true;
			});
		await entering;
		controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		reject(new Error("cancelled while acknowledgement was outstanding"));
		const error = await result;
		expect(getToolErrorOutcome(error, name, args)).toBe("unknown");
		expect(await readFile(path, "utf8")).toBe("before");
	});

	it("keeps partial mkdir failure unknown without treating directory creation as target write", async () => {
		const dir = directory();
		const parent = join(dir, "created");
		const target = join(parent, "target.txt");
		const write = vi.fn(async () => {});
		const h = await fixture(
			createWriteTool(dir, {
				operations: {
					mkdir: async (path) => {
						await mkdir(path);
						throw new Error("mkdir response lost after creation");
					},
					writeFile: write,
				},
			}),
			{ path: target, content: "after" },
		);
		await h.session.prompt("write");
		expect(existsSync(parent)).toBe(true);
		expect(existsSync(target)).toBe(false);
		expect(write).not.toHaveBeenCalled();
		expect(h.session.suspendedTaskRecovery[0]?.state.status).toBe("needs_reconciliation");
	});

	it("keeps an opaque foreground spawn_error after dispatch unknown", async () => {
		const dir = directory();
		let calls = 0;
		const h = await fixture(
			createBashTool(dir, {
				operations: {
					exec: async () => {
						calls++;
						throw Object.assign(new Error("Working directory does not exist: opaque lost acknowledgement"), {
							code: "spawn_error",
						});
					},
				},
			}),
			{ command: "effect" },
		);
		await h.session.prompt("bash");
		expect(calls).toBe(1);
		expect(h.session.suspendedTaskRecovery[0]?.state.status).toBe("needs_reconciliation");
	});
});
