/**
 * Reference PiServerService backed by the durable AgentHarness (T-007).
 *
 * One in-repo remote session product: sessions live in a harness SessionRepo,
 * execution is driven by the durable coordinator (crash-resumable by
 * construction), and snapshots are projected from the authoritative log.
 */

import type {
	AgentHarness,
	AgentHarnessOptions,
	ExecutionEnv,
	SessionMetadata as HarnessSessionMetadata,
	Session,
	SessionRepo,
	StreamFn,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, Model, Models, ThinkingLevel, ToolCall } from "@earendil-works/pi-ai";
import type {
	ModelMetadata,
	SessionMetadata,
	SessionPhase,
	SessionSnapshot,
	TranscriptItem,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import {
	PiServerError,
	type PiServerService,
	type PiSessionRuntime,
	type PiSessionRuntimeEvent,
	type PromptInput,
	type CreateSessionOptions as ServerCreateSessionOptions,
	type SteerInput,
	toProtocolAssistantMessage,
	toProtocolModelMetadata,
	toProtocolToolResultMessage,
	toProtocolUserMessage,
} from "@earendil-works/pi-server";
import { createCodingAgentHarness } from "./create-harness.ts";

export interface HarnessPiServerServiceOptions {
	repo: Omit<SessionRepo, "list"> & { list(): Promise<HarnessSessionMetadata[]> };
	models: Models;
	defaultModel: Model<Api>;
	/** Provider call seam (defaults to the Agent-level default stream function). */
	streamFn?: StreamFn;
	/** Extra harness option overrides (retry, budgets, tools, systemPrompt, ...). */
	harness?: Partial<Omit<AgentHarnessOptions, "session" | "models" | "model">>;
	/** Execution environment factory; defaults to a Node env rooted at the given cwd. */
	createEnv?: (cwd: string) => ExecutionEnv;
	/** cwd used for sessions that do not specify one. Defaults to process.cwd(). */
	defaultCwd?: string;
}

interface RuntimeState {
	harness: AgentHarness;
	models: Models;
	cwd: string;
	revision: number;
	updatedAt: number;
	listeners: Set<(event: PiSessionRuntimeEvent) => void>;
	unsubscribe: () => void;
}

export class HarnessPiServerService implements PiServerService {
	private readonly options: HarnessPiServerServiceOptions;
	private readonly liveSessions = new Map<string, { session: Session; runtime: PiSessionRuntime }>();

	constructor(options: HarnessPiServerServiceOptions) {
		this.options = options;
	}

	async listSessions(): Promise<SessionMetadata[]> {
		const metas = await this.options.repo.list();
		return Promise.all(
			metas.map(async (meta) => {
				const live = this.liveSessions.get(meta.id);
				let name: string | undefined;
				if (live) name = await live.session.getName();
				else if (this.options.repo.inspect) name = (await this.options.repo.inspect(meta)).name;
				else {
					const session = await this.options.repo.open(meta);
					try {
						name = await session.getName();
					} finally {
						await release(session);
					}
				}
				return {
					id: meta.id,
					createdAt: meta.createdAt,
					...(meta.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
					...(name ? { sessionName: name } : {}),
				};
			}),
		);
	}

	async listModels(): Promise<ModelMetadata[]> {
		const available = new Set(
			(await this.options.models.getAvailable()).map((model) => `${model.provider}/${model.id}`),
		);
		return this.options.models
			.getModels()
			.map((model) => toProtocolModelMetadata(model, available.has(`${model.provider}/${model.id}`)));
	}

	async createSession(options: ServerCreateSessionOptions): Promise<PiSessionRuntime> {
		// PiServer assigned this id; the repo must persist it exactly.
		const cwd = options.cwd ?? this.options.defaultCwd ?? process.cwd();
		const createOptions = { id: options.id, cwd };
		const session = await this.options.repo.create(createOptions);
		try {
			if (options.name) await session.setName(options.name);
			return await this.openRuntime(session, cwd, {
				...(options.model
					? { model: { provider: String(options.model.provider), id: String(options.model.id) } }
					: {}),
				...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel as ThinkingLevel } : {}),
			});
		} catch (error) {
			await release(session);
			throw error;
		}
	}

	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		const live = this.liveSessions.get(sessionId);
		if (live) return live.runtime;
		const metas = await this.options.repo.list();
		const meta = metas.find((candidate) => candidate.id === sessionId);
		if (!meta) throw new PiServerError("not_found", `Session not found: ${sessionId}`);
		const session = await this.options.repo.open(meta);
		try {
			return await this.openRuntime(session, this.options.defaultCwd ?? process.cwd(), {});
		} catch (error) {
			await release(session);
			throw error;
		}
	}

	private async openRuntime(
		session: Session,
		cwd: string,
		options: { model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel },
	): Promise<PiSessionRuntime> {
		const env = this.options.createEnv?.(cwd) ?? new NodeExecutionEnv({ cwd });
		const model = options.model
			? this.options.models.getModel(options.model.provider, options.model.id)
			: this.options.defaultModel;
		if (!model)
			throw new PiServerError("invalid_request", `Unknown model: ${options.model?.provider}/${options.model?.id}`);
		const { harness, suspended } = await createCodingAgentHarness({
			env,
			session,
			models: this.options.models,
			model,
			thinkingLevel: options.thinkingLevel,
			...(this.options.streamFn ? { streamFn: this.options.streamFn } : {}),
			...(this.options.harness ?? {}),
		});
		const state: RuntimeState = {
			harness,
			models: this.options.models,
			cwd,
			revision: 0,
			updatedAt: Date.now(),
			listeners: new Set(),
			unsubscribe: () => undefined,
		};
		state.unsubscribe = harness.events.on("run_end", () => {
			notifySnapshot(state);
		});
		const metadata = await session.getMetadata();
		const runtime = new HarnessSessionRuntime(session, state, () => {
			if (this.liveSessions.get(metadata.id)?.session === session) this.liveSessions.delete(metadata.id);
		});
		this.liveSessions.set(metadata.id, { session, runtime });
		if (suspended.length > 0) {
			// Crash recovery is the product behavior: reopening a session resumes
			// its suspended operation; the run_end event broadcasts the snapshot.
			state.updatedAt = Date.now();
			const revision = state.revision;
			const settled = () => {
				if (state.revision === revision) notifySnapshot(state);
			};
			void harness.resume().then(settled, settled);
		}
		return runtime;
	}
}

