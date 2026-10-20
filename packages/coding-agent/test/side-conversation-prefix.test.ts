import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, test, vi } from "vitest";
import type { InlineExtension } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	assertSideConversationPrefixCompatible,
	getSideConversationPrefix,
	observeSideConversationPrefix,
} from "../src/core/side-conversation-prefix.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(api = "faux", extensions: InlineExtension[] = []) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-side-prefix-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		api,
		provider: "side-prefix-faux",
		tokensPerSecond: 0,
		models: [{ id: "prefix-model", reasoning: true }],
	});
	runtime.registerNativeProvider(faux.provider);
	const manager = SessionManager.inMemory(cwd);
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: extensions,
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime: runtime,
		model: faux.getModel(),
		thinkingLevel: "medium",
		sessionManager: manager,
		settingsManager: settings,
		resourceLoader: loader,
		tools: ["read", "deliver_result", "report_progress"],
		customTools: ["deliver_result", "report_progress"].map((name) => ({
			name,
			label: name,
			description: `Original ${name} description`,
			parameters: Type.Object({ text: Type.String() }),
			constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const },
			async execute() {
				return { content: [{ type: "text" as const, text: "unused" }], details: {} };
			},
		})),
	});
	await session.bindExtensions({ mode: "rpc" });
	const stop = observeSideConversationPrefix(session);
	cleanups.push(async () => {
		stop();
		await session.shutdown();
	});
	const warm = async () => {
		faux.setResponses([fauxAssistantMessage("parent answer")]);
		await session.prompt("parent question");
		return getSideConversationPrefix(session);
	};
	return { session, manager, faux, warm, stop };
}

test("missing parent capture fails clearly without inference or a fallback", async () => {
	const f = await fixture();
	expect(() => getSideConversationPrefix(f.session)).toThrow(/Send a parent message first/);
	expect(f.faux.state.callCount).toBe(0);
});

