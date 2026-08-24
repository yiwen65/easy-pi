import { describe, expect, it } from "vitest";
import { type AppendEventInput, InMemoryEventLog } from "../../src/core/compaction/subsystem/event-log.ts";
import { replayLedger, ToolLedger } from "../../src/core/compaction/subsystem/tool-ledger.ts";

const user = { kind: "user" as const, id: "user-1", verified: true };

function planned(ledger: ToolLedger, toolCallId: string, key?: string) {
	return ledger.recordPlanned({
		operationId: `op-${toolCallId}`,
		toolCallId,
		idempotencyKey: key,
		sideEffectClass: "filesystem",
		riskLevel: "medium",
		authority: user,
	});
}

describe("ToolLedger", () => {
	it("commits memory only after durable transition append succeeds", () => {
		class FailingLog extends InMemoryEventLog {
			fail = false;
			override append(input: AppendEventInput) {
				if (this.fail) throw new Error("disk unavailable");
				return super.append(input);
			}
		}
		const log = new FailingLog();
		const ledger = new ToolLedger({ eventLog: log, sessionId: "s-1", agentId: "a-1" });
		log.fail = true;
		expect(() => planned(ledger, "tc-unwritten")).toThrow(/disk unavailable/);
		expect(ledger.get("tc-unwritten")).toBeUndefined();

		log.fail = false;
		planned(ledger, "tc-1");
		ledger.recordStarted("tc-1");
		log.fail = true;
		expect(() => ledger.recordSucceeded("tc-1", { exitCode: 0 })).toThrow(/disk unavailable/);
		expect(ledger.get("tc-1")?.state).toBe("started");
		expect(replayLedger(log.all("s-1")).get("tc-1")?.state).toBe("started");
	});

	it("walks planned → approved → started → succeeded with legal monotonic transitions", () => {
		const ledger = new ToolLedger();
		planned(ledger, "tc-1");
		ledger.recordApproved("tc-1", { approvedBy: user, at: new Date().toISOString() });
		ledger.recordStarted("tc-1");
		const done = ledger.recordSucceeded("tc-1", { exitCode: 0, resultRef: "artifact://sha256/abc" });
		expect(done.state).toBe("succeeded");
		expect(done.exitCode).toBe(0);
		expect(done.history.map((h) => h.state)).toEqual(["planned", "approved", "started", "succeeded"]);
	});

	it("rejects illegal transitions (no planned→succeeded without execution evidence)", () => {
		const ledger = new ToolLedger();
		planned(ledger, "tc-1");
		expect(() => ledger.recordSucceeded("tc-1", { exitCode: 0 })).toThrow(/transition/i);
	});

	it("terminal states are terminal (succeeded cannot become failed)", () => {
		const ledger = new ToolLedger();
		planned(ledger, "tc-1");
		ledger.recordStarted("tc-1");
		ledger.recordSucceeded("tc-1", { exitCode: 0 });
		expect(() => ledger.recordFailed("tc-1", { exitCode: 1 })).toThrow(/terminal|transition/i);
	});

	it("a planned operation is never reported as complete", () => {
		const ledger = new ToolLedger();
		planned(ledger, "tc-1");
		expect(ledger.isComplete("tc-1")).toBe(false);
		ledger.recordStarted("tc-1");
		expect(ledger.isComplete("tc-1")).toBe(false);
	});

	it("deduplicates by idempotency key: same key never produces a second operation", () => {
		const ledger = new ToolLedger();
		const a = planned(ledger, "tc-1", "key-1");
		const b = ledger.recordPlanned({
			operationId: "op-other",
			toolCallId: "tc-2",
			idempotencyKey: "key-1",
			sideEffectClass: "network",
			riskLevel: "high",
			authority: user,
		});
		expect(b.operationId).toBe(a.operationId);
		expect(ledger.list()).toHaveLength(1);
	});

	it("timeout/interruption marks unknown; unknown is resolvable only by verification, never by blind replay", () => {
		const ledger = new ToolLedger();
		planned(ledger, "tc-1", "key-9");
		ledger.recordStarted("tc-1");
		const unknown = ledger.recordUnknown("tc-1", "network timeout after request sent");
		expect(unknown.state).toBe("unknown");

		// Recovery path: caller must query real state first (wouldReplay surfaces the entry).
		const pending = ledger.wouldReplay("key-9");
		expect(pending?.state).toBe("unknown");

		// Verification confirms success → allowed.
		const verified = ledger.recordSucceeded("tc-1", { exitCode: 0, externalResourceId: "ext-123" });
		expect(verified.state).toBe("succeeded");
		expect(verified.externalResourceId).toBe("ext-123");
	});

	it("requires approval state before started when approval was required", () => {
		const ledger = new ToolLedger();
		planned(ledger, "tc-1");
		// No approval recorded: starting a high-risk operation must fail.
		const entry = ledger.get("tc-1")!;
		entry.riskLevel = "high";
		expect(() => ledger.recordStarted("tc-1", { requiresApproval: true })).toThrow(/approv/i);
	});

	it("is event-sourced: replaying ledger events rebuilds identical state", () => {
		const log = new InMemoryEventLog();
		const ledger = new ToolLedger({ eventLog: log, sessionId: "s-1", agentId: "a-1" });
		planned(ledger, "tc-1", "key-1");
		ledger.recordStarted("tc-1");
		ledger.recordUnknown("tc-1", "timeout");
		planned(ledger, "tc-2");
		ledger.recordStarted("tc-2");
		ledger.recordFailed("tc-2", { exitCode: 3 });

		const rebuilt = replayLedger(log.all("s-1"));
		expect(rebuilt.get("tc-1")?.state).toBe("unknown");
		expect(rebuilt.get("tc-2")?.state).toBe("failed");
		expect(rebuilt.get("tc-2")?.exitCode).toBe(3);
		expect(rebuilt.byIdempotencyKey("key-1")[0]?.toolCallId).toBe("tc-1");
	});
});
