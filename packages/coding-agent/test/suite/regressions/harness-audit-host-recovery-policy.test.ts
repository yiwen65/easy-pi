import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { TaskRecoveryJournal } from "../../../src/core/task-recovery.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.shutdown();
		harness.cleanup();
	}
});

function retainedTask() {
	const manager = SessionManager.inMemory();
	const journal = new TaskRecoveryJournal(manager);
	journal.start([{ role: "user", content: "old accepted prompt", timestamp: 1 }]);
	journal.queue("steer", [{ role: "user", content: "old steering", timestamp: 2 }], "old steering");
	journal.queue("followUp", [{ role: "user", content: "old followup", timestamp: 3 }], "old followup");
	journal.queue("nextTurn", [
		{ role: "custom", customType: "old-aside", content: "old nextTurn", display: false, timestamp: 4 },
	]);
	return { manager, retained: manager.getLeafEntry()! };
}

it("host-controlled recovery policy survives rebinding and isolates new admissions from all restored queues", async () => {
	const { manager, retained } = retainedTask();
	const harness = await createHarness({
		sessionManager: manager,
		hfCompaction: { mode: "off" },
		settings: { retry: { enabled: false } },
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("unexpected recovery"), fauxAssistantMessage("unexpected queue")]);
	await harness.session.bindExtensions({ recoveryPolicy: "host-controlled" });
	expect(harness.session.pendingMessageCount).toBe(0);
	await harness.session.bindExtensions({ mode: "rpc" });
	expect(harness.faux.state.callCount).toBe(0);
	expect(manager.getEntry(retained.id)).toEqual(retained);
	harness.setResponses([
		(context) => {
			expect(JSON.stringify(context.messages)).not.toContain("old accepted prompt");
			expect(JSON.stringify(context.messages)).not.toContain("old steering");
			expect(JSON.stringify(context.messages)).not.toContain("old followup");
			expect(JSON.stringify(context.messages)).not.toContain("old nextTurn");
			return fauxAssistantMessage("new admitted result");
		},
		fauxAssistantMessage("later admitted result"),
	]);
	await harness.session.prompt("new admitted assignment");
	await harness.session.prompt("later admitted assignment");
	expect(harness.faux.state.callCount).toBe(2);
	expect(harness.session.getLastAssistantText()).toBe("later admitted result");
	expect(manager.getEntry(retained.id)).toEqual(retained);
});

it("default root binding still recovers the task and delivers ordinary queued inputs", async () => {
	const { manager, retained } = retainedTask();
	const harness = await createHarness({
		sessionManager: manager,
		hfCompaction: { mode: "off" },
		settings: { retry: { enabled: false } },
	});
	harnesses.push(harness);
	const requests: string[] = [];
	harness.setResponses(
		Array.from({ length: 3 }, () => (context: Context) => {
			requests.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("root response");
		}),
	);
	await harness.session.bindExtensions({ mode: "print" });
	expect(harness.faux.state.callCount).toBe(2);
	expect(requests[0]).toContain("old accepted prompt");
	expect(requests[0]).toContain("old steering");
	expect(requests[1]).toContain("old followup");
	await harness.session.prompt("new root prompt");
	expect(requests[2]).toContain("old nextTurn");
	expect(harness.faux.state.callCount).toBe(3);
	expect(manager.getEntry(retained.id)).toEqual(retained);
});
