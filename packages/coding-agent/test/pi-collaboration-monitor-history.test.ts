import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import type { ChildSessionHost } from "@easy-pi/subagent/session-host";
import { expect, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { PiCollaborationMonitor } from "../src/extensions/pi-collaboration-monitor.ts";

test("retained monitor queries parse summaries, preserve rows after query revocation and never load/run/ack", async () => {
	let creates = 0;
	let runs = 0;
	let tools = ["list_agents", "get_agent_result", "list_agent_turns"];
	const store = new CollaborationStore({ path: ":memory:", rootSessionId: "monitor-team", cwd: process.cwd() });
	const host: ChildSessionHost = {
		create: async (options) => {
			creates++;
			return {
				identity: options,
				sessionId: "child",
				sessionFile: undefined,
				context: () => [],
				forkContext: () => [],
				abort: async () => {},
				dispose: async () => {},
				run: async () => {
					runs++;
					return { status: "completed", text: JSON.stringify({ summary: `Result ${runs}`, outcome: "blocked" }) };
				},
			};
		},
	};
	const controller = new CollaborationController({
		store,
		host,
		agentDir: process.cwd(),
		getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
	});
	const root = {
		sessionId: "monitor-team",
		messages: [],
		model: { provider: "faux", id: "one" },
		thinkingLevel: "off",
		isStreaming: false,
		subscribe: () => () => {},
		getActiveToolNames: () => tools,
	} as unknown as AgentSession;
	const monitor = new PiCollaborationMonitor(controller, root);
	try {
		await controller.spawn(monitor.identity, "worker", "Original full task", {
			provider: "faux",
			id: "one",
			thinkingLevel: "off",
		});
		await controller.settled();
		const first = monitor.result("/root/worker");
		expect(first.state).toBe("found");
		if (first.state !== "found") throw new Error("Missing fixture result");
		for (let i = 0; i < 11; i++) {
			await controller.followup(monitor.identity, "worker", `Followup ${i}`);
			await controller.settled();
		}
		const before = store.read();
		const count = { creates, runs };
		expect(monitor.list().find((row) => row.task_name === "/root/worker")?.resultSummary).toBe("Result 12");
		const page = monitor.turns("/root/worker");
		expect(page.turns).toHaveLength(10);
		expect(page.next_cursor).toBeTruthy();
		expect(monitor.turns("/root/worker", page.next_cursor!).turns).toHaveLength(2);
		expect(monitor.result("/root/worker", first.turn.turn_id)).toEqual(first);
		expect(monitor.view("/root/worker").resultMetadata).toContain("Usage: unknown");
		expect(monitor.view("/root/worker").resultMetadata).toContain("Delivery: enqueued (not acceptance)");
		expect(monitor.view("/root/worker").resultMetadata).toContain("Source: unavailable");
		expect({ creates, runs }).toEqual(count);
		expect(store.read()).toEqual(before);
		tools = ["list_agents"];
		expect(monitor.list()).toHaveLength(2);
		expect(monitor.view("/root/worker").queryUnavailable).toContain("unavailable");
		expect(() => monitor.turns("/root/worker")).toThrow(/unavailable/);
		expect(() => monitor.result("/root/worker")).toThrow(/unavailable/);
		expect({ creates, runs }).toEqual(count);
	} finally {
		monitor.dispose();
		await controller.shutdown();
	}
});
