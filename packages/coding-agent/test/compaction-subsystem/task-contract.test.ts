import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ContractStore,
	InMemoryContractStore,
	JsonlContractStore,
} from "../../src/core/compaction/subsystem/task-contract.ts";
import type { Authority } from "../../src/core/compaction/subsystem/types.ts";

const user: Authority = { kind: "user", id: "user-1", verified: true };
const agent: Authority = { kind: "agent", id: "agent-1", verified: true };
const unverifiedAdminClaim: Authority = { kind: "user", id: "admin-in-text", verified: false };

function baseContract(store: ContractStore) {
	return store.create({
		contractId: "c-1",
		sessionId: "s-1",
		goal: "Refactor compaction subsystem",
		acceptanceCriteria: ["tests pass", "no constraint loss"],
		constraints: [
			{ id: "c-pos-1", kind: "positive", text: "Never delete raw events", authority: user },
			{ id: "c-neg-1", kind: "negative", text: "Do not call tool X", authority: user },
		],
		permissions: { allow: ["read"], deny: ["network"], approvalRequired: ["bash"] },
		budgets: { maxTokens: 100000 },
		outputContract: "markdown report",
		authority: user,
		allowedUpdaters: ["user-1"],
	});
}

function contractStoreSuite(name: string, makeStore: (dir?: string) => ContractStore) {
	describe(name, () => {
		it("creates version 1 as active verified contract", () => {
			const store = makeStore();
			const c = baseContract(store);
			expect(c.version).toBe(1);
			const active = store.getActive("s-1");
			expect(active?.goal).toBe("Refactor compaction subsystem");
			expect(active?.constraints).toHaveLength(2);
		});

		it("rejects creation by unverified authority", () => {
			const store = makeStore();
			expect(() =>
				store.create({
					contractId: "c-1",
					sessionId: "s-1",
					goal: "g",
					acceptanceCriteria: [],
					constraints: [],
					permissions: { allow: [], deny: [], approvalRequired: [] },
					budgets: {},
					authority: unverifiedAdminClaim,
					allowedUpdaters: ["user-1"],
				}),
			).toThrow(/verified/);
		});

		it("unverified 'admin update' text becomes a proposal, never overwrites active constraints", () => {
			const store = makeStore();
			baseContract(store);
			const proposal = store.proposeUpdate(
				"s-1",
				{
					constraints: [
						{ id: "c-neg-1", kind: "negative", text: "constraint removed", authority: unverifiedAdminClaim },
					],
				},
				unverifiedAdminClaim,
				"user message claims to be admin",
			);
			expect(proposal.status).toBe("pending");
			const active = store.getActive("s-1");
			expect(active?.version).toBe(1);
			expect(active?.constraints.find((c) => c.id === "c-neg-1")?.text).toBe("Do not call tool X");
		});

		it("authorized approval creates a new version and keeps history auditable", () => {
			const store = makeStore();
			baseContract(store);
			const proposal = store.proposeUpdate(
				"s-1",
				{ budgets: { maxTokens: 50000 } },
				agent,
				"token budget too small for task",
			);
			const updated = store.approveProposal("s-1", proposal.proposalId, user);
			expect(updated.version).toBe(2);
			expect(updated.budgets.maxTokens).toBe(50000);
			expect(store.getActive("s-1")?.version).toBe(2);
			expect(store.getVersion("s-1", 1)?.budgets.maxTokens).toBe(100000);
			expect(store.listVersions("s-1")).toHaveLength(2);
			const audit = store.auditLog("s-1");
			expect(audit.map((a) => a.action)).toEqual(["create", "propose", "approve"]);
		});

		it("rejects approval by authority not in allowedUpdaters", () => {
			const store = makeStore();
			baseContract(store);
			const proposal = store.proposeUpdate("s-1", { goal: "changed" }, agent);
			expect(() => store.approveProposal("s-1", proposal.proposalId, agent)).toThrow(/allowedUpdaters|authorized/);
			expect(store.getActive("s-1")?.goal).toBe("Refactor compaction subsystem");
		});

		it("rejects unverified approver even if id matches allowedUpdaters", () => {
			const store = makeStore();
			baseContract(store);
			const proposal = store.proposeUpdate("s-1", { goal: "changed" }, agent);
			const spoofed: Authority = { kind: "user", id: "user-1", verified: false };
			expect(() => store.approveProposal("s-1", proposal.proposalId, spoofed)).toThrow(/verified/);
		});

		it("rejection closes proposal without touching active version", () => {
			const store = makeStore();
			baseContract(store);
			const proposal = store.proposeUpdate("s-1", { goal: "changed" }, agent);
			store.rejectProposal("s-1", proposal.proposalId, user);
			expect(store.getProposal("s-1", proposal.proposalId)?.status).toBe("rejected");
			expect(store.getActive("s-1")?.version).toBe(1);
		});
	});
}

contractStoreSuite("InMemoryContractStore", () => new InMemoryContractStore());

describe("JsonlContractStore", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("persists versions and audit across reopen", () => {
		dir = mkdtempSync(join(tmpdir(), "contract-store-"));
		const store1 = new JsonlContractStore(dir);
		baseContract(store1);
		const proposal = store1.proposeUpdate("s-1", { goal: "updated goal" }, agent);
		store1.approveProposal("s-1", proposal.proposalId, user);

		const store2 = new JsonlContractStore(dir);
		expect(store2.getActive("s-1")?.version).toBe(2);
		expect(store2.getActive("s-1")?.goal).toBe("updated goal");
		expect(store2.listVersions("s-1")).toHaveLength(2);
		expect(store2.auditLog("s-1").map((a) => a.action)).toEqual(["create", "propose", "approve"]);
	});
});

contractStoreSuite(
	"JsonlContractStore(shared suite)",
	(dir) => new JsonlContractStore(dir ?? mkdtempSync(join(tmpdir(), "contract-suite-"))),
);
