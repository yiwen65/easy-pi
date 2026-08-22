/**
 * CCTX-071: evaluation fixtures — a coding trajectory and a tool-heavy
 * trajectory with ground-truth atoms.
 */

import type { EvalFixture } from "./atoms.ts";

export const codingFixture: EvalFixture = {
	name: "coding",
	contract: {
		goal: "Migrate auth to v2",
		constraints: ["Never delete raw events", "Always run tests before commit"],
	},
	compactionRounds: 2,
	events: [
		{ eventType: "message", id: "u-1", payload: { text: "user: migrate /src/auth to handler v2.3.1" } },
		{
			eventType: "state_change",
			id: "t-1a",
			payload: { kind: "task_update", taskId: "t-1", title: "Migrate login flow", state: "in_progress" },
		},
		{
			eventType: "tool_call",
			id: "c-1",
			toolCallId: "tc-1",
			payload: { name: "bash", arguments: { command: "npm test" } },
		},
		{
			eventType: "tool_result",
			id: "r-1",
			toolCallId: "tc-1",
			payload: { isError: false, content: `TESTS 42 passed\n${"log\n".repeat(500)}`, exitCode: 0 },
		},
		{ eventType: "message", id: "m-1", payload: { text: "assistant: decided to keep the v2.3.1 handler signature" } },
		{ eventType: "state_change", id: "t-1b", payload: { kind: "task_update", taskId: "t-1", state: "done" } },
		{
			eventType: "state_change",
			id: "t-2a",
			payload: { kind: "task_update", taskId: "t-2", title: "Migrate logout flow", state: "pending" },
		},
	],
	atoms: [
		{ id: "C-1", kind: "C", text: "Never delete raw events" },
		{ id: "C-2", kind: "C", text: "Always run tests before commit" },
		{ id: "F-1", kind: "F", text: "handler version", exact: ["v2.3.1"] },
		{ id: "T-1", kind: "T", text: "npm test ran", toolCallId: "tc-1", expectToolState: "succeeded" },
		{ id: "S-1", kind: "S", text: "login migration done", taskId: "t-1", expectTaskState: "done" },
		{ id: "U-1", kind: "U", text: "logout migration open", taskId: "t-2", expectTaskState: "pending" },
		{ id: "P-1", kind: "P", text: "provenance resolves" },
	],
	needleQueries: [{ id: "N-1", mustFind: "TESTS 42 passed" }],
};

export const toolHeavyFixture: EvalFixture = {
	name: "tool-heavy",
	contract: {
		goal: "Deploy the service safely",
		constraints: ["Never touch production without approval"],
	},
	compactionRounds: 2,
	events: [
		{ eventType: "message", id: "u-1", payload: { text: "user: deploy staging build 4815" } },
		{
			eventType: "tool_call",
			id: "c-1",
			toolCallId: "tc-1",
			payload: { name: "bash", arguments: { command: "build" } },
		},
		{
			eventType: "tool_result",
			id: "r-1",
			toolCallId: "tc-1",
			payload: { isError: false, content: `BUILD 4815 ok\n${"b\n".repeat(600)}`, exitCode: 0 },
		},
		{
			eventType: "tool_call",
			id: "c-2",
			toolCallId: "tc-2",
			payload: { name: "bash", arguments: { command: "deploy --staging" } },
		},
		{
			eventType: "tool_result",
			id: "r-2",
			toolCallId: "tc-2",
			payload: { isError: true, content: "deploy failed: cert expired", exitCode: 1 },
		},
		{
			eventType: "state_change",
			id: "t-1a",
			payload: { kind: "task_update", taskId: "t-1", title: "Fix staging cert", state: "in_progress" },
		},
	],
	atoms: [
		{ id: "C-1", kind: "C", text: "Never touch production without approval" },
		{ id: "F-1", kind: "F", text: "build number", exact: ["4815"] },
		{ id: "T-1", kind: "T", text: "build succeeded", toolCallId: "tc-1", expectToolState: "succeeded" },
		{ id: "T-2", kind: "T", text: "deploy failed", toolCallId: "tc-2", expectToolState: "failed" },
		{ id: "S-1", kind: "S", text: "cert task open", taskId: "t-1", expectTaskState: "in_progress" },
		{ id: "P-1", kind: "P", text: "provenance resolves" },
	],
	needleQueries: [{ id: "N-1", mustFind: "deploy failed: cert expired" }],
};
