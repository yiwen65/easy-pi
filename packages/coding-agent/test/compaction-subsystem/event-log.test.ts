import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "../../src/core/compaction/subsystem/artifact-store.ts";
import {
	type AppendEventInput,
	appendWithOffload,
	type EventLog,
	InMemoryEventLog,
	JsonlEventLog,
	sessionEntriesToEvents,
} from "../../src/core/compaction/subsystem/event-log.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

const authority = { kind: "user" as const, id: "user-1", verified: true };

function input(partial: Partial<AppendEventInput>): AppendEventInput {
	return {
		sessionId: "s-1",
		agentId: "agent-1",
		eventType: "message",
		payload: { text: "hello" },
		authority,
		...partial,
	};
}

function logSuite(name: string, makeLog: (dir?: string) => EventLog) {
	describe(name, () => {
		it("assigns monotonic seq per session and rejects duplicate event ids", () => {
			const log = makeLog();
			const e1 = log.append(input({ eventId: "e-1" }));
			const e2 = log.append(input({ eventId: "e-2" }));
			expect(e1.seq).toBe(1);
			expect(e2.seq).toBe(2);
			expect(() => log.append(input({ eventId: "e-1" }))).toThrow(/duplicate/i);
			expect(log.all("s-1")).toHaveLength(2);
		});

		it("freeze boundary excludes later events from ranged reads", () => {
			const log = makeLog();
			log.append(input({ eventId: "e-1" }));
			log.append(input({ eventId: "e-2" }));
			const boundary = log.freeze("s-1");
			expect(boundary.seq).toBe(2);
			log.append(input({ eventId: "e-3" }));
			const frozen = log.range("s-1", 1, boundary.seq);
			expect(frozen.map((e) => e.eventId)).toEqual(["e-1", "e-2"]);
			expect(log.all("s-1")).toHaveLength(3);
		});

		it("replays from empty state in seq order with causal parents intact", () => {
			const log = makeLog();
			log.append(input({ eventId: "e-1" }));
			log.append(input({ eventId: "e-2", causalParentIds: ["e-1"], eventType: "tool_call", toolCallId: "tc-1" }));
			log.append(input({ eventId: "e-3", causalParentIds: ["e-2"], eventType: "tool_result", toolCallId: "tc-1" }));
			const replayed = log.replay("s-1");
			expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3]);
			expect(replayed[2].causalParentIds).toEqual(["e-2"]);
			expect(replayed[2].toolCallId).toBe("tc-1");
		});

		it("compaction events never delete or rewrite prior events", () => {
			const log = makeLog();
			log.append(input({ eventId: "e-1" }));
			log.append(input({ eventId: "e-2" }));
			const before = log.all("s-1").map((e) => ({ ...e }));
			log.append(input({ eventId: "e-c1", eventType: "compaction", payload: { snapshotVersion: 1 } }));
			const after = log.all("s-1");
			expect(after.slice(0, 2)).toEqual(before);
			expect(after[2].eventType).toBe("compaction");
		});

		it("many appends never duplicate or overwrite", () => {
			const log = makeLog();
			for (let i = 0; i < 200; i++) {
				log.append(input({ eventId: `e-${i}` }));
			}
			const all = log.all("s-1");
			expect(new Set(all.map((e) => e.seq)).size).toBe(200);
			expect(new Set(all.map((e) => e.eventId)).size).toBe(200);
		});

		it("computes content hash for every event", () => {
			const log = makeLog();
			const e = log.append(input({ eventId: "e-1", payload: { n: 42 } }));
			expect(e.contentHash).toMatch(/^[0-9a-f]{64}$/);
		});

		it("does not expose mutable event, payload, causal-parent, or authority references", () => {
			const log = makeLog();
			const mutableAuthority = { kind: "user" as const, id: "user-1", verified: true };
			const mutablePayload = { text: "trusted" };
			const mutableParents = ["parent-1"];
			const appended = log.append(
				input({
					eventId: "immutable-1",
					payload: mutablePayload,
					causalParentIds: mutableParents,
					authority: mutableAuthority,
				}),
			);
			mutablePayload.text = "forged input";
			mutableParents.push("forged-parent");
			mutableAuthority.verified = false;
			(appended.payload as { text: string }).text = "forged return";
			appended.authority.verified = false;
			const read = log.all("s-1")[0];
			expect(read.payload).toEqual({ text: "trusted" });
			expect(read.causalParentIds).toEqual(["parent-1"]);
			expect(read.authority).toEqual({ kind: "user", id: "user-1", verified: true });
			(read.payload as { text: string }).text = "forged read";
			expect(log.get("immutable-1")?.payload).toEqual({ text: "trusted" });
		});
	});
}

