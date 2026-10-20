import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { Type } from "typebox";
import { afterEach, expect, test, vi } from "vitest";
import { streamSimple as codexStream } from "../../ai/src/api/openai-codex-responses.ts";
import { streamSimple as responsesStream } from "../../ai/src/api/openai-responses.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionFactory, InlineExtension, ToolDefinition } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SideConversationController, type SideConversationOptions } from "../src/core/side-conversation.ts";
import { BACKGROUND_TASK_TOOL_NAMES } from "../src/core/tools/index.ts";
import { createCodemodeExtension } from "../src/extensions/codemode/index.ts";
import { createMcpExtension, getSessionMcpConfig } from "../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../src/extensions/mcp/runtime.ts";
import { registerPiCollaborationRoot } from "../src/extensions/pi-collaboration-root.ts";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function capture(context: Context): Context {
	return {
		systemPrompt: context.systemPrompt,
		messages: structuredClone(context.messages),
		tools: context.tools?.map(({ name, description, parameters, constrainedSampling }) =>
			structuredClone({
				name,
				description,
				parameters,
				...(constrainedSampling === undefined ? {} : { constrainedSampling }),
			}),
		),
	};
}

function textOf(messages: readonly AgentMessage[]): string {
	return messages
		.map((message) =>
			"content" in message
				? typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n")
				: "",
		)
		.join("\n");
}

