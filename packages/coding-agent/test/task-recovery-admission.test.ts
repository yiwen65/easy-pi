import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentToolCall } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { TaskRecoveryJournal, type TaskRecoveryState } from "../src/core/task-recovery.ts";

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(persist: boolean) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-recovery-admission-")));
	directories.push(cwd);
	const manager = persist ? SessionManager.create(cwd, cwd) : SessionManager.inMemory(cwd);
	return { manager, journal: new TaskRecoveryJournal(manager) };
}

const input = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
const call = (id: string): AgentToolCall => ({ type: "toolCall", id, name: "effect", arguments: { operation: id } });
const result = (id: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "effect",
	content: [{ type: "text", text: "recorded result" }],
	isError: false,
	timestamp: 2,
});

function queueAll(journal: TaskRecoveryJournal): void {
	journal.queue("steer", [input("old steer")], "old steer");
	journal.queue("followUp", [input("old followup")], "old followup");
	journal.queue("nextTurn", [
		{ role: "custom", customType: "old-next-turn", content: "old next turn", display: false, timestamp: 1 },
	]);
}

function historicalState(manager: SessionManager, id: string): TaskRecoveryState {
	const entry = manager.getEntry(id);
	if (entry?.type !== "custom") throw new Error("Missing historical task record");
	return entry.data as TaskRecoveryState;
}

test.each([false, true])(
	"fresh admission leaves old initial intent and all three queue kinds historical (persist=%s)",
	(persist) => {
		const { manager, journal } = fixture(persist);
		journal.start([input("old initial prompt")], "old system", ["old-input"]);
		queueAll(journal);
		const oldLeaf = manager.getLeafId()!;
		const oldState = journal.state!;
		const file = manager.getSessionFile();
		const before = file ? readFileSync(file, "utf8") : undefined;

		journal.start([input("new assignment")], "new system", ["new-input"], { inheritQueuedInputs: false });

		expect(journal.state).toMatchObject({
			prompt: [input("new assignment")],
			promptEntryIds: ["new-input"],
			systemPrompt: "new system",
			queued: [],
			tools: [],
			suspendedTasks: [],
		});
		expect(historicalState(manager, oldLeaf)).toEqual(oldState);
		expect(oldState.status).toBe("running");
		expect(oldState.queued.map((group) => group.kind)).toEqual(["steer", "followUp", "nextTurn"]);
		for (const id of [...oldState.promptEntryIds, ...oldState.queued.flatMap((group) => group.entryIds)])
			expect(manager.getEntry(id)).toBeUndefined();
		expect(oldState.queued.every((group) => group.cancelled === undefined)).toBe(true);
		if (file) expect(readFileSync(file, "utf8").startsWith(before!)).toBe(true);
		const reopened = new TaskRecoveryJournal(file ? SessionManager.open(file) : manager);
		expect(reopened.state).toEqual(journal.state);
		reopened.start([input("later assignment")]);
		expect(reopened.state?.queued).toEqual([]);
		expect(historicalState(manager, oldLeaf)).toEqual(oldState);
	},
);

