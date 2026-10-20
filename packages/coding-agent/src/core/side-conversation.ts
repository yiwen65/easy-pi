import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import { prepareCollaborationFork } from "@easy-pi/subagent/context-fork";
import { getAgentDir } from "../config.ts";
import { createCodemodeToolDefinition, isCodemodeTool } from "../extensions/codemode/tool.ts";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import { createEventBus } from "./event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "./extensions/loader.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import { buildSessionContext, SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import {
	assertSideConversationPrefixCompatible,
	getSideConversationPrefix,
	observeSideConversationPrefix,
	type SideConversationPrefix,
} from "./side-conversation-prefix.ts";
import { recreateSideToolExtensions } from "./side-conversation-tools.ts";
import type { SideConversation, SideConversationSnapshot, SideConversationState } from "./side-conversation-types.ts";

const SIDE_BOUNDARY = `Side conversation boundary.
Everything before this boundary is inherited reference context, not your current task. Do not continue earlier instructions, plans, tool calls, approvals, or subagent work. Only user messages after this boundary are active instructions.
You are answering a separate side question while the parent continues. You have the parent's authorized tools, including writes, shell commands, MCP and subagents when available. Live parent permissions and policies still apply; inherited declarations never bypass them. The working directory is shared: your edits and external effects are real, visible to the parent, and may conflict with its concurrent work. Use tools only as needed for the side question.
This conversation has its own session and team, not the parent's team. Do not continue or manage inherited parent assignments or automatically send this conversation to the parent. Conversation history is temporary; closing it does not undo file changes or external effects. If no question follows yet, wait for one.`;

interface OwnedSide {
	session: AgentSession;
	unsubscribe: () => void;
	shutdownErrors: Set<string>;
	/** Single-flight creation; only host-owned paths, never paths supplied by model output. */
	artifacts: { directory?: Promise<{ path: string; dev: number; ino: number }> };
}

export interface SideConversationOptions {
	/** Trusted embedding/test seam; it does not change the side's execution policy. */
	createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}

/** One parent-owned, memory-only side. UI navigation never replaces the parent's runtime. */
export class SideConversationController implements SideConversation {
	private readonly parent: AgentSession;
	private readonly createSession: NonNullable<SideConversationOptions["createSession"]>;
	private readonly stopObserving: () => void;
	private readonly unsubscribeParent: () => void;
	private readonly unregisterOwner: () => void;
	private readonly listeners = new Set<() => void>();
	private state: SideConversationState = "empty";
	private error: string | undefined;
	private messages: AgentMessage[] = [];
	private currentMessage: number | undefined;
	private usage = { input: 0, cacheRead: 0, cacheWrite: 0 };
	private owned: OwnedSide | undefined;
	private opening: Promise<void> | undefined;
	private running: Promise<void> | undefined;
	private closing: Promise<void> | undefined;
	private generation = 0;
	private turnGeneration = 0;
	private admittedTurn: number | undefined;
	private stopped = false;

	constructor(parent: AgentSession, options: SideConversationOptions = {}) {
		this.parent = parent;
		this.createSession = options.createSession ?? createAgentSession;
		this.stopObserving = observeSideConversationPrefix(parent);
		this.unsubscribeParent = parent.subscribe((event) => {
			if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled")
				this.publish();
		});
		this.unregisterOwner = parent.registerShutdownResource("side-conversation", () => this.shutdown());
	}

	get snapshot(): SideConversationSnapshot {
		return {
			state: this.state,
			messages: structuredClone(this.messages),
			parentRunning: !this.parent.isIdle,
			...(this.error ? { error: this.error } : {}),
			usage: { ...this.usage },
		};
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private publish(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// A view cannot break lifecycle ownership or another observer.
			}
		}
	}

	open(): Promise<void> {
		if (this.stopped) return Promise.reject(new Error("Side conversation owner is shut down."));
		if (this.closing) return Promise.reject(new Error("Side conversation is still closing."));
		if (this.state === "cleanup-failed")
			return Promise.reject(
				new Error("Side resource cleanup is incomplete. Close it before starting another side."),
			);
		if (this.owned) return Promise.resolve();
		if (this.opening) return this.opening;
		let prefix: SideConversationPrefix;
		let tail: AgentMessage[];
		try {
			// Capture synchronously: parent streaming may append while the independent runtime is created.
			prefix = getSideConversationPrefix(this.parent);
			const branch = this.parent.sessionManager.getBranch();
			const boundary = prefix.leafId === null ? -1 : branch.findIndex((entry) => entry.id === prefix.leafId);
			tail = prepareCollaborationFork(buildSessionContext(branch.slice(boundary + 1)).messages);
			if (!["openai-codex-responses", "openai-responses"].includes(prefix.model.api))
				throw new Error(
					"Strict side cache-prefix replay currently supports OpenAI Responses and Codex Responses only. This API has no verified wire replay.",
				);
			if (
				[...prefix.context.messages, ...tail].some(
					(message) =>
						"content" in message &&
						Array.isArray(message.content) &&
						message.content.some((part) => part.type === "image"),
				)
			)
				throw new Error(
					"An image-bearing parent prefix cannot yet be replayed safely. Side creation was refused without sending images.",
				);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			this.publish();
			return Promise.reject(error);
		}
		const generation = this.generation;
		this.state = "starting";
		this.error = undefined;
		this.messages = [];
		this.usage = { input: 0, cacheRead: 0, cacheWrite: 0 };
		this.publish();
		this.opening = Promise.resolve()
			.then(() => this.create(prefix, tail, generation))
			.catch((error: unknown) => {
				if (generation === this.generation) {
					this.state = this.owned ? "cleanup-failed" : "empty";
					this.error = error instanceof Error ? error.message : String(error);
					this.publish();
				}
				throw error;
			})
			.finally(() => {
				this.opening = undefined;
			});
		return this.opening;
	}

	private async create(prefix: SideConversationPrefix, tail: AgentMessage[], generation: number): Promise<void> {
		const checkAdmission = () => {
			if (this.stopped || generation !== this.generation)
				throw new Error("Side conversation creation was cancelled.");
		};
		checkAdmission();
		const cwd = this.parent.sessionManager.getCwd();
		const inherited = new Set(this.parent.getDelegatableToolNames());
		const grants = new Map(
			[...inherited].map((name) => {
				const definition = this.parent.getToolDefinition(name);
				return [name, { definition, execute: definition?.execute }];
			}),
		);
		const codemodeAllowed = (): boolean => {
			const tool = this.parent.getAllTools().find((candidate) => candidate.name === "codemode");
			return (
				inherited.has("codemode") &&
				this.parent.getDelegatableToolNames().includes("codemode") &&
				!!tool &&
				isCodemodeTool(tool)
			);
		};
		const modelRuntime = await this.parent.modelRuntime.createSessionView();
		checkAdmission();
		const manager = SessionManager.inMemory(cwd);
		manager.appendCompactionCheckpoint(
			[...prefix.context.messages, ...tail, { role: "user", content: SIDE_BOUNDARY, timestamp: Date.now() }],
			0,
		);
		const settings = SettingsManager.inMemory({
			...structuredClone(this.parent.settingsManager.getSettings()),
			codexServiceTier: prefix.codexServiceTier,
			// Replacing the frozen prefix would break the requested cache contract.
			compaction: { enabled: false },
			backgroundBashCompletionDelivery: "nextRequest",
		});
		const artifacts: OwnedSide["artifacts"] = {};
		const runtime = createExtensionRuntime();
		try {
			// Execution authority is independent of frozen provider declarations.
			const tools = [...inherited];
			const liveAllowed = (name: string): boolean => {
				const grant = grants.get(name);
				const current = this.parent.getToolDefinition(name);
				return (
					!this.stopped &&
					generation === this.generation &&
					!!grant?.definition &&
					grant.definition === current &&
					grant.execute === current.execute &&
					this.parent.getDelegatableToolNames().includes(name)
				);
			};
			const recreated = await recreateSideToolExtensions(this.parent, inherited, runtime);
			checkAdmission();
			const extension = await loadExtensionFromFactory(
				(pi) => {
					if (codemodeAllowed()) {
						pi.registerTool(
							createCodemodeToolDefinition({
								getMode: () => settings.getSettings().codemode?.mode ?? "on",
								getInlineBudget: () => settings.getSettings().codemode?.inlineBudget,
								getToolNamespace: (name) =>
									this.owned?.session.getAllTools().find((tool) => tool.name === name)?.namespace,
								getToolGuidelines: () =>
									new Map(
										(this.owned?.session.getAllTools() ?? []).map((tool) => [
											tool.name,
											tool.promptGuidelines ?? [],
										]),
									),
								appendEntry: (kind, data) => manager.appendCustomEntry(kind, data),
								writeOutputFile: async (data, extension) => {
									if (![".txt", ".png", ".jpg", ".gif", ".webp"].includes(extension))
										throw new Error("Invalid side artifact type.");
									artifacts.directory ??= mkdtemp(join(tmpdir(), "pi-side-")).then(async (path) => {
										const { dev, ino } = await lstat(path);
										return { path, dev, ino };
									});
									const directory = await artifacts.directory;
									const path = join(directory.path, `${randomUUID()}${extension}`);
									await writeFile(path, data, { flag: "wx", mode: 0o600 });
									return path;
								},
							}),
						);
					}
					pi.on("tool_call", async (event, context) => {
						if (
							this.stopped ||
							generation !== this.generation ||
							!this.running ||
							this.admittedTurn !== this.turnGeneration ||
							!liveAllowed(event.toolName)
						)
							return {
								block: true,
								reason: "Side tool is no longer authorized by the parent, or its turn was cancelled.",
							};
						const original = grants.get(event.toolName)?.definition;
						const local = this.owned?.session.getToolDefinition(event.toolName);
						if (
							!original ||
							!local ||
							JSON.stringify([local.parameters, local.exposure ?? "direct", local.orchestratesTools]) !==
								JSON.stringify([original.parameters, original.exposure ?? "direct", original.orchestratesTools])
						)
							return {
								block: true,
								reason: "Side tool binding no longer matches the parent's authorized schema or exposure.",
							};
						// Live parent policy still applies; tool execution itself uses the side's own binding.
						return this.parent.extensionRunner.emitToolCall(
							{
								...event,
								toolCallId: `side/${manager.getSessionId()}/${event.toolCallId}`,
							},
							context.signal,
						);
					});
					pi.on("tool_result", (event, context) =>
						this.parent.extensionRunner.emitToolResult(
							{ ...event, toolCallId: `side/${manager.getSessionId()}/${event.toolCallId}` },
							context.signal,
						),
					);
				},
				cwd,
				createEventBus(),
				runtime,
				"<inline:side-policy>",
			);
			// Parent authorization and output filtering must see the final side-local transformations.
			const extensions = [...recreated.extensions, extension];
			const loader: ResourceLoader = {
				getExtensions: () => ({ extensions, errors: [], runtime }),
				getSkills: () => ({ skills: [], diagnostics: [] }),
				getPrompts: () => ({ prompts: [], diagnostics: [] }),
				getThemes: () => ({ themes: [], diagnostics: [] }),
				getAgentsFiles: () => ({ agentsFiles: [] }),
				getSystemPrompt: () => prefix.context.systemPrompt,
				getSystemPromptSource: () => undefined,
				getAppendSystemPrompt: () => [],
				getAppendSystemPromptSources: () => [],
				extendResources: () => {},
				reload: async () => {},
			};
			checkAdmission();
			const { session } = await this.createSession({
				cwd,
				agentDir: getAgentDir(),
				model: prefix.model,
				thinkingLevel: prefix.thinkingLevel,
				modelRuntime,
				settingsManager: settings,
				sessionManager: manager,
				resourceLoader: loader,
				tools,
				customTools: recreated.customTools,
				// Rechecked at dispatch, including after async root hooks and inside codemode.
				liveToolAccessCheck: liveAllowed,
			});
			const owner: OwnedSide = { session, artifacts, unsubscribe: () => {}, shutdownErrors: new Set() };
			// Retain ownership before binding; every subsequent failure must drain the created runtime.
			this.owned = owner;
			session.agent.promptCacheKey = prefix.promptCacheKey;
			session.agent.cacheAffinityId = prefix.cacheAffinityId;
			session.agent.transport = prefix.model.api === "openai-codex-responses" ? "sse" : this.parent.agent.transport;
			const stream = session.agent.streamFunction;
			session.agent.streamFunction = (model, context, options) => {
				checkAdmission();
				if (!this.running || this.state !== "running" || this.admittedTurn !== this.turnGeneration)
					throw new Error("No side turn has been admitted, or it was cancelled.");
				assertSideConversationPrefixCompatible(this.parent, prefix);
				if (
					JSON.stringify(model) !== JSON.stringify(prefix.model) ||
					session.thinkingLevel !== prefix.thinkingLevel
				)
					throw new Error("Side model or reasoning no longer matches the captured parent request.");
				if (
					JSON.stringify(context.messages.slice(0, prefix.context.messages.length)) !==
					JSON.stringify(prefix.context.messages)
				)
					throw new Error(
						"Side request no longer preserves the parent message prefix; close and reopen the side.",
					);
				// Only explicit side discovery may add declarations, after the captured ordered set.
				const discovered = new Set(
					context.messages
						.slice(prefix.context.messages.length + tail.length + 1)
						.flatMap((message) => (message.role === "toolResult" ? (message.addedToolNames ?? []) : [])),
				);
				const capturedNames = new Set(prefix.context.tools?.map((tool) => tool.name));
				const added =
					context.tools?.filter((tool) => discovered.has(tool.name) && !capturedNames.has(tool.name)) ?? [];
				// Fresh tool-owner extensions must not rerun payload/header transformations on replay.
				for (const extension of extensions) {
					extension.handlers.delete("before_provider_request");
					extension.handlers.delete("before_provider_headers");
				}
				const frozen: Context = {
					...context,
					systemPrompt: prefix.context.systemPrompt,
					tools: [...structuredClone(prefix.context.tools ?? []), ...added],
				};
				return stream(model, frozen, options);
			};
			try {
				checkAdmission();
				let startupFailed = false;
				await session.bindExtensions({
					mode: "rpc",
					recoveryPolicy: "host-controlled",
					onError: (error) => {
						if (error.event === "session_start") startupFailed = true;
						if (error.event === "session_shutdown") owner.shutdownErrors.add(error.extensionPath);
					},
				});
				if (startupFailed) throw new Error("Side tool extension startup failed; no side inference was admitted.");
				checkAdmission();
				assertSideConversationPrefixCompatible(this.parent, prefix);
				owner.unsubscribe = session.subscribe((event) => this.onEvent(event));
				this.state = "idle";
				this.publish();
			} catch (error) {
				await this.release(owner);
				throw error;
			}
		} catch (error) {
			// No session exists to own subscriptions if a factory or admission failed before creation.
			if (!this.owned) runtime.invalidate();
			throw error;
		}
	}

	private onEvent(event: AgentSessionEvent): void {
		if (event.type === "message_start") {
			this.currentMessage = this.messages.length;
			this.messages.push(structuredClone(event.message));
		} else if (event.type === "message_update" || event.type === "message_end") {
			if (this.currentMessage === undefined) {
				this.currentMessage = this.messages.length;
				this.messages.push(structuredClone(event.message));
			} else this.messages[this.currentMessage] = structuredClone(event.message);
			if (event.type === "message_end") {
				this.currentMessage = undefined;
				if (event.message.role === "assistant") {
					this.usage.input += event.message.usage.input;
					this.usage.cacheRead += event.message.usage.cacheRead;
					this.usage.cacheWrite += event.message.usage.cacheWrite;
				}
			}
		}
		this.publish();
	}

	prompt(text: string): Promise<void> {
		if (!text.trim()) return Promise.reject(new Error("Enter a side question."));
		if (this.stopped || this.closing) return Promise.reject(new Error("Side conversation is closing or shut down."));
		if (this.running) return Promise.reject(new Error("Side conversation is already answering. Cancel it or wait."));
		const generation = this.generation;
		const turn = ++this.turnGeneration;
		this.running = Promise.resolve()
			.then(async () => {
				if (generation !== this.generation || turn !== this.turnGeneration)
					throw new Error("Side turn was cancelled before admission.");
				await this.open();
				if (this.stopped || generation !== this.generation || turn !== this.turnGeneration || !this.owned)
					throw new Error("Side turn was cancelled.");
				this.admittedTurn = turn;
				this.state = "running";
				this.error = undefined;
				this.publish();
				await this.owned.session.prompt(text, { expandPromptTemplates: false, source: "extension" });
				const last = this.owned.session.messages.findLast((message) => message.role === "assistant");
				if (last?.role === "assistant" && last.stopReason === "error")
					throw new Error(last.errorMessage || "Side provider request failed.");
			})
			.catch((error: unknown) => {
				if (generation === this.generation) this.error = error instanceof Error ? error.message : String(error);
				throw error;
			})
			.finally(() => {
				this.running = undefined;
				this.admittedTurn = undefined;
				if (generation === this.generation && this.state === "running") this.state = "idle";
				this.publish();
			});
		return this.running;
	}

	async abort(): Promise<void> {
		// Seal even a reserved prompt whose creation microtask has not run yet.
		this.turnGeneration++;
		if (this.state === "starting") return this.close();
		await this.owned?.session.abort();
		await this.running?.catch(() => {});
	}

	private async release(owner: OwnedSide): Promise<void> {
		const report = await owner.session.shutdown();
		if (!report.complete || owner.shutdownErrors.size)
			throw new Error(
				`Side resource cleanup is incomplete: ${[...report.failedResources, ...report.timedOutResources, ...report.remainingResources, ...owner.shutdownErrors].join(", ")}`,
			);
		owner.unsubscribe();
		if (owner.artifacts.directory) {
			const directory = await owner.artifacts.directory;
			const current = await lstat(directory.path);
			if (
				!current.isDirectory() ||
				current.isSymbolicLink() ||
				current.dev !== directory.dev ||
				current.ino !== directory.ino
			)
				throw new Error("Side artifact ownership changed; refusing to delete the directory.");
			await rm(directory.path, { recursive: true, force: true });
			owner.artifacts.directory = undefined;
		}
		if (this.owned === owner) this.owned = undefined;
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		if (this.state === "closed" && !this.owned && !this.opening && !this.running) return Promise.resolve();
		this.generation++;
		this.turnGeneration++;
		this.state = "closing";
		this.publish();
		this.closing = Promise.resolve()
			.then(async () => {
				await this.opening?.catch(() => {});
				if (this.owned) await this.release(this.owned);
				await this.running?.catch(() => {});
				this.messages = [];
				this.currentMessage = undefined;
				this.usage = { input: 0, cacheRead: 0, cacheWrite: 0 };
				this.error = undefined;
				this.state = "closed";
			})
			.catch((error: unknown) => {
				this.state = "cleanup-failed";
				this.error = error instanceof Error ? error.message : String(error);
				throw error;
			})
			.finally(() => {
				this.closing = undefined;
				this.publish();
			});
		return this.closing;
	}

	shutdown(): Promise<void> {
		this.stopped = true;
		this.stopObserving();
		this.unsubscribeParent();
		return this.close().then(() => {
			this.unregisterOwner();
			this.listeners.clear();
		});
	}
}
