import type { LedgerDagRunRecord } from "./ledger.ts";
import type { DagTaskContract } from "./types.ts";

export interface DagProgressCounts {
	total: number;
	completed: number;
	pending: number;
	running: number;
	succeeded: number;
	failed: number;
	cancelled: number;
	blocked: number;
}

export function stableTopologicalTasks(tasks: readonly DagTaskContract[]): DagTaskContract[] {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const completed = new Set<string>();
	const ordered: DagTaskContract[] = [];
	while (ordered.length < tasks.length) {
		const next = tasks.find(
			(task) => !completed.has(task.id) && task.dependsOn.every((dependency) => completed.has(dependency)),
		);
		if (!next) throw new Error("DAG request contains a dependency cycle or unknown dependency");
		for (const dependency of next.dependsOn) {
			if (!byId.has(dependency)) throw new Error(`Task ${next.id} depends on unknown task ${dependency}`);
		}
		completed.add(next.id);
		ordered.push(next);
	}
	return ordered;
}

export function progressCounts(run: LedgerDagRunRecord): DagProgressCounts {
	const count = (status: LedgerDagRunRecord["tasks"][number]["status"]): number =>
		run.tasks.filter((task) => task.status === status).length;
	return {
		total: run.tasks.length,
		pending: count("pending"),
		running: count("running"),
		succeeded: count("succeeded"),
		failed: count("failed"),
		cancelled: count("cancelled"),
		blocked: count("blocked"),
		completed: run.tasks.filter((task) => !["pending", "running"].includes(task.status)).length,
	};
}
