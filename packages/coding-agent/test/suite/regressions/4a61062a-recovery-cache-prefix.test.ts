import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../../../../ai/src/api/openai-responses-shared.ts";
import { preservesProviderContextPrefix } from "../../../src/core/compaction/subsystem/context-identity.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { TaskRecoveryJournal } from "../../../src/core/task-recovery.ts";
import { createHarness, type Harness } from "../harness.ts";

const pendingCall = { type: "toolCall" as const, id: "unknown-computer", name: "computer", arguments: {} };
const inspection: AgentTool = {
	name: "inspect",
	label: "inspect",
	description: "Read-only offline inspection",
	parameters: Type.Object({}),
	contract: { readOnly: true },
	execute: async () => ({ content: [{ type: "text", text: "observed state" }], details: {} }),
};

describe("suspended recovery prompt cache continuity", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function fixture(manager?: SessionManager) {
		if (!manager) {
			const dir = mkdtempSync(join(tmpdir(), "pi-recovery-prefix-"));
			dirs.push(dir);
			manager = SessionManager.create(dir, dir);
			const journal = new TaskRecoveryJournal(manager);
			const user = { role: "user" as const, content: "original task", timestamp: 1 };
			journal.start([user]);
			manager.appendMessage(user, journal.state!.promptEntryIds[0]);
			const assistant = fauxAssistantMessage([pendingCall], { stopReason: "toolUse" });
			journal.beginStep(assistant);
			journal.commitAssistant(assistant, manager.appendMessage(assistant));
			journal.dispatch(pendingCall, {}, false);
		}
		const harness = await createHarness({
			sessionManager: SessionManager.open(manager.getSessionFile()!),
			tools: [inspection],
			// Harnesses have distinct temporary cwd values; hold the actual request policy fixed.
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({ systemPrompt: "Fixed request policy." }));
				},
			],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		const contexts: Context[] = [];
		harness.session.agent.onProviderContext = (_model, context) =>
			contexts.push(
				structuredClone({
					systemPrompt: context.systemPrompt,
					messages: context.messages,
					tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
				}),
			);
		return { harness, contexts };
	}

	it("preserves the system and Responses wire prefix across tool turns and session reopening", async () => {
		const { harness, contexts } = await fixture();
		harness.setResponses([
			fauxAssistantMessage([{ type: "toolCall", id: "inspect-1", name: "inspect", arguments: {} }], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([{ type: "toolCall", id: "inspect-2", name: "inspect", arguments: {} }], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("independent work finished"),
		]);
		await harness.session.prompt("continue independent work");
		expect(contexts).toHaveLength(3);
		for (let index = 1; index < contexts.length; index++) {
			expect(preservesProviderContextPrefix(contexts[index - 1], contexts[index])).toBe(true);
			const model = { ...harness.getModel(), api: "openai-codex-responses" as const, provider: "openai-codex" };
			const before = convertResponsesMessages(model, contexts[index - 1], new Set(["openai-codex"]));
			const after = convertResponsesMessages(model, contexts[index], new Set(["openai-codex"]));
			expect(after.slice(0, before.length)).toEqual(before);
		}
		expect(contexts[0].systemPrompt).toContain("Previous tasks are paused");
		expect(contexts[0].systemPrompt).toContain(pendingCall.id);
		expect(JSON.stringify(contexts[0].messages)).not.toContain(pendingCall.id);
		expect(JSON.stringify(contexts[0].messages)).not.toContain("Previous tasks are paused");
		expect(harness.session.suspendedTaskRecovery[0].state.tools[0].result).toBeUndefined();
		const reopened = await fixture(harness.sessionManager);
		reopened.harness.setResponses([fauxAssistantMessage("continued after reopening")]);
		await reopened.harness.session.prompt("another independent task");
		expect(preservesProviderContextPrefix(contexts[2], reopened.contexts[0])).toBe(true);
	});

	it("updates recovery facts after verified reconciliation and then preserves subsequent prefixes", async () => {
		const { harness, contexts } = await fixture();
		harness.setResponses([
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
							toolCallId: pendingCall.id,
							evidenceToolCallIds: ["evidence"],
							observedOutcome: "external state confirms completion",
							outcome: "succeeded",
						},
					},
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([{ type: "toolCall", id: "inspect-after", name: "inspect", arguments: {} }], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect and reconcile the old operation");
		expect(contexts).toHaveLength(4);
		expect(contexts[0].systemPrompt).toContain("Previous tasks are paused");
		expect(contexts[0].systemPrompt).toBe(contexts[1].systemPrompt);
		expect(contexts[2].systemPrompt).toContain("external state confirms completion");
		expect(contexts[2].systemPrompt).not.toBe(contexts[1].systemPrompt);
		expect(preservesProviderContextPrefix(contexts[2], contexts[3])).toBe(true);
		expect(harness.session.suspendedTaskRecovery[0].state.tools[0].result?.isError).toBe(false);
	});
});
