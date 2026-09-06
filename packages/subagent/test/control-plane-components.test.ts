import { describe, expect, it, vi } from "vitest";
import { AttemptRuntimeRegistry } from "../src/attempt-runtime-registry.ts";
import type { ChildAgentRuntime } from "../src/child-agent-runtime.ts";
import { stableTopologicalTasks } from "../src/dag-scheduler.ts";
import type { ChildRuntimeMetadata, DagTaskContract } from "../src/types.ts";

function task(id: string, dependsOn: string[] = []): DagTaskContract {
	return {
		id,
		role: "scout",
		objective: id,
		nonGoals: [],
		readPaths: ["src"],
		acceptance: ["done"],
		dependsOn,
		maxAttempts: 1,
		contractHash: `hash-${id}`,
	};
}

function runtime() {
	return {
		closed: false,
		metadata: { sessionId: "session", runtimeGeneration: 1, lastEventSeq: 0 },
		prompt: vi.fn(async () => undefined),
		steer: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
		abort: vi.fn(async () => undefined),
		getState: vi.fn(),
		onEvent: vi.fn(),
		waitForSettled: vi.fn(),
		shutdown: vi.fn(),
	} as unknown as ChildAgentRuntime;
}

const metadata: ChildRuntimeMetadata = {
	provider: "fake",
	model: "fake/model",
	thinkingLevel: "medium",
	isolationLevel: "tool-bounded",
	sessionId: "session",
	runtimeGeneration: 1,
	lastEventSeq: 0,
	activity: "idle",
};

describe("control-plane components", () => {
	it("keeps topological ordering stable and rejects an invalid graph", () => {
		const tasks = [task("second", ["first"]), task("independent"), task("first")];
		expect(stableTopologicalTasks(tasks).map((candidate) => candidate.id)).toEqual([
			"independent",
			"first",
			"second",
		]);
		expect(() => stableTopologicalTasks([task("a", ["b"]), task("b", ["a"])])).toThrow(
			"dependency cycle or unknown dependency",
		);
	});

	it("routes control by exact run/task and never lets an old runtime delete its replacement", async () => {
		const registry = new AttemptRuntimeRegistry();
		const oldRuntime = runtime();
		const replacement = runtime();
		const oldEntry = {
			runId: "run-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			ownerId: "owner",
			runtime: oldRuntime,
			metadata,
			runLease: () => ({ ownerId: "owner", epoch: 1, leaseExpiresAt: 10 }),
		};
		registry.set(oldEntry);
		registry.set({ ...oldEntry, attemptId: "attempt-2", runtime: replacement });
		registry.delete("run-1", "task-1", oldRuntime);

		const active = registry.get("run-1", "task-1");
		expect(active?.runtime).toBe(replacement);
		expect(registry.get("run-2", "task-1")).toBeUndefined();
		await registry.control(active!, "message", "new direction");
		expect(replacement.prompt).toHaveBeenCalledWith("new direction", "steer");
		expect(oldRuntime.prompt).not.toHaveBeenCalled();
	});
});