logSuite("InMemoryEventLog", () => new InMemoryEventLog());

describe("JsonlEventLog", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	function make(): { log: JsonlEventLog; dir: string } {
		const dir = mkdtempSync(join(tmpdir(), "event-log-"));
		dirs.push(dir);
		return { log: new JsonlEventLog(dir), dir };
	}

	logSuite("JsonlEventLog(shared)", () => make().log);

	it("durable: events exist after reopen (no success-without-persistence)", () => {
		const { log, dir } = make();
		log.append(input({ eventId: "e-1" }));
		log.append(input({ eventId: "e-2", eventType: "tool_call", toolCallId: "tc-1" }));
		const reopened = new JsonlEventLog(dir);
		expect(reopened.all("s-1").map((e) => e.eventId)).toEqual(["e-1", "e-2"]);
	});

	it("detects out-of-order or duplicate seq on load (explicit error)", () => {
		const { log, dir } = make();
		log.append(input({ eventId: "e-1" }));
		log.append(input({ eventId: "e-2" }));
		// Corrupt the file: append a forged event with seq 1 again.
		const filePath = join(dir, "s-1.jsonl");
		const forged = { ...log.all("s-1")[0], eventId: "e-forged" };
		appendFileSync(filePath, `${JSON.stringify(forged)}\n`);
		const reopened = new JsonlEventLog(dir);
		expect(() => reopened.all("s-1")).toThrow(/seq|order|duplicate/i);
		expect(() => reopened.all("s-1")).toThrow(/seq|order|duplicate/i);
	});
});

describe("appendWithOffload", () => {
	it("externalizes large payloads, keeping metadata and hash; small stay inline", () => {
		const log = new InMemoryEventLog();
		const store = new InMemoryArtifactStore();
		const big = "x".repeat(10_000);
		const e1 = appendWithOffload(log, input({ eventId: "e-big", payload: big }), {
			artifactStore: store,
			thresholdBytes: 1000,
			tenant: "t-1",
		});
		expect(e1.payload).toBeUndefined();
		expect(e1.payloadRef?.startsWith("artifact://sha256/")).toBe(true);
		const stored = store.get(e1.payloadRef!, "t-1");
		expect(new TextDecoder().decode(stored!.data)).toBe(big);

		const e2 = appendWithOffload(log, input({ eventId: "e-small", payload: "tiny" }), {
			artifactStore: store,
			thresholdBytes: 1000,
			tenant: "t-1",
		});
		expect(e2.payload).toBe("tiny");
		expect(e2.payloadRef).toBeUndefined();
	});

	it("keeps inline content when the object store fails", () => {
		const log = new InMemoryEventLog();
		const store = new InMemoryArtifactStore();
		store.put = () => {
			throw new Error("object store down");
		};
		const e = appendWithOffload(log, input({ eventId: "e-big", payload: "x".repeat(5000) }), {
			artifactStore: store,
			thresholdBytes: 100,
			tenant: "t-1",
		});
		expect(e.payload).toBe("x".repeat(5000));
		expect(e.payloadRef).toBeUndefined();
	});
});

describe("sessionEntriesToEvents adapter", () => {
	it("projects v3 session entries into events preserving ids and order", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m-1",
				parentId: null,
				timestamp: "2026-08-22T00:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "do the thing" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "m-2",
				parentId: "m-1",
				timestamp: "2026-08-22T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "/a" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "m-3",
				parentId: "m-2",
				timestamp: "2026-08-22T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 3,
				},
			},
			{
				type: "model_change",
				id: "mc-1",
				parentId: "m-3",
				timestamp: "2026-08-22T00:00:03.000Z",
				provider: "anthropic",
				modelId: "claude",
			},
		];
		const events = sessionEntriesToEvents(entries, "s-1", "agent-1");
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
		expect(events[0].eventType).toBe("message");
		expect(events[0].authority).toEqual({ kind: "user", id: "local-user", verified: true });
		expect(events[0].payload).toMatchObject({ text: "do the thing" });
		expect(events[1].eventType).toBe("tool_call");
		expect(events[1].toolCallId).toBe("tc-1");
		expect(events[2].eventType).toBe("tool_result");
		expect(events[2].toolCallId).toBe("tc-1");
		expect(events[3].eventType).toBe("state_change");
		expect(events[1].causalParentIds).toEqual(["m-1"]);
	});
});
