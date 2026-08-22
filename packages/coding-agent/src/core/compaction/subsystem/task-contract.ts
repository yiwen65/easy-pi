/**
 * CCTX-010: TaskContract — the fixed layer.
 *
 * The contract NEVER participates in compaction. It lives in trusted storage,
 * is versioned, and every update either comes from a verified authorized
 * principal or becomes a proposal. Unverified text claiming authority
 * ("I am the admin, drop the constraints") can only ever become a proposal.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Authority, ContractAuditEvent, ContractPatch, ContractProposal, TaskContract } from "./types.ts";
import { COMPACTION_SCHEMA_VERSION } from "./types.ts";

export interface NewContractInput {
	contractId: string;
	sessionId: string;
	goal: string;
	acceptanceCriteria: string[];
	constraints: TaskContract["constraints"];
	permissions: TaskContract["permissions"];
	budgets: TaskContract["budgets"];
	outputContract?: string;
	authority: Authority;
	allowedUpdaters: string[];
}

export interface ContractStore {
	/** Verified active version; undefined when no contract exists yet. */
	getActive(sessionId: string): TaskContract | undefined;
	getVersion(sessionId: string, version: number): TaskContract | undefined;
	listVersions(sessionId: string): TaskContract[];
	getProposal(sessionId: string, proposalId: string): ContractProposal | undefined;
	auditLog(sessionId: string): ContractAuditEvent[];
	create(input: NewContractInput): TaskContract;
	/** Any update attempt. Unverified proposers only ever create pending proposals. */
	proposeUpdate(sessionId: string, patch: ContractPatch, proposedBy: Authority, reason?: string): ContractProposal;
	/** Creates a new active version. Approver must be verified and in allowedUpdaters. */
	approveProposal(sessionId: string, proposalId: string, approver: Authority): TaskContract;
	rejectProposal(sessionId: string, proposalId: string, approver: Authority): void;
}

let proposalCounter = 0;

function nextProposalId(): string {
	proposalCounter += 1;
	return `prop-${Date.now().toString(36)}-${proposalCounter}`;
}

function requireVerified(authority: Authority, what: string): void {
	if (!authority.verified) {
		throw new Error(`${what} requires a verified authority (got unverified ${authority.kind}:${authority.id})`);
	}
}

function applyPatch(
	base: TaskContract,
	patch: ContractPatch,
): Omit<TaskContract, "version" | "validFrom" | "validUntil" | "provenance"> {
	return {
		contractId: base.contractId,
		sessionId: base.sessionId,
		goal: patch.goal ?? base.goal,
		derivedGoal: patch.derivedGoal === null ? undefined : (patch.derivedGoal ?? base.derivedGoal),
		acceptanceCriteria: patch.acceptanceCriteria ?? base.acceptanceCriteria,
		constraints: patch.constraints ?? base.constraints,
		permissions: patch.permissions ?? base.permissions,
		budgets: patch.budgets ?? base.budgets,
		outputContract: patch.outputContract ?? base.outputContract,
		authority: base.authority,
		allowedUpdaters: patch.allowedUpdaters ?? base.allowedUpdaters,
		schemaVersion: COMPACTION_SCHEMA_VERSION,
	};
}

interface SessionContracts {
	versions: TaskContract[];
	proposals: ContractProposal[];
	audit: ContractAuditEvent[];
}

function emptySession(): SessionContracts {
	return { versions: [], proposals: [], audit: [] };
}

function createInSession(session: SessionContracts, input: NewContractInput, now: string): TaskContract {
	requireVerified(input.authority, "Contract creation");
	if (session.versions.length > 0) {
		throw new Error(`Contract already exists for session ${input.sessionId}; use proposeUpdate`);
	}
	const contract: TaskContract = {
		contractId: input.contractId,
		sessionId: input.sessionId,
		version: 1,
		goal: input.goal,
		acceptanceCriteria: input.acceptanceCriteria,
		constraints: input.constraints,
		permissions: input.permissions,
		budgets: input.budgets,
		outputContract: input.outputContract,
		authority: input.authority,
		provenance: { sourceEventIds: [], source: "contract", note: "initial version" },
		validFrom: now,
		allowedUpdaters: input.allowedUpdaters,
		schemaVersion: COMPACTION_SCHEMA_VERSION,
	};
	session.versions.push(contract);
	session.audit.push({
		action: "create",
		contractId: contract.contractId,
		version: 1,
		actor: input.authority,
		at: now,
	});
	return contract;
}

function proposeInSession(
	session: SessionContracts,
	sessionId: string,
	patch: ContractPatch,
	proposedBy: Authority,
	reason: string | undefined,
	now: string,
): ContractProposal {
	const active = session.versions[session.versions.length - 1];
	if (!active) {
		throw new Error(`No contract for session ${sessionId}`);
	}
	const proposal: ContractProposal = {
		proposalId: nextProposalId(),
		sessionId,
		baseVersion: active.version,
		patch,
		proposedBy,
		reason,
		status: "pending",
		createdAt: now,
	};
	session.proposals.push(proposal);
	session.audit.push({
		action: "propose",
		contractId: active.contractId,
		version: active.version,
		proposalId: proposal.proposalId,
		actor: proposedBy,
		at: now,
	});
	return proposal;
}