function notifySnapshot(state: RuntimeState): void {
	state.revision += 1;
	state.updatedAt = Date.now();
	for (const listener of state.listeners) listener({ type: "snapshot" });
}

async function release(session: unknown): Promise<void> {
	const candidate = session as { release?: () => Promise<void> };
	if (typeof candidate.release === "function") await candidate.release();
}

class HarnessSessionRuntime implements PiSessionRuntime {
	private readonly session: Session;
	private readonly state: RuntimeState;
	private phase: SessionPhase = "idle";
	private readonly onDispose: () => void;

	constructor(session: Session, state: RuntimeState, onDispose: () => void) {
		this.session = session;
		this.state = state;
		this.onDispose = onDispose;
	}

	getPhase(): SessionPhase {
		return this.phase;
	}

	async snapshot(): Promise<SessionSnapshot> {
		const harness = this.state.harness;
		const [meta, leafId, model, thinkingLevel, name] = await Promise.all([
			this.session.getMetadata(),
			this.session.getLeafId(),
			harness.getModel(),
			harness.getThinkingLevel(),
			this.session.getName(),
		]);
		const entries = await this.session.findEntriesOnBranch({ start: leafId ?? undefined, order: "oldestFirst" });
		const transcript: TranscriptItem[] = [];
		const toolCalls = new Map<string, ToolCall>();
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") {
				transcript.push(toProtocolUserMessage(message, { id: entry.id }));
			} else if (message.role === "assistant") {
				for (const part of message.content) {
					if (part.type === "toolCall") toolCalls.set(part.id, part);
				}
				transcript.push(toProtocolAssistantMessage(message, { id: entry.id }));
			} else if (message.role === "toolResult") {
				const call = toolCalls.get(message.toolCallId);
				if (call) transcript.push(toProtocolToolResultMessage(message, { id: entry.id, call }));
			}
		}
		const lanes = await harness.lanes();
		const operation = lanes.find((lane) => lane.name === "main")?.operation ?? null;
		this.phase = phaseOf(operation);
		const watch = await harness.watch();
		const queuedSteer: UserTranscriptItem[] = watch.snapshot.queues.steer
			.map((item) => {
				const message = item.message;
				return message.role === "user" ? toProtocolUserMessage(message, { id: item.entryId }) : undefined;
			})
			.filter((item): item is UserTranscriptItem => item !== undefined);
		return {
			id: meta.id,
			...(name ? { name } : {}),
			cwd: this.state.cwd,
			createdAt: meta.createdAt,
			updatedAt: this.state.updatedAt,
			phase: this.phase,
			model: { provider: model.provider, id: model.id },
			thinkingLevel,
			attached: false,
			locked: true,
			revision: this.state.revision,
			transcript,
			queuedSteer,
			queuedSteerCount: queuedSteer.length,
		};
	}

	async prompt(input: PromptInput): Promise<void> {
		if (input.text === "/resume-task" || input.text.startsWith("/reconcile-task")) {
			const revision = this.state.revision;
			try {
				if (input.text === "/resume-task") {
					const result = await this.state.harness.resume();
					if (!result.ok) throw new PiServerError("invalid_request", result.error.message);
				} else await this.reconcile(input.text);
			} finally {
				if (this.state.revision === revision) notifySnapshot(this.state);
			}
			return;
		}
		const revision = this.state.revision;
		try {
			const result = await this.state.harness.prompt(input.text);
			if (!result.ok) throw new PiServerError("busy", result.error.message);
		} finally {
			if (this.state.revision === revision) notifySnapshot(this.state);
		}
		// A failed run is not a transport error: the terminal error assistant
		// message is part of the authoritative snapshot the client receives.
	}

	private async reconcile(text: string): Promise<void> {
		const command = /^\/reconcile-task\s+(\S+)\s+(retry|result)(?:\s+([\s\S]+))?$/.exec(text);
		if (!command || (command[2] === "result" && !command[3]) || (command[2] === "retry" && command[3]))
			throw new PiServerError("invalid_request", "Use /reconcile-task <callId> retry or result <verified text>");
		const operation = (await this.state.harness.lanes()).find((lane) => lane.name === "main")?.operation;
		if (!operation || operation.kind !== "run" || operation.status === "running")
			throw new PiServerError("busy", "Wait for tool execution to stop before reconciliation");
		const records = await this.session.findRecords({ lane: "main", type: "tool_started", runId: operation.id });
		const started = records.find((record) => record.toolCallId === command[1]);
		if (!started || (await this.session.getEntry(started.resultEntryId)))
			throw new PiServerError("invalid_request", "No unresolved tool execution matches this call");
		try {
			await this.state.harness.reconcileTool(
				started.toolCallId,
				command[2] === "retry"
					? { kind: "retry" }
					: {
							kind: "result",
							result: {
								role: "toolResult",
								toolCallId: started.toolCallId,
								toolName: started.toolName,
								content: [{ type: "text", text: command[3]! }],
								isError: false,
								timestamp: Date.now(),
							},
						},
			);
		} catch (error) {
			throw new PiServerError("invalid_request", error instanceof Error ? error.message : String(error));
		}
	}

	async steer(input: SteerInput): Promise<void> {
		const result = await this.state.harness.steer(input.text);
		if (!result.ok) throw new PiServerError("invalid_request", result.error.message);
	}

	async abort(): Promise<void> {
		const result = await this.state.harness.abort();
		if (!result.ok) throw new PiServerError("invalid_request", result.error.message);
	}

	async setModel(model: { provider: string; id: string }): Promise<void> {
		const resolved = this.state.models.getModel(model.provider, model.id);
		if (!resolved) throw new PiServerError("not_found", `Unknown model: ${model.provider}/${model.id}`);
		await this.state.harness.setModel(resolved);
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		await this.state.harness.setThinkingLevel(thinkingLevel);
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.state.listeners.add(listener);
		return () => this.state.listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		this.state.unsubscribe();
		this.state.listeners.clear();
		try {
			await this.state.harness.close();
		} finally {
			try {
				await release(this.session);
			} finally {
				this.onDispose();
			}
		}
	}
}

function phaseOf(operation: { kind: "run" | "compaction" | "navigation"; status: string } | null): SessionPhase {
	if (!operation || operation.status !== "running") return "idle";
	if (operation.kind === "compaction") return "compaction";
	if (operation.kind === "navigation") return "branch_summary";
	return "turn";
}
