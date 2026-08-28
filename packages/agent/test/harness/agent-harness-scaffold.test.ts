import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	AgentHarness,
	HarnessClosed,
	HarnessNotImplemented,
	type HarnessTool,
	type Resources,
} from "../../src/harness/agent-harness.ts";
import {
	InMemorySessionStorage,
	type NewRecord,
	type OperationStartedRecord,
	Session,
} from "../../src/harness/session/index.ts";

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

function createHarness(session = createSession()): Promise<AgentHarness> {
	return AgentHarness.create({
		session,
		models: createModels(),
		model: getModel("google", "gemini-2.5-flash"),
	}).then(({ harness }) => harness);
}

function operationStarted(id: string): NewRecord<OperationStartedRecord> {
	return {
		type: "operation_started",
		id,
		lane: "main",
		sourceLeafId: null,
		intent: { kind: "run", originalPrompt: [], initialMessages: [] },
	};
}

describe("AgentHarness v2 scaffold", () => {
	it("opens only record-free sessions before restore is implemented", async () => {
		const session = createSession();
		const { harness, suspended } = await AgentHarness.create({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
		});

		expect(suspended).toEqual([]);
		expect(harness.name).toBe("main");
		expect(harness.session).toBe(session);
		expect(await harness.getLeafId()).toBeNull();
		expect(await harness.session.getLeafId()).toBeNull();

		await expect(harness.close()).resolves.toBeUndefined();

		// A lane with an open operation restores as suspended instead of rejecting.
		const recorded = createSession("recorded");
		await recorded.appendRecord(operationStarted("run"));
		const restored = await AgentHarness.create({
			session: recorded,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
		});
		expect(restored.suspended).toHaveLength(1);
		expect(restored.suspended[0]).toMatchObject({ lane: "main", kind: "run", id: "run", reason: "crash" });
	});

	it("keeps scaffold-safe configuration as defensive copies", async () => {
		const harness = await createHarness();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		await harness.setModel(model);
		expect(await harness.getModel()).toBe(model);

		await harness.setThinkingLevel("high");
		expect(await harness.getThinkingLevel()).toBe("high");

		const activeTools = ["one"];
		await harness.setActiveTools(activeTools);
		activeTools.push("mutated");
		expect(await harness.getActiveTools()).toEqual(["one"]);
		const readActiveTools = await harness.getActiveTools();
		readActiveTools.push("mutated");
		expect(await harness.getActiveTools()).toEqual(["one"]);

		const tool = { name: "tool", label: "Tool" } as HarnessTool;
		const tools = [tool];
		await harness.setTools(tools);
		tools.push({ name: "mutated", label: "Mutated" } as HarnessTool);
		expect((await harness.getTools()).map((item) => item.name)).toEqual(["tool"]);
		const readTools = await harness.getTools();
		readTools.push({ name: "mutated", label: "Mutated" } as HarnessTool);
		expect((await harness.getTools()).map((item) => item.name)).toEqual(["tool"]);

		const resources: Resources = {
			skills: [{ name: "skill", description: "desc", content: "body", filePath: "/tmp/SKILL.md" }],
			promptTemplates: [{ name: "template", content: "body" }],
		};
		await harness.setResources(resources);
		resources.skills?.push({ name: "mutated", description: "desc", content: "body", filePath: "/tmp/OTHER.md" });
		expect((await harness.getResources()).skills?.map((skill) => skill.name)).toEqual(["skill"]);
		const readResources = await harness.getResources();
		readResources.skills?.push({ name: "mutated", description: "desc", content: "body", filePath: "/tmp/OTHER.md" });
		expect((await harness.getResources()).skills?.map((skill) => skill.name)).toEqual(["skill"]);

		const streamOptions = { maxTokens: 10 };
		await harness.setStreamOptions(streamOptions);
		streamOptions.maxTokens = 20;
		expect(await harness.getStreamOptions()).toEqual({ sessionId: "session", maxTokens: 10 });
		const readStreamOptions = await harness.getStreamOptions();
		readStreamOptions.maxTokens = 30;
		expect(await harness.getStreamOptions()).toEqual({ sessionId: "session", maxTokens: 10 });

		const retryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 10 };
		await harness.setRetryPolicy(retryPolicy);
		retryPolicy.maxRetries = 99;
		expect(await harness.getRetryPolicy()).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 10 });

		const compactionSettings = { enabled: false, reserveTokens: 1, keepRecentTokens: 2 };
		await harness.setCompactionSettings(compactionSettings);
		compactionSettings.reserveTokens = 99;
		expect(await harness.getCompactionSettings()).toEqual({ enabled: false, reserveTokens: 1, keepRecentTokens: 2 });

		await harness.setSteeringMode("all");
		expect(await harness.getSteeringMode()).toBe("all");
		await harness.setFollowUpMode("all");
		expect(await harness.getFollowUpMode()).toBe("all");
	});

	it("uses the durable session id for cache affinity and preserves explicit overrides", async () => {
		const defaultHarness = await createHarness(createSession("durable-cache-session"));
		expect(await defaultHarness.getStreamOptions()).toEqual({ sessionId: "durable-cache-session" });
		await defaultHarness.setStreamOptions({ sessionId: undefined, maxTokens: 32 });
		expect(await defaultHarness.getStreamOptions()).toEqual({ sessionId: "durable-cache-session", maxTokens: 32 });

		const undefinedAtCreate = await AgentHarness.create({
			session: createSession("undefined-cache-session"),
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			streamOptions: { sessionId: undefined },
		});
		expect(await undefinedAtCreate.harness.getStreamOptions()).toEqual({ sessionId: "undefined-cache-session" });

		const explicit = await AgentHarness.create({
			session: createSession("durable-cache-session"),
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			streamOptions: { sessionId: "explicit-cache-scope" },
		});
		expect(await explicit.harness.getStreamOptions()).toEqual({ sessionId: "explicit-cache-scope" });
	});

	it("reuses a growing faux-provider prompt within the durable session cache scope", async () => {
		const faux = fauxProvider({ provider: "faux-cache-affinity" });
		faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const { harness } = await AgentHarness.create({
			session: createSession("faux-cache-session"),
			models,
			model: faux.getModel(),
			streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
		});

		const cold = await harness.prompt("shared prefix");
		const warm = await harness.prompt("extend the conversation");
		expect(cold.ok && cold.value.kind === "completed").toBe(true);
		expect(warm.ok && warm.value.kind === "completed").toBe(true);
		if (!cold.ok || cold.value.kind !== "completed" || !warm.ok || warm.value.kind !== "completed") return;
		expect(cold.value.finalMessage.usage.cacheWrite).toBeGreaterThan(0);
		expect(warm.value.finalMessage.usage.cacheRead).toBeGreaterThan(0);
	});

	it("normalizes runtime undefined values in provider messages before durable persistence", async () => {
		const response = fauxAssistantMessage("answer");
		const content = response.content as unknown[];
		(content[0] as Record<string, unknown>).optional = undefined;
		content.push(undefined);
		const session = createSession("provider-json-session");
		const { harness } = await AgentHarness.create({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			streamFn: async () => {
				const stream = createAssistantMessageEventStream();
				stream.end(response as AssistantMessage);
				return stream;
			},
		});

		const result = await harness.prompt("normalize provider response");
		expect(result.ok && result.value.kind === "completed").toBe(true);
		if (!result.ok || result.value.kind !== "completed") return;
		expect(result.value.finalMessage.content).toHaveLength(1);
		expect(result.value.finalMessage.content[0]).not.toHaveProperty("optional");
		expect(result.value.finalMessage.usage).toEqual(response.usage);
	});

	it("isolates faux-provider prompt caches by durable session", async () => {
		const faux = fauxProvider({ provider: "faux-cache-isolation" });
		faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const create = (sessionId: string) =>
			AgentHarness.create({
				session: createSession(sessionId),
				models,
				model: faux.getModel(),
				streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
			});
		const firstHarness = (await create("cache-session-a")).harness;
		const secondHarness = (await create("cache-session-b")).harness;

		const first = await firstHarness.prompt("same prompt");
		const second = await secondHarness.prompt("same prompt");
		for (const result of [first, second]) {
			expect(result.ok && result.value.kind === "completed").toBe(true);
			if (!result.ok || result.value.kind !== "completed") continue;
			expect(result.value.finalMessage.usage.cacheRead).toBe(0);
			expect(result.value.finalMessage.usage.cacheWrite).toBeGreaterThan(0);
		}
	});

	it("keeps faux-provider prompt caching disabled when cache retention is none", async () => {
		const faux = fauxProvider({ provider: "faux-cache-disabled" });
		faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const { harness } = await AgentHarness.create({
			session: createSession("faux-no-cache-session"),
			models,
			model: faux.getModel(),
			streamOptions: { cacheRetention: "none" },
			streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
		});

		const first = await harness.prompt("shared prefix");
		const second = await harness.prompt("extend the conversation");
		for (const result of [first, second]) {
			expect(result.ok && result.value.kind === "completed").toBe(true);
			if (!result.ok || result.value.kind !== "completed") continue;
			expect(result.value.finalMessage.usage.cacheRead).toBe(0);
			expect(result.value.finalMessage.usage.cacheWrite).toBe(0);
		}
	});

	it("rejects every unfinished public operation explicitly", async () => {
		const harness = await createHarness();
		const unfinished: [string, () => unknown | Promise<unknown>][] = [
			["peekAction", () => harness.peekAction()],
			["executeAction", () => harness.executeAction()],
			["runToCompletion", () => harness.runToCompletion()],
			["lane", () => harness.lane("main")],
			["createLane", () => harness.createLane("thread", null)],
		];

		for (const [operation, invoke] of unfinished) {
			await expect(Promise.resolve().then(invoke), operation).rejects.toMatchObject({
				name: "HarnessNotImplemented",
				operation,
			});
		}
		expect(() => harness.hooks.on("before_run", () => {})).toThrow(HarnessNotImplemented);
	});

	it("reports HarnessClosed for unfinished operations after close", async () => {
		const harness = await createHarness();
		await harness.close();

		await expect(harness.prompt("hello")).rejects.toBeInstanceOf(HarnessClosed);
		await expect(harness.waitForIdle()).rejects.toBeInstanceOf(HarnessClosed);
		expect(() => harness.hooks.on("before_run", () => {})).toThrow(HarnessClosed);
	});
});