test("captures every ordered neutral schema and detached model/messages without executable implementations", async () => {
	const f = await fixture();
	let sent: Context | undefined;
	f.faux.setResponses([
		(context) => {
			sent = context;
			return fauxAssistantMessage("captured");
		},
	]);
	await f.session.prompt("exact parent input");
	const prefix = getSideConversationPrefix(f.session);
	expect(prefix.context.systemPrompt).toBe(sent?.systemPrompt);
	expect(prefix.context.messages).toEqual(sent?.messages);
	expect(prefix.context.tools?.map((tool) => tool.name)).toEqual(["read", "deliver_result", "report_progress"]);
	expect(prefix.context.tools?.[1].constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
	expect(prefix.context.tools?.every((tool) => !("execute" in tool))).toBe(true);
	expect(prefix.model).toEqual(f.session.model);
	expect(prefix.model).not.toBe(f.session.model);
	prefix.context.messages.splice(0);
	prefix.context.tools?.reverse();
	prefix.model.id = "detached mutation";
	const fresh = getSideConversationPrefix(f.session);
	expect(fresh.context.messages).toEqual(sent?.messages);
	expect(fresh.context.tools?.map((tool) => tool.name)).toEqual(["read", "deliver_result", "report_progress"]);
	expect(fresh.model.id).toBe("prefix-model");
});

test("same-branch appends preserve a snapshot, but rewinds and sibling branches reject it", async () => {
	const f = await fixture();
	const prefix = await f.warm();
	f.manager.appendMessage({ role: "user", content: "later append", timestamp: 5 });
	expect(() => assertSideConversationPrefixCompatible(f.session, prefix)).not.toThrow();
	expect(getSideConversationPrefix(f.session).leafId).toBe(prefix.leafId);
	const beforeCapture = f.manager.getEntries().find((entry) => entry.id !== prefix.leafId)!;
	f.manager.branch(beforeCapture.id);
	expect(() => assertSideConversationPrefixCompatible(f.session, prefix)).toThrow(/branch or compaction changed/);
	f.manager.appendMessage({ role: "user", content: "sibling", timestamp: 6 });
	expect(() => getSideConversationPrefix(f.session)).toThrow(/branch or compaction changed/);
});

test("replacement checkpoints invalidate the prior effective prefix", async () => {
	const f = await fixture();
	const prefix = await f.warm();
	f.manager.appendCompactionCheckpoint([{ role: "user", content: "replacement", timestamp: 7 }], 100);
	expect(() => assertSideConversationPrefixCompatible(f.session, prefix)).toThrow(/branch or compaction changed/);
});

test.each(["model", "endpoint", "api", "effort", "tier", "rules", "tool-schema", "tool-order"])(
	"rejects changed parent %s before side admission",
	async (change) => {
		const f = await fixture();
		await f.warm();
		switch (change) {
			case "model":
				f.session.agent.state.model = { ...f.session.model!, id: "another-model" };
				break;
			case "endpoint":
				f.session.agent.state.model = { ...f.session.model!, baseUrl: "https://example.invalid/changed" };
				break;
			case "api":
				f.session.agent.state.model = { ...f.session.model!, api: "changed-api" };
				break;
			case "effort":
				f.session.setThinkingLevel("high");
				break;
			case "tier":
				f.session.setCodexServiceTier("fast");
				break;
			case "rules":
				f.session.agent.state.systemPrompt += "\nNew parent policy";
				break;
			case "tool-schema":
				f.session.agent.state.tools[0] = { ...f.session.agent.state.tools[0], description: "changed" };
				break;
			case "tool-order":
				f.session.agent.state.tools.reverse();
				break;
		}
		expect(() => getSideConversationPrefix(f.session)).toThrow(
			/parent (model or reasoning|service tier|rules|tool declarations) changed/,
		);
		expect(f.faux.state.callCount).toBe(1);
	},
);

test.each(["before_provider_request", "before_provider_headers"] as const)(
	"rejects %s hooks rather than promising an unverifiable final request",
	async (hook) => {
		const f = await fixture("faux", [
			(pi) => {
				if (hook === "before_provider_request") pi.on(hook, (event) => event.payload);
				else pi.on(hook, () => {});
			},
		]);
		f.faux.setResponses([fauxAssistantMessage("parent ran")]);
		await f.session.prompt("capture parent");
		expect(() => getSideConversationPrefix(f.session)).toThrow(/transforming extensions enabled/);
	},
);

test.each(["faux", "openai-codex-responses"])(
	"inherits effective routing for %s without replacing native identity",
	async (api) => {
		const f = await fixture(api);
		const id = f.session.sessionId;
		f.session.agent.promptCacheKey = "existing-cache-key";
		f.session.agent.cacheAffinityId = "existing-lineage";
		const prefix = await f.warm();
		expect(prefix.promptCacheKey).toBe("existing-cache-key");
		expect(prefix.cacheAffinityId).toBe(api === "openai-codex-responses" ? "existing-lineage" : undefined);
		expect(f.session.sessionId).toBe(id);
		expect(f.session.agent.sessionId).toBe(id);
		f.session.agent.promptCacheKey = "different-key";
		expect(() => assertSideConversationPrefixCompatible(f.session, prefix)).toThrow(/cache routing changed/);
	},
);

test("missing explicit routing uses the parent's native ID as lineage, not another generated identity", async () => {
	const f = await fixture("openai-codex-responses");
	const prefix = await f.warm();
	expect(prefix.promptCacheKey).toBe(f.session.sessionId);
	expect(prefix.cacheAffinityId).toBe(f.session.sessionId);
});

test("chains a throwing existing observer and restores it without retaining a side snapshot", async () => {
	const f = await fixture();
	f.stop();
	const original = vi.fn(() => {
		throw new Error("diagnostic failure");
	});
	f.session.agent.onProviderContext = original;
	const stop = observeSideConversationPrefix(f.session);
	await f.warm();
	expect(original).toHaveBeenCalledOnce();
	stop();
	expect(f.session.agent.onProviderContext).toBe(original);
	expect(() => getSideConversationPrefix(f.session)).toThrow(/No parent request prefix/);
});

test("disposing an older observer cannot overwrite a later observer or resurrect its snapshot", async () => {
	const f = await fixture();
	const later = observeSideConversationPrefix(f.session);
	const callback = f.session.agent.onProviderContext;
	f.stop();
	await f.warm();
	expect(f.session.agent.onProviderContext).toBe(callback);
	later();
	expect(() => getSideConversationPrefix(f.session)).toThrow(/No parent request prefix/);
	f.faux.setResponses([fauxAssistantMessage("after disposal")]);
	await f.session.prompt("must not recapture");
	expect(() => getSideConversationPrefix(f.session)).toThrow(/No parent request prefix/);
});

test("diagnostic observer mutation cannot alter the captured provider prefix", async () => {
	const f = await fixture();
	f.stop();
	f.session.agent.onProviderContext = (_model, context) => {
		context.messages.splice(0);
		context.tools?.reverse();
	};
	const stop = observeSideConversationPrefix(f.session);
	try {
		const prefix = await f.warm();
		expect(prefix.context.messages).not.toHaveLength(0);
		expect(prefix.context.tools?.map((tool) => tool.name)).toEqual(["read", "deliver_result", "report_progress"]);
	} finally {
		stop();
	}
});

test("a failed new capture clears the older snapshot instead of silently reusing it", async () => {
	const f = await fixture();
	const prefix = await f.warm();
	f.session.agent.onProviderContext?.(prefix.model, {
		...prefix.context,
		tools: [
			{
				name: "uncloneable",
				description: "cannot snapshot",
				parameters: { ...Type.Object({}), invalid: () => {} },
			},
		],
	});
	expect(() => getSideConversationPrefix(f.session)).toThrow(/No parent request prefix/);
});

test("Codex affinity changes invalidate an otherwise unchanged captured prefix", async () => {
	const f = await fixture("openai-codex-responses");
	const prefix = await f.warm();
	f.session.agent.cacheAffinityId = "another-lineage";
	expect(() => assertSideConversationPrefixCompatible(f.session, prefix)).toThrow(/cache routing changed/);
});

test("prefix ownership rejects another parent even when its model and tools match", async () => {
	const source = await fixture();
	const other = await fixture();
	const prefix = await source.warm();
	await other.warm();
	expect(() => assertSideConversationPrefixCompatible(other.session, prefix)).toThrow(/another parent session/);
});
