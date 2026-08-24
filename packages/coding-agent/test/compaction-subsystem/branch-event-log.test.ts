import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AppendEventInput,
	BranchScopedEventLog,
	InMemoryEventLog,
	JsonlEventLog,
} from "../../src/core/compaction/subsystem/event-log.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

const authority = { kind: "system" as const, id: "test", verified: true };

function event(partial: Partial<AppendEventInput> & Pick<AppendEventInput, "eventId" | "eventType">): AppendEventInput {
	return {
		sessionId: "s-1",
		agentId: "test",
		authority,
		payload: {},
		...partial,
	};
}

function entry(id: string): Pick<SessionEntry, "id"> {
	return { id };
}

describe("BranchScopedEventLog", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	it("shares fork ancestors while isolating sibling branch events", () => {
		const base = new InMemoryEventLog();
		base.append(event({ eventId: "root", eventType: "message", branchHeadId: "root", payload: { entryId: "root" } }));
		base.append(event({ eventId: "common", eventType: "task", branchHeadId: "root" }));
		base.append(
			event({
				eventId: "a",
				eventType: "message",
				branchHeadId: "a",
				causalParentIds: ["root"],
				payload: { entryId: "a" },
			}),
		);
		base.append(event({ eventId: "a-task", eventType: "task", branchHeadId: "a" }));
		base.append(
			event({
				eventId: "b",
				eventType: "message",
				branchHeadId: "b",
				causalParentIds: ["root"],
				payload: { entryId: "b" },
			}),
		);
		base.append(event({ eventId: "b-task", eventType: "task", branchHeadId: "b", causalParentIds: ["root"] }));
		const view = new BranchScopedEventLog(base, "s-1");

		view.setBranch([entry("root"), entry("a")]);
		expect(view.all("s-1").map((item) => item.eventId)).toEqual(["root", "common", "a", "a-task"]);
		expect(view.freeze("s-1").seq).toBe(4);

		view.setBranch([entry("root"), entry("b")]);
		expect(view.all("s-1").map((item) => item.eventId)).toEqual(["root", "common", "b", "b-task"]);
		expect(view.get("a-task")).toBeUndefined();
	});

	it("does not let a forged event-id collision bypass authoritative branch tags", () => {
		const base = new InMemoryEventLog();
		base.append(event({ eventId: "root", eventType: "message", payload: { entryId: "root" } }));
		base.append(event({ eventId: "a", eventType: "task", branchHeadId: "b", payload: { forged: true } }));
		const view = new BranchScopedEventLog(base, "s-1");
		view.setBranch([entry("root"), entry("a")]);
		expect(view.all("s-1").map((item) => item.eventId)).toEqual(["root"]);
	});

	it("recovers legacy task and tool events through source and tool-call references", () => {
		const base = new InMemoryEventLog();
		base.append(event({ eventId: "root", eventType: "message", payload: { entryId: "root" } }));
		base.append(
			event({
				eventId: "assistant:tc-1",
				eventType: "tool_call",
				toolCallId: "tc-1",
				payload: { entryId: "assistant", name: "read" },
			}),
		);
		base.append(
			event({
				eventId: "legacy-task",
				eventType: "task",
				payload: { kind: "task_op", sourceEventId: "root" },
			}),
		);
		base.append(
			event({
				eventId: "legacy-ledger",
				eventType: "ledger",
				toolCallId: "tc-1",
				payload: { kind: "ledger_transition", toolCallId: "tc-1" },
			}),
		);
		const view = new BranchScopedEventLog(base, "s-1");
		view.setBranch([entry("root"), entry("assistant")]);

		expect(view.all("s-1").map((item) => item.eventId)).toEqual([
			"root",
			"assistant:tc-1",
			"legacy-task",
			"legacy-ledger",
		]);
	});

	it("fails closed and reports detached internal events once", () => {
		const base = new InMemoryEventLog();
		base.append(event({ eventId: "root", eventType: "message", payload: { entryId: "root" } }));
		base.append(event({ eventId: "orphan", eventType: "state_change", payload: { kind: "unknown" } }));
		const reported: string[] = [];
		const view = new BranchScopedEventLog(base, "s-1", { onOrphan: (item) => reported.push(item.eventId) });

		view.setBranch([entry("root")]);
		view.setBranch([entry("root")]);

		expect(view.all("s-1").map((item) => item.eventId)).toEqual(["root"]);
		expect(view.getProjectionState().orphanEventIds).toEqual(["orphan"]);
		expect(reported).toEqual(["orphan"]);
	});

	it("delegates durable append with branch metadata and keeps defensive copies", () => {
		const dir = mkdtempSync(join(tmpdir(), "branch-event-log-"));
		dirs.push(dir);
		const base = new JsonlEventLog(dir);
		base.append(event({ eventId: "root", eventType: "message", payload: { entryId: "root" } }));
		const view = new BranchScopedEventLog(base, "s-1");
		view.setBranch([entry("root")]);
		const appended = view.append(event({ eventId: "internal", eventType: "task", payload: { value: "trusted" } }));
		expect(appended.branchHeadId).toBe("root");
		expect(appended.causalParentIds).toEqual(["root"]);
		(appended.payload as { value: string }).value = "forged";

		const reopenedBase = new JsonlEventLog(dir);
		const reopened = new BranchScopedEventLog(reopenedBase, "s-1");
		reopened.setBranch([entry("root")]);
		expect(reopened.all("s-1").map((item) => item.eventId)).toEqual(["root", "internal"]);
		expect(reopened.get("internal")?.payload).toEqual({ value: "trusted" });
	});
});
