import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../src/core/agent-session-runtime.ts";
import { isCodexFastModeAvailable, resolveCodexServiceTierRequest } from "../../src/core/codex-service-tier.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
	vi.restoreAllMocks();
});

function codexModel(
	h: Harness,
	compat: { supportsFastMode?: boolean } = { supportsFastMode: true },
): Model<"openai-codex-responses"> {
	return {
		...h.getModel(),
		id: "codex-test",
		provider: "openai-codex",
		api: "openai-codex-responses",
		compat,
	};
}

async function harness(): Promise<Harness> {
	const h = await createHarness({ tools: [], hfCompaction: { mode: "off" } });
	cleanups.push(h.cleanup);
	return h;
}

function assistant(model: Model<Api>, serviceTier?: AssistantMessage["serviceTier"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		provider: model.provider,
		api: model.api,
		model: model.id,
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...(serviceTier ? { serviceTier } : {}),
	};
}

async function sdkSession(h: Harness, options: Partial<CreateAgentSessionOptions> = {}): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: h.tempDir,
		agentDir: h.tempDir,
		model: codexModel(h),
		resourceLoader: h.session.resourceLoader,
		modelRuntime: h.session.modelRuntime,
		settingsManager: h.settingsManager,
		sessionManager: SessionManager.inMemory(h.tempDir),
		noTools: "all",
		...options,
	});
	cleanups.push(() => session.shutdown().then(() => undefined));
	return session;
}

function captureRequests(h: Harness) {
	return vi.spyOn(h.session.modelRuntime, "streamSimple").mockImplementation((model) => {
		const stream = createAssistantMessageEventStream();
		stream.end(assistant(model));
		return stream;
	});
}

async function request(session: AgentSession, options: SimpleStreamOptions = {}) {
	const stream = await session.agent.streamFunction(session.model!, { messages: [] }, options);
	await stream.result();
}

