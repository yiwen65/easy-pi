import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preservesProviderContextPrefix } from "../../../src/core/compaction/subsystem/context-identity.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { TaskRecoveryJournal } from "../../../src/core/task-recovery.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("removed computer capture recovery", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function seed(suspended = false, op = "capture", mixed = false) {
		const dir = mkdtempSync(join(tmpdir(), "pi-retired-capture-"));
		dirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		const journal = new TaskRecoveryJournal(manager);
		const user = { role: "user" as const, content: "old task", timestamp: 1 };
		journal.start([user]);
		manager.appendMessage(user, journal.state!.promptEntryIds[0]);
		const call = {
			type: "toolCall" as const,
			id: "lost-capture",
			name: "computer",
			arguments: { request: { op, maxDimension: 1400 } },
		};
		const write = { type: "toolCall" as const, id: "lost-write", name: "write", arguments: {} };
		const assistant = fauxAssistantMessage(mixed ? [call, write] : [call], { stopReason: "toolUse" });
		journal.beginStep(assistant);
		journal.commitAssistant(assistant, manager.appendMessage(assistant));
		journal.dispatch(call, call.arguments, false);
		if (mixed) journal.dispatch(write, {}, false);
		journal.update((state) => {
			state.status = "needs_reconciliation";
		});
		const taskId = journal.state!.id;
		if (suspended) {
			journal.start([]);
			journal.update((state) => {
				state.status = "completed";
			});
		}
		return { manager, taskId, before: readFileSync(manager.getSessionFile()!, "utf8") };
	}

	async function fixture(manager: SessionManager, tools: AgentTool[] = [], excludedToolNames?: string[]) {
		const harness = await createHarness({
			sessionManager: SessionManager.open(manager.getSessionFile()!),
			tools,
			excludedToolNames,
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		return harness;
	}

	it.each([false, true])(
		"retires the missing observation without fabricating a result: suspended=%s",
		async (suspended) => {
			const { manager, taskId, before } = seed(suspended);
			const harness = await fixture(manager);
			const state = harness.session.taskRecovery!;
			const retired = suspended ? state.suspendedTasks![0].state : state;
			expect(retired).toMatchObject({
				id: taskId,
				status: "cancelled",
				retirement: "computer_capture_tool_removed",
			});
			expect(retired.tools[0].result).toBeUndefined();
			expect(harness.session.suspendedTaskRecovery).toEqual([]);
			expect(new TaskRecoveryJournal(harness.sessionManager).allUnknownTools).toEqual([]);
			expect(readFileSync(manager.getSessionFile()!, "utf8").startsWith(before)).toBe(true);
			expect(
				harness.session.messages.filter((m) => m.role === "custom" && m.customType === "task-retirement"),
			).toHaveLength(1);
			harness.setResponses([fauxAssistantMessage("new task done")]);
			await harness.session.bindExtensions({ mode: "print" });
			expect(harness.getPendingResponseCount()).toBe(1);
			await expect(harness.session.resumeTask(taskId)).rejects.toThrow("retired");
			await harness.session.prompt("independent task");
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.session.suspendedTaskRecovery).toEqual([]);
			const reopened = await fixture(harness.sessionManager);
			expect(
				reopened.session.messages.filter((m) => m.role === "custom" && m.customType === "task-retirement"),
			).toHaveLength(1);
		},
	);

	it.each(["click", "type", "exec"])(
		"keeps unknown %s effects protected even though computer is absent",
		async (op) => {
			const { manager } = seed(true, op);
			const harness = await fixture(manager);
			expect(harness.session.suspendedTaskRecovery).toHaveLength(1);
			expect(new TaskRecoveryJournal(harness.sessionManager).allUnknownTools).toHaveLength(1);
		},
	);

	it("does not retire a task with a separate unknown write", async () => {
		const { manager } = seed(true, "capture", true);
		const harness = await fixture(manager);
		expect(new TaskRecoveryJournal(harness.sessionManager).allUnknownTools).toHaveLength(2);
		expect(harness.session.suspendedTaskRecovery).toHaveLength(1);
	});

	it.each([undefined, ["computer"]])(
		"does not confuse a disabled installed tool with removal: excluded=%s",
		async (excluded) => {
			const { manager } = seed(true);
			const computer: AgentTool = {
				name: "computer",
				label: "computer",
				description: "installed",
				parameters: Type.Object({}),
				execute: async () => {
					throw new Error("must not execute");
				},
			};
			const harness = await fixture(manager, [computer], excluded);
			expect(harness.session.suspendedTaskRecovery).toHaveLength(1);
		},
	);

	it("keeps the retired capture out of the system layer and preserves consecutive request prefixes", async () => {
		const { manager } = seed(true);
		const inspect: AgentTool = {
			name: "inspect",
			label: "inspect",
			description: "offline observation",
			parameters: Type.Object({}),
			contract: { readOnly: true },
			execute: async () => ({ content: [{ type: "text", text: "observed" }], details: {} }),
		};
		const harness = await fixture(manager, [inspect]);
		const contexts: Context[] = [];
		harness.session.agent.onProviderContext = (_model, context) =>
			contexts.push({
				systemPrompt: context.systemPrompt,
				messages: structuredClone(context.messages),
				tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
			});
		harness.setResponses([
			fauxAssistantMessage([{ type: "toolCall", id: "read-1", name: "inspect", arguments: {} }], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([{ type: "toolCall", id: "read-2", name: "inspect", arguments: {} }], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("finished"),
		]);
		await harness.session.prompt("independent work");
		expect(contexts).toHaveLength(3);
		for (const context of contexts) {
			expect(context.systemPrompt).not.toContain("lost-capture");
			expect(JSON.stringify(context.messages)).not.toContain("Previous tasks are paused");
		}
		expect(preservesProviderContextPrefix(contexts[0], contexts[1])).toBe(true);
		expect(preservesProviderContextPrefix(contexts[1], contexts[2])).toBe(true);
	});

	it("finishes the history notice after a commit-before-notice failure without duplicate notices", async () => {
		const { manager } = seed(true);
		const journal = new TaskRecoveryJournal(manager);
		const notice = vi.spyOn(manager, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("notice write failed");
		});
		expect(() => journal.retireRemovedComputerCaptures(new Set())).toThrow("notice write failed");
		expect(journal.allUnknownTools).toEqual([]);
		notice.mockRestore();
		journal.retireRemovedComputerCaptures(new Set());
		journal.retireRemovedComputerCaptures(new Set());
		expect(
			manager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "task-retirement"),
		).toHaveLength(1);
	});

	it("rejects a retirement flag on an unknown write operation", () => {
		const { manager } = seed(false, "click");
		const journal = new TaskRecoveryJournal(manager);
		manager.appendCustomEntry("pi-task-recovery", {
			...journal.state,
			status: "cancelled",
			retirement: "computer_capture_tool_removed",
		});
		expect(() => journal.state).toThrow("Invalid task retirement record");
	});
});
