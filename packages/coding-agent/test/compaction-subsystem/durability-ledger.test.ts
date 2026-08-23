/**
 * T-302: durable subsystem state + tool ledger backfill.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { replayLedger } from "../../src/core/compaction/subsystem/tool-ledger.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../test-harness.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "hf-durable-"));
	dirs.push(d);
	return d;
}

async function makeFileSession(
	cwd: string,
	sessionDir: string,
	responses: string[] = ["ok"],
	sessionManager?: SessionManager,
): Promise<Harness> {
	const h = await createHarness({
		responses,
		sessionManager: sessionManager ?? SessionManager.create(cwd, sessionDir),
		hfCompaction: {
			mode: "structured_compaction",
			complete: async (req) => ({
				text: req.responseSchema ? JSON.stringify({ facts: [], decisions: [], nextActions: [] }) : "n",
				stopReason: "stop",
			}),
			minTokenGainFraction: -1,
		},
	});
	return h;
}

describe("durable subsystem state", () => {
	it("event log, contract, and snapshot survive process restart", async () => {
		const cwd = tempDir();
		const sessionDir = tempDir();
		const h1 = await makeFileSession(cwd, sessionDir, ["answer one", "answer two"]);
		harnesses.push(h1);
		const s1 = h1.session;
		await s1.prompt("first question");
		await s1.prompt("second question");
		await s1.waitForIdle();
		s1.setTaskContract({
			goal: "durable goal",
			constraints: [{ id: "c-1", kind: "negative", text: "Never delete raw events" }],
		});
		const host1 = s1.hfCompactionHost!;
		await host1.attemptCompaction({
			action: "soft_compact",
			complete: async (req) => ({
				text: req.responseSchema ? JSON.stringify({ facts: [], decisions: [], nextActions: [] }) : "n",
				stopReason: "stop",
			}),
			branchEntries: s1.sessionManager.getBranch(),
			keepRecentTokens: 1,
			outputReserveTokens: 10,
		});
		const sessionFile = s1.sessionFile!;
		expect(existsSync(sessionFile)).toBe(true);
		const s1Events = host1.eventLog.all(s1.sessionId).length;
		expect(s1Events).toBeGreaterThan(0);
		s1.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "unsynchronized crash tail" }],
			timestamp: Date.now() + 1000,
		});
		expect(host1.snapshotStore.getActive(s1.sessionId)).toBeDefined();

		// Reopen the same session file in a fresh session/host.
		const s2Manager = SessionManager.open(sessionFile, sessionDir);
		const s2Harness = await makeFileSession(cwd, sessionDir, ["ok"], s2Manager);
		const host2 = s2Harness.session.hfCompactionHost!;
		// Same durable state: events replayed, contract intact, snapshot readable.
		expect(host2.eventLog.all(s2Harness.session.sessionId).length).toBeGreaterThan(s1Events);
		expect(host2.getContract()?.goal).toBe("durable goal");
		expect(host2.getContract()?.constraints[0].text).toBe("Never delete raw events");
		expect(host2.snapshotStore.getActive(s2Harness.session.sessionId)).toBeDefined();
		const restored = s2Harness.session.messages[0];
		expect(JSON.stringify(restored && "content" in restored ? restored.content : undefined)).toContain(
			"# Verified state snapshot",
		);
		expect(JSON.stringify(s2Harness.session.messages)).toContain("unsynchronized crash tail");
		s1.dispose();
		s2Harness.cleanup();
	});

	it("in-memory SessionManager keeps in-memory subsystem stores", async () => {
		const h = await createHarness({ responses: ["ok"] });
		harnesses.push(h);
		await h.session.prompt("hi");
		await h.session.waitForIdle();
		// Host exists (default-on) but no state directory was created for the in-memory session.
		expect(h.session.sessionFile).toBeUndefined();
		expect(h.session.hfCompactionHost).toBeDefined();
	});
});

const harnesses: Harness[] = [];

describe("tool ledger backfill", () => {
	it("real tool executions produce classified ledger events", async () => {
		const probe: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "test tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "probe result" }], details: undefined }),
		};
		const h = await createHarness({
			baseToolsOverride: { probe },
			responses: [
				{ toolCalls: [{ name: "probe", args: {} }], usage: { totalTokens: 100 } },
				{ text: "done", usage: { totalTokens: 120 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("run the probe");
		await h.session.waitForIdle();

		const host = h.session.hfCompactionHost!;
		const ledgerEvents = host.eventLog.all(h.session.sessionId).filter((e) => e.eventType === "ledger");
		expect(ledgerEvents.length).toBeGreaterThanOrEqual(2); // planned/started + succeeded
		const ledger = replayLedger(host.eventLog.all(h.session.sessionId));
		const entry = ledger.list().find((l) => l.toolCallId.includes("toolu") || l.toolCallId.length > 0);
		expect(entry).toBeDefined();
		expect(entry!.state).toBe("succeeded");
	});

	it("bash is classified process/high; failures land in failed state", async () => {
		const h = await createHarness({
			responses: [
				{ toolCalls: [{ name: "bash", args: { command: "exit 3" } }], usage: { totalTokens: 100 } },
				{ text: "it failed", usage: { totalTokens: 120 } },
			],
		});
		harnesses.push(h);
		await h.session.prompt("run a failing command");
		await h.session.waitForIdle();
		const host = h.session.hfCompactionHost!;
		const ledger = replayLedger(host.eventLog.all(h.session.sessionId));
		const bashEntry = ledger.list().find((l) => l.state === "failed");
		expect(bashEntry).toBeDefined();
		expect(bashEntry!.sideEffectClass).toBe("process");
		expect(bashEntry!.riskLevel).toBe("high");
	});
});