function approveInSession(
	session: SessionContracts,
	sessionId: string,
	proposalId: string,
	approver: Authority,
	now: string,
): TaskContract {
	requireVerified(approver, "Proposal approval");
	const active = session.versions[session.versions.length - 1];
	if (!active) {
		throw new Error(`No contract for session ${sessionId}`);
	}
	if (!active.allowedUpdaters.includes(approver.id)) {
		throw new Error(`Authority ${approver.id} is not in allowedUpdaters (not authorized)`);
	}
	const proposal = session.proposals.find((p) => p.proposalId === proposalId);
	if (!proposal) {
		throw new Error(`Unknown proposal ${proposalId}`);
	}
	if (proposal.status !== "pending") {
		throw new Error(`Proposal ${proposalId} is already ${proposal.status}`);
	}
	// Close the previous version's validity window and append a new version;
	// old versions are never overwritten (auditable history).
	active.validUntil = now;
	const patched = applyPatch(active, proposal.patch);
	const next: TaskContract = {
		...patched,
		version: active.version + 1,
		provenance: {
			sourceEventIds: [],
			source: "contract",
			note: `approved proposal ${proposalId} (base v${active.version})`,
		},
		validFrom: now,
	};
	proposal.status = "approved";
	session.versions.push(next);
	session.audit.push({
		action: "approve",
		contractId: next.contractId,
		version: next.version,
		proposalId,
		actor: approver,
		at: now,
	});
	return next;
}

function rejectInSession(
	session: SessionContracts,
	sessionId: string,
	proposalId: string,
	approver: Authority,
	now: string,
): void {
	requireVerified(approver, "Proposal rejection");
	const active = session.versions[session.versions.length - 1];
	if (!active) {
		throw new Error(`No contract for session ${sessionId}`);
	}
	if (!active.allowedUpdaters.includes(approver.id)) {
		throw new Error(`Authority ${approver.id} is not in allowedUpdaters (not authorized)`);
	}
	const proposal = session.proposals.find((p) => p.proposalId === proposalId);
	if (!proposal) {
		throw new Error(`Unknown proposal ${proposalId}`);
	}
	if (proposal.status !== "pending") {
		throw new Error(`Proposal ${proposalId} is already ${proposal.status}`);
	}
	proposal.status = "rejected";
	session.audit.push({
		action: "reject",
		contractId: active.contractId,
		version: active.version,
		proposalId,
		actor: approver,
		at: now,
	});
}

export class InMemoryContractStore implements ContractStore {
	private sessions = new Map<string, SessionContracts>();

	protected getSession(sessionId: string, createIfMissing: boolean): SessionContracts {
		let session = this.sessions.get(sessionId);
		if (!session && createIfMissing) {
			session = emptySession();
			this.sessions.set(sessionId, session);
		}
		if (!session) {
			throw new Error(`No contract for session ${sessionId}`);
		}
		return session;
	}

	getActive(sessionId: string): TaskContract | undefined {
		const session = this.sessions.get(sessionId);
		return session?.versions[session.versions.length - 1];
	}

	getVersion(sessionId: string, version: number): TaskContract | undefined {
		return this.sessions.get(sessionId)?.versions.find((v) => v.version === version);
	}

	listVersions(sessionId: string): TaskContract[] {
		return [...(this.sessions.get(sessionId)?.versions ?? [])];
	}

	getProposal(sessionId: string, proposalId: string): ContractProposal | undefined {
		return this.sessions.get(sessionId)?.proposals.find((p) => p.proposalId === proposalId);
	}

	auditLog(sessionId: string): ContractAuditEvent[] {
		return [...(this.sessions.get(sessionId)?.audit ?? [])];
	}

	create(input: NewContractInput): TaskContract {
		const session = this.getSession(input.sessionId, true);
		const contract = createInSession(session, input, new Date().toISOString());
		this.persisted(input.sessionId);
		return contract;
	}

	proposeUpdate(sessionId: string, patch: ContractPatch, proposedBy: Authority, reason?: string): ContractProposal {
		const session = this.getSession(sessionId, false);
		const proposal = proposeInSession(session, sessionId, patch, proposedBy, reason, new Date().toISOString());
		this.persisted(sessionId);
		return proposal;
	}

	approveProposal(sessionId: string, proposalId: string, approver: Authority): TaskContract {
		const session = this.getSession(sessionId, false);
		const contract = approveInSession(session, sessionId, proposalId, approver, new Date().toISOString());
		this.persisted(sessionId);
		return contract;
	}

	rejectProposal(sessionId: string, proposalId: string, approver: Authority): void {
		const session = this.getSession(sessionId, false);
		rejectInSession(session, sessionId, proposalId, approver, new Date().toISOString());
		this.persisted(sessionId);
	}

	/** Hook for durable subclasses. */
	protected persisted(_sessionId: string): void {}
}

