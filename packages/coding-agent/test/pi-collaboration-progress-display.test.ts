import { stripVTControlCharacters } from "node:util";
import { Container, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { type CollaborationTurnView, validateDelegation } from "@easy-pi/subagent/collaboration-contract";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import type { ChildSessionHost, ChildTurnResult } from "@easy-pi/subagent/session-host";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { PiCollaborationMonitor } from "../src/extensions/pi-collaboration-monitor.ts";
import {
	resultQueryText,
	SubagentGroupComponent,
	SubagentTranscriptRouter,
} from "../src/modes/interactive/components/subagent-group.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { GrokAgentsPanel } from "../src/modes/interactive-grok/components/grok-agents-panel.ts";

const progress = { summary: "38 regression tests passed; final report pending", reported_at: 1000, revision: 1 };
const interruption = { reason: "Coordinator takes over validation", requested_at: 2000, requested_by: "/root" };
const envelope = {
	id: "progress-1",
	from: "/root/worker",
	to: "/root",
	turnId: "turn-1",
	kind: "progress",
	text: progress.summary,
	progress,
};
const tool = (name: string) =>
	new ToolExecutionComponent(name, "call", {}, {}, undefined, undefined as unknown as TUI, process.cwd());
const rendered = (group: SubagentGroupComponent, width = 160) =>
	group.render(width).map(stripVTControlCharacters).join("\n");
function assigned(): SubagentGroupComponent {
	const group = new SubagentGroupComponent("/root/worker");
	const spawn = tool("spawn_agent");
	group.addTool("spawn_agent", spawn, { task: { objective: "Original task" } }, Date.now() - 100);
	spawn.updateResult({ content: [{ type: "text", text: '{"turn_id":"turn-1"}' }], isError: false });
	return group;
}
function turn(): CollaborationTurnView {
	return {
		target: "/root/worker",
		turn_id: "turn-1",
		sequence: 1,
		task_message_id: "task-1",
		result_message_id: "result-1",
		status: "interrupted",
		history_coverage: "complete",
		task_preview: "Original task",
		task_truncated: false,
		admitted_at: 100,
		started_at: 100,
		finished_at: 2000,
		delivery: { state: "enqueued", enqueued_at: 2000, acknowledged_at: null },
		usage: { coverage: "partial", input: 12, output: 3, cacheRead: 0, cacheWrite: 0 },
		resultValidation: { contract: "not_completed" },
		progress,
		interruption,
	};
}

beforeEach(() => initTheme("dark"));
describe("nonterminal collaboration progress display", () => {
	it("does not count progress as a result or trust a forged terminal status", () => {
		const group = assigned();
		group.addMailboxResult({ ...envelope, status: "completed" }, 1000);
		expect(group.resultCount).toBe(0);
		expect(group.isRunning()).toBe(true);
		expect(rendered(group)).toContain("Progress:");
		group.setExpanded(true);
		expect(rendered(group)).toContain("not a final result");
		expect(rendered(group)).toContain(progress.summary);
		expect(rendered(group)).not.toContain("Outcome:");
	});
	it("retains progress and reason after an empty interrupted result, without claiming success", () => {
		const group = assigned();
		group.addMailboxResult(envelope, 1000);
		group.addMailboxResult(
			{
				...envelope,
				id: "result-1",
				kind: "result",
				text: "",
				status: "interrupted",
				interruption,
				resultValidation: { contract: "not_completed" },
			},
			2000,
		);
		expect(group.resultCount).toBe(1);
		expect(rendered(group)).toContain("Interrupted");
		expect(rendered(group)).toContain("!incomplete");
		expect(rendered(group)).toContain("Progress:");
		group.setExpanded(true);
		expect(rendered(group)).toContain(interruption.reason);
		expect(rendered(group)).toContain("not a final result");
		expect(rendered(group)).not.toContain("Outcome: succeeded");
		for (const width of [1, 12, 40, 80])
			expect(group.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});
	it("does not regress progress revision, reactivate settled work, or carry progress into a new turn", () => {
		const group = assigned();
		group.addMailboxResult({ ...envelope, progress: { ...progress, summary: "LATEST_PROGRESS", revision: 2 } });
		group.addMailboxResult({ ...envelope, id: "older", progress: { ...progress, summary: "OLD_PROGRESS" } });
		expect(rendered(group)).toContain("LATEST_PROGRESS");
		group.addMailboxResult({
			...envelope,
			id: "done",
			kind: "result",
			status: "completed",
			text: '{"summary":"FINAL_RESULT","outcome":"succeeded"}',
			resultValidation: { contract: "valid", outcome: "succeeded" },
		});
		group.addMailboxResult({ ...envelope, id: "late", progress: { ...progress, revision: 3 } });
		expect(group.isRunning()).toBe(false);
		expect(rendered(group)).toContain("FINAL_RESULT");
		const followup = tool("followup_task");
		group.addTool("followup_task", followup, { task: { objective: "NEW_TASK" } });
		followup.updateResult({ content: [{ type: "text", text: '{"turn_id":"turn-2"}' }], isError: false });
		expect(rendered(group)).toContain("NEW_TASK");
		expect(rendered(group)).not.toContain("Progress:");
	});
	it.each([
		null,
		{},
		{ ...progress, summary: 42 },
		{ ...progress, revision: -1 },
		{ ...progress, summary: "x".repeat(3000) },
	])("rejects malformed progress without interpreting it as a result", (bad) => {
		const group = assigned();
		expect(() => group.addMailboxResult({ ...envelope, progress: bad })).not.toThrow();
		expect(group.resultCount).toBe(0);
		expect(group.isRunning()).toBe(true);
		expect(rendered(group)).not.toContain("Progress:");
	});
	it("shows cold pending/terminal query handoff separately from the result body", () => {
		const pending = resultQueryText({ state: "pending", turn: { ...turn(), status: "running", finished_at: null } });
		expect(pending).toContain("Result: pending");
		expect(pending).toContain("Progress (self-reported; not a final result)");
		const terminal = resultQueryText({
			state: "found",
			turn: turn(),
			result: {
				preview: "",
				truncated: false,
				source: { kind: "unavailable", turn_id: "turn-1", coverage: "unknown" },
			},
		});
		expect(terminal).toContain("not_completed");
		expect(terminal).toContain(interruption.reason);
		expect(terminal).toContain(progress.summary);
	});
	it.each([false, true])(
		"shows the canonical same-turn interruption despite delayed older receipts (equal timestamp: %s)",
		(equalTimestamp) => {
			const group = assigned();
			const update = (metadata: typeof interruption) => {
				const operation = tool("interrupt_agent");
				group.addTool("interrupt_agent", operation, { target: "/root/worker" });
				operation.updateResult({
					content: [
						{
							type: "text",
							text: JSON.stringify({
								previous_status: "interrupted",
								turn_id: "turn-1",
								interruption: metadata,
							}),
						},
					],
					isError: false,
				});
			};
			const old = { ...interruption, reason: "OLD_REASON", requested_at: 1500 };
			const latest = { ...interruption, reason: "LATEST_REASON", requested_at: equalTimestamp ? 1500 : 2000 };
			update(old);
			update(latest);
			group.addMailboxResult({
				...envelope,
				id: "result-1",
				kind: "result",
				status: "interrupted",
				text: "",
				interruption: latest,
				resultValidation: { contract: "not_completed" },
			});
			update(old);
			group.setExpanded(true);
			expect(rendered(group)).toContain("LATEST_REASON");
			expect(rendered(group)).not.toContain("OLD_REASON");
		},
	);
	it("keeps an interrupt receipt for an old turn from settling a fast followup", () => {
		const group = assigned();
		const interrupt = tool("interrupt_agent");
		group.addTool("interrupt_agent", interrupt, { target: "/root/worker" });
		const followup = tool("followup_task");
		group.addTool("followup_task", followup, { task: { objective: "NEW_TASK" } });
		followup.updateResult({ content: [{ type: "text", text: '{"turn_id":"turn-2"}' }], isError: false });
		interrupt.updateResult({
			content: [
				{
					type: "text",
					text: JSON.stringify({ previous_status: "running", turn_id: "turn-1", progress, interruption }),
				},
			],
			isError: false,
		});
		expect(group.isRunning()).toBe(true);
		expect(rendered(group)).not.toContain("Progress:");
		expect(rendered(group)).toContain("NEW_TASK");
	});
	it("routes progress to the assigning parent turn without adding a result", () => {
		let current = {};
		const mounts: object[] = [];
		const router = new SubagentTranscriptRouter(new Container(), () => false, {
			getTurn: () => current,
			mount: (_group, owner) => mounts.push(owner),
		});
		const original = current;
		const spawn = tool("spawn_agent");
		router.handleTool("spawn_agent", { task_name: "worker", task: { objective: "Original task" } }, spawn);
		spawn.updateResult({ content: [{ type: "text", text: '{"turn_id":"turn-1"}' }], isError: false });
		current = {};
		expect(
			router.handleMailboxMessage({ customType: "epi-collaboration-message", content: JSON.stringify(envelope) }),
		).toBe(true);
		expect(mounts).toEqual([original]);
		expect(router.currentGroups()[0].resultCount).toBe(0);
		expect(router.turnGroups()[0].render(160).map(stripVTControlCharacters).join("\n")).toContain("Progress:");
	});
});

it("monitor and Grok retain nonfinal progress after operator interrupt without loading or running again", async () => {
	let finish!: (result: ChildTurnResult) => void;
	const work = new Promise<ChildTurnResult>((resolve) => {
		finish = resolve;
	});
	let ready!: () => void;
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	let creates = 0;
	let runs = 0;
	const store = new CollaborationStore({ path: ":memory:", rootSessionId: "progress-monitor", cwd: process.cwd() });
	const host: ChildSessionHost = {
		create: async (request) => {
			creates++;
			return {
				identity: request,
				sessionId: "child",
				sessionFile: undefined,
				context: () => [],
				forkContext: () => [],
				dispose: async () => {},
				abort: async () => {
					finish({ status: "interrupted", text: "" });
				},
				run: async (_text, task) => {
					runs++;
					await request.reportProgress!(task!.turnId, progress.summary);
					ready();
					return work;
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
		sessionId: "progress-monitor",
		messages: [],
		model: { provider: "faux", id: "one" },
		thinkingLevel: "off",
		isStreaming: false,
		subscribe: () => () => {},
		getActiveToolNames: () => ["list_agents", "get_agent_result", "list_agent_turns", "interrupt_agent"],
	} as unknown as AgentSession;
	const monitor = new PiCollaborationMonitor(controller, root);
	let panel: GrokAgentsPanel | undefined;
	try {
		await controller.spawn(
			monitor.identity,
			"worker",
			"Original task",
			{ provider: "faux", id: "one", thinkingLevel: "off" },
			undefined,
			undefined,
			{
				delegation: validateDelegation({ task: { objective: "Original task" }, context: "isolated", tools: [] }),
				tools: [],
			},
		);
		await started;
		expect(monitor.list()[1].progressSummary).toBe(progress.summary);
		expect(monitor.list()[1].resultSummary).toBeUndefined();
		const notice = await monitor.act("/root/worker", "interrupt");
		await controller.settled();
		expect(notice).toContain("Operator requested interrupt");
		expect(notice).toContain(progress.summary);
		const view = monitor.view("/root/worker");
		expect(view.state).toBe("interrupted");
		expect(view.resultMetadata).toContain("not_completed");
		expect(view.handoffMetadata).toContain("not a final result");
		panel = new GrokAgentsPanel({
			monitor,
			theme,
			keybindings: new KeybindingsManager(),
			requestRender: () => {},
			done: () => {},
			height: () => 24,
		});
		const listText = panel.render(140).map(stripVTControlCharacters).join("\n");
		expect(listText).toContain("Interrupted");
		expect(listText).toContain("Progress (not final)");
		for (const width of [12, 40, 80, 140])
			expect(panel.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		expect({ creates, runs }).toEqual({ creates: 1, runs: 1 });
	} finally {
		panel?.dispose();
		monitor.dispose();
		finish({ status: "interrupted", text: "" });
		await controller.shutdown();
	}
});
