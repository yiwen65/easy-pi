import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { COLLABORATION_HISTORY_LIMITS } from "../src/collaboration-contract.ts";
import { CollaborationStore, type StoredCollaborationAgent } from "../src/collaboration-store.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(file: boolean) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "epi-turns-")));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const path = file ? join(cwd, "registry.sqlite") : ":memory:";
	const store = new CollaborationStore({ path, cwd, rootSessionId: "team" });
	cleanups.push(() => store.close());
	return { cwd, path, store };
}
function agent(): StoredCollaborationAgent {
	return {
		id: randomUUID(),
		path: "/root/a",
		parent: "/root",
		status: "pending",
		completionPending: true,
		model: { provider: "faux", id: "one", thinkingLevel: "off" },
		turnId: randomUUID(),
	};
}
function admit(store: CollaborationStore) {
	const snapshot = store.read();
	const record = agent();
	record.taskMessage = {
		id: randomUUID(),
		rootSessionId: "team",
		from: "/root",
		to: record.path,
		turnId: record.turnId,
		kind: "task",
		text: "界🙂".repeat(200),
	};
	snapshot.agents = [record];
	store.commit(snapshot);
	return record;
}

test.each([false, true])("memory/file history is indexed, bounded and survives lifecycle changes (%s)", (file) => {
	const { store } = fixture(file);
	const first = admit(store);
	const highWater = store.highWater();
	expect(store.getTurn(first.path, { turn_id: first.turnId })).toMatchObject({
		sequence: 1,
		task_message_id: first.taskMessage!.id,
		task_preview: "界🙂".repeat(128),
		task_truncated: true,
		status: "pending",
		history_coverage: "complete",
		started_at: null,
		usage: { coverage: "unknown", input: null },
	});
	let snapshot = store.read();
	snapshot.agents[0].status = "running";
	store.commit(snapshot);
	snapshot = store.read();
	snapshot.agents[0].status = "completed";
	snapshot.agents[0].result = "result";
	snapshot.agents[0].completionPending = false;
	const id = randomUUID();
	snapshot.messages = [
		{
			id,
			rootSessionId: "team",
			from: first.path,
			to: "/root",
			turnId: first.turnId,
			kind: "result",
			status: "completed",
			text: "result",
		},
	];
	store.commit(snapshot);
	expect(store.getTurn(first.path, { message_id: id })).toMatchObject({
		status: "completed",
		delivery: { state: "enqueued" },
		finished_at: expect.any(Number),
		started_at: expect.any(Number),
	});
	snapshot = store.read();
	snapshot.messages = [];
	store.commit(snapshot, [{ target: first.path, turn_id: first.turnId, acknowledged: true }]);
	snapshot = store.read();
	snapshot.agents[0].status = "closed";
	store.commit(snapshot);
	expect(store.getTurn(first.path, { message_id: id })).toMatchObject({
		status: "completed",
		delivery: { state: "acknowledged", acknowledged_at: expect.any(Number) },
	});
	const second = admit(store);
	expect(second.turnId).not.toBe(first.turnId);
	expect(store.pageTurns(first.path, { highWater })).toHaveLength(1);
	expect(store.pageTurns(first.path)).toHaveLength(2);
	expect(store.pageTurns(first.path)[0]).not.toHaveProperty("result");
	expect(store.pageTurns(first.path)[0]).not.toHaveProperty("delegation");
	expect(store.getTurn("/root/wrong", { message_id: id })).toBeUndefined();
	expect(() => store.getTurn(first.path, { turn_id: first.turnId, message_id: id })).toThrow(/exactly one/);
});

test.each([false, true])("snapshot/terminal/message/ack roll back together on SQL failure (%s)", (file) => {
	const { store } = fixture(file);
	const record = admit(store);
	const database = Reflect.get(store, "database") as DatabaseSync;
	database.exec(
		"CREATE TRIGGER reject_update BEFORE UPDATE ON team BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END",
	);
	const before = store.read();
	const beforeTurn = store.getTurn(record.path, { turn_id: record.turnId });
	const next = structuredClone(before);
	next.agents[0].status = "completed";
	next.agents[0].completionPending = false;
	next.agents[0].result = "new result";
	next.messages = [
		{
			id: randomUUID(),
			rootSessionId: "team",
			from: record.path,
			to: "/root",
			turnId: record.turnId,
			kind: "result",
			status: "completed",
			text: "new result",
		},
	];
	expect(() => store.commit(next)).toThrow(/synthetic disk/);
	expect(store.read()).toEqual(before);
	expect(store.getTurn(record.path, { turn_id: record.turnId })).toEqual(beforeTurn);
	database.exec("DROP TRIGGER reject_update");
	store.commit(next);
	const completed = store.read();
	const completedTurn = store.getTurn(record.path, { turn_id: record.turnId });
	database.exec("CREATE TRIGGER reject_ack BEFORE UPDATE ON team BEGIN SELECT RAISE(ABORT, 'ack failure'); END");
	const ack = store.read();
	ack.messages = [];
	expect(() => store.commit(ack, [{ target: record.path, turn_id: record.turnId, acknowledged: true }])).toThrow(
		/ack failure/,
	);
	expect(store.read()).toEqual(completed);
	expect(store.getTurn(record.path, { turn_id: record.turnId })).toEqual(completedTurn);
	database.exec("DROP TRIGGER reject_ack");
});

