import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
	CollaborationError,
	validateAgentPath,
	validateCollaborationMessage,
} from "@easy-pi/subagent/collaboration-contract";
import type {
	ChildSession,
	ChildSessionHost,
	ChildSessionIdentity,
	ChildTurnResult,
} from "@easy-pi/subagent/session-host";
import type { ExtensionAPI, InlineExtension } from "../core/extensions/types.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { createAgentSession } from "../core/sdk.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../core/session-manager.ts";
import { type Settings, SettingsManager } from "../core/settings-manager.ts";
import { createEasyPiHarness } from "./easy-pi.ts";

const IDENTITY_ENTRY = "epi-collaboration-identity";

/**
 * Native SDK adapter. The caller owns the team store, model runtime and tool registry.
 * No process-global cwd/env changes, model login, worker processes, or implicit turn resumption.
 */
export function createPiChildSessionHost(options: {
	modelRuntime: ModelRuntime;
	settings: Settings;
	registerTools: (identity: Readonly<ChildSessionIdentity>, pi: ExtensionAPI) => void;
	additionalExtensions?: (identity: Readonly<ChildSessionIdentity>) => InlineExtension[];
	/** Trusted embedding control, also used by isolated tests. */
	noExtensions?: boolean;
}): ChildSessionHost {
	return {
		async create(request): Promise<ChildSession> {
			validateAgentPath(request.agentPath);
			if (request.agentPath === "/root" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.rootSessionId)) {
				throw new CollaborationError("invalid_arguments", "Invalid child session identity");
			}
			if (!isAbsolute(request.cwd) || !isAbsolute(request.agentDir)) {
				throw new CollaborationError("invalid_arguments", "Child directories must be absolute");
			}
			const cwd = await realpath(request.cwd);
			const identity = Object.freeze({ rootSessionId: request.rootSessionId, agentPath: request.agentPath });
			const modelRuntime = await options.modelRuntime.createSessionView();
			const model = modelRuntime.getModel(request.model.provider, request.model.id);
			if (!model) throw new CollaborationError("invalid_arguments", "Requested child model is unavailable");
			let manager: SessionManager;
			if (request.storage.kind === "memory") {
				manager = SessionManager.inMemory(cwd);
			} else {
				const { directory, sessionFile } = request.storage;
				if (!isAbsolute(directory))
					throw new CollaborationError("invalid_arguments", "Session directory must be absolute");
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const metadata = await lstat(directory);
				if (!metadata.isDirectory() || metadata.isSymbolicLink())
					throw new CollaborationError("forbidden", "Unsafe child session directory");
				if (sessionFile) {
					if (!isAbsolute(sessionFile) || dirname(resolve(sessionFile)) !== resolve(directory)) {
						throw new CollaborationError("forbidden", "Session is outside its assigned directory");
					}
					const file = await lstat(sessionFile);
					if (!file.isFile() || file.isSymbolicLink())
						throw new CollaborationError("forbidden", "Unsafe child session file");
					// Validate before SessionManager.open(), which can migrate or initialize files.
					const entries: unknown[] = (await readFile(sessionFile, "utf8"))
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line));
					const records = entries.filter(
						(entry): entry is Record<string, unknown> =>
							!!entry && typeof entry === "object" && !Array.isArray(entry),
					);
					const header = records[0];
					const recorded = records.filter(
						(entry) => entry.type === "custom" && entry.customType === IDENTITY_ENTRY,
					);
					const stored = recorded[0]?.data as Record<string, unknown> | undefined;
					if (
						records.length !== entries.length ||
						header?.type !== "session" ||
						header.version !== CURRENT_SESSION_VERSION ||
						typeof header.cwd !== "string" ||
						(await realpath(header.cwd)) !== cwd ||
						recorded.length !== 1 ||
						stored?.version !== 1 ||
						stored.rootSessionId !== identity.rootSessionId ||
						stored.agentPath !== identity.agentPath
					) {
						throw new CollaborationError("forbidden", "Stored child identity does not match its owner");
					}
					manager = SessionManager.open(join(directory, basename(sessionFile)), directory);
				} else {
					manager = SessionManager.create(cwd, directory);
				}
			}
			if (request.storage.kind === "memory" || !request.storage.sessionFile) {
				manager.appendCustomEntry(IDENTITY_ENTRY, { version: 1, ...identity });
			}
			const settingsManager = SettingsManager.inMemory(structuredClone(options.settings));
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir: request.agentDir,
				settingsManager,
				noExtensions: options.noExtensions,
				extensionFactories: [
					{
						name: "easy-pi-child",
						factory: createEasyPiHarness({
							nativeSession: {
								getPermissions: request.getPermissions,
								registerTools: (pi) => options.registerTools(identity, pi),
							},
						}),
					},
					...(options.additionalExtensions?.(identity) ?? []),
				],
			});
			await loader.reload();
			if (loader.getExtensions().errors.length)
				throw new CollaborationError("invalid_arguments", "Child extensions failed to load");
			const { session } = await createAgentSession({
				cwd,
				agentDir: request.agentDir,
				model,
				thinkingLevel: request.model.thinkingLevel,
				modelRuntime,
				settingsManager,
				sessionManager: manager,
				resourceLoader: loader,
			});
			let extensionFailed = false;
			try {
				if (session.thinkingLevel !== request.model.thinkingLevel)
					throw new CollaborationError("invalid_arguments", "Requested child reasoning effort is unsupported");
				await session.bindExtensions({
					mode: "rpc",
					onError: () => {
						extensionFailed = true;
					},
				});
				if (extensionFailed) throw new CollaborationError("invalid_arguments", "Child extension startup failed");
			} catch (error) {
				session.dispose();
				throw error;
			}

			let active: Promise<ChildTurnResult> | undefined;
			let interrupted = false;
			let closing: Promise<void> | undefined;
			let closed = false;
			const stream = session.agent.streamFunction;
			// abort() can race with asynchronous prompt preflight, before Agent has an abort controller.
			// Guard the public stream seam as well, so delayed preflight cannot start a provider request.
			session.agent.streamFunction = (model, context, streamOptions) => {
				if (closed || interrupted) throw new CollaborationError("interrupted", "Child turn was interrupted");
				if (extensionFailed) throw new CollaborationError("forbidden", "Child extension authority failed");
				return stream(model, context, streamOptions);
			};
			return {
				identity,
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				context: (): AgentMessage[] => structuredClone(manager.buildSessionContext().messages),
				run(text) {
					validateCollaborationMessage(text);
					if (closed) throw new CollaborationError("interrupted", "Child session is closed");
					if (extensionFailed) throw new CollaborationError("forbidden", "Child extension authority failed");
					if (active) throw new CollaborationError("busy", "Child session is already running");
					interrupted = false;
					const operation = async (): Promise<ChildTurnResult> => {
						if (closed || interrupted) return { status: "interrupted", text: "" };
						let last: AssistantMessage | undefined;
						let usage: Usage | undefined;
						const unsubscribe = session.subscribe((event) => {
							if (event.type !== "message_end" || event.message.role !== "assistant") return;
							last = event.message;
							if (!usage) usage = structuredClone(last.usage);
							else {
								for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
									usage[key] += last.usage[key];
								for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
									usage.cost[key] += last.usage.cost[key];
							}
						});
						try {
							// Run through Pi's prompt preflight/hooks, without slash/skill/template execution.
							await session.prompt(text, { expandPromptTemplates: false, source: "extension" });
							if (manager.isPersisted() && session.sessionFile && last) await chmod(session.sessionFile, 0o600);
							return {
								status:
									interrupted || last?.stopReason === "aborted"
										? "interrupted"
										: !last || last.stopReason === "error"
											? "failed"
											: "completed",
								text:
									last?.content
										.filter((item) => item.type === "text")
										.map((item) => item.text)
										.join("\n") ?? "",
								...(usage ? { usage } : {}),
							};
						} finally {
							unsubscribe();
						}
					};
					// Reserve before any async extension callback can re-enter run().
					active = Promise.resolve()
						.then(operation)
						.finally(() => {
							active = undefined;
						});
					return active;
				},
				async abort() {
					if (!active) return;
					interrupted = true;
					await session.abort();
					await active;
				},
				dispose() {
					if (closing) return closing;
					closed = true;
					interrupted = true;
					closing = (async () => {
						try {
							await session.abort();
							await active;
							await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
						} finally {
							session.dispose();
						}
					})();
					return closing;
				},
			};
		},
	};
}
