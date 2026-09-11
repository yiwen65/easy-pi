import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { CollaborationResults } from "@easy-pi/subagent/collaboration-contract";
import { afterEach, expect, test, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InMemorySettingsStorage, type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { currentCollaborationPath, followupArgs, spawnArgs } from "./collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("global Subagent fields persist, reset independently and ignore project/temporary overrides", async () => {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () =>
		JSON.stringify({ defaultModel: "root", defaultThinkingLevel: "medium", theme: "dark" }),
	);
	storage.withLock("project", () => JSON.stringify({ subagentModel: "project/wrong", subagentThinkingLevel: "max" }));
	const settings = SettingsManager.fromStorage(storage);
	expect(settings.getSubagentModel()).toBeUndefined();
	expect(settings.getSubagentThinkingLevel()).toBeUndefined();
	settings.setSubagentModel("provider/model/with/slash");
	settings.setSubagentThinkingLevel("high");
	settings.applyOverrides({ subagentModel: "override/wrong", subagentThinkingLevel: "off" });
	expect(settings.getSubagentModel()).toBe("provider/model/with/slash");
	expect(settings.getSubagentThinkingLevel()).toBe("high");
	await settings.flush();
	const restored = SettingsManager.fromStorage(storage);
	expect(restored.getSubagentModel()).toBe("provider/model/with/slash");
	expect(restored.getSubagentThinkingLevel()).toBe("high");
	restored.setSubagentModel(undefined);
	await restored.flush();
	const inheritedModel = SettingsManager.fromStorage(storage);
	expect(inheritedModel.getSubagentModel()).toBeUndefined();
	expect(inheritedModel.getSubagentThinkingLevel()).toBe("high");
	inheritedModel.setSubagentThinkingLevel(undefined);
	await inheritedModel.flush();
	const cleared = SettingsManager.fromStorage(storage);
	expect(cleared.getSubagentThinkingLevel()).toBeUndefined();
	expect(cleared.getGlobalSettings()).toEqual({ defaultModel: "root", defaultThinkingLevel: "medium", theme: "dark" });
	expect(cleared.getProjectSettings()).toEqual({ subagentModel: "project/wrong", subagentThinkingLevel: "max" });
	expect(cleared.drainErrors()).toEqual([]);
});

async function fixture(defaults: Partial<Settings> = {}) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-subagent-defaults-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		provider: "defaults-faux",
		tokensPerSecond: 0,
		models: [
			{ id: "one", reasoning: true },
			{ id: "two", reasoning: true },
			{ id: "plain", reasoning: false },
		],
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		...defaults,
	});
	// Built-in root wiring, not a test-only defaults injection.
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime,
		model: faux.getModel("one")!,
		thinkingLevel: "medium",
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
	});
	await session.bindExtensions({ mode: "rpc" });
	cleanups.push(async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	});
	const captures: Array<{ path: string; model: string; effort: string }> = [];
	const nested = new Map<string, Record<string, unknown>[]>();
	faux.setResponses(
		Array.from({ length: 30 }, () => (context, options, _state, model) => {
			const path = currentCollaborationPath(context);
			captures.push({ path, model: model.id, effort: options?.reasoning ?? "off" });
			const action = nested.get(path)?.shift();
			return action
				? fauxAssistantMessage(fauxToolCall("spawn_agent", action), { stopReason: "toolUse" })
				: fauxAssistantMessage("done");
		}),
	);
	const call = (name: string, args: Record<string, unknown>) =>
		session.agent.state.tools.find((tool) => tool.name === name)!.execute(randomUUID(), args);
	const idle = async (path: string) => {
		await vi.waitFor(async () => {
			const result = await call("list_agents", {});
			const list = result.details as CollaborationResults["list_agents"];
			expect(list.agents.find((agent) => agent.task_name === path)?.status).toBe("completed");
		});
	};
	return { session, settingsManager, modelRuntime, faux, captures, nested, call, idle };
}

