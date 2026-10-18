import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type CollaborationActivity, CollaborationError } from "@easy-pi/subagent/collaboration-contract";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createPiChildSessionHost } from "../src/extensions/pi-child-session-host.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-child-observability-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "child-observability-faux", tokensPerSecond: 0 });
	runtime.registerNativeProvider(faux.provider);
	let native!: AgentSession;
	const activity: Array<{ turnId: string; observation: Omit<CollaborationActivity, "last_activity_at"> }> = [];
	const host = createPiChildSessionHost({
		modelRuntime: runtime,
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		noExtensions: true,
		registerTools: () => {},
		observeSession: (_identity, session) => {
			native = session;
			return () => {};
		},
	});
	const child = await host.create({
		rootSessionId: "child-observability",
		agentPath: "/root/worker",
		cwd,
		agentDir: join(cwd, "agent"),
		model: { provider: faux.provider.id, id: faux.getModel().id, thinkingLevel: "off" },
		storage: { kind: "file", directory: join(cwd, "history") },
		getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
		reportActivity: (turnId, observation) => activity.push({ turnId, observation }),
	});
	cleanups.push(() => child.dispose());
	const diagnostics = () =>
		SessionManager.open(child.sessionFile!)
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "epi-collaboration-diagnostic");
	return { child, native, faux, diagnostics, activity };
}

test("preflight failure records a safe diagnostic even before any provider message exists", async () => {
	const f = await fixture();
	const secret = "SECRET_TOKEN /private/provider/path";
	vi.spyOn(f.native, "prompt").mockRejectedValueOnce(new CollaborationError("forbidden", secret, "tools_unavailable"));
	const result = await f.child.run("explicit task");
	expect(result.status).toBe("failed");
	expect(result.text).toContain("preflight");
	expect(result.text).toContain("forbidden / tools_unavailable");
	expect(f.faux.state.callCount).toBe(0);
	const records = f.diagnostics();
	expect(records).toHaveLength(1);
	expect(result.text).toContain(records[0].id);
	expect(JSON.stringify([result, records])).not.toContain(secret);
});

test("provider errors keep their stage without echoing arbitrary provider error text", async () => {
	const f = await fixture();
	f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "SECRET_PROVIDER_TOKEN" })]);
	const result = await f.child.run("provider failure");
	expect(result.status).toBe("failed");
	expect(result.text).toContain("provider");
	expect(f.diagnostics()).toHaveLength(1);
	expect(JSON.stringify([result, f.diagnostics()])).not.toContain("SECRET_PROVIDER_TOKEN");
});

test("successful delivery and a warm explicit followup each execute exactly one provider turn", async () => {
	const f = await fixture();
	for (const summary of ["first", "second"]) {
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("deliver_result", { summary, outcome: "succeeded" }), {
				stopReason: "toolUse",
			}),
		]);
		expect(await f.child.run(summary)).toMatchObject({
			status: "completed",
			text: JSON.stringify({ summary, outcome: "succeeded" }),
		});
	}
	expect(f.faux.state.callCount).toBe(2);
	expect((await stat(f.child.sessionFile!)).mode & 0o777).toBe(0o600);
	expect(f.diagnostics()).toHaveLength(0);
});

test("host activity is turn-bound metadata, never prompt text, tool arguments or progress", async () => {
	const f = await fixture();
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "PRIVATE_ARGUMENT_PATH" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("finished"),
	]);
	await f.child.run("PRIVATE_TASK_TEXT", {
		id: "task-message",
		rootSessionId: "child-observability",
		from: "/root",
		to: "/root/worker",
		kind: "task",
		turnId: "activity-turn",
		text: "PRIVATE_TASK_TEXT",
	});
	expect(f.activity).toEqual(
		expect.arrayContaining([
			{ turnId: "activity-turn", observation: { phase: "preflight" } },
			{ turnId: "activity-turn", observation: { phase: "model" } },
			{ turnId: "activity-turn", observation: { phase: "tool", tool_name: "read" } },
			{ turnId: "activity-turn", observation: { phase: "settled" } },
		]),
	);
	expect(JSON.stringify(f.activity)).not.toContain("PRIVATE_");
});

test("failed diagnostic persistence still returns an honest bounded failure", async () => {
	const f = await fixture();
	vi.spyOn(f.native, "prompt").mockRejectedValueOnce(new Error("SECRET_SOURCE_ERROR"));
	vi.spyOn(f.native.sessionManager, "appendCustomEntry").mockImplementationOnce(() => {
		throw new Error("SECRET_DIAGNOSTIC_WRITE_ERROR");
	});
	const result = await f.child.run("fail before prompt");
	expect(result.status).toBe("failed");
	expect(result.text).toContain("Diagnostic history unavailable");
	expect(result.text).not.toContain("SECRET_");
});
