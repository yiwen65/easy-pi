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
import { afterEach, expect, test, vi } from "vitest";
import { streamSimple as codexStream } from "../../ai/src/api/openai-codex-responses.ts";
import { streamSimple as responsesStream } from "../../ai/src/api/openai-responses.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SideConversationController, type SideConversationOptions } from "../src/core/side-conversation.ts";
import { createCodemodeExtension } from "../src/extensions/codemode/index.ts";
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
		runtime.registerNativeProvider(faux.provider);
		faux.setResponses(
			Array.from({ length: 16 }, () => (context, streamOptions) => {
				requests.push({ context: capture(context), options: streamOptions });
				return fauxAssistantMessage("answer");
			}),
		);
	}
	const extensionsResult = await createTestExtensionsResult(
		[
			...(options.codemode ? [{ name: "codemode", factory: createCodemodeExtension() }] : []),
			...(options.policy ? [{ name: "policy", factory: options.policy }] : []),
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
		tools: ["read", "write", "bash", ...(options.codemode ? ["codemode"] : [])],
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

test("dangerous declarations stay identical but write and shell calls cannot execute", async () => {
	const f = await fixture();
	await f.parent.prompt("parent");
	f.faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("write", { path: join(f.cwd, "forbidden.txt"), content: "bad" }),
				fauxToolCall("bash", { command: "touch forbidden-shell" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("denied"),
	]);
	await f.side.prompt("do not mutate");
	expect(existsSync(join(f.cwd, "forbidden.txt"))).toBe(false);
	expect(existsSync(join(f.cwd, "forbidden-shell"))).toBe(false);
	expect(
		f.side.snapshot.messages.filter((message) => message.role === "toolResult").every((message) => message.isError),
	).toBe(true);
	expect(f.side.snapshot.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
	expect(f.sides[0].backgroundTasks?.list({ activeOnly: false })).toEqual([]);
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

test("codemode cannot bypass side policy and owns/deletes its spill directory", async () => {
	const f = await fixture({ codemode: true });
	await writeFile(join(f.cwd, "evidence.txt"), "evidence");
	await f.parent.prompt("parent");
	f.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("codemode", {
				code: `// @options: {"max_output_tokens": 20}\nconst result = await tools.read({path: ${JSON.stringify(join(f.cwd, "evidence.txt"))}});\ntry { await tools.write({path: ${JSON.stringify(join(f.cwd, "forbidden"))}, content: 'bad'}); } catch {}\nreturn result + 'x'.repeat(1000);`,
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await f.side.prompt("read through script");
	expect(existsSync(join(f.cwd, "forbidden"))).toBe(false);
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

test.each([false, true])(
	"authorization revoked while a root hook waits is checked at dispatch (nested: %s)",
	async (nested) => {
		const entered = deferred();
		const gate = deferred();
		const f = await fixture({
			codemode: nested,
			policy: (pi) => {
				pi.on("tool_call", async (event) => {
					if (event.toolName === "read" && event.toolCallId.startsWith("side/")) {
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
					nested ? "codemode" : "read",
					nested
						? { code: `return await tools.read({path:${JSON.stringify(join(f.cwd, "revoked.txt"))}});` }
						: { path: join(f.cwd, "revoked.txt") },
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