async function fixture(
	options: {
		codemode?: boolean;
		api?: string;
		policy?: ExtensionFactory;
		extensions?: (cwd: string) => InlineExtension[];
		customTools?: ToolDefinition[];
		tools?: string[];
		createSession?: SideConversationOptions["createSession"];
		wire?: boolean;
	} = {},
) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-side-test-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		provider: "side-test",
		api: options.api ?? "openai-codex-responses",
		tokensPerSecond: 0,
	});
	const requests: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
	const bodies: Array<Record<string, unknown>> = [];
	const headers: Headers[] = [];
	if (options.wire) {
		const token = `synthetic.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "side-test" } }))}.signature`;
		runtime.registerNativeProvider({
			...faux.provider,
			streamSimple(model, context, streamOptions) {
				requests.push({ context: capture(context), options: streamOptions });
				const requestOptions = {
					...streamOptions,
					apiKey: token,
					transport: "sse" as const,
					maxRetries: 0,
					fetch: async (_input: string | URL | Request, init?: RequestInit) => {
						const requestHeaders = new Headers(init?.headers);
						const body = init?.body;
						const json =
							typeof body === "string"
								? body
								: body instanceof Uint8Array
									? requestHeaders.get("content-encoding") === "zstd"
										? zstdDecompressSync(body).toString("utf8")
										: new TextDecoder().decode(body)
									: "";
						bodies.push(JSON.parse(json) as Record<string, unknown>);
						headers.push(requestHeaders);
						return new Response(
							`data: ${JSON.stringify({ type: "response.completed", response: { id: `response-${bodies.length}`, status: "completed", usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100, input_tokens_details: { cached_tokens: 80 } } } })}\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						);
					},
				};
				return model.api === "openai-responses"
					? responsesStream(model as Model<"openai-responses">, context, requestOptions)
					: codexStream(model as Model<"openai-codex-responses">, context, requestOptions);
			},
		});
	} else {
		runtime.registerNativeProvider({
			...faux.provider,
			streamSimple(model, context, streamOptions) {
				requests.push({ context: capture(context), options: streamOptions });
				return faux.provider.streamSimple!(model, context, streamOptions);
			},
		});
		faux.setResponses(Array.from({ length: 16 }, () => fauxAssistantMessage("answer")));
	}
	const extensionsResult = await createTestExtensionsResult(
		[
			...(options.codemode ? [{ name: "codemode", factory: createCodemodeExtension() }] : []),
			...(options.policy ? [{ name: "policy", factory: options.policy }] : []),
			...(options.extensions?.(cwd) ?? []),
		],
		cwd,
	);
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime: runtime,
		model: faux.getModel(),
		thinkingLevel: "off",
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			transport: "sse",
		}),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		tools: options.tools ?? [
			"read",
			"write",
			"edit",
			"bash",
			...BACKGROUND_TASK_TOOL_NAMES,
			...(options.codemode ? ["codemode"] : []),
		],
		customTools: options.customTools,
	});
	await parent.bindExtensions({ mode: "rpc", recoveryPolicy: "host-controlled" });
	const sides: AgentSession[] = [];
	const side = new SideConversationController(parent, {
		createSession: async (sessionOptions) => {
			const result = await (options.createSession ?? createAgentSession)(sessionOptions);
			sides.push(result.session);
			return result;
		},
	});
	cleanups.push(async () => {
		await side.shutdown();
		await parent.shutdown();
	});
	return { cwd, runtime, faux, requests, bodies, headers, parent, side, sides };
}

test("side requires a captured request and does not infer or create files on open", async () => {
	const f = await fixture();
	await expect(f.side.open()).rejects.toThrow(/parent request prefix/);
	expect(f.faux.state.callCount).toBe(0);
	await f.parent.prompt("parent background");
	await f.side.open();
	expect(f.faux.state.callCount).toBe(1);
	expect(f.sides[0].sessionId).not.toBe(f.parent.sessionId);
	expect(f.sides[0].sessionFile).toBeUndefined();
	expect(f.sides[0].modelRuntime).not.toBe(f.parent.modelRuntime);
	expect(f.side.snapshot.messages).toEqual([]);
	expect(await readdir(f.cwd)).toEqual([]);
});

test("side preserves full neutral prefix, routing and parent history while supporting followup", async () => {
	const f = await fixture();
	f.parent.agent.promptCacheKey = "already-shared-key";
	f.parent.agent.cacheAffinityId = "already-shared-affinity";
	await f.parent.prompt("background marker");
	const before = structuredClone(f.parent.messages);
	await f.side.prompt("side question");
	const parent = f.requests[0];
	const child = f.requests[1];
	expect(child.context.systemPrompt).toBe(parent.context.systemPrompt);
	expect(child.context.tools).toEqual(parent.context.tools);
	expect(child.context.messages.slice(0, parent.context.messages.length)).toEqual(parent.context.messages);
	expect(JSON.stringify(child.context.messages)).toContain("Side conversation boundary");
	expect(child.options).toMatchObject({
		promptCacheKey: "already-shared-key",
		cacheAffinityId: "already-shared-affinity",
		transport: "sse",
	});
	expect(child.options?.sessionId).not.toBe(parent.options?.sessionId);
	expect(f.parent.messages).toEqual(before);
	expect(textOf(f.side.snapshot.messages)).not.toContain("background marker");
	expect(textOf(f.side.snapshot.messages)).toContain("side question");
	const id = f.sides[0].sessionId;
	await f.side.prompt("followup");
	expect(f.sides).toHaveLength(1);
	expect(f.sides[0].sessionId).toBe(id);
	expect(f.side.snapshot.state).toBe("idle");
});

test.each(["openai-codex-responses", "openai-responses"])(
	"real %s serializer preserves the wire prefix and native identity",
	async (api) => {
		const f = await fixture({ wire: true, api });
		await f.parent.prompt("wire prefix marker");
		await f.side.prompt("wire side question");
		expect(f.bodies).toHaveLength(2);
		const [parent, side] = f.bodies;
		expect(side.instructions).toBe(parent.instructions);
		expect(side.tools).toEqual(parent.tools);
		const parentInput = parent.input as unknown[];
		expect((side.input as unknown[]).slice(0, parentInput.length)).toEqual(parentInput);
		expect(side.prompt_cache_key).toBe(parent.prompt_cache_key);
		if (api === "openai-codex-responses") {
			expect(f.headers[1].get("session-id")).toBe(f.headers[0].get("session-id"));
			expect(f.headers[1].get("x-client-request-id")).not.toBe(f.headers[0].get("x-client-request-id"));
		}
		expect(f.requests[1].options?.sessionId).not.toBe(f.requests[0].options?.sessionId);
		expect(f.side.snapshot.usage.cacheRead).toBe(80); // Mock usage, not a live cache-hit claim.
		await f.side.close();
		expect(f.parent.isIdle).toBe(true);
		await f.parent.prompt("parent still usable");
		expect(f.bodies).toHaveLength(3);
	},
);

test.each(["openai-codex-responses", "openai-responses"])(
	"inactive model-scoped payload hook permits verified side replay for %s",
	async (api) => {
		let hookCalls = 0;
		const f = await fixture({
			wire: true,
			api,
			policy: (pi) => {
				pi.on("before_provider_request", (event) => {
					hookCalls++;
					const payload = event.payload as { model?: string; instructions?: string };
					if (payload.model?.startsWith("qd/")) return { ...payload, instructions: "Qoder-only policy" };
					return undefined;
				});
			},
		});
		await f.parent.prompt("parent cache prefix");
		await f.side.prompt("side question");
		expect(hookCalls).toBe(1); // Observe the real parent hook once; do not re-execute it for a side probe.
		expect(f.bodies).toHaveLength(2);
		const [parent, side] = f.bodies;
		expect(side.instructions).toBe(parent.instructions);
		expect(side.tools).toEqual(parent.tools);
		expect((side.input as unknown[]).slice(0, (parent.input as unknown[]).length)).toEqual(parent.input);
		expect(side.prompt_cache_key).toBe(parent.prompt_cache_key);
	},
);

test.each(["return", "in-place", "awaited", "throw"])(
	"a %s payload hook blocks side replay without changing parent execution",
	async (kind) => {
		let calls = 0;
		const f = await fixture({
			wire: true,
			policy: (pi) => {
				pi.on("before_provider_request", async (event) => {
					calls++;
					const payload = event.payload as Record<string, unknown>;
					if (kind === "throw") throw new Error("fixture hook failure");
					if (kind === "return") return { ...payload, instructions: "modified parent policy" };
					if (kind === "awaited") await Promise.resolve();
					payload.instructions = "modified parent policy";
					return undefined;
				});
			},
		});
		await f.parent.prompt("parent executes once");
		expect(f.bodies).toHaveLength(1);
		if (kind !== "throw") expect(f.bodies[0].instructions).toBe("modified parent policy");
		await expect(f.side.prompt("must not infer")).rejects.toThrow(
			kind === "throw" ? /observation or hook execution failed/ : /payload hook changed the request/,
		);
		expect(f.bodies).toHaveLength(1);
		expect(f.sides).toHaveLength(0);
		expect(calls).toBe(1);
	},
);

test("authorized write, edit and shell tools affect the shared workspace, not parent history", async () => {
	const f = await fixture();
	await f.parent.prompt("parent");
	const before = structuredClone(f.parent.messages);
	f.faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("write", { path: join(f.cwd, "result.txt"), content: "first" }),
				fauxToolCall("bash", { command: "printf shell > shell-effect" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("edit", { path: join(f.cwd, "result.txt"), oldText: "first", newText: "edited" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await f.side.prompt("write and edit the requested files");
	expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toBe("edited");
	expect(await readFile(join(f.cwd, "shell-effect"), "utf8")).toBe("shell");
	expect(
		f.side.snapshot.messages.filter((message) => message.role === "toolResult").every((message) => !message.isError),
	).toBe(true);
	expect(f.parent.messages).toEqual(before);
	await f.side.close();
	expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toBe("edited");
});

test("read uses the side's own builtin and retains the root's read policy", async () => {
	const f = await fixture({
		policy: (pi) => {
			pi.on("tool_call", (event) =>
				event.toolName === "read" && String(event.input.path).endsWith("protected.txt")
					? { block: true, reason: "protected" }
					: undefined,
			);
		},
	});
	await writeFile(join(f.cwd, "allowed.txt"), "read-only evidence");
	await writeFile(join(f.cwd, "protected.txt"), "private evidence");
	await f.parent.prompt("parent");
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: join(f.cwd, "allowed.txt") }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("read", { path: join(f.cwd, "protected.txt") }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await f.side.prompt("inspect");
	const results = f.side.snapshot.messages.filter((message) => message.role === "toolResult");
	expect(textOf(results)).toContain("read-only evidence");
	expect(textOf(results)).not.toContain("private evidence");
	expect(results.at(-1)?.isError).toBe(true);
});

test("codemode inherits writes and parent policy while owning/deleting only its spill directory", async () => {
	const f = await fixture({
		codemode: true,
		policy: (pi) => {
			pi.on("tool_call", (event) =>
				event.toolName === "write" && String(event.input.path).endsWith("protected")
					? { block: true, reason: "parent policy" }
					: undefined,
			);
		},
	});
	await writeFile(join(f.cwd, "evidence.txt"), "evidence");
	await f.parent.prompt("parent");
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: `// @options: {"max_output_tokens": 20}\nconst result = await tools.read({path: ${JSON.stringify(join(f.cwd, "evidence.txt"))}});\nawait tools.write({path: ${JSON.stringify(join(f.cwd, "written"))}, content: 'allowed'});\ntry { await tools.write({path: ${JSON.stringify(join(f.cwd, "protected"))}, content: 'bad'}); } catch {}\nreturn result + 'x'.repeat(1000);`,
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await f.side.prompt("read through script");
	expect(existsSync(join(f.cwd, "protected"))).toBe(false);
	expect(await readFile(join(f.cwd, "written"), "utf8")).toBe("allowed");
	const result = f.side.snapshot.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "codemode",
	);
	expect(result?.role).toBe("toolResult");
	const path =
		result?.role === "toolResult" ? (result.details as { fullOutputPath?: string }).fullOutputPath : undefined;
	expect(path).toBeDefined();
	expect(await readFile(path!, "utf8")).toContain("evidence");
	await f.side.close();
	expect(existsSync(dirname(path!))).toBe(false);
	expect(await readFile(join(f.cwd, "evidence.txt"), "utf8")).toBe("evidence");
});

test("recreated extension tools bind captured pi and context to the side, not the parent", async () => {
	const f = await fixture({
		tools: ["probe"],
		extensions: () => [
			{
				name: "probe",
				factory: (pi) => {
					let calls = 0;
					pi.registerTool({
						name: "probe",
						label: "probe",
						description: "Session probe",
						parameters: Type.Object({}),
						async execute(_id, _args, _signal, _update, ctx) {
							pi.appendEntry("probe-state", { calls: ++calls });
							return {
								content: [{ type: "text", text: ctx.sessionManager.getSessionId() }],
								details: { calls },
							};
						},
					});
				},
			},
		],
	});
	await f.parent.prompt("parent");
	const before = structuredClone(f.parent.sessionManager.getEntries());
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await f.side.prompt("probe own session");
	expect(textOf(f.side.snapshot.messages)).toContain(f.sides[0].sessionId);
	expect(f.sides[0].sessionManager.getEntries()).toContainEqual(
		expect.objectContaining({ type: "custom", customType: "probe-state", data: { calls: 1 } }),
	);
	expect(f.parent.sessionManager.getEntries()).toEqual(before);
});

test("SDK same-named tools retain their implementation but receive the side's context", async () => {
	const seen: string[] = [];
	const f = await fixture({
		tools: ["write"],
		customTools: [
			{
				name: "write",
				label: "host write",
				description: "Host custom write",
				parameters: Type.Object({}),
				async execute(_id, _args, _signal, _update, ctx) {
					seen.push(ctx.sessionManager.getSessionId());
					return { content: [{ type: "text", text: "host implementation" }], details: {} };
				},
			},
		],
	});
	await f.parent.prompt("parent");
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await f.side.prompt("use custom writer");
	expect(seen).toEqual([f.sides[0].sessionId]);
	expect(textOf(f.side.snapshot.messages)).toContain("host implementation");
});

test("parent policy runs after side-local hooks have finished changing tool arguments", async () => {
	let executions = 0;
	const f = await fixture({
		tools: ["probe"],
		extensions: () => [
			{
				name: "owner",
				factory: (pi) => {
					pi.registerTool({
						name: "probe",
						label: "probe",
						description: "Probe",
						parameters: Type.Object({ value: Type.Integer() }),
						async execute() {
							executions++;
							return { content: [], details: {} };
						},
					});
					pi.on("tool_call", (event) => {
						if (event.toolName === "probe") event.input.value = Number(event.input.value) + 1;
					});
				},
			},
			{
				name: "guard",
				factory: (pi) => {
					pi.on("tool_call", (event) =>
						event.toolName === "probe" && Number(event.input.value) >= 2
							? { block: true, reason: "final input denied" }
							: undefined,
					);
				},
			},
		],
	});
	await f.parent.prompt("parent");
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("probe", { value: 0 }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await f.side.prompt("check final arguments");
	expect(executions).toBe(0);
	expect(f.side.snapshot.messages.filter((message) => message.role === "toolResult").at(-1)).toMatchObject({
		isError: true,
	});
});

test("parent output policy runs after side-local result hooks", async () => {
	const f = await fixture({
		tools: ["probe"],
		extensions: () => [
			{
				name: "owner",
				factory: (pi) => {
					pi.registerTool({
						name: "probe",
						label: "probe",
						description: "Probe",
						parameters: Type.Object({}),
						async execute() {
							return { content: [{ type: "text", text: "PARENT_REDACTION_SECRET" }], details: {} };
						},
					});
					pi.on("tool_result", () => ({ content: [{ type: "text", text: "PARENT_REDACTION_SECRET" }] }));
				},
			},
			{
				name: "redaction",
				factory: (pi) => {
					pi.on("tool_result", () => ({ content: [{ type: "text", text: "redacted" }] }));
				},
			},
		],
	});
	await f.parent.prompt("parent");
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await f.side.prompt("show permitted output only");
	expect(textOf(f.side.snapshot.messages)).toContain("redacted");
	expect(textOf(f.side.snapshot.messages)).not.toContain("PARENT_REDACTION_SECRET");
});

test("failed extension recreation releases already-created side event subscriptions", async () => {
	const emitters: Array<() => void> = [];
	let loads = 0;
	const f = await fixture({
		tools: ["first", "second"],
		extensions: () => [
			{
				name: "first",
				factory: (pi) => {
					pi.events.on("probe", () => {});
					emitters.push(() => pi.events.emit("probe", undefined));
					pi.registerTool({
						name: "first",
						label: "first",
						description: "First",
						parameters: Type.Object({}),
						async execute() {
							return { content: [], details: {} };
						},
					});
				},
			},
			{
				name: "second",
				factory: (pi) => {
					if (++loads > 1) throw new Error("fixture recreation failure");
					pi.registerTool({
						name: "second",
						label: "second",
						description: "Second",
						parameters: Type.Object({}),
						async execute() {
							return { content: [], details: {} };
						},
					});
				},
			},
		],
	});
	await f.parent.prompt("parent");
	await expect(f.side.open()).rejects.toThrow(/fixture recreation failure/);
	expect(() => emitters[1]()).toThrow(/stale/);
	expect(() => emitters[0]()).not.toThrow();
});

test("no implicit write grant is added to a parent that only allows read and codemode", async () => {
	const f = await fixture({ codemode: true, tools: ["read", "codemode"] });
	await f.parent.prompt("parent");
	f.faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("write", { path: join(f.cwd, "denied"), content: "bad" }),
				fauxToolCall("codemode", {
					code: `return await tools.write({path:${JSON.stringify(join(f.cwd, "denied"))},content:'bad'});`,
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("denied"),
	]);
	await f.side.prompt("cannot expand permissions");
	expect(existsSync(join(f.cwd, "denied"))).toBe(false);
	expect(
		f.side.snapshot.messages.filter((message) => message.role === "toolResult").every((message) => message.isError),
	).toBe(true);
});

test("closing side background Bash stops only side tasks and retains workspace effects", async () => {
	const f = await fixture();
	await f.parent.prompt("parent");
	await f.parent.agent.state.tools
		.find((tool) => tool.name === "bash")!
		.execute("parent-bg", { command: "sleep 60", run_in_background: true });
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 60", run_in_background: true }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("started"),
	]);
	await f.side.prompt("background task");
	expect(f.sides[0].backgroundTasks?.list({ activeOnly: true })).toHaveLength(1);
	await f.side.close();
	expect(f.sides[0].backgroundTasks?.list({ activeOnly: true })).toHaveLength(0);
	expect(f.parent.backgroundTasks?.list({ activeOnly: true })).toHaveLength(1);
});

test("side tool extension shutdown failures are visible, not swallowed as successful cleanup", async () => {
	let instance = 0;
	const f = await fixture({
		tools: ["probe"],
		extensions: () => [
			{
				name: "probe",
				factory: (pi) => {
					const side = ++instance === 2;
					pi.registerTool({
						name: "probe",
						label: "probe",
						description: "Probe",
						parameters: Type.Object({}),
						async execute() {
							return { content: [], details: {} };
						},
					});
					pi.on("session_shutdown", () => {
						if (side) throw new Error("fixture shutdown failure");
					});
				},
			},
		],
	});
	await f.parent.prompt("parent");
	await f.side.open();
	await expect(f.side.close()).rejects.toThrow(/cleanup is incomplete.*probe/);
	expect(f.side.snapshot.state).toBe("cleanup-failed");
	// No external resource exists in this fixture; the recorded failure intentionally remains sticky.
	const cleanup = cleanups.pop()!;
	cleanups.push(async () => {
		await expect(cleanup()).rejects.toThrow(/cleanup is incomplete/);
		const report = await f.parent.shutdown();
		expect(report.failedResources).toContain("side-conversation");
	});
});

test.each(["deferred", "codemode"] as const)(
	"side inherits %s MCP tools with approved config and independent connections",
	async (exposure) => {
		const pairs: ReturnType<typeof createInMemoryTransportPair>[] = [];
		const closes: ReturnType<typeof vi.fn>[] = [];
		const calls: number[] = [];
		const loadConfig = vi.fn(() => ({
			servers: [{ name: "docs", source: "approved-fixture", config: { command: "never-executed", exposure } }],
			errors: [],
		}));
		const f = await fixture({
			codemode: true,
			tools: ["codemode", "tool_search", "mcp__docs__update"],
			extensions: (cwd) => [
				{ name: "tool-search", factory: createToolSearchExtension() },
				{
					name: "mcp",
					factory: createMcpExtension({
						agentDir: cwd,
						loadConfig,
						credentials: new McpOAuthCredentialStore(cwd, new InMemoryAuthStorageBackend()),
						logPath: join(cwd, "mcp.log"),
						createTransport: () => {
							const pair = createInMemoryTransportPair();
							const index = pairs.push(pair) - 1;
							closes.push(vi.spyOn(pair.client, "close"));
							cleanups.unshift(async () => {
								await pair.server.close();
							});
							pair.server.onMessage((message) => {
								if (!("id" in message) || !("method" in message)) return;
								if (message.method === "tools/call") calls.push(index);
								const result =
									message.method === "initialize"
										? {
												protocolVersion: LATEST_PROTOCOL_VERSION,
												capabilities: { tools: {} },
												serverInfo: { name: "docs", version: "1" },
											}
										: message.method === "tools/list"
											? {
													tools: [
														{
															name: "update",
															description: "Update docs",
															inputSchema: {
																type: "object",
																properties: { value: { type: "string" } },
																required: ["value"],
															},
														},
													],
												}
											: { content: [{ type: "text", text: `connection-${index}` }] };
								void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
							});
							void pair.server.start();
							return pair.client;
						},
					}),
				},
			],
		});
		await vi.waitFor(() => expect(f.parent.getToolDefinition("mcp__docs__update")).toBeDefined());
		await f.parent.prompt("parent MCP context");
		const before = structuredClone(f.parent.messages);
		f.faux.setResponses(
			exposure === "deferred"
				? [
						fauxAssistantMessage(fauxToolCall("tool_search", { query: "update docs" }), {
							stopReason: "toolUse",
						}),
						fauxAssistantMessage(fauxToolCall("mcp__docs__update", { value: "side" }), { stopReason: "toolUse" }),
						fauxAssistantMessage("done"),
					]
				: [
						fauxAssistantMessage(
							fauxToolCall("codemode", {
								code: 'const matches = await searchTools("update", {namespace:"mcp__docs"}); const ns = await describeNamespace("mcp__docs"); if (ns.tools.length !== 1) throw new Error("missing namespace"); return await tools[matches[0].name]({value:"side"});',
							}),
							{ stopReason: "toolUse" },
						),
						fauxAssistantMessage("done"),
					],
		);
		await f.side.prompt("update docs through the authorized route");
		expect(calls).toEqual([1]);
		expect(pairs).toHaveLength(2);
		expect(loadConfig).toHaveBeenCalledOnce();
		expect(f.parent.messages).toEqual(before);
		expect(f.requests[1].context.tools).toEqual(f.requests[0].context.tools);
		if (exposure === "deferred")
			expect(f.requests[2].context.tools?.some((tool) => tool.name === "mcp__docs__update")).toBe(true);
		expect(getSessionMcpConfig(f.sides[0].sessionManager)?.servers.map((server) => server.name)).toEqual(["docs"]);
		await f.side.close();
		expect(closes[1]).toHaveBeenCalled();
		expect(closes[0]).not.toHaveBeenCalled();
		f.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", { code: 'return await tools.mcp__docs__update({value:"parent"});' }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await f.parent.prompt("parent MCP remains usable");
		expect(calls).toEqual([1, 0]);
	},
);

test("withdrawing one parent MCP server revokes side resources even when generic tool identity stays unchanged", async () => {
	let registrar!: ExtensionAPI;
	let reads = 0;
	const f = await fixture({
		tools: ["read_mcp_resource"],
		extensions: (cwd) => [
			{
				name: "servers",
				factory: (pi) => {
					registrar = pi;
					for (const name of ["a", "b"])
						pi.registerMcpServer(name, { command: "never-executed", exposure: "direct" });
				},
			},
			{
				name: "mcp",
				factory: createMcpExtension({
					agentDir: cwd,
					loadConfig: () => ({ servers: [], errors: [] }),
					credentials: new McpOAuthCredentialStore(cwd, new InMemoryAuthStorageBackend()),
					logPath: join(cwd, "mcp.log"),
					createTransport: (entry) => {
						const pair = createInMemoryTransportPair();
						cleanups.unshift(async () => {
							await pair.server.close();
						});
						pair.server.onMessage((message) => {
							if (!("id" in message) || !("method" in message)) return;
							if (message.method === "resources/read") reads++;
							const result =
								message.method === "initialize"
									? {
											protocolVersion: LATEST_PROTOCOL_VERSION,
											capabilities: { tools: {}, resources: {} },
											serverInfo: { name: entry.name, version: "1" },
										}
									: message.method === "tools/list"
										? { tools: [] }
										: message.method === "resources/list"
											? { resources: [{ name: "doc", uri: "docs://doc" }] }
											: message.method === "resources/templates/list"
												? { resourceTemplates: [] }
												: { contents: [{ uri: "docs://doc", text: "resource content" }] };
							void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
						});
						void pair.server.start();
						return pair.client;
					},
				}),
			},
		],
	});
	await f.parent.prompt("parent resources");
	const definition = f.parent.getToolDefinition("read_mcp_resource");
	expect(definition).toBeDefined();
	const response = () => [
		fauxAssistantMessage(fauxToolCall("read_mcp_resource", { server: "a", uri: "docs://doc" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	];
	f.faux.setResponses(response());
	await f.side.prompt("read from authorized server a");
	expect(reads).toBe(1);
	registrar.unregisterMcpServer("a");
	await vi.waitFor(() =>
		expect(getSessionMcpConfig(f.parent.sessionManager)?.servers.map((server) => server.name)).toEqual(["b"]),
	);
	expect(f.parent.getToolDefinition("read_mcp_resource")).toBe(definition);
	f.faux.setResponses(response());
	await f.side.prompt("server a has been revoked");
	expect(reads).toBe(1);
	expect(f.side.snapshot.messages.filter((message) => message.role === "toolResult").at(-1)).toMatchObject({
		isError: true,
	});
});

test("side owns an independent in-memory team and closing it leaves the parent's team usable", async () => {
	const f = await fixture({
		tools: ["read", "spawn_agent", "wait_agent", "list_agents"],
		extensions: (cwd) => [
			{
				name: "collaboration-root",
				factory: (pi) =>
					registerPiCollaborationRoot(pi, join(cwd, "agent"), () => ({
						mode: "full-access",
						sessionGrants: [],
						protectedRoots: [],
					})),
			},
		],
	});
	await f.parent.prompt("parent team context");
	let sideRequests = 0;
	f.faux.setResponses(
		Array.from({ length: 12 }, () => (context) => {
			if (textOf(context.messages).includes("Current runtime delegation."))
				return fauxAssistantMessage("child result");
			if (sideRequests++ === 0)
				return fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						task_name: "side-worker",
						task: { objective: "answer this side task" },
						relationship: "explore",
						tools: ["read"],
					}),
					{ stopReason: "toolUse" },
				);
			if (sideRequests === 2)
				return fauxAssistantMessage(fauxToolCall("wait_agent", { target: "side-worker", timeout_ms: 1000 }), {
					stopReason: "toolUse",
				});
			return fauxAssistantMessage("side done");
		}),
	);
	await f.side.prompt("use a subagent for this side task");
	const results = f.side.snapshot.messages.filter((message) => message.role === "toolResult");
	expect(
		results.some(
			(message) => message.role === "toolResult" && message.toolName === "spawn_agent" && !message.isError,
		),
	).toBe(true);
	expect(textOf(results)).toContain("side-worker");
	const rootList = f.parent.agent.state.tools.find((tool) => tool.name === "list_agents")!;
	expect((await rootList.execute("parent-list", {})).details).toMatchObject({ agents: [] });
	await f.side.close();
	expect((await rootList.execute("parent-list-after", {})).details).toMatchObject({ agents: [] });
	expect(existsSync(join(f.cwd, "agent", "teams"))).toBe(false);
});

test("plain side input never executes shell escapes or slash commands", async () => {
	const f = await fixture();
	await f.parent.prompt("parent");
	await f.side.prompt("!touch shell-escape");
	await f.side.prompt("/quit");
	expect(existsSync(join(f.cwd, "shell-escape"))).toBe(false);
	expect(textOf(f.side.snapshot.messages)).toContain("/quit");
	expect(f.side.snapshot.state).toBe("idle");
});

test("parent and side run concurrently; cancelling side does not cancel parent", async () => {
	const f = await fixture();
	const parentGate = deferred();
	const parentStarted = deferred();
	const sideGate = deferred();
	const sideStarted = deferred();
	f.faux.setResponses([
		async () => {
			parentStarted.resolve();
			await parentGate.promise;
			return fauxAssistantMessage("parent done");
		},
		async () => {
			sideStarted.resolve();
			await sideGate.promise;
			return fauxAssistantMessage("side done");
		},
	]);
	const parentRun = f.parent.prompt("running parent");
	await parentStarted.promise;
	const sideRun = f.side.prompt("parallel question");
	await sideStarted.promise;
	expect(f.side.snapshot.parentRunning).toBe(true);
	const stopping = f.side.abort();
	sideGate.resolve();
	await stopping;
	await sideRun;
	expect(f.parent.isStreaming).toBe(true);
	parentGate.resolve();
	await parentRun;
	expect(textOf(f.parent.messages)).toContain("parent done");
});

test("closing during creation prevents inference, drains runtime and can reopen", async () => {
	const gate = deferred();
	const creating = deferred();
	const f = await fixture({
		createSession: async (options) => {
			creating.resolve();
			await gate.promise;
			return createAgentSession(options);
		},
	});
	await f.parent.prompt("parent");
	const opening = f.side.open();
	const rejected = expect(opening).rejects.toThrow(/cancelled/);
	await creating.promise;
	const closing = f.side.close();
	gate.resolve();
	await rejected;
	await closing;
	expect(f.side.snapshot.state).toBe("closed");
	expect(f.faux.state.callCount).toBe(1);
	await expect(f.sides[0].prompt("after close")).rejects.toThrow(/disposed/);
	await f.side.open();
	expect(f.sides).toHaveLength(2);
});

test("close is idempotent and shutdown permanently seals admission", async () => {
	const f = await fixture();
	await f.parent.prompt("parent");
	await f.side.prompt("side");
	const session = f.sides[0];
	const shutdown = vi.spyOn(session, "shutdown");
	const first = f.side.close();
	const second = f.side.close();
	expect(second).toBe(first);
	await first;
	expect(shutdown).toHaveBeenCalledTimes(1);
	expect(f.side.snapshot.messages).toEqual([]);
	await f.side.shutdown();
	await expect(f.side.open()).rejects.toThrow(/shut down/);
	await expect(f.side.prompt("late")).rejects.toThrow(/shut down/);
});

test("incomplete shutdown is visible and blocks reopening instead of claiming cleanup", async () => {
	const f = await fixture();
	await f.parent.prompt("parent");
	await f.side.open();
	const original = f.sides[0].shutdown.bind(f.sides[0]);
	const mock = vi.spyOn(f.sides[0], "shutdown").mockResolvedValue({
		complete: false,
		failedResources: [],
		timedOutResources: [],
		remainingResources: ["test-resource"],
	});
	await expect(f.side.close()).rejects.toThrow(/incomplete.*test-resource/);
	expect(f.side.snapshot.state).toBe("cleanup-failed");
	await expect(f.side.open()).rejects.toThrow(/cleanup is incomplete/);
	mock.mockImplementation(original);
	await f.side.close();
	expect(f.side.snapshot.state).toBe("closed");
});

test("prefix invalidation rejects the provider call without silent rebuilding", async () => {
	const f = await fixture();
	await f.parent.prompt("parent");
	await f.side.open();
	f.parent.setActiveToolsByName(["read"]);
	await expect(f.side.prompt("question")).rejects.toThrow(/rules changed|tool declarations changed/);
	expect(f.faux.state.callCount).toBe(1);
	expect(f.side.snapshot.error).toMatch(/rules changed|tool declarations changed/);
});

test.each([false, true])("abort seals a reserved prompt before admission (already open: %s)", async (alreadyOpen) => {
	const f = await fixture();
	await f.parent.prompt("parent");
	if (alreadyOpen) await f.side.open();
	const run = f.side.prompt("must not start");
	const rejected = expect(run).rejects.toThrow(/cancelled/);
	await f.side.abort();
	await rejected;
	expect(f.faux.state.callCount).toBe(1);
	expect(textOf(f.side.snapshot.messages)).not.toContain("must not start");
});

test.each([
	{ nested: false, toolName: "read" },
	{ nested: true, toolName: "read" },
	{ nested: false, toolName: "write" },
	{ nested: true, toolName: "write" },
])(
	"authorization revoked during a parent hook prevents $toolName dispatch (nested: $nested)",
	async ({ nested, toolName }) => {
		const entered = deferred();
		const gate = deferred();
		const f = await fixture({
			codemode: nested,
			policy: (pi) => {
				pi.on("tool_call", async (event) => {
					if (event.toolName === toolName && event.toolCallId.startsWith("side/")) {
						entered.resolve();
						await gate.promise;
					}
				});
			},
		});
		await writeFile(join(f.cwd, "revoked.txt"), "REVOCATION_SECRET");
		await f.parent.prompt("parent");
		await f.side.open();
		f.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					nested ? "codemode" : toolName,
					nested
						? {
								code: `return await tools.${toolName}(${JSON.stringify({ path: join(f.cwd, "revoked.txt"), ...(toolName === "write" ? { content: "forbidden mutation" } : {}) })});`,
							}
						: {
								path: join(f.cwd, "revoked.txt"),
								...(toolName === "write" ? { content: "forbidden mutation" } : {}),
							},
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const run = f.side.prompt("inspect the allowed file");
		const rejected = expect(run).rejects.toThrow(/rules changed|tool declarations changed|no longer authorized/);
		await entered.promise;
		f.parent.setToolAccessByName([]);
		gate.resolve();
		await rejected;
		expect(textOf(f.side.snapshot.messages)).not.toContain("REVOCATION_SECRET");
		expect(await readFile(join(f.cwd, "revoked.txt"), "utf8")).toBe("REVOCATION_SECRET");
		expect(f.faux.state.callCount).toBe(2);
	},
);

test("unsupported cache-marker APIs fail closed rather than claiming wire-prefix preservation", async () => {
	const f = await fixture({ api: "anthropic-messages" });
	await f.parent.prompt("parent");
	await expect(f.side.open()).rejects.toThrow(/no verified wire replay/);
	expect(f.sides).toHaveLength(0);
	expect(f.faux.state.callCount).toBe(1);
});

test("an excluded historical image is never resent by side creation", async () => {
	const f = await fixture({ wire: true });
	const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
	await f.parent.prompt("image", { images: [{ type: "image", mimeType: "image/png", data: image }] });
	await f.parent.prompt("make the image historical");
	const id = f.parent.getImageDecisions().find((decision) => /^image_[a-f0-9]{24}$/.test(decision.imageId))?.imageId;
	expect(id).toBeDefined();
	f.parent.setImageSelection([id!]);
	await f.parent.prompt("parent request excludes the image");
	expect(JSON.stringify(f.bodies.at(-1))).not.toContain(image);
	const calls = f.bodies.length;
	await expect(f.side.open()).rejects.toThrow(/image-bearing parent prefix/);
	expect(f.bodies).toHaveLength(calls);
	expect(f.sides).toHaveLength(0);
});

test("real parent shutdown aggregates side cleanup failure even when extension hooks swallow it", async () => {
	let side: SideConversationController | undefined;
	const f = await fixture({
		policy: (pi) => {
			pi.on("session_shutdown", async () => {
				await side?.shutdown();
			});
		},
	});
	side = f.side;
	await f.parent.prompt("parent");
	await f.side.open();
	const original = f.sides[0].shutdown.bind(f.sides[0]);
	const mock = vi.spyOn(f.sides[0], "shutdown").mockResolvedValue({
		complete: false,
		failedResources: [],
		timedOutResources: [],
		remainingResources: ["owned-side-test"],
	});
	const report = await f.parent.shutdown();
	expect(report.complete).toBe(false);
	expect(report.failedResources).toContain("side-conversation");
	expect(f.side.snapshot.state).toBe("cleanup-failed");
	mock.mockImplementation(original);
	await f.side.shutdown();
});

test.each([true, false])(
	"Codex wire prefix retains grammar and native deferred declarations (additional_tools: %s)",
	async (additionalTools) => {
		const f = await fixture({ wire: true, codemode: true });
		f.parent.agent.state.model = {
			...f.parent.model!,
			compat: {
				supportsOpenAIGrammarTools: true,
				supportsAdditionalTools: additionalTools,
				supportsToolSearch: true,
			},
		};
		const manager = f.parent.sessionManager;
		manager.appendMessage({ role: "user", content: "historical discovery", timestamp: 1 });
		const call = fauxToolCall("bash", { command: "historical discovery only; never executed" });
		manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		manager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: "bash",
			content: [{ type: "text", text: "historical receipt" }],
			addedToolNames: ["read"],
			isError: false,
			timestamp: 3,
		});
		f.parent.agent.state.messages = manager.buildSessionContext().messages;
		await f.parent.prompt("warm native declarations");
		await f.side.prompt("reuse native prefix");
		const [parent, side] = f.bodies;
		const input = parent.input as Array<{ type?: string }>;
		expect(input.some((item) => item.type === (additionalTools ? "additional_tools" : "tool_search_output"))).toBe(
			true,
		);
		expect((parent.tools as Array<{ type?: string }>).some((tool) => tool.type === "custom")).toBe(true);
		expect(side.tools).toEqual(parent.tools);
		expect((side.input as unknown[]).slice(0, input.length)).toEqual(input);
	},
);
