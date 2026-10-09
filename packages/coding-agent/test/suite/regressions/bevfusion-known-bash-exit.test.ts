import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { TaskRecoveryJournal } from "../../../src/core/task-recovery.ts";
import { createBashTool } from "../../../src/core/tools/bash.ts";
import { createHarness, type Harness } from "../harness.ts";

const command = "pwd; git branch --show-current; ls -l /missing/ssh-control-03";
const call = { type: "toolCall" as const, id: "inspection", name: "bash", arguments: { command } };
const details = {
	command,
	cwd: "/workspace",
	exitCode: 2,
	signal: null,
	terminationReason: "exit",
	terminationRequested: false,
	timedOut: false,
	durationMs: 42,
};
const diagnostic: ToolResultMessage = {
	role: "toolResult",
	toolCallId: call.id,
	toolName: "bash",
	content: [{ type: "text", text: "No such file or directory\nCommand exited with code 2" }],
	details,
	isError: true,
	timestamp: 2,
};

describe("bevfusion confirmed Bash failures", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
	});

	it.each([1, 2])("continues after a captured exit code %s without reconciliation", async (exitCode) => {
		let executions = 0;
		const harness = await createHarness({
			hfCompaction: { mode: "off" },
			tools: [
				createBashTool("/workspace", {
					operations: {
						exec: async (_command, _cwd, options) => {
							executions++;
							options.onData(Buffer.from("missing control file"));
							return { exitCode };
						},
					},
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([call], { stopReason: "toolUse" }),
			fauxAssistantMessage("inspect another path"),
		]);
		await harness.session.prompt("continue the task");
		expect(executions).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.taskRecovery?.status).toBe("completed");
		expect(harness.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
			details: { exitCode, terminationReason: "exit" },
		});
	});

	it.each(["resume", "newPrompt", "startup", "suspended"])(
		"recovers an earlier diagnostic-only result without replay: mode=%s",
		async (mode) => {
			const suspended = mode === "suspended";
			const manager = SessionManager.inMemory();
			const journal = new TaskRecoveryJournal(manager);
			const user = { role: "user" as const, content: "task", timestamp: 1 };
			journal.start([user]);
			manager.appendMessage(user, journal.state!.promptEntryIds[0]);
			const assistant = fauxAssistantMessage([call], { stopReason: "toolUse" });
			journal.beginStep(assistant);
			journal.commitAssistant(assistant, manager.appendMessage(assistant));
			journal.dispatch(call, call.arguments, false);
			manager.appendCustomEntry("pi-tool-interruption", { message: diagnostic });
			const state = journal.state!;
			state.status = "needs_reconciliation";
			state.tools[0].result = undefined;
			if (suspended) {
				const leafId = manager.getLeafId()!;
				const { suspendedTasks: _suspended, ...paused } = state;
				manager.appendCustomEntry("pi-task-recovery", {
					...state,
					id: "new-task",
					status: "completed",
					tools: [],
					step: undefined,
					suspendedTasks: [{ leafId, state: paused }],
				});
			} else manager.appendCustomEntry("pi-task-recovery", state);
			let executions = 0;
			const harness = await createHarness({
				sessionManager: manager,
				hfCompaction: { mode: "off" },
				tools: [
					createBashTool("/workspace", {
						operations: {
							exec: async () => {
								executions++;
								return { exitCode: 0 };
							},
						},
					}),
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("continued")]);
			if (mode === "newPrompt") await harness.session.prompt("continue with another inspection");
			else if (mode === "startup") await harness.session.bindExtensions({ mode: "print" });
			else await harness.session.resumeTask(suspended ? state.id : undefined);
			expect(executions).toBe(0);
			expect(harness.session.taskRecovery?.status).toBe("completed");
			expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
			expect(harness.session.messages.find((message) => message.role === "toolResult")).toMatchObject(diagnostic);
		},
	);

	it("automatically inspects an uncertain Bash outcome and continues the dependent queue within one user turn", async () => {
		let executions = 0;
		const harness = await createHarness({
			hfCompaction: { mode: "off" },
			tools: [
				createBashTool("/workspace", {
					operations: {
						exec: async () => {
							executions++;
							await harness.session.followUp("dependent step");
							throw new Error("ECONNRESET after dispatch");
						},
					},
				}),
				{
					name: "inspect",
					label: "inspect",
					description: "read recorded completion",
					parameters: Type.Object({}),
					contract: { readOnly: true },
					execute: async () => ({ content: [{ type: "text", text: "completion receipt exists" }], details: {} }),
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([call], { stopReason: "toolUse" }),
			fauxAssistantMessage([{ type: "toolCall", id: "evidence", name: "inspect", arguments: {} }], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					{
						type: "toolCall",
						id: "record",
						name: "reconcile_task",
						arguments: {
							toolCallId: call.id,
							evidenceToolCallIds: ["evidence"],
							observedOutcome: "completion receipt confirms the operation finished",
							outcome: "succeeded",
						},
					},
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("original task continued"),
			fauxAssistantMessage("dependent task completed"),
		]);
		await harness.session.prompt("perform the original task");
		expect(executions).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.taskRecovery?.status).toBe("completed");
		expect(harness.session.suspendedTaskRecovery[0].state.tools[0].result).toMatchObject({
			isError: false,
			details: { reconciliation: "inspection" },
		});
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("does not start automatic investigation after the user cancels a running tool", async () => {
		let enter: () => void = () => undefined;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const harness = await createHarness({
			hfCompaction: { mode: "off" },
			tools: [
				createBashTool("/workspace", {
					operations: {
						exec: async (_command, _cwd, options) =>
							new Promise((_resolve, reject) => {
								options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
								enter();
							}),
					},
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([call], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not investigate"),
		]);
		const running = harness.session.prompt("task");
		await entered;
		await harness.session.abort();
		await running;
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.suspendedTaskRecovery).toHaveLength(0);
	});

	it.each(["timeout", "aborted", "signal", null])("keeps %s diagnostics unresolved", (terminationReason) => {
		const manager = SessionManager.inMemory();
		const journal = new TaskRecoveryJournal(manager);
		journal.start([]);
		journal.dispatch(call, call.arguments, false);
		manager.appendCustomEntry("pi-tool-interruption", {
			message: { ...diagnostic, details: { ...details, terminationReason, exitCode: null } },
		});
		expect(journal.unknownTools).toHaveLength(1);
	});
});
