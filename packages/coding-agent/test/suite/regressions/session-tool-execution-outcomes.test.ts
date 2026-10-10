import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentTool, InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { BackgroundTaskManager, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createAssistantMessageEventStream, createModels, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundTaskToolDefinitions } from "../../../src/core/tools/background-tasks.ts";
import { createBashTool } from "../../../src/core/tools/bash.ts";
import { createLsTool } from "../../../src/core/tools/ls.ts";
import { wrapToolDefinition } from "../../../src/core/tools/tool-definition-wrapper.ts";
import { createCodingAgentHarness } from "../../../src/server/create-harness.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const managers: BackgroundTaskManager[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.shutdown();
		harness.cleanup();
	}
	for (const manager of managers.splice(0)) await manager.cleanup();
});
async function fixture(tool: AgentTool, args: Record<string, unknown>) {
	const h = await createHarness({
		tools: [tool],
		hfCompaction: { mode: "off" },
		settings: { retry: { enabled: false } },
	});
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage([{ type: "toolCall", id: "probe", name: tool.name, arguments: args }], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("next model turn"),
	]);
	return h;
}
function manager() {
	const m = new BackgroundTaskManager({
		shell: async () => {
			throw new Error("No process spawning allowed");
		},
		stallTimeoutMs: 0,
	});
	managers.push(m);
	return m;
}
describe("tool execution certainty", () => {
	it("reports a missing directory without suspending the task", async () => {
		const h = await fixture(createLsTool(process.cwd()), { path: "/tmp/epi-audit-nonexistent-52d81" });
		await h.session.prompt("list");
		expect(h.session.suspendedTaskRecovery).toEqual([]);
		expect(h.session.taskRecovery?.status).toBe("completed");
	});
	it.each(["task_output", "wait_for"])("reports a missing task in %s without suspending the task", async (name) => {
		const definition = createBackgroundTaskToolDefinitions(process.cwd(), manager()).find((t) => t.name === name)!;
		const h = await fixture(wrapToolDefinition(definition), { task_id: "task-from-previous-process" });
		await h.session.prompt("inspect progress");
		expect(h.session.suspendedTaskRecovery).toEqual([]);
		expect(h.session.taskRecovery?.status).toBe("completed");
	});
	it.each(["empty", "timeout"])(
		"Bash %s validation returns a known failure without starting a command",
		async (kind) => {
			let executions = 0;
			const bash = createBashTool(process.cwd(), {
				operations: {
					exec: async () => {
						executions++;
						return { exitCode: 0 };
					},
				},
			});
			const h = await fixture(bash, kind === "empty" ? { command: " " } : { command: "echo probe", timeout: -1 });
			await h.session.prompt("command");
			expect(executions).toBe(0);
			expect(h.session.suspendedTaskRecovery).toEqual([]);
			expect(h.session.taskRecovery?.status).toBe("completed");
		},
	);
	it("keeps confirmed execution independent of a hook business error", async () => {
		let executions = 0;
		const h = await createHarness({
			tools: [
				{
					name: "effect",
					label: "effect",
					description: "offline",
					parameters: Type.Object({}),
					execute: async () => {
						executions++;
						return {
							content: [{ type: "text", text: "request rejected by remote validation" }],
							details: { status: 400 },
						};
					},
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", () => ({ isError: true }));
				},
			],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
		});
		harnesses.push(h);
		await h.session.bindExtensions({ mode: "print" });
		h.setResponses([
			fauxAssistantMessage([{ type: "toolCall", id: "probe", name: "effect", arguments: {} }], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("after inspection"),
		]);
		await h.session.prompt("perform");
		expect(executions).toBe(1);
		expect(h.session.suspendedTaskRecovery).toEqual([]);
		expect(h.session.taskRecovery?.status).toBe("completed");
	});
	it("an unsafe tool's rejected execution remains protected", async () => {
		const h = await fixture(
			{
				name: "effect",
				label: "effect",
				description: "offline",
				parameters: Type.Object({}),
				execute: async () => {
					throw new Error("ECONNRESET after dispatch");
				},
			},
			{},
		);
		await h.session.prompt("perform");
		expect(h.session.suspendedTaskRecovery[0]?.state.status).toBe("needs_reconciliation");
	});
	it("a presentation hook cannot turn an unknown execution into a confirmed result", async () => {
		let executions = 0;
		const h = await fixture(
			{
				name: "effect",
				label: "effect",
				description: "offline",
				parameters: Type.Object({}),
				execute: async () => {
					executions++;
					throw new Error("ECONNRESET after remote commit");
				},
			},
			{},
		);
		h.session.agent.afterToolCall = async () => ({ isError: false, details: { executionOutcome: "not_started" } });
		await h.session.prompt("perform");
		expect(h.session.suspendedTaskRecovery[0]?.state.status).toBe("needs_reconciliation");
		expect(executions).toBe(1);
	});
	it.each(["edit", "read"] as const)("the server Harness continues after a known %s failure", async (name) => {
		const host = await createHarness({ tools: [], hfCompaction: { mode: "off" } });
		harnesses.push(host);
		const path = join(host.tempDir, "original.txt");
		writeFileSync(path, "original\n");
		const session = new Session(new InMemorySessionStorage({ id: "audit-server", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: host.tempDir });
		let requests = 0;
		const { harness } = await createCodingAgentHarness({
			session,
			env,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			streamFn: () => {
				requests++;
				const stream = createAssistantMessageEventStream();
				stream.end(
					requests === 1
						? fauxAssistantMessage(
								[
									{
										type: "toolCall",
										id: "edit-audit",
										name,
										arguments:
											name === "edit"
												? { path, edits: [{ oldText: "missing", newText: "updated" }] }
												: { path: join(host.tempDir, "absent.txt") },
									},
								],
								{ stopReason: "toolUse" },
							)
						: fauxAssistantMessage("correct the input"),
				);
				return stream;
			},
		});
		try {
			const outcome = await harness.prompt("edit the file");
			expect(outcome.ok && outcome.value.kind).toBe("completed");
			expect(readFileSync(path, "utf8")).toBe("original\n");
			expect(requests).toBe(2);
		} finally {
			await harness.close();
			await env.cleanup();
		}
	});
	it("the server Harness preserves a write that started but failed to return a result", async () => {
		const host = await createHarness({ tools: [], hfCompaction: { mode: "off" } });
		harnesses.push(host);
		const path = join(host.tempDir, "uncertain.txt");
		writeFileSync(path, "original\n");
		const session = new Session(new InMemorySessionStorage({ id: "uncertain-server", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: host.tempDir });
		let writes = 0;
		vi.spyOn(env, "writeFile").mockImplementation(async () => {
			writes++;
			writeFileSync(path, "updated\n");
			throw new Error("write response lost");
		});
		let requests = 0;
		const { harness } = await createCodingAgentHarness({
			session,
			env,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			streamFn: () => {
				requests++;
				const stream = createAssistantMessageEventStream();
				stream.end(
					fauxAssistantMessage(
						[
							{
								type: "toolCall",
								id: "uncertain",
								name: "edit",
								arguments: { path, edits: [{ oldText: "original", newText: "updated" }] },
							},
						],
						{ stopReason: "toolUse" },
					),
				);
				return stream;
			},
		});
		try {
			const outcome = await harness.prompt("edit");
			expect(outcome.ok && outcome.value.kind).toBe("needs_reconciliation");
			const resumed = await harness.resume();
			expect(resumed.ok && resumed.value.kind).toBe("needs_reconciliation");
			expect(readFileSync(path, "utf8")).toBe("updated\n");
			expect(writes).toBe(1);
			expect(requests).toBe(1);
		} finally {
			await harness.close();
			await env.cleanup();
		}
	});
});
