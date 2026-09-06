import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CHILD_HARNESS_CONTEXT_ENV } from "@easy-pi/permissions";
import { afterEach, describe, expect, it } from "vitest";
import { registerChildProtocol } from "../src/child-protocol-extension.ts";

const temporaryPaths: string[] = [];
const originalCwd = process.cwd();
const originalContextPath = process.env[CHILD_HARNESS_CONTEXT_ENV];
const originalPromptCacheKey = process.env.WJ_SUBAGENT_PROMPT_CACHE_KEY;

type ProtocolHook = (event: Record<string, unknown>, context: { cwd: string }) => unknown;

interface TestHandoffPolicy {
	taskId: string;
	role: "scout" | "test-analyst" | "failure-analyst" | "reviewer" | "writer" | "external-writer";
}

async function registeredProtocol(handoff?: TestHandoffPolicy): Promise<{
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, ProtocolHook>;
	root: string;
	handoffPath?: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "subagent-child-protocol-"));
	temporaryPaths.push(root);
	let handoffPath: string | undefined;
	if (handoff) {
		const controllerDirectory = await mkdtemp(join(tmpdir(), "subagent-controller-"));
		temporaryPaths.push(controllerDirectory);
		handoffPath = join(controllerDirectory, "handoff.json");
	}
	const contextPath = join(root, "child-harness-context.json");
	await writeFile(
		contextPath,
		JSON.stringify({
			schemaVersion: 2,
			cwd: root,
			permissionMode: "auto",
			sessionGrants: [],
			protectedRoots: [root],
			inheritedWriteRoots: [],
			...(handoff && handoffPath
				? { handoff: { protocolVersion: 2, path: handoffPath, taskId: handoff.taskId, role: handoff.role } }
				: {}),
		}),
		{ mode: 0o600 },
	);
	await chmod(contextPath, 0o600);
	process.chdir(root);
	process.env[CHILD_HARNESS_CONTEXT_ENV] = contextPath;
	process.env.WJ_SUBAGENT_PROMPT_CACHE_KEY = `wj-subagent-v1-${"a".repeat(40)}`;
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, ProtocolHook>();
	const api = {
		on(event: string, handler: ProtocolHook) {
			handlers.set(event, handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerChildProtocol(api);
	return { tools, handlers, root, ...(handoffPath ? { handoffPath } : {}) };
}

async function execute(tool: ToolDefinition, params: unknown): Promise<unknown> {
	return await tool.execute("test-call", params as never, undefined, undefined, undefined as never);
}

afterEach(async () => {
	process.chdir(originalCwd);
	if (originalContextPath === undefined) delete process.env[CHILD_HARNESS_CONTEXT_ENV];
	else process.env[CHILD_HARNESS_CONTEXT_ENV] = originalContextPath;
	if (originalPromptCacheKey === undefined) delete process.env.WJ_SUBAGENT_PROMPT_CACHE_KEY;
	else process.env.WJ_SUBAGENT_PROMPT_CACHE_KEY = originalPromptCacheKey;
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.sequential("child protocol extension", () => {
	it("registers cache-affinity hooks without file-tool overrides", async () => {
		const { tools, handlers, root } = await registeredProtocol();
		expect([...tools.keys()]).toEqual([]);
		expect([...handlers.keys()]).toEqual(["before_agent_start", "before_provider_request"]);

		const promptResult = (await handlers.get("before_agent_start")?.(
			{
				type: "before_agent_start",
				systemPrompt: `Project instructions: ${root}/AGENTS.md\nCurrent working directory: ${root}\nExternal: /external/live`,
			},
			{ cwd: root },
		)) as { systemPrompt: string };
		expect(promptResult.systemPrompt).toContain("Project instructions: ./AGENTS.md");
		expect(promptResult.systemPrompt).toContain("Current working directory: .");
		expect(promptResult.systemPrompt).toContain("External: /external/live");
		expect(promptResult.systemPrompt).not.toContain(root);

		const providerResult = (await handlers.get("before_provider_request")?.(
			{
				type: "before_provider_request",
				payload: {
					prompt_cache_key: "child-session-cache-key",
					session_id: "child-transport-session",
				},
			},
			{ cwd: root },
		)) as { prompt_cache_key: string; session_id: string };
		expect(providerResult).toMatchObject({
			prompt_cache_key: `wj-subagent-v1-${"a".repeat(40)}`,
			session_id: "child-transport-session",
		});
	});

	it("publishes exactly one strict reader handoff through the terminating protocol tool", async () => {
		const { tools, handoffPath } = await registeredProtocol({ taskId: "inspect", role: "scout" });
		expect([...tools.keys()]).toEqual(["submit_handoff"]);
		const payload = {
			summary: "Inspection completed; static inspection passed",
			outcome: "accepted",
			evidence: [{ path: "src/index.ts", claim: "Entry point inspected" }],
		};
		const attempts = await Promise.allSettled([
			execute(tools.get("submit_handoff")!, payload),
			execute(tools.get("submit_handoff")!, payload),
		]);
		expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
		const envelope = JSON.parse(await readFile(handoffPath!, "utf8"));
		expect(envelope).toMatchObject({
			protocolVersion: 2,
			payload: { taskId: "inspect", role: "scout", outcome: "accepted" },
		});
		expect(envelope.payload).toMatchObject({ verification: [], assumptions: [], risks: [], nextActions: [] });
		expect(envelope.payload).not.toHaveProperty("verificationLevel");
	});

	it("rejects missing outcomes and every model-supplied Controller field", async () => {
		const { tools, handoffPath } = await registeredProtocol({ taskId: "review", role: "reviewer" });
		const submit = tools.get("submit_handoff")!;
		const base = {
			summary: "Review completed",
			outcome: "accepted",
		};
		await expect(execute(submit, { ...base, taskId: "other" })).rejects.toThrow("task-bound protocol v2 schema");
		await expect(execute(submit, { ...base, role: "scout" })).rejects.toThrow("task-bound protocol v2 schema");
		const { outcome: _outcome, ...withoutOutcome } = base;
		await expect(execute(submit, withoutOutcome)).rejects.toThrow("task-bound protocol v2 schema");
		await expect(execute(submit, { ...base, artifactVersion: 2, changedPaths: [] })).rejects.toThrow(
			"task-bound protocol v2 schema",
		);
		await expect(readFile(handoffPath!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("injects empty Controller-owned paths into an external-writer envelope", async () => {
		const { tools, handoffPath } = await registeredProtocol({
			taskId: "publish",
			role: "external-writer",
		});
		await expect(
			execute(tools.get("submit_handoff")!, {
				summary: "Published; live side effect recorded",
				outcome: "accepted",
			}),
		).resolves.toMatchObject({ terminate: true });
		const envelope = JSON.parse(await readFile(handoffPath!, "utf8"));
		expect(envelope.payload).toMatchObject({ taskId: "publish", role: "external-writer", artifactVersion: 2 });
		expect(envelope.payload.externalChangedPaths).toEqual([]);
	});

	it("gives each role stable system-level outcome semantics", async () => {
		const { tools: analystTools } = await registeredProtocol({ taskId: "read-guidance", role: "scout" });
		const { tools: reviewerTools } = await registeredProtocol({ taskId: "review-guidance", role: "reviewer" });
		const { tools: writerTools } = await registeredProtocol({ taskId: "write-guidance", role: "writer" });
		const { tools: externalTools } = await registeredProtocol({
			taskId: "external-guidance",
			role: "external-writer",
		});
		const analystGuidance = (analystTools.get("submit_handoff")?.promptGuidelines ?? []).join("\n");
		const reviewerGuidance = (reviewerTools.get("submit_handoff")?.promptGuidelines ?? []).join("\n");
		const writerGuidance = (writerTools.get("submit_handoff")?.promptGuidelines ?? []).join("\n");
		const externalGuidance = (externalTools.get("submit_handoff")?.promptGuidelines ?? []).join("\n");

		expect(analystGuidance).toContain("whether the assigned analysis is complete");
		expect(analystGuidance).toContain("recommend against an option");
		expect(analystGuidance).toContain("known not to satisfy");
		expect(reviewerGuidance).toContain("the review verdict");
		expect(reviewerGuidance).toContain("Use rejected when evidence proves");
		expect(reviewerGuidance).toContain("Use inconclusive when the available evidence is insufficient");
		expect(writerGuidance).toContain("checks performed, unavailable checks, and material risks in summary");
		expect(writerGuidance).toContain(
			"Parent Controller owns changed-path audit, registered validation, and the Git commit",
		);
		expect(externalGuidance).toContain("usable external change");
		expect(externalGuidance).toContain("mutation-journal audit");
		for (const guidance of [analystGuidance, reviewerGuidance, writerGuidance, externalGuidance]) {
			expect(guidance).toContain("Report only summary, outcome, and optional evidence");
			expect(guidance).toContain("Put checks, assumptions, risks, and next steps in summary");
		}
		expect(new Set([analystGuidance, reviewerGuidance, writerGuidance, externalGuidance]).size).toBe(4);
	});

	it("does not duplicate WJ permission decisions in writer handoff publication", async () => {
		const { tools, handoffPath } = await registeredProtocol({ taskId: "write", role: "writer" });
		await expect(
			execute(tools.get("submit_handoff")!, {
				summary: "Writer completed",
				outcome: "accepted",
			}),
		).resolves.toMatchObject({ terminate: true });
		const envelope = JSON.parse(await readFile(handoffPath!, "utf8"));
		expect(envelope.payload).toMatchObject({ taskId: "write", role: "writer", artifactVersion: 2 });
		expect(envelope.payload.changedPaths).toEqual([]);
	});
});