test.each([false, true])("4096 retained rows reject admission without pruning or disabling queries (%s)", (file) => {
	const { store } = fixture(file);
	const first = admit(store);
	const turn = store.getTurn(first.path, { turn_id: first.turnId })!;
	const database = Reflect.get(store, "database") as DatabaseSync;
	database.exec("BEGIN");
	const insert = database.prepare("INSERT INTO turns VALUES (?, ?, ?, NULL, NULL, ?)");
	for (let sequence = 2; sequence <= COLLABORATION_HISTORY_LIMITS.maxRetainedTurns; sequence++) {
		const row = { ...turn, sequence, turn_id: `turn-${sequence}`, task_message_id: null };
		insert.run(sequence, first.path, row.turn_id, JSON.stringify(row));
	}
	database.exec("COMMIT");
	expect(store.countTurns()).toBe(4096);
	expect(() => store.assertTurnCapacity()).toThrow(expect.objectContaining({ reason: "turn_history_full" }));
	const before = store.read();
	const next = store.read();
	next.agents[0].turnId = randomUUID();
	next.agents[0].taskMessage = undefined;
	expect(() => store.commit(next)).toThrow(/history is full/);
	expect(store.read()).toEqual(before);
	expect(store.countTurns()).toBe(4096);
	expect(store.getTurn(first.path, { turn_id: first.turnId })).toEqual(turn);
	expect(store.pageTurns(first.path, { after: 4095, highWater: 4096 })).toHaveLength(1);
});

function legacy(conflict = false) {
	const { cwd, path, store } = fixture(true);
	store.close();
	const record = agent();
	record.status = "closed";
	record.completionPending = false;
	record.result = "latest";
	record.usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 };
	const oldTurn = randomUUID();
	const oldMessage = randomUUID();
	const messages = [
		{
			id: oldMessage,
			rootSessionId: "team",
			from: record.path,
			to: "/root",
			turnId: oldTurn,
			kind: "result",
			status: "failed",
			text: "old result",
		},
	];
	if (conflict) messages.push({ ...messages[0], id: randomUUID(), text: "conflict" });
	const snapshot = { version: 1, rootSessionId: "team", cwd, revision: 4, agents: [record], messages };
	const db = new DatabaseSync(path);
	db.exec("DROP TABLE turns; DROP TABLE history");
	db.prepare("UPDATE team SET snapshot=?").run(JSON.stringify(snapshot));
	db.close();
	return { cwd, path, record, oldTurn, oldMessage, snapshot };
}

test("upgrade seeds only provable retained turns; closed status and times remain unknown", () => {
	const f = legacy();
	const store = new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" });
	cleanups.push(() => store.close());
	expect(store.historyCoverage()).toBe("retained_only");
	expect(store.countTurns()).toBe(2);
	expect(store.getTurn(f.record.path, { turn_id: f.record.turnId })).toMatchObject({
		status: "unknown",
		admitted_at: null,
		started_at: null,
		finished_at: null,
		result: { preview: "latest", truncated: null },
		delivery: { state: "unknown", acknowledged_at: null },
		usage: { coverage: "partial", input: 2 },
	});
	expect(store.getTurn(f.record.path, { message_id: f.oldMessage })).toMatchObject({
		status: "failed",
		task_message_id: null,
		task_preview: "",
		result: { preview: "old result" },
		delivery: { state: "enqueued", enqueued_at: null },
		usage: { coverage: "unknown", input: null },
	});
});