test.each([
	{ defaults: {}, overrides: {}, model: "one", effort: "medium" },
	{
		defaults: { subagentModel: "defaults-faux/two", subagentThinkingLevel: "high" },
		overrides: {},
		model: "two",
		effort: "high",
	},
	{ defaults: { subagentModel: "defaults-faux/two" }, overrides: {}, model: "two", effort: "medium" },
	{ defaults: { subagentThinkingLevel: "low" }, overrides: {}, model: "one", effort: "low" },
	{
		defaults: { subagentModel: "defaults-faux/two", subagentThinkingLevel: "high" },
		overrides: { model: "defaults-faux/one" },
		model: "one",
		effort: "high",
	},
	{
		defaults: { subagentModel: "defaults-faux/two", subagentThinkingLevel: "high" },
		overrides: { reasoning_effort: "off" },
		model: "two",
		effort: "off",
	},
	{
		defaults: { subagentModel: "defaults-faux/two", subagentThinkingLevel: "high" },
		overrides: { model: "defaults-faux/one", reasoning_effort: "low" },
		model: "one",
		effort: "low",
	},
])(
	"spawn resolves independent defaults/overrides to $model/$effort",
	async ({ defaults, overrides, model, effort }) => {
		const f = await fixture(defaults as Partial<Settings>);
		await f.call("spawn_agent", { ...spawnArgs("worker", "inspect"), ...overrides });
		await f.idle("/root/worker");
		expect(f.captures).toEqual([{ path: "/root/worker", model, effort }]);
		expect(f.session.model?.id).toBe("one");
		expect(f.session.thinkingLevel).toBe("medium");
	},
);

test("existing child retains its model/effort while nested spawn reads changed live global defaults", async () => {
	const f = await fixture({ subagentModel: "defaults-faux/one", subagentThinkingLevel: "low" });
	await f.call("spawn_agent", spawnArgs("parent", "first"));
	await f.idle("/root/parent");
	f.settingsManager.setSubagentModel("defaults-faux/two");
	f.settingsManager.setSubagentThinkingLevel("high");
	f.nested.set("/root/parent", [spawnArgs("leaf", "nested")]);
	await f.call("followup_task", followupArgs("parent", "delegate now"));
	await f.idle("/root/parent/leaf");
	await f.idle("/root/parent");
	expect(
		f.captures
			.filter(({ path }) => path === "/root/parent")
			.every(({ model, effort }) => model === "one" && effort === "low"),
	).toBe(true);
	expect(f.captures.find(({ path }) => path === "/root/parent/leaf")).toEqual({
		path: "/root/parent/leaf",
		model: "two",
		effort: "high",
	});
	f.settingsManager.setSubagentModel(undefined);
	f.settingsManager.setSubagentThinkingLevel(undefined);
	await f.call("spawn_agent", spawnArgs("inherited", "after reset"));
	await f.idle("/root/inherited");
	expect(f.captures.at(-1)).toEqual({ path: "/root/inherited", model: "one", effort: "medium" });
});

test.each([
	{ subagentModel: "missing/model", reason: "model_unavailable" },
	{ subagentModel: "not-qualified", reason: "model_unavailable" },
	{ subagentModel: null, reason: "model_unavailable" },
	{ subagentModel: "defaults-faux/plain", subagentThinkingLevel: "high", reason: "effort_unsupported" },
	{ subagentThinkingLevel: "max", reason: "effort_unsupported" },
	{ subagentThinkingLevel: "bogus", reason: "effort_unsupported" },
	{ subagentThinkingLevel: null, reason: "effort_unsupported" },
])(
	"invalid Subagent defaults reject safely: $reason ($subagentModel/$subagentThinkingLevel)",
	async ({ reason, ...defaults }) => {
		const f = await fixture(defaults as unknown as Partial<Settings>);
		await expect(f.call("spawn_agent", spawnArgs("bad", "must not run"))).rejects.toThrow(reason);
		expect(f.faux.state.callCount).toBe(0);
		expect((await f.call("list_agents", {})).details).toEqual({ agents: [] });
		await f.call("spawn_agent", {
			...spawnArgs("override", "valid override"),
			model: "defaults-faux/one",
			reasoning_effort: "off" satisfies ThinkingLevel,
		});
		await f.idle("/root/override");
	},
);

test("preserve rejects a global model/effort conflict without fallback, but explicit matching overrides work", async () => {
	const f = await fixture();
	await f.session.prompt("capture a canonical parent prefix");
	f.settingsManager.setSubagentModel("defaults-faux/two");
	f.settingsManager.setSubagentThinkingLevel("low");
	const args = spawnArgs("preserved", "inspect", { mode: "fork", turns: "all", prefix: "preserve" });
	const before = f.faux.state.callCount;
	await expect(f.call("spawn_agent", args)).rejects.toThrow("prefix_model_changed");
	expect(f.faux.state.callCount).toBe(before);
	await f.call("spawn_agent", { ...args, model: "defaults-faux/one", reasoning_effort: "medium" });
	await f.idle("/root/preserved");
	expect(f.captures.at(-1)).toEqual({ path: "/root/preserved", model: "one", effort: "medium" });
});