test.each([false, true])(
	"fresh admission retains unknown effects, known results, suspended tasks and their original queues (persist=%s)",
	(persist) => {
		const { manager, journal } = fixture(persist);
		journal.start([input("older suspended intent")], undefined, ["older-input"]);
		journal.dispatch(call("older-unknown"), call("older-unknown").arguments, false);
		journal.start([input("old initial prompt")], "old system", ["old-input"]);
		queueAll(journal);
		journal.dispatch(call("old-known"), call("old-known").arguments, false);
		journal.result(result("old-known"), call("old-known"), false, false);
		journal.dispatch(call("old-unknown"), call("old-unknown").arguments, false);
		journal.result(result("old-unknown"), call("old-unknown"), false, true);
		const oldLeaf = manager.getLeafId()!;
		const oldState = journal.state!;
		const { suspendedTasks: olderTasks, ...oldTask } = oldState;

		journal.start([input("new assignment")], undefined, ["new-input"], { inheritQueuedInputs: false });

		expect(journal.state).toMatchObject({
			prompt: [input("new assignment")],
			promptEntryIds: ["new-input"],
			queued: [],
			tools: [],
		});
		expect(journal.suspendedTasks).toEqual([...olderTasks!, { leafId: oldLeaf, state: oldTask }]);
		expect(journal.suspendedTasks.at(-1)?.state.queued.map((group) => group.kind)).toEqual([
			"steer",
			"followUp",
			"nextTurn",
		]);
		expect(journal.allUnknownTools.map((tool) => tool.call.id)).toEqual(["older-unknown", "old-unknown"]);
		expect(journal.allUnknownTools.every((tool) => tool.result === undefined && tool.dispatched && !tool.safe)).toBe(
			true,
		);
		expect(historicalState(manager, oldLeaf)).toEqual(oldState);
		const file = manager.getSessionFile();
		const reopened = new TaskRecoveryJournal(file ? SessionManager.open(file) : manager);
		expect(reopened.state).toEqual(journal.state);
		reopened.start([input("later assignment")]);
		expect(reopened.state?.queued).toEqual([]);
		expect(reopened.suspendedTasks).toEqual(journal.suspendedTasks);
		expect(() =>
			reopened.dispatch({ ...call("old-unknown"), id: "repeat-old-effect" }, call("old-unknown").arguments, false),
		).toThrow(/unknown outcome/);
		expect(reopened.allUnknownTools).toEqual(journal.allUnknownTools);
	},
);

test.each([
	{ inheritQueuedInputs: undefined, unknown: false },
	{ inheritQueuedInputs: true, unknown: false },
	{ inheritQueuedInputs: undefined, unknown: true },
	{ inheritQueuedInputs: true, unknown: true },
])("default queue migration remains unchanged ($inheritQueuedInputs/$unknown)", ({ inheritQueuedInputs, unknown }) => {
	const { journal } = fixture(false);
	journal.start([input("old prompt")]);
	queueAll(journal);
	if (unknown) journal.dispatch(call("unknown"), call("unknown").arguments, false);
	const previous = journal.state!;
	if (inheritQueuedInputs === undefined) journal.start([input("new prompt")]);
	else journal.start([input("new prompt")], undefined, undefined, { inheritQueuedInputs });
	expect(journal.state?.prompt).toEqual([input("new prompt")]);
	expect(journal.state?.queued).toEqual(
		unknown ? previous.queued.filter((group) => group.kind === "nextTurn") : previous.queued,
	);
	if (unknown)
		expect(journal.suspendedTasks[0].state.queued).toEqual(
			previous.queued.filter((group) => group.kind !== "nextTurn"),
		);
	else expect(journal.suspendedTasks).toEqual([]);
});

test("failed fresh admission does not cancel inputs, erase unknown effects or advance durable history", () => {
	const { manager, journal } = fixture(true);
	journal.start([input("old prompt")]);
	queueAll(journal);
	journal.dispatch(call("unknown"), call("unknown").arguments, false);
	const before = journal.state;
	const leaf = manager.getLeafId();
	const file = manager.getSessionFile()!;
	const bytes = readFileSync(file);
	vi.spyOn(manager, "appendCustomEntry").mockImplementationOnce(() => {
		throw new Error("synthetic admission failure");
	});
	expect(() => journal.start([input("new assignment")], undefined, undefined, { inheritQueuedInputs: false })).toThrow(
		"synthetic admission failure",
	);
	expect(journal.state).toEqual(before);
	expect(manager.getLeafId()).toBe(leaf);
	expect(readFileSync(file).equals(bytes)).toBe(true);
	expect(new TaskRecoveryJournal(SessionManager.open(file)).state).toEqual(before);
});