test("conflicting legacy proof fails atomically without acquiring owner or installing ledger", () => {
	const f = legacy(true);
	expect(() => new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" })).toThrow(
		/Conflicting retained/,
	);
	const db = new DatabaseSync(f.path);
	cleanups.push(() => db.close());
	expect(db.prepare("SELECT name FROM sqlite_master WHERE name='turns'").get()).toBeUndefined();
	const row = db.prepare("SELECT snapshot, owner FROM team").get()!;
	expect(JSON.parse(String(row.snapshot))).toEqual(f.snapshot);
	expect(row.owner).toBeNull();
});

test("reopening interrupts the retained active turn and emits its notification atomically", () => {
	const f = fixture(true);
	const record = admit(f.store);
	const running = f.store.read();
	running.agents[0].status = "running";
	f.store.commit(running);
	f.store.close();
	const recovered = new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" });
	cleanups.push(() => recovered.close());
	const message = recovered.read().messages![0];
	expect(recovered.getTurn(record.path, { turn_id: record.turnId })).toMatchObject({
		status: "interrupted",
		finished_at: expect.any(Number),
		result_message_id: message.id,
		usage: { coverage: "partial", input: null },
		delivery: { state: "enqueued" },
	});
	expect(recovered.countTurns()).toBe(1);
});

test.each(["index", "identity", "coverage", "preview"])(
	"external corrupt %s is rejected on history reads",
	(corruption) => {
		const f = fixture(false);
		const record = admit(f.store);
		const database = Reflect.get(f.store, "database") as DatabaseSync;
		const turn = f.store.getTurn(record.path, { turn_id: record.turnId })!;
		if (corruption === "index") database.prepare("UPDATE turns SET task_message_id='other'").run();
		else if (corruption === "coverage") database.prepare("UPDATE history SET coverage='invented'").run();
		else {
			if (corruption === "identity") turn.rootSessionId = "foreign";
			else turn.task_preview = "界".repeat(257);
			database.prepare("UPDATE turns SET record=?").run(JSON.stringify(turn));
		}
		expect(() => f.store.getTurn(record.path, { turn_id: record.turnId })).toThrow(
			expect.objectContaining({ code: "storage_error" }),
		);
		expect(() => f.store.pageTurns(record.path)).toThrow(expect.objectContaining({ code: "storage_error" }));
	},
);

test("legacy missing notification status is not conflicting proof, while known validation mismatch is", () => {
	const f = legacy();
	const db = new DatabaseSync(f.path);
	const snapshot = structuredClone(f.snapshot);
	snapshot.agents[0].status = "completed";
	snapshot.messages = [];
	const latest = {
		id: randomUUID(),
		rootSessionId: "team",
		from: f.record.path,
		to: "/root",
		turnId: f.record.turnId,
		kind: "result",
		text: "latest",
	};
	db.prepare("UPDATE team SET snapshot=?").run(JSON.stringify({ ...snapshot, messages: [latest] }));
	db.close();
	const recovered = new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" });
	expect(recovered.getTurn(f.record.path, { message_id: latest.id })).toMatchObject({
		status: "completed",
		finished_at: null,
		delivery: { state: "enqueued", enqueued_at: null },
	});
	recovered.close();
	const conflicting = new DatabaseSync(f.path);
	conflicting.exec("DROP TABLE turns; DROP TABLE history");
	conflicting.prepare("UPDATE team SET snapshot=?").run(
		JSON.stringify({
			...snapshot,
			agents: [{ ...snapshot.agents[0], resultValidation: { contract: "valid", outcome: "succeeded" } }],
			messages: [{ ...latest, resultValidation: { contract: "invalid" } }],
		}),
	);
	conflicting.close();
	expect(() => new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" })).toThrow(
		/Conflicting retained result proof/,
	);
});

test.each([undefined, ""])("legacy missing/empty result is retained without guessing completeness (%s)", (result) => {
	const f = legacy();
	const db = new DatabaseSync(f.path);
	db.prepare("UPDATE team SET snapshot=?").run(
		JSON.stringify({ ...f.snapshot, agents: [{ ...f.record, result }], messages: [] }),
	);
	db.close();
	const recovered = new CollaborationStore({ path: f.path, cwd: f.cwd, rootSessionId: "team" });
	cleanups.push(() => recovered.close());
	const turn = recovered.getTurn(f.record.path, { turn_id: f.record.turnId })!;
	expect(turn.status).toBe("unknown");
	expect(turn.finished_at).toBeNull();
	expect(turn.result_message_id).toBeNull();
	if (result === undefined) expect(turn.result).toBeUndefined();
	else expect(turn.result).toMatchObject({ preview: "", truncated: null });
});
