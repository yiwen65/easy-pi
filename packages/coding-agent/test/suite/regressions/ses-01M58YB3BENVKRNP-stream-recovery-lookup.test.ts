import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRecoveryJournal } from "../../../src/core/task-recovery.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

describe("ses_01M58YB3BENVKRNP: streaming recovery lookups", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
		vi.restoreAllMocks();
	});

	it("skips recovery state reads for stream updates but captures tool receipt ownership before extensions", async () => {
		const state = vi.spyOn(TaskRecoveryJournal.prototype, "state", "get");
		const subscribe = Agent.prototype.subscribe;
		const updates: Array<{ type: string; reads: number }> = [];
		let readsAtEventStart = 0;
		// Observe each real subscriber boundary without replacing the session event handler.
		vi.spyOn(Agent.prototype, "subscribe").mockImplementation(function (this: Agent, listener) {
			return subscribe.call(this, async (event, signal) => {
				const before = state.mock.calls.length;
				readsAtEventStart = before;
				await listener(event, signal);
				if (event.type === "message_update") {
					updates.push({ type: event.assistantMessageEvent.type, reads: state.mock.calls.length - before });
				}
			});
		});
		const receipt = vi.spyOn(TaskRecoveryJournal.prototype, "recordResultEntry");
		const readsBeforeToolExtension: number[] = [];
		const harness = await createHarness({
			hfCompaction: { mode: "off" },
			tools: [
				{
					name: "inspect",
					label: "Inspect",
					description: "Offline read-only inspection",
					parameters: Type.Object({}),
					contract: { readOnly: true },
					execute: async () => ({ content: [{ type: "text", text: "raw result" }], details: {} }),
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role !== "toolResult") return;
						readsBeforeToolExtension.push(state.mock.calls.length - readsAtEventStart);
						await Promise.resolve();
						return { message: { ...event.message, content: [{ type: "text", text: "transformed result" }] } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					{ type: "thinking", thinking: "Inspect the recorded state before answering." },
					{ type: "text", text: "Checking the recorded state." },
					fauxToolCall("inspect", {}, { id: "inspection" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Inspection complete."),
		]);
		await harness.session.prompt("inspect the state");

		expect(updates.length).toBeGreaterThan(0);
		for (const type of ["thinking_delta", "text_delta", "toolcall_delta"])
			expect(updates.some((update) => update.type === type)).toBe(true);
		expect(updates.filter((update) => update.reads !== 0)).toEqual([]);
		expect(readsBeforeToolExtension).toEqual([1]);
		const branch = harness.sessionManager.getBranch();
		const source = branch.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((block) => block.type === "toolCall" && block.id === "inspection"),
		);
		const results = branch.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(source).toBeDefined();
		expect(results).toHaveLength(1);
		const result = results[0];
		if (result.type !== "message") throw new Error("Missing canonical result");
		expect(getMessageText(result.message)).toBe("transformed result");
		expect(
			receipt.mock.calls.map(([id, message, entryId]) => ({ id, text: getMessageText(message), entryId })),
		).toEqual([
			{ id: source!.id, text: "transformed result", entryId: undefined },
			{ id: source!.id, text: "transformed result", entryId: result.id },
		]);
		expect(new TaskRecoveryJournal(harness.sessionManager).resultEntrySources.get(result.id)).toBe(source!.id);
		expect(harness.faux.state.callCount).toBe(2);
	});
});