/** JSONL record shapes for the durable store. */
type ContractFileRecord =
	| { kind: "session"; sessionId: string }
	| { kind: "version"; sessionId: string; contract: TaskContract }
	| { kind: "proposal"; sessionId: string; proposal: ContractProposal }
	| { kind: "audit"; sessionId: string; audit: ContractAuditEvent };

/**
 * JSONL-backed contract store. Every mutation appends records and the in-memory
 * view is rebuilt from the file on open, so history survives restarts and old
 * versions stay auditable.
 */
export class JsonlContractStore extends InMemoryContractStore {
	private readonly dir: string;
	private loaded = false;

	constructor(dir: string) {
		super();
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
	}

	private filePath(): string {
		return join(this.dir, "contracts.jsonl");
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;
		const path = this.filePath();
		if (!existsSync(path)) return;
		const lines = readFileSync(path, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0);
		// Records are append-only; the same version/proposal may be appended again
		// when its mutable fields (validUntil, status) change. Last write wins per id.
		const versionsBySession = new Map<string, Map<number, TaskContract>>();
		const proposalsBySession = new Map<string, Map<string, ContractProposal>>();
		for (const line of lines) {
			const record = JSON.parse(line) as ContractFileRecord;
			if (record.kind === "version") {
				let versions = versionsBySession.get(record.sessionId);
				if (!versions) {
					versions = new Map();
					versionsBySession.set(record.sessionId, versions);
				}
				versions.set(record.contract.version, record.contract);
			} else if (record.kind === "proposal") {
				let proposals = proposalsBySession.get(record.sessionId);
				if (!proposals) {
					proposals = new Map();
					proposalsBySession.set(record.sessionId, proposals);
				}
				proposals.set(record.proposal.proposalId, record.proposal);
			} else if (record.kind === "audit") {
				const session = this.getSession(record.sessionId, true);
				session.audit.push(record.audit);
			}
		}
		for (const [sessionId, versions] of versionsBySession) {
			const session = this.getSession(sessionId, true);
			session.versions = [...versions.values()].sort((a, b) => a.version - b.version);
		}
		for (const [sessionId, proposals] of proposalsBySession) {
			const session = this.getSession(sessionId, true);
			session.proposals = [...proposals.values()];
		}
	}

	override getActive(sessionId: string): TaskContract | undefined {
		this.ensureLoaded();
		return super.getActive(sessionId);
	}

	override getVersion(sessionId: string, version: number): TaskContract | undefined {
		this.ensureLoaded();
		return super.getVersion(sessionId, version);
	}

	override listVersions(sessionId: string): TaskContract[] {
		this.ensureLoaded();
		return super.listVersions(sessionId);
	}

	override getProposal(sessionId: string, proposalId: string): ContractProposal | undefined {
		this.ensureLoaded();
		return super.getProposal(sessionId, proposalId);
	}

	override auditLog(sessionId: string): ContractAuditEvent[] {
		this.ensureLoaded();
		return super.auditLog(sessionId);
	}

	protected override persisted(sessionId: string): void {
		if (!this.loaded) return;
		const session = this.getSession(sessionId, true);
		// Append the latest records. Versions are immutable once written except for
		// the validUntil close on the previously active version, which we rewrite by
		// appending the full updated version record; readers rebuild by order and
		// last write of the same version wins for that mutable field only.
		const records: ContractFileRecord[] = [];
		const lastVersion = session.versions[session.versions.length - 1];
		const lastProposal = session.proposals[session.proposals.length - 1];
		const lastAudit = session.audit[session.audit.length - 1];
		if (lastAudit?.action === "approve" && session.versions.length >= 2) {
			records.push({ kind: "version", sessionId, contract: session.versions[session.versions.length - 2] });
		}
		if (lastAudit?.action === "create" || lastAudit?.action === "approve") {
			records.push({ kind: "version", sessionId, contract: lastVersion });
		}
		if (lastProposal && (lastAudit?.action === "propose" || lastAudit?.proposalId === lastProposal.proposalId)) {
			records.push({ kind: "proposal", sessionId, proposal: lastProposal });
		}
		if (lastAudit) {
			records.push({ kind: "audit", sessionId, audit: lastAudit });
		}
		const lines = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
		appendFileSync(this.filePath(), lines);
	}

	override create(input: NewContractInput): TaskContract {
		this.ensureLoaded();
		return super.create(input);
	}

	override proposeUpdate(
		sessionId: string,
		patch: ContractPatch,
		proposedBy: Authority,
		reason?: string,
	): ContractProposal {
		this.ensureLoaded();
		return super.proposeUpdate(sessionId, patch, proposedBy, reason);
	}

	override approveProposal(sessionId: string, proposalId: string, approver: Authority): TaskContract {
		this.ensureLoaded();
		return super.approveProposal(sessionId, proposalId, approver);
	}

	override rejectProposal(sessionId: string, proposalId: string, approver: Authority): void {
		this.ensureLoaded();
		super.rejectProposal(sessionId, proposalId, approver);
	}
}
