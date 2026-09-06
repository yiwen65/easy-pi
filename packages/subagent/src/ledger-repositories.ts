import type { Usage } from "@earendil-works/pi-ai";
import type { RunLedger } from "./ledger.ts";
import type { ChildRuntimeMetadata, DagRunLease } from "./types.ts";

export class AttemptLedgerRepository {
	private readonly ledger: RunLedger;

	constructor(ledger: RunLedger) {
		this.ledger = ledger;
	}

	recordAccounting(
		runId: string,
		taskId: string,
		attemptId: string,
		ownerId: string,
		usage: Usage,
		turns: number,
		now: number,
		lease: DagRunLease,
	): boolean {
		return this.ledger.recordDagAttemptAccounting(runId, taskId, attemptId, ownerId, usage, turns, now, lease);
	}

	recordRuntime(
		runId: string,
		taskId: string,
		attemptId: string,
		ownerId: string,
		runtime: ChildRuntimeMetadata,
		now: number,
		lease: DagRunLease,
		force = false,
	): boolean {
		return this.ledger.recordDagAttemptRuntime(runId, taskId, attemptId, ownerId, runtime, now, lease, force);
	}

	recordControl(
		runId: string,
		taskId: string,
		attemptId: string,
		ownerId: string,
		operation: "message" | "follow_up" | "interrupt",
		message: string | undefined,
		accepted: boolean,
		now: number,
		lease: DagRunLease,
		error?: string,
	): void {
		this.ledger.recordDagTaskControl(
			runId,
			taskId,
			attemptId,
			ownerId,
			operation,
			message,
			accepted,
			now,
			lease,
			error,
		);
	}
}

/** Repository grouping only; RunLedger remains the sole SQLite connection and transaction owner. */
export function createLedgerRepositories(ledger: RunLedger): { attempts: AttemptLedgerRepository } {
	return { attempts: new AttemptLedgerRepository(ledger) };
}
