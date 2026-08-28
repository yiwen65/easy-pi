import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession, type InlineExtension } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const V2_NAMES = ["search", "read", "edit", "run"];

describe("v2 tool profile", () => {
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-v2-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	async function createSession(
		options: {
			toolProfile?: "legacy" | "v2";
			tools?: string[];
			excludeTools?: string[];
			extensions?: InlineExtension[];
			sessionManager?: SessionManager;
		} = {},
	) {
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: options.extensions,
		});
		await resourceLoader.reload();
		return (
			await createAgentSession({
				cwd,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				resourceLoader,
				sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
				toolProfile: options.toolProfile,
				tools: options.tools,
				excludeTools: options.excludeTools,
			})
		).session;
	}

	it("rejects unknown SDK profiles instead of falling back", async () => {
		await expect(createAgentSession({ toolProfile: "future" as "v2" })).rejects.toThrow(
			"Unknown tool profile: future",
		);
	});

	it("keeps legacy as the default and selects exactly four v2 built-ins", async () => {
		const legacy = await createSession();
		expect(legacy.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		legacy.dispose();

		const v2 = await createSession({ toolProfile: "v2" });
		expect(v2.getActiveToolNames()).toEqual(V2_NAMES);
		expect(v2.getAllTools().map((tool) => tool.name)).toEqual(V2_NAMES);
		expect(v2.systemPrompt).toContain("- search:");
		expect(v2.systemPrompt).toContain("- run:");
		expect(v2.systemPrompt).not.toContain("- bash:");
		expect(v2.getToolDefinition("search")?.parameters).toMatchObject({ required: ["query"] });
		expect(v2.getToolDefinition("read")?.parameters).toMatchObject({ required: ["path"] });
		expect(v2.getToolDefinition("edit")?.parameters).toMatchObject({ required: ["operations"] });
		expect(v2.getToolDefinition("run")?.parameters).toMatchObject({ required: ["command"] });
		expect(v2.getToolDefinition("run")?.renderCall).toBeTypeOf("function");
		expect(v2.systemPrompt).toContain("use one edit batch with move first");
		v2.dispose();
	});

	it("applies allowlist, denylist, and extension overrides after profile selection", async () => {
		const session = await createSession({
			toolProfile: "v2",
			tools: ["search", "run"],
			excludeTools: ["run"],
			extensions: [
				(pi) =>
					pi.registerTool({
						name: "search",
						label: "override",
						description: "extension search override",
						parameters: Type.Object({ query: Type.String() }),
						execute: async () => ({ content: [{ type: "text", text: "override" }], details: {} }),
					}),
			],
		});
		expect(session.getActiveToolNames()).toEqual(["search"]);
		expect(session.getToolDefinition("search")?.description).toBe("extension search override");
		expect(session.getToolDefinition("bash")).toBeUndefined();
		session.dispose();
	});

	it("does not persist v2 across session recreation", async () => {
		const sessionManager = SessionManager.inMemory(cwd);
		const v2 = await createSession({ toolProfile: "v2", sessionManager });
		expect(v2.getActiveToolNames()).toEqual(V2_NAMES);
		v2.dispose();

		const resumedWithoutProfile = await createSession({ sessionManager });
		expect(resumedWithoutProfile.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		resumedWithoutProfile.dispose();
	});
});
