import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import webSearchExtension from "../../../../pi-web-search/src/index.ts";
import { createEditTool } from "../../../src/core/tools/edit.ts";
import { createHarness, type Harness } from "../harness.ts";

vi.mock("../../../../pi-web-search/src/browser.ts", () => ({
	readPage: vi.fn(async () => {
		throw new Error("Could not load the webpage (net::ERR_TUNNEL_CONNECTION_FAILED).");
	}),
}));

describe("session continues after known tool failures", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
	});

	it("reports a rejected edit to the model without suspending the task or changing the file", async () => {
		const harness = await createHarness({ tools: [createEditTool(process.cwd())], hfCompaction: { mode: "off" } });
		harnesses.push(harness);
		const path = join(harness.tempDir, "task.md");
		const original = "Status: pending\nNext: waiting\n";
		writeFileSync(path, original);
		harness.setResponses([
			fauxAssistantMessage(
				[
					{
						type: "toolCall",
						id: "rejected-edit",
						name: "edit",
						arguments: {
							path,
							edits: [
								{ oldText: "Status: pending", newText: "Status: done" },
								{ oldText: "Status: done\nNext: waiting", newText: "Status: done\nNext: ready" },
							],
						},
					},
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("I can correct the edit using the original text."),
		]);
		await harness.session.prompt("update the task document");
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(harness.session.taskRecovery?.status).toBe("completed");
		expect(harness.session.suspendedTaskRecovery).toEqual([]);
		expect(harness.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
			toolCallId: "rejected-edit",
			isError: true,
			details: { executionOutcome: "not_started" },
		});
	});

	it("preserves uncertainty when a write fails after starting", async () => {
		const harness = await createHarness({
			tools: [
				createEditTool(process.cwd(), {
					operations: {
						access: async () => {},
						readFile: async () => Buffer.from("original"),
						writeFile: async () => {
							throw new Error("write outcome unknown");
						},
					},
				}),
			],
			hfCompaction: { mode: "off" },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					{
						type: "toolCall",
						id: "uncertain-edit",
						name: "edit",
						arguments: {
							path: join(harness.tempDir, "file"),
							edits: [{ oldText: "original", newText: "updated" }],
						},
					},
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Inspection needed."),
		]);
		await harness.session.prompt("edit");
		expect(harness.session.suspendedTaskRecovery).toMatchObject([{ state: { status: "needs_reconciliation" } }]);
	});

	it("returns a failed anonymous webpage read as a tool result and continues the same task", async () => {
		const harness = await createHarness({
			tools: [],
			extensionFactories: [webSearchExtension],
			initialActiveToolNames: ["web_fetch"],
			hfCompaction: { mode: "off" },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });
		harness.setResponses([
			fauxAssistantMessage(
				[
					{
						type: "toolCall",
						id: "failed-fetch",
						name: "web_fetch",
						arguments: { url: "https://docs.gitlab.com/", max_chars: 8000 },
					},
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The page failed to load; I can continue independent work."),
		]);
		await harness.session.prompt("read the documentation");
		expect(harness.session.taskRecovery?.status).toBe("completed");
		expect(harness.session.suspendedTaskRecovery).toEqual([]);
		expect(harness.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
			toolCallId: "failed-fetch",
			isError: true,
		});
	});
});
