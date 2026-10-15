import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ChildSession } from "@easy-pi/subagent/session-host";
import { afterEach, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { CodexServiceTier } from "../src/core/codex-service-tier.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createPiChildSessionHost } from "../src/extensions/pi-child-session-host.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.each([undefined, "default", "fast"] as const)(
	"new and cold-loaded children inherit the current remembered global Fast preference (%s)",
	async (defaultTier) => {
		const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-fast-child-")));
		cleanups.push(() => rm(cwd, { recursive: true, force: true }));
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({
			api: "openai-codex-responses",
			provider: "openai-codex",
			models: [{ id: "supported" }, { id: "unknown" }],
			tokensPerSecond: 0,
		});
		// The faux facade uses a generic API type; this fixture explicitly selected Codex above.
		const supportedModel = faux.models[0] as Model<"openai-codex-responses">;
		supportedModel.compat = { supportsFastMode: true };
		modelRuntime.registerNativeProvider(faux.provider);
		const settings = { codexServiceTier: defaultTier, compaction: { enabled: false }, retry: { enabled: false } };
		const settingsManager = SettingsManager.inMemory(settings);
		const agentDir = join(cwd, "agent");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
		});
		await loader.reload();
		const { session: parent } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: faux.getModel(),
			settingsManager,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
			noTools: "all",
		});
		cleanups.push(async () => {
			await parent.shutdown();
		});
		const native: AgentSession[] = [];
		const host = createPiChildSessionHost({
			modelRuntime,
			settings: settingsManager.getSettings(),
			getCodexServiceTier: () => settingsManager.getCodexServiceTier(),
			noExtensions: true,
			getTools: () => [],
			registerTools: () => {},
			observeSession: (_identity, session) => {
				native.push(session);
				return () => {};
			},
		});
		// Change Fast after host construction: new children must not use its stale settings snapshot.
		const globalTier = defaultTier === "fast" ? "default" : "fast";
		parent.setCodexServiceTier(globalTier);
		const children: ChildSession[] = [];
		for (const [index, id] of ["supported", "unknown"].entries()) {
			const child = await host.create({
				rootSessionId: "fast-test",
				agentPath: `/root/child-${index}`,
				cwd,
				agentDir,
				model: { provider: "openai-codex", id, thinkingLevel: "off" },
				storage: index === 0 ? { kind: "file", directory: join(cwd, "child-history") } : { kind: "memory" },
				getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
			});
			children.push(child);
			cleanups.push(() => child.dispose());
			expect(native[index].codexServiceTier).toBe(globalTier);
			expect(native[index].getCodexServiceTierStatus().source).toBe("settings");
			const calls: Array<SimpleStreamOptions | undefined> = [];
			faux.setResponses([
				(_context, options) => {
					calls.push(options);
					return fauxAssistantMessage("child done");
				},
			]);
			expect(await child.run("complete the child task")).toMatchObject({ status: "completed" });
			expect(calls).toHaveLength(1);
			const expected: CodexServiceTier | undefined =
				id === "unknown" && globalTier === "fast" ? undefined : globalTier;
			if (expected === undefined) expect(calls[0]).not.toHaveProperty("serviceTier");
			else expect(calls[0]?.serviceTier).toBe(expected);
		}
		parent.setCodexServiceTier(undefined);
		expect(native.map((session) => session.codexServiceTier)).toEqual([globalTier, globalTier]);
		expect(settingsManager.getCodexServiceTier()).toBeUndefined();
		const file = children[0].sessionFile!;
		await children[0].dispose();
		for (const [index, storage] of [
			{ kind: "memory" as const },
			{ kind: "file" as const, directory: join(cwd, "child-history"), sessionFile: file },
		].entries()) {
			const child = await host.create({
				rootSessionId: "fast-test",
				agentPath: index === 0 ? "/root/new-child" : "/root/child-0",
				cwd,
				agentDir,
				model: { provider: "openai-codex", id: "supported", thinkingLevel: "off" },
				storage,
				getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
			});
			cleanups.push(() => child.dispose());
			expect(native.at(-1)?.codexServiceTier).toBeUndefined();
			const calls: Array<SimpleStreamOptions | undefined> = [];
			faux.setResponses([
				(_context, options) => {
					calls.push(options);
					return fauxAssistantMessage("current global default");
				},
			]);
			expect(await child.run("use the remembered global preference")).toMatchObject({ status: "completed" });
			expect(calls[0]).not.toHaveProperty("serviceTier");
		}
	},
);
