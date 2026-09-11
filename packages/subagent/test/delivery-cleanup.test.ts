import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { cleanupConfirmedRun, type DeliveryCleanupHost, registerDeliveryCleanup } from "../src/delivery-cleanup.ts";
import { RunLedger } from "../src/ledger.ts";
import type { CompiledSubagentDagRequest, SubagentDagRunDetails } from "../src/types.ts";

const request: CompiledSubagentDagRequest = {
	version: 2,
	handoffProtocolVersion: 2,
	objective: "Synthetic task",
	tasks: [
		{
			id: "inspect",
			role: "scout",
			objective: "Inspect",
			nonGoals: [],
			readPaths: [],
			acceptance: [],
			dependsOn: [],
			maxAttempts: 1,
			contractHash: "test",
		},
	],
	budget: { maxTokens: 10000 },
	budgetScope: "task",
	merge: { enabled: false, refPrefix: "pi/subagent/integration" },
	graph: { sealed: true },
};
function terminal(ledger: RunLedger, id: string, confirmed: boolean, collected = true, input = request): void {
	ledger.createDagRun({
		runId: id,
		request: input,
		baseline: {
			repositoryRoot: "/synthetic",
			headCommit: "abc",
			snapshotId: "snapshot",
			fileCount: 0,
			totalBytes: 0,
		},
	});
	const lease = ledger.acquireDagRunLease(id, "controller", 0, 1000)!;
	ledger.setDagRunStatus(id, "running", 1, lease);
	ledger.setDagRunStatus(id, "cancelled", 2, lease);
	if (confirmed) ledger.confirmDagCleanup(id, "discard", 3);
	if (collected) {
		ledger.beginDagResourceGc(id, 4);
		ledger.completeDagResourceGc(id, 5);
	}
}

describe("confirmed history retention", () => {
	it("reclaims file-backed SQLite pages after confirmed history expires", () => {
		const root = mkdtempSync(join(tmpdir(), "epi-history-retention-"));
		const path = join(root, "state.sqlite");
		let ledger = new RunLedger(path);
		try {
			terminal(ledger, "large", true, true, { ...request, objective: "synthetic".repeat(100000) });
			ledger.close();
			const before = statSync(path).size;
			ledger = new RunLedger(path);
			expect(ledger.pruneConfirmedHistory({ now: 20, maxAgeMs: 10 }).deletedRunIds).toEqual(["large"]);
			expect(statSync(path).size).toBeLessThan(before);
		} finally {
			ledger.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("expires only explicitly confirmed and fully released histories", () => {
		const ledger = new RunLedger(":memory:");
		try {
			terminal(ledger, "confirmed", true);
			terminal(ledger, "unconfirmed", false);
			terminal(ledger, "partial-cleanup", true, false);
			const result = ledger.pruneConfirmedHistory({ now: 20, maxAgeMs: 10 });
			expect(result.deletedRunIds).toEqual(["confirmed"]);
			expect(ledger.getDagRun("unconfirmed")).toBeDefined();
			expect(ledger.getDagRun("partial-cleanup")).toBeDefined();
			expect(ledger.listDagEvents("confirmed")).toEqual([]);
		} finally {
			ledger.close();
		}
	});
	it("budget pressure removes eligible history but never unconfirmed data", () => {
		const ledger = new RunLedger(":memory:");
		try {
			terminal(ledger, "confirmed", true);
			terminal(ledger, "unconfirmed", false);
			const result = ledger.pruneConfirmedHistory({ now: 6, maxAgeMs: 99999, maxBytes: 1 });
			expect(result.deletedRunIds).toEqual(["confirmed"]);
			expect(result.overBudget).toBe(true);
			expect(ledger.getDagRun("unconfirmed")).toBeDefined();
		} finally {
			ledger.close();
		}
	});
	it("keeps recent acknowledged history within budget and makes confirmation idempotent", () => {
		const ledger = new RunLedger(":memory:");
		try {
			terminal(ledger, "recent", true);
			ledger.confirmDagCleanup("recent", "discard", 6);
			expect(ledger.listDagEvents("recent").filter((e) => e.type === "run.cleanup_confirmed")).toHaveLength(1);
			expect(ledger.pruneConfirmedHistory({ now: 6 }).deletedRunIds).toEqual([]);
		} finally {
			ledger.close();
		}
	});
});

function host(status: "running" | "succeeded") {
	const calls: string[] = [];
	const details = { status, resources: { candidate: "none", pins: "retained" } } as SubagentDagRunDetails;
	const adapter: DeliveryCleanupHost = {
		inspect: () => details,
		cancel: async () => {
			calls.push("cancel");
			details.status = "cancelled";
			return details;
		},
		gc: async () => {
			calls.push("gc");
			details.resources.pins = "released";
			return details;
		},
	};
	return {
		calls,
		adapter,
		confirm: () => {
			calls.push("confirm");
		},
	};
}

it("keep performs no mutation; delivered never discards a running task", async () => {
	const fixture = host("running");
	await cleanupConfirmedRun(fixture.adapter, "run", "keep", fixture.confirm);
	await expect(cleanupConfirmedRun(fixture.adapter, "run", "delivered", fixture.confirm)).rejects.toThrow(
		/non-terminal/,
	);
	expect(fixture.calls).toEqual([]);
});
it("explicit discard cancels first, then records intent before GC", async () => {
	const fixture = host("running");
	await cleanupConfirmedRun(fixture.adapter, "run", "discard", fixture.confirm);
	expect(fixture.calls).toEqual(["cancel", "confirm", "gc"]);
});
it("command requires disposition, matching scope and authorization before cleanup", async () => {
	const ledger = new RunLedger(":memory:");
	const fixture = host("succeeded");
	const notices: string[] = [];
	let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	let allowed = false;
	const api = {
		registerCommand: (_name: string, command: { handler: typeof handler }) => {
			handler = command.handler;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "rpc",
		hasUI: false,
		ui: { notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionCommandContext;
	terminal(ledger, "run", false, false);
	const originalGc = fixture.adapter.gc!;
	fixture.adapter.gc = async (options) => {
		ledger.beginDagResourceGc(options.runId);
		ledger.completeDagResourceGc(options.runId);
		return originalGc(options);
	};
	registerDeliveryCleanup(api, {
		host: fixture.adapter,
		ledger,
		checkScope: async (id) => {
			if (id !== "run") throw new Error("Wrong workspace");
		},
		authorize: async () => allowed,
	});
	try {
		await handler("run", ctx);
		await handler("other delivered", ctx);
		await handler("run delivered", ctx);
		expect(fixture.calls).toEqual([]);
		expect(notices).toHaveLength(3);
		allowed = true;
		await handler("run delivered", ctx);
		expect(fixture.calls).toEqual(["gc"]);
		expect(ledger.listDagEvents("run").some((e) => e.type === "run.cleanup_confirmed")).toBe(true);
	} finally {
		ledger.close();
	}
});

it("failed confirmation prevents deletion", async () => {
	const fixture = host("succeeded");
	await expect(
		cleanupConfirmedRun(fixture.adapter, "run", "delivered", () => {
			throw new Error("storage failed");
		}),
	).rejects.toThrow(/storage failed/);
	expect(fixture.calls).toEqual([]);
});