describe("Codex service tier global preference", () => {
	it("leaves old sessions unspecified and saves globally without appending session entries", async () => {
		const h = await harness();
		h.session.agent.state.model = codexModel(h);
		expect(h.session.codexServiceTier).toBeUndefined();
		expect(h.session.getCodexServiceTierStatus()).toEqual({ source: "none", available: true });
		const messagesBefore = h.session.messages.slice();
		const entriesBefore = h.sessionManager.getEntries().slice();
		h.session.setCodexServiceTier("fast");
		expect(h.session.codexServiceTier).toBe("fast");
		expect(h.session.getCodexServiceTierStatus()).toEqual({
			preference: "fast",
			source: "settings",
			available: true,
		});
		expect(h.session.messages).toEqual(messagesBefore);
		expect(h.sessionManager.buildSessionContext().messages).toEqual(messagesBefore);
		expect(h.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(h.eventsOfType("codex_service_tier_changed")).toEqual([
			{ type: "codex_service_tier_changed", status: { preference: "fast", source: "settings", available: true } },
		]);
		expect(h.settingsManager.getCodexServiceTier()).toBe("fast");
	});

	it("clears the global preference rather than restoring an earlier default", async () => {
		const h = await harness();
		h.session.agent.state.model = codexModel(h);
		h.settingsManager.setCodexServiceTier("fast");
		h.session.setCodexServiceTier("default");
		expect(h.settingsManager.getCodexServiceTier()).toBe("default");
		h.session.setCodexServiceTier(undefined);
		expect(h.session.getCodexServiceTierStatus()).toEqual({ source: "none", available: true });
		expect(h.settingsManager.getCodexServiceTier()).toBeUndefined();
		expect(h.sessionManager.getEntries()).toEqual([]);
		expect(h.eventsOfType("codex_service_tier_changed").at(-1)?.status).toEqual({ source: "none", available: true });
	});

	it.each([false, undefined])("allows saving global Fast with capability %s", async (capability) => {
		const h = await harness();
		h.session.agent.state.model = codexModel(h, { supportsFastMode: capability });
		h.session.setCodexServiceTier("fast");
		expect(h.session.getCodexServiceTierStatus()).toEqual({
			preference: "fast",
			source: "settings",
			available: false,
		});
		expect(h.settingsManager.getCodexServiceTier()).toBe("fast");
		expect(h.sessionManager.getEntries()).toHaveLength(0);
	});

	it("validates untyped session setters and requires both the Codex provider and API", async () => {
		const h = await harness();
		for (const model of [
			h.getModel(),
			{ ...codexModel(h), provider: "other" },
			{ ...codexModel(h), api: "openai-responses" },
		]) {
			h.session.agent.state.model = model;
			expect(isCodexFastModeAvailable(model)).toBe(false);
			h.session.setCodexServiceTier("fast");
			expect(h.session.codexServiceTier).toBe("fast");
		}
		const eventCount = h.eventsOfType("codex_service_tier_changed").length;
		// @ts-expect-error exercise untyped callers
		expect(() => h.session.setCodexServiceTier("priority")).toThrow("Invalid codexServiceTier");
		expect(h.session.codexServiceTier).toBe("fast");
		expect(h.eventsOfType("codex_service_tier_changed")).toHaveLength(eventCount);
		Reflect.set(h.session.agent.state, "model", undefined);
		h.session.setCodexServiceTier("fast");
		expect(h.session.getCodexServiceTierStatus().available).toBe(false);
	});

	it("retains preference and effort across real setModel switches", async () => {
		const h = await harness();
		const supported = codexModel(h);
		vi.spyOn(h.session.modelRuntime, "checkAuth").mockResolvedValue({ type: "oauth", source: "test" });
		await h.session.setModel(supported);
		h.session.setCodexServiceTier("fast");
		const effort = h.session.thinkingLevel;
		await h.session.setModel(h.getModel());
		expect(h.session.getCodexServiceTierStatus()).toMatchObject({ preference: "fast", available: false });
		await h.session.setModel(codexModel(h, { supportsFastMode: false }));
		expect(h.session.getCodexServiceTierStatus().available).toBe(false);
		await h.session.setModel(supported);
		expect(h.session.getCodexServiceTierStatus()).toMatchObject({ preference: "fast", available: true });
		expect(h.session.thinkingLevel).toBe(effort);
		expect(h.session.model).toBe(supported);
	});

	it("ignores historical sibling, reset, and malformed overrides when navigating branches", async () => {
		const h = await harness();
		h.session.agent.state.model = codexModel(h);
		const root = h.sessionManager.appendCustomEntry("root", {});
		const fast = h.sessionManager.appendCustomEntry("codex-service-tier", { tier: "fast" });
		const reset = h.sessionManager.appendCustomEntry("codex-service-tier", { tier: null });
		h.sessionManager.branch(root);
		const standard = h.sessionManager.appendCustomEntry("codex-service-tier", { tier: "default" });
		const malformed = h.sessionManager.appendCustomEntry("codex-service-tier", { tier: "priority" });
		for (const tier of ["fast", "default", undefined] as const) {
			h.session.setCodexServiceTier(tier);
			for (const target of [fast, reset, standard, malformed, root]) {
				await h.session.navigateTree(target);
				expect(h.session.codexServiceTier).toBe(tier);
				expect(h.session.getCodexServiceTierStatus().source).toBe(tier === undefined ? "none" : "settings");
			}
		}
		expect(h.sessionManager.getEntries()).toHaveLength(5);
	});

	it("reports only the latest matching branch-visible Codex attempt, preserving null and unknown", async () => {
		const h = await harness();
		const model = codexModel(h);
		h.session.agent.state.model = model;
		const first = h.sessionManager.appendMessage(
			assistant(model, { requested: "fast", sent: "priority", reported: "default", costEstimated: true }),
		);
		expect(h.session.getCodexServiceTierStatus()).toMatchObject({
			sent: "priority",
			reported: "default",
			costEstimated: true,
		});
		h.sessionManager.appendMessage(assistant({ ...model, id: "other" }, { reported: "fast" }));
		expect(h.session.getCodexServiceTierStatus().reported).toBe("default");
		const failure = { ...assistant(model), stopReason: "error" as const, errorMessage: "mock failure" };
		h.sessionManager.appendMessage(failure);
		expect(h.session.getCodexServiceTierStatus().reported).toBeUndefined();
		expect(h.session.getCodexServiceTierStatus().sent).toBeUndefined();
		h.sessionManager.appendMessage(assistant(model, { sent: null, reported: null }));
		expect(h.session.getCodexServiceTierStatus()).toMatchObject({ sent: null, reported: null });
		await h.session.navigateTree(first);
		expect(h.session.getCodexServiceTierStatus().reported).toBe("default");
		h.session.agent.state.model = h.getModel();
		expect(h.session.getCodexServiceTierStatus().reported).toBeUndefined();
	});

	it("reuses persisted global settings on new/resumed sessions in another cwd and ignores fork/clone overrides", async () => {
		const h = await harness();
		const sessionDir = join(h.tempDir, "sessions");
		const agentDir = join(h.tempDir, "agent");
		const otherCwd = join(h.tempDir, "other-project");
		mkdirSync(sessionDir);
		mkdirSync(otherCwd);
		const settingsManager = SettingsManager.create(h.tempDir, agentDir);
		const sm = SessionManager.create(h.tempDir, sessionDir);
		const session = await sdkSession(h, { sessionManager: sm, settingsManager });
		session.setCodexServiceTier("fast");
		// Historical branch state must survive as data, but never decide the preference.
		const forkParent = sm.appendCustomEntry("codex-service-tier", { tier: "fast" });
		sm.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		sm.appendMessage(assistant(session.model!, { sent: "priority", reported: "default", costEstimated: true }));
		const cloneLeaf = sm.appendCustomEntry("codex-service-tier", { tier: "default" });
		const file = session.sessionFile!;
		const fileBefore = readFileSync(file, "utf-8");
		expect(fileBefore).toContain('"customType":"codex-service-tier"');
		for (const tier of ["fast", "default", undefined] as const) {
			session.setCodexServiceTier(tier);
			await settingsManager.flush();
			expect(readFileSync(file, "utf-8")).toBe(fileBefore);
			const reloaded = SettingsManager.create(otherCwd, agentDir);
			const fresh = await sdkSession(h, { cwd: otherCwd, settingsManager: reloaded });
			const resumed = await sdkSession(h, {
				cwd: otherCwd,
				sessionManager: SessionManager.open(file, sessionDir),
				settingsManager: reloaded,
				codexServiceTier: undefined,
			});
			expect(fresh.codexServiceTier).toBe(tier);
			expect(resumed.codexServiceTier).toBe(tier);
			expect(resumed.getCodexServiceTierStatus()).toMatchObject({ reported: "default", costEstimated: true });
			const fork = SessionManager.open(file, sessionDir);
			fork.createBranchedSession(forkParent);
			const forked = await sdkSession(h, { sessionManager: fork, settingsManager: reloaded });
			expect(forked.codexServiceTier).toBe(tier);
			expect(forked.messages).toEqual([]);
			const clone = SessionManager.open(file, sessionDir);
			clone.createBranchedSession(cloneLeaf);
			const cloned = await sdkSession(h, { sessionManager: clone, settingsManager: reloaded });
			expect(cloned.codexServiceTier).toBe(tier);
			expect(cloned.getCodexServiceTierStatus().reported).toBe("default");
			expect(cloned.messages).toHaveLength(2);
		}
	});
});

describe("Codex service tier SDK request seam", () => {
	it("does not inject a tier for an old or unconfigured session", async () => {
		const h = await harness();
		const capture = captureRequests(h);
		const session = await sdkSession(h);
		await request(session);
		expect(capture.mock.calls[0][2]).not.toHaveProperty("serviceTier");
	});

	it("uses explicit request > global settings, without undefined erasing defaults", async () => {
		const h = await harness();
		h.settingsManager.setCodexServiceTier("fast");
		const capture = captureRequests(h);
		const session = await sdkSession(h, { codexServiceTier: undefined });
		await request(session, { serviceTier: undefined });
		expect(capture.mock.calls.at(-1)?.[2]?.serviceTier).toBe("fast");
		session.setCodexServiceTier("default");
		await request(session);
		expect(capture.mock.calls.at(-1)?.[2]?.serviceTier).toBe("default");
		await request(session, { serviceTier: "priority" });
		expect(capture.mock.calls.at(-1)?.[2]?.serviceTier).toBe("priority");
		session.setCodexServiceTier(undefined);
		await request(session, { serviceTier: "default" });
		expect(capture.mock.calls.at(-1)?.[2]?.serviceTier).toBe("default");
		expect(session.codexServiceTier).toBeUndefined();
		await request(session);
		expect(capture.mock.calls.at(-1)?.[2]).not.toHaveProperty("serviceTier");
	});

	it("ignores project, temporary and historical branch preferences at the SDK seam", async () => {
		const h = await harness();
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ codexServiceTier: "fast" }));
		storage.withLock("project", () => JSON.stringify({ codexServiceTier: "default" }));
		const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: false });
		const capture = captureRequests(h);
		const session = await sdkSession(h, { settingsManager });
		await request(session);
		expect(capture.mock.calls.at(-1)?.[2]?.serviceTier).toBe("fast");
		settingsManager.setProjectTrusted(true);
		settingsManager.applyOverrides({ codexServiceTier: "default" });
		session.sessionManager.appendCustomEntry("codex-service-tier", { tier: "default" });
		await request(session);
		expect(capture.mock.calls.at(-1)?.[2]?.serviceTier).toBe("fast");
		session.setCodexServiceTier(undefined);
		await request(session);
		expect(capture.mock.calls.at(-1)?.[2]).not.toHaveProperty("serviceTier");
		session.setCodexServiceTier("default");
		session.sessionManager.appendCustomEntry("codex-service-tier", { tier: "fast" });
		await request(session);
		expect(capture.mock.calls.at(-1)?.[2]?.serviceTier).toBe("default");
	});

	it("re-resolves each request across supported, unsupported, and non-Codex model switches", async () => {
		const h = await harness();
		const capture = captureRequests(h);
		vi.spyOn(h.session.modelRuntime, "checkAuth").mockResolvedValue({ type: "oauth", source: "test" });
		const session = await sdkSession(h, { codexServiceTier: "fast" });
		const supported = session.model!;
		await request(session);
		await session.setModel(codexModel(h, { supportsFastMode: false }));
		await request(session);
		await session.setModel(h.getModel());
		await request(session);
		await session.setModel(supported);
		await request(session);
		expect(capture.mock.calls.map((call) => call[2]?.serviceTier)).toEqual(["fast", undefined, undefined, "fast"]);
		expect(session.codexServiceTier).toBe("fast");
	});

	it("sets the global preference from the initial SDK option even on unsupported or non-Codex models", async () => {
		const h = await harness();
		const capture = captureRequests(h);
		for (const model of [codexModel(h), codexModel(h, { supportsFastMode: false }), h.getModel()]) {
			h.settingsManager.setCodexServiceTier("default");
			const session = await sdkSession(h, { model, codexServiceTier: "fast" });
			expect(session.getCodexServiceTierStatus()).toMatchObject({ preference: "fast", source: "settings" });
			expect(h.settingsManager.getCodexServiceTier()).toBe("fast");
			expect(session.sessionManager.getBranch().some((entry) => entry.type === "custom")).toBe(false);
			await request(session);
			expect(capture.mock.calls.at(-1)?.[2]?.serviceTier).toBe(isCodexFastModeAvailable(model) ? "fast" : undefined);
		}
		// @ts-expect-error exercise untyped SDK input
		await expect(sdkSession(h, { codexServiceTier: "priority" })).rejects.toThrow("Invalid codexServiceTier");
		expect(h.settingsManager.getCodexServiceTier()).toBe("fast");
	});

	it.each([false, undefined])(
		"suppresses a configured Fast default on capability %s but rejects explicit Fast",
		async (capability) => {
			const h = await harness();
			h.settingsManager.setCodexServiceTier("fast");
			const capture = captureRequests(h);
			const session = await sdkSession(h, { model: codexModel(h, { supportsFastMode: capability }) });
			await request(session);
			expect(capture.mock.calls[0][2]).not.toHaveProperty("serviceTier");
			expect(session.getCodexServiceTierStatus()).toMatchObject({ preference: "fast", available: false });
			for (const serviceTier of ["fast", "priority"] as const) {
				await expect(request(session, { serviceTier })).rejects.toThrow("Fast mode is unavailable");
			}
			expect(capture).toHaveBeenCalledTimes(1);
			await request(session, { serviceTier: "default" });
			expect(capture.mock.calls.at(-1)?.[2]?.serviceTier).toBe("default");
		},
	);

	it("does not inject product defaults on other providers/APIs and preserves direct options", async () => {
		const h = await harness();
		for (const tier of ["fast", "default"] as const) {
			h.settingsManager.setCodexServiceTier(tier);
			for (const model of [
				h.getModel(),
				{ ...codexModel(h), provider: "other" },
				{ ...codexModel(h), api: "openai-responses" },
			]) {
				expect(resolveCodexServiceTierRequest(model, tier)).toBeUndefined();
				expect(resolveCodexServiceTierRequest(model, tier, "fast")).toBe("fast");
			}
		}
		const capture = captureRequests(h);
		const session = await sdkSession(h, { model: h.getModel() });
		await request(session);
		expect(capture.mock.calls[0][2]).not.toHaveProperty("serviceTier");
		await request(session, { serviceTier: "priority" });
		expect(capture.mock.calls[1][2]?.serviceTier).toBe("priority");
	});

	it("captures the current tier per call and leaves in-flight options, effort and cache identity unchanged", async () => {
		const h = await harness();
		const capture = captureRequests(h);
		const session = await sdkSession(h, { codexServiceTier: "fast", cacheAffinityId: "same-prefix" });
		const pending = createAssistantMessageEventStream();
		capture.mockReturnValueOnce(pending);
		const model = session.model!;
		const effort = session.thinkingLevel;
		const options: SimpleStreamOptions = {
			sessionId: "request-id",
			promptCacheKey: "same-key",
			cacheAffinityId: "same-prefix",
			reasoning: "medium",
		};
		const stream = await session.agent.streamFunction(model, { messages: [] }, options);
		session.setCodexServiceTier("default");
		expect(capture.mock.calls[0][2]).toMatchObject({ ...options, serviceTier: "fast" });
		pending.end(assistant(model));
		await stream.result();
		await request(session, options);
		expect(capture.mock.calls[1][2]).toMatchObject({ ...options, serviceTier: "default" });
		expect(options).not.toHaveProperty("serviceTier");
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(effort);
		expect(session.agent.cacheAffinityId).toBe("same-prefix");
		expect(session.agent.promptCacheKey).toBe("same-prefix");
	});

	it("shares the current global preference between sessions using the same SettingsManager", async () => {
		const h = await harness();
		const capture = captureRequests(h);
		const first = await sdkSession(h, { codexServiceTier: "fast" });
		const second = await sdkSession(h);
		expect(second.codexServiceTier).toBe("fast");
		first.setCodexServiceTier("default");
		expect(second.getCodexServiceTierStatus()).toMatchObject({ preference: "default", source: "settings" });
		await request(second);
		expect(capture.mock.calls.at(-1)?.[2]?.serviceTier).toBe("default");
		second.setCodexServiceTier("fast");
		expect(first.codexServiceTier).toBe("fast");
		await request(first);
		expect(capture.mock.calls.at(-1)?.[2]?.serviceTier).toBe("fast");
		first.setCodexServiceTier(undefined);
		expect(second.codexServiceTier).toBeUndefined();
		await request(second);
		expect(capture.mock.calls.at(-1)?.[2]).not.toHaveProperty("serviceTier");
	});

	it("retains the global preference through actual runtime clone/fork and newSession flows", async () => {
		const h = await harness();
		const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager }) => {
			const session = await sdkSession(h, { cwd, sessionManager });
			return {
				session,
				extensionsResult: session.resourceLoader.getExtensions(),
				services: {
					cwd,
					agentDir: h.tempDir,
					modelRuntime: session.modelRuntime,
					settingsManager: h.settingsManager,
					resourceLoader: session.resourceLoader,
					diagnostics: [],
				},
				diagnostics: [],
			};
		};
		const runtime = await createAgentSessionRuntime(factory, {
			cwd: h.tempDir,
			agentDir: h.tempDir,
			sessionManager: SessionManager.inMemory(h.tempDir),
		});
		cleanups.push(() => runtime.dispose());
		const original = runtime.session;
		original.agent.state.model = codexModel(h);
		original.setCodexServiceTier("fast");
		const user = original.sessionManager.appendMessage({ role: "user", content: "fork me", timestamp: Date.now() });
		const response = original.sessionManager.appendMessage(assistant(original.model!));
		await runtime.fork(response, { position: "at" });
		expect(runtime.session.codexServiceTier).toBe("fast");
		expect(runtime.session.messages).toHaveLength(2);
		await runtime.fork(user);
		expect(runtime.session.codexServiceTier).toBe("fast");
		expect(runtime.session.messages).toEqual([]);
		await runtime.newSession();
		expect(runtime.session.codexServiceTier).toBe("fast");
		runtime.session.setCodexServiceTier("default");
		await runtime.newSession();
		expect(runtime.session.codexServiceTier).toBe("default");
		runtime.session.setCodexServiceTier(undefined);
		await runtime.newSession();
		expect(runtime.session.codexServiceTier).toBeUndefined();
	});

	it("sends normal faux prompts without inventing Codex defaults on non-Codex models", async () => {
		const h = await harness();
		h.settingsManager.setCodexServiceTier("fast");
		const session = await sdkSession(h, { model: h.getModel() });
		h.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("hello");
		expect(session.getLastAssistantText()).toBe("ok");
		expect(session.getCodexServiceTierStatus()).toMatchObject({ preference: "fast", available: false });
	});
});
