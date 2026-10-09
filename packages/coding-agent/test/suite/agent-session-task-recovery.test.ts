import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { TaskRecoveryJournal } from "../../src/core/task-recovery.ts";
import { createHarness, type Harness } from "./harness.ts";

const user = { role: "user" as const, content: "task", timestamp: 1 };
const call = (id: string, name = "effect") => ({ type: "toolCall" as const, id, name, arguments: {} });
const result = (id: string, name = "effect"): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text: `result:${id}` }],
	isError: false,
	timestamp: 1,
});

describe("native durable task recovery", () => {
	const dirs: string[] = [];
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function manager() {
		const dir = mkdtempSync(join(tmpdir(), "pi-native-recovery-"));
		dirs.push(dir);
		return SessionManager.create(dir, join(dir, "sessions"));
	}
	async function fixture(sessionManager: SessionManager, tools: AgentTool[] = []) {
		const harness = await createHarness({
			sessionManager: SessionManager.open(sessionManager.getSessionFile()!),
			tools,
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		return harness;
	}
	function seedTools(sessionManager: SessionManager, names: string[]) {
		const journal = new TaskRecoveryJournal(sessionManager);
		journal.start([user]);
		sessionManager.appendMessage(user, journal.state?.promptEntryIds[0]);
		const assistant = fauxAssistantMessage(
			names.map((name) => call(name, name)),
			{ stopReason: "toolUse" },
		);
		journal.beginStep(assistant);
		const id = sessionManager.appendMessage(assistant);
		journal.commitAssistant(assistant, id);
		return { journal, assistant };
	}

	it("opens legacy recovery state while preserving cancelled unknown effects and existing receipts", async () => {
		const sessionManager = manager();
		const { journal } = seedTools(sessionManager, ["effect"]);
		journal.dispatch(call("effect"), {}, false);
		const expectedIds = journal.state?.promptEntryIds;
		const legacy: Record<string, unknown> = { ...journal.state, version: 1, status: "cancelled" };
		delete legacy.promptEntryIds;
		delete legacy.queued;
		sessionManager.appendCustomEntry("pi-task-recovery", legacy);
		const before = readFileSync(sessionManager.getSessionFile()!, "utf8");
		const harness = await fixture(sessionManager);
		expect(harness.session.taskRecovery).toMatchObject({
			version: 2,
			status: "cancelled",
			promptEntryIds: expectedIds,
			queued: [],
			tools: [{ dispatched: true, safe: false }],
		});
		expect(readFileSync(sessionManager.getSessionFile()!, "utf8")).toBe(before);
		await harness.session.bindExtensions({ mode: "print" });
		expect(harness.getPendingResponseCount()).toBe(1);
		await expect(harness.session.resumeTask()).rejects.toThrow("Unknown tool effects");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("upgrades v1 stable receipt IDs and queues without replacing their identities", () => {
		const sessionManager = manager();
		const journal = new TaskRecoveryJournal(sessionManager);
		journal.start([user]);
		journal.queue("followUp", [{ role: "user", content: "queued", timestamp: 2 }], "queued");
		const original = journal.state!;
		sessionManager.appendCustomEntry("pi-task-recovery", { ...original, version: 1 });
		expect(journal.state).toMatchObject({
			version: 2,
			promptEntryIds: original.promptEntryIds,
			queued: original.queued,
		});
	});

	it("uses stable targets for a legacy intent that has not delivered its prompt", async () => {
		const sessionManager = manager();
		const journal = new TaskRecoveryJournal(sessionManager);
		journal.start([user]);
		const legacy: Record<string, unknown> = { ...journal.state, version: 1 };
		delete legacy.promptEntryIds;
		delete legacy.queued;
		sessionManager.appendCustomEntry("pi-task-recovery", legacy);
		const firstIds = journal.state?.promptEntryIds;
		expect(journal.state?.promptEntryIds).toEqual(firstIds);
		const harness = await fixture(sessionManager);
		await harness.session.resumeTask();
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(harness.session.taskRecovery?.version).toBe(2);
	});

	it("restores accepted intent before the first user message exactly once", async () => {
		const sessionManager = manager();
		const journal = new TaskRecoveryJournal(sessionManager);
		journal.start([user]);
		const taskId = journal.state?.id;
		const harness = await fixture(sessionManager);
		await harness.session.resumeTask();
		expect(harness.session.taskRecovery).toMatchObject({ id: taskId, status: "completed" });
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		await harness.session.resumeTask();
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(
			SessionManager.open(harness.session.sessionFile!)
				.buildSessionContext()
				.messages.filter((message) => message.role === "user"),
		).toHaveLength(1);
	});

	it("restores completed stream items without executing an incomplete call", async () => {
		const sessionManager = manager();
		const journal = new TaskRecoveryJournal(sessionManager);
		journal.start([user]);
		sessionManager.appendMessage(user, journal.state?.promptEntryIds[0]);
		const partial = fauxAssistantMessage([call("complete"), call("partial")]);
		partial.stopReason = "pending";
		journal.beginStep(partial);
		journal.completeItem(0, call("complete"), partial);
		let effects = 0;
		const tool: AgentTool = {
			name: "effect",
			label: "effect",
			description: "offline",
			parameters: Type.Object({}),
			execute: async () => {
				effects++;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const harness = await fixture(sessionManager, [tool]);
		await harness.session.resumeTask();
		expect(effects).toBe(1);
		expect(JSON.stringify(harness.session.messages)).not.toContain('"partial"');
		expect(harness.session.taskRecovery?.status).toBe("completed");
	});

	it("pauses an unknown side effect and uses a verified result without replay", async () => {
		const sessionManager = manager();
		const { journal } = seedTools(sessionManager, ["effect"]);
		journal.dispatch(call("effect"), {}, false);
		let effects = 0;
		const tool: AgentTool = {
			name: "effect",
			label: "effect",
			description: "offline",
			parameters: Type.Object({}),
			execute: async () => {
				effects++;
				return { content: [], details: {} };
			},
		};
		const harness = await fixture(sessionManager, [tool]);
		await expect(harness.session.resumeTask()).rejects.toThrow("Unknown tool effects");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.taskRecovery?.status).toBe("needs_reconciliation");
		await expect(harness.session.prompt("another task")).rejects.toThrow("unknown tool effects");
		harness.session.reconcileTool("effect", { kind: "result", result: result("effect") });
		await harness.session.resumeTask();
		expect(effects).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.taskRecovery?.status).toBe("completed");
	});

	it("records fast results immediately and restores missing results in source order", async () => {
		const sessionManager = manager();
		const { journal } = seedTools(sessionManager, ["slow", "fast"]);
		journal.dispatch(call("fast", "fast"), {}, false);
		journal.result(result("fast", "fast"), call("fast", "fast"), false, false);
		const effects: string[] = [];
		const tools: AgentTool[] = ["slow", "fast"].map((name) => ({
			name,
			label: name,
			description: "offline",
			parameters: Type.Object({}),
			execute: async () => {
				effects.push(name);
				return { content: [{ type: "text", text: name }], details: {} };
			},
		}));
		const harness = await fixture(sessionManager, tools);
		await harness.session.resumeTask();
		expect(effects).toEqual(["slow"]);
		const restored = SessionManager.open(harness.session.sessionFile!).buildSessionContext().messages;
		expect(restored.filter((message) => message.role === "toolResult").map((message) => message.toolCallId)).toEqual([
			"slow",
			"fast",
		]);
	});

	it("unsafe execution errors stop before another model request", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "effect",
					label: "effect",
					description: "offline",
					parameters: Type.Object({}),
					execute: async () => {
						throw new Error("ECONNRESET after dispatch");
					},
				},
			],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([call("effect")], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		await harness.session.prompt("task");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.taskRecovery?.status).toBe("needs_reconciliation");
	});

	it("failed recovery remains interrupted rather than marking old progress completed", async () => {
		const sessionManager = manager();
		const journal = new TaskRecoveryJournal(sessionManager);
		sessionManager.appendMessage(fauxAssistantMessage("old done"));
		journal.start([user]);
		const harness = await fixture(sessionManager);
		harness.session.agent.continue = async () => {
			throw new Error("recovery failure");
		};
		await expect(harness.session.resumeTask()).rejects.toThrow("recovery failure");
		expect(harness.session.taskRecovery?.status).toBe("interrupted");
	});

	it.each(["retry", "result"] as const)("resolves a live unknown failure with %s", async (kind) => {
		let effects = 0;
		const harness = await createHarness({
			tools: [
				{
					name: "effect",
					label: "effect",
					description: "offline",
					parameters: Type.Object({}),
					execute: async () => {
						effects++;
						if (effects === 1) throw new Error("ECONNRESET after effect");
						return { content: [{ type: "text", text: "confirmed" }], details: {} };
					},
				},
			],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([call("effect")], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("task");
		expect(
			harness.sessionManager.buildSessionContext().messages.filter((message) => message.role === "toolResult"),
		).toHaveLength(0);
		harness.session.reconcileTool("effect", kind === "retry" ? { kind } : { kind, result: result("effect") });
		await harness.session.resumeTask();
		expect(effects).toBe(kind === "retry" ? 2 : 1);
		expect(harness.session.taskRecovery?.status).toBe("completed");
		const results = harness.sessionManager
			.buildSessionContext()
			.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0]?.isError).toBe(false);
	});

	it("persists journal-only terminating results without another model request", async () => {
		const sessionManager = manager();
		const { journal } = seedTools(sessionManager, ["effect"]);
		journal.dispatch(call("effect"), {}, false);
		journal.result(result("effect"), call("effect"), true, false);
		const harness = await fixture(sessionManager);
		await harness.session.resumeTask();
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.taskRecovery?.status).toBe("completed");
		expect(
			SessionManager.open(harness.session.sessionFile!)
				.buildSessionContext()
				.messages.filter((message) => message.role === "toolResult"),
		).toHaveLength(1);
	});

	it("prevents dispatch when cancellation occurred during an awaited admission hook", async () => {
		const sessionManager = manager();
		const journal = new TaskRecoveryJournal(sessionManager);
		journal.start([user]);
		journal.update((state) => {
			state.status = "cancelled";
		});
		expect(() => journal.dispatch(call("effect"), {}, false)).toThrow("dispatch is paused");
		expect(journal.unknownTools).toHaveLength(0);
	});

	it("a killed native tool remains unknown on restart until its result is verified", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-native-kill-"));
		dirs.push(dir);
		const script = join(dir, "crash.mts");
		writeFileSync(
			script,
			[
				'import { appendFileSync, writeFileSync } from "node:fs";',
				`import { createHarness } from ${JSON.stringify(new URL("./harness.ts", import.meta.url).href)};`,
				`import { SessionManager } from ${JSON.stringify(new URL("../../src/core/session-manager.ts", import.meta.url).href)};`,
				'import { fauxAssistantMessage } from "@earendil-works/pi-ai";',
				`import { Type } from ${JSON.stringify(new URL("../../../../node_modules/typebox/build/index.mjs", import.meta.url).href)};`,
				`const manager = SessionManager.create(${JSON.stringify(dir)}, ${JSON.stringify(dir)});`,
				`const harness = await createHarness({ sessionManager: manager, tools: [{ name: "effect", label: "effect", description: "offline", parameters: Type.Object({}), execute: async () => { appendFileSync(${JSON.stringify(join(dir, "effect"))}, "effect\\n"); process.kill(process.pid, "SIGKILL"); return { content: [], details: {} }; } }], hfCompaction: { mode: "off" } });`,
				`writeFileSync(${JSON.stringify(join(dir, "child-temp"))}, harness.tempDir);`,
				'harness.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "effect", name: "effect", arguments: {} }], { stopReason: "toolUse" })]);',
				'await harness.session.prompt("task");',
			].join("\n"),
		);
		const root = new URL("../../../../", import.meta.url).pathname;
		const child = spawnSync(
			process.execPath,
			[join(root, "node_modules/tsx/dist/cli.mjs"), "--tsconfig", join(root, "tsconfig.json"), script],
			{ cwd: root, encoding: "utf8" },
		);
		expect(child.stderr).toBe("");
		// tsx forwards the child's signal using exit 137 on some Node releases.
		expect(child.signal === "SIGKILL" || child.status === 137).toBe(true);
		const childTemp = readFileSync(join(dir, "child-temp"), "utf8");
		expect(childTemp.startsWith(join(tmpdir(), "pi-suite-"))).toBe(true);
		dirs.push(childTemp);
		const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
		expect(file).toBeDefined();
		const manager = SessionManager.open(join(dir, file!));
		const harness = await fixture(manager);
		await expect(harness.session.resumeTask()).rejects.toThrow("Unknown tool effects");
		expect(readFileSync(join(dir, "effect"), "utf8")).toBe("effect\n");
		expect(harness.getPendingResponseCount()).toBe(1);
		harness.session.reconcileTool("effect", { kind: "result", result: result("effect") });
		await harness.session.resumeTask();
		expect(harness.session.taskRecovery?.status).toBe("completed");
	});

	it("startup resumes a running task but keeps a cancelled task paused", async () => {
		const sessionManager = manager();
		const journal = new TaskRecoveryJournal(sessionManager);
		journal.start([user]);
		journal.update((state) => {
			state.status = "cancelled";
		});
		const harness = await fixture(sessionManager);
		await harness.session.bindExtensions({ mode: "print" });
		expect(harness.getPendingResponseCount()).toBe(1);
		await harness.session.prompt("/resume-task");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.taskRecovery?.status).toBe("completed");
		const nextManager = manager();
		new TaskRecoveryJournal(nextManager).start([user]);
		const next = await fixture(nextManager);
		await next.session.bindExtensions({ mode: "print" });
		expect(next.session.taskRecovery?.status).toBe("completed");
	});

	it.each([false, true])("only replays safe dispatches with an unchanged contract: changed=%s", async (changed) => {
		const sessionManager = manager();
		const { journal } = seedTools(sessionManager, ["effect"]);
		const parameters = Type.Object({});
		const contract = { readOnly: true };
		journal.dispatch(call("effect"), {}, true, JSON.stringify({ name: "effect", parameters, contract }));
		let effects = 0;
		const tool: AgentTool = {
			name: "effect",
			label: "effect",
			description: "offline",
			parameters,
			contract: changed ? undefined : contract,
			execute: async () => {
				effects++;
				return { content: [], details: {} };
			},
		};
		const harness = await fixture(sessionManager, [tool]);
		await harness.session.resumeTask();
		expect(effects).toBe(changed ? 0 : 1);
		expect(harness.session.taskRecovery?.status).toBe(changed ? "needs_reconciliation" : "completed");
	});

	it("does not execute completed stream calls after a permanent provider failure", async () => {
		const sessionManager = manager();
		const journal = new TaskRecoveryJournal(sessionManager);
		journal.start([user]);
		sessionManager.appendMessage(user, journal.state?.promptEntryIds[0]);
		const partial = fauxAssistantMessage([call("effect")]);
		partial.stopReason = "pending";
		journal.beginStep(partial);
		journal.completeItem(0, call("effect"), partial);
		const failure = {
			...partial,
			stopReason: "error" as const,
			errorMessage: "insufficient_quota: billing quota exceeded",
		};
		journal.commitAssistant(failure, sessionManager.appendMessage(failure));
		let effects = 0;
		const harness = await fixture(sessionManager, [
			{
				name: "effect",
				label: "effect",
				description: "offline",
				parameters: Type.Object({}),
				execute: async () => {
					effects++;
					return { content: [], details: {} };
				},
			},
		]);
		await harness.session.resumeTask();
		expect(effects).toBe(0);
		expect(harness.session.taskRecovery?.status).toBe("completed");
	});

	it("commits live complete items before listeners and waits for stream interruption to dispatch", async () => {
		const sessionManager = manager();
		let effects = 0;
		const harness = await fixture(sessionManager, [
			{
				name: "effect",
				label: "effect",
				description: "offline",
				parameters: Type.Object({}),
				execute: async () => {
					effects++;
					return { content: [], details: {} };
				},
			},
		]);
		const fallback = harness.session.agent.streamFunction;
		let requests = 0;
		const partial = fauxAssistantMessage([call("effect")]);
		partial.stopReason = "pending";
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial });
		stream.push({ type: "toolcall_start", contentIndex: 0, partial });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call("effect"), itemComplete: true, partial });
		harness.session.agent.streamFunction = (model, context, options) =>
			requests++ === 0 ? stream : fallback(model, context, options);
		let observed = false;
		harness.session.subscribe((event) => {
			if (event.type !== "message_update" || event.assistantMessageEvent.type !== "toolcall_end") return;
			observed = true;
			const disk = new TaskRecoveryJournal(SessionManager.open(harness.session.sessionFile!));
			expect(disk.state?.step?.items).toMatchObject([{ index: 0, block: call("effect") }]);
			expect(effects).toBe(0);
			partial.stopReason = "error";
			partial.errorMessage = "Network connection lost";
			stream.push({ type: "error", reason: "error", error: partial });
		});
		await harness.session.prompt("task");
		expect(observed).toBe(true);
		expect(effects).toBe(1);
		await harness.session.resumeTask();
		expect(effects).toBe(1);
		expect(harness.session.taskRecovery?.status).toBe("completed");
	});

	it("releases ownership and settles even when the final journal commit fails", async () => {
		const harness = await fixture(manager());
		const append = harness.sessionManager.appendCustomEntry.bind(harness.sessionManager);
		const spy = vi.spyOn(harness.sessionManager, "appendCustomEntry").mockImplementation((type, data) => {
			if (
				type === "pi-task-recovery" &&
				data &&
				typeof data === "object" &&
				"status" in data &&
				data.status === "completed"
			)
				throw new Error("journal sync failed");
			return append(type, data);
		});
		try {
			await expect(harness.session.prompt("task")).rejects.toThrow("journal sync failed");
			expect(harness.session.isIdle).toBe(true);
			expect(harness.session.agent.state.isStreaming).toBe(false);
			expect(existsSync(`${harness.session.sessionFile}.task.lock`)).toBe(false);
		} finally {
			spy.mockRestore();
		}
		await harness.session.resumeTask();
		expect(harness.session.taskRecovery?.status).toBe("completed");
	});

	it("acknowledges a request only after its intent is committed", async () => {
		const harness = await fixture(manager());
		let accepted = false;
		await harness.session.prompt("accepted", {
			preflightResult: (success) => {
				accepted = success;
				const disk = new TaskRecoveryJournal(SessionManager.open(harness.session.sessionFile!));
				expect(disk.state).toMatchObject({
					status: "running",
					prompt: [{ role: "user", content: [{ text: "accepted" }] }],
				});
			},
		});
		expect(accepted).toBe(true);
	});

	it.each([false, true])("restores a durable queued input exactly once: already delivered=%s", async (delivered) => {
		const sessionManager = manager();
		const journal = new TaskRecoveryJournal(sessionManager);
		journal.start([user]);
		sessionManager.appendMessage(user, journal.state?.promptEntryIds[0]);
		const queued = { role: "user" as const, content: "queued", timestamp: 2 };
		const ids = journal.queue("followUp", [queued], "queued");
		if (delivered) sessionManager.appendMessage(queued, ids[0]);
		const harness = await fixture(sessionManager);
		harness.setResponses(
			delivered
				? [fauxAssistantMessage("done")]
				: [fauxAssistantMessage("first done"), fauxAssistantMessage("queued done")],
		);
		await harness.session.resumeTask();
		const users = harness.sessionManager.buildSessionContext().messages.filter((message) => message.role === "user");
		expect(users.map((message) => message.content)).toEqual(["task", "queued"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		const reopened = await fixture(harness.sessionManager);
		await reopened.session.resumeTask();
		expect(reopened.getPendingResponseCount()).toBe(1);
		expect(reopened.session.pendingMessageCount).toBe(0);
	});

	it("queue cancellation remains durable after reopening", async () => {
		const sessionManager = manager();
		const journal = new TaskRecoveryJournal(sessionManager);
		journal.start([user]);
		sessionManager.appendMessage(user, journal.state?.promptEntryIds[0]);
		journal.queue("followUp", [{ role: "user", content: "cancelled", timestamp: 2 }], "cancelled");
		const harness = await fixture(sessionManager);
		expect(harness.session.clearQueue().followUp).toEqual(["cancelled"]);
		const reopened = await fixture(harness.sessionManager);
		await reopened.session.resumeTask();
		expect(reopened.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(reopened.getPendingResponseCount()).toBe(0);
	});

	it("retains next-turn context when an attempted new task is rejected", async () => {
		const sessionManager = manager();
		const { journal } = seedTools(sessionManager, ["effect"]);
		journal.dispatch(call("effect"), {}, false);
		const harness = await fixture(sessionManager);
		await harness.session.sendCustomMessage(
			{ customType: "aside", content: "retained", display: false, details: {} },
			{ deliverAs: "nextTurn" },
		);
		await expect(harness.session.prompt("rejected")).rejects.toThrow("unknown tool effects");
		harness.session.reconcileTool("effect", { kind: "result", result: result("effect") });
		harness.setResponses([fauxAssistantMessage("resumed"), fauxAssistantMessage("new task done")]);
		await harness.session.resumeTask();
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "aside"),
		).toBe(false);
		await harness.session.prompt("accepted next task");
		expect(
			harness.session.messages.filter((message) => message.role === "custom" && message.customType === "aside"),
		).toHaveLength(1);
	});

	it("does not revive a cancelled queue on an already completed task", async () => {
		const sessionManager = manager();
		const journal = new TaskRecoveryJournal(sessionManager);
		journal.start([user]);
		sessionManager.appendMessage(user, journal.state?.promptEntryIds[0]);
		journal.queue("followUp", [{ role: "user", content: "late queue", timestamp: 2 }], "late queue");
		journal.update((state) => {
			state.status = "completed";
		});
		const harness = await fixture(sessionManager);
		expect(harness.session.clearQueue().followUp).toEqual(["late queue"]);
		const reopened = await fixture(harness.sessionManager);
		expect(reopened.session.pendingMessageCount).toBe(0);
		expect(reopened.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("preserves next-turn context without starting it early or reviving it after consumption", async () => {
		const harness = await fixture(manager());
		await harness.session.sendCustomMessage(
			{ customType: "aside", content: "queued context", display: false, details: {} },
			{ deliverAs: "nextTurn" },
		);
		const reopened = await fixture(harness.sessionManager);
		await reopened.session.bindExtensions({ mode: "print" });
		expect(reopened.getPendingResponseCount()).toBe(1);
		await reopened.session.prompt("task");
		expect(
			reopened.session.messages.filter((message) => message.role === "custom" && message.customType === "aside"),
		).toHaveLength(1);
		const again = await fixture(reopened.sessionManager);
		await again.session.prompt("next task");
		expect(
			again.session.messages.filter((message) => message.role === "custom" && message.customType === "aside"),
		).toHaveLength(1);
	});
});
