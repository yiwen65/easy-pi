import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	assertAgentTransition,
	COLLABORATION_LIMITS,
	type CollaborationAgentView,
	CollaborationError,
	type CollaborationMessage,
	type CollaborationStatus,
	childAgentPath,
	resolveAgentPath,
	validateCollaborationMessage,
} from "./collaboration-contract.ts";
import { CollaborationMailboxActivity } from "./collaboration-mailbox.ts";
import type { CollaborationSnapshot, CollaborationStore, StoredCollaborationAgent } from "./collaboration-store.ts";
import { prepareCollaborationFork } from "./context-fork.ts";
import type {
	ChildSession,
	ChildSessionHost,
	ChildSessionIdentity,
	ChildSessionModel,
	ChildSessionPermissions,
	ChildTurnResult,
} from "./session-host.ts";

/** Root-scoped orchestration. All state changes are serialized; model execution never holds the queue. */
export class CollaborationController {
	private readonly store: CollaborationStore;
	private readonly host: ChildSessionHost;
	private readonly agentDir: string;
	private readonly getPermissions: () => ChildSessionPermissions;
	private readonly sessions = new Map<string, ChildSession>();
	private readonly active = new Map<string, Promise<void>>();
	private queue: Promise<unknown> = Promise.resolve();
	private stopping = false;
	private failure: unknown;
	private shutdownPromise: Promise<void> | undefined;
	private readonly activity = new CollaborationMailboxActivity();

	constructor(options: {
		store: CollaborationStore;
		host: ChildSessionHost;
		agentDir: string;
		getPermissions: () => ChildSessionPermissions;
	}) {
		this.store = options.store;
		this.host = options.host;
		this.agentDir = options.agentDir;
		this.getPermissions = options.getPermissions;
	}

	get persistent(): boolean {
		return this.store.directory !== undefined;
	}

	private serialize<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private assertReady(): void {
		if (this.stopping) throw new CollaborationError("interrupted", "Team controller is stopping");
		if (this.failure) throw new CollaborationError("storage_error", "Team requires explicit operator inspection");
	}

	private assertCaller(caller: ChildSessionIdentity): void {
		if (caller.rootSessionId !== this.store.rootSessionId)
			throw new CollaborationError("forbidden", "Agent belongs to another root session");
		if (
			caller.agentPath !== "/root" &&
			!this.store.read().agents.some((agent) => agent.path === caller.agentPath && agent.status !== "closed")
		) {
			throw new CollaborationError("unknown_agent", "Unknown calling agent");
		}
	}

	private target(caller: ChildSessionIdentity, target: string): StoredCollaborationAgent {
		this.assertCaller(caller);
		const path = resolveAgentPath(caller.agentPath, target);
		const record = this.store.read().agents.find((agent) => agent.path === path);
		if (!record) throw new CollaborationError("unknown_agent", "Unknown child agent");
		return record;
	}

	list(caller: ChildSessionIdentity, prefix?: string): CollaborationAgentView[] {
		this.assertReady();
		this.assertCaller(caller);
		const path = prefix === undefined ? undefined : resolveAgentPath(caller.agentPath, prefix);
		return this.store
			.read()
			.agents.filter((agent) => !path || agent.path === path || agent.path.startsWith(`${path}/`))
			.map((agent) => ({
				task_name: agent.path,
				status: agent.status,
				loaded: this.sessions.has(agent.path),
			}));
	}

	/** Trusted controller API; fork preparation belongs to the tool/context adapter, not this method. */
	spawn(
		caller: ChildSessionIdentity,
		taskName: string,
		message: string,
		model: ChildSessionModel,
		fork?: AgentMessage[],
		signal?: AbortSignal,
	): Promise<string> {
		validateCollaborationMessage(message);
		const context = fork ? prepareCollaborationFork(fork) : undefined;
		return this.serialize(async () => {
			this.assertReady();
			if (signal?.aborted) throw new CollaborationError("interrupted", "Spawn was cancelled before admission");
			this.assertCaller(caller);
			const snapshot = this.store.read();
			const path = childAgentPath(caller.agentPath, taskName);
			if (snapshot.agents.some((agent) => agent.path === path))
				throw new CollaborationError("busy", "Agent name already exists");
			if (snapshot.agents.length >= COLLABORATION_LIMITS.maxAgents - 1)
				throw new CollaborationError("limit_reached", "Team agent limit reached");
			this.checkCapacity();
			this.checkMailboxCapacity(snapshot, caller.agentPath);
			const record: StoredCollaborationAgent = {
				id: randomUUID(),
				path,
				parent: caller.agentPath,
				model: structuredClone(model),
				status: "pending",
				completionPending: true,
				turnId: randomUUID(),
			};
			snapshot.agents.push(record);
			this.persist(snapshot);
			try {
				const session = await this.load(record, context);
				if (signal?.aborted) throw new CollaborationError("interrupted", "Spawn was cancelled before execution");
				this.start(record, session, message, caller);
				return path;
			} catch (error) {
				this.update(record.path, (current) => {
					current.status = signal?.aborted ? "interrupted" : "failed";
					current.completionPending = false;
				});
				throw error;
			}
		});
	}

	followup(caller: ChildSessionIdentity, target: string, message: string, signal?: AbortSignal): Promise<string> {
		validateCollaborationMessage(message);
		return this.serialize(async () => {
			this.assertReady();
			if (signal?.aborted) throw new CollaborationError("interrupted", "Followup was cancelled before admission");
			const record = this.target(caller, target);
			if (this.active.has(record.path) || record.status === "pending" || record.status === "closed")
				throw new CollaborationError("busy", "Agent cannot accept a follow-up now");
			this.checkCapacity();
			this.checkMailboxCapacity(this.store.read(), record.parent);
			const session = await this.load(record);
			if (signal?.aborted) throw new CollaborationError("interrupted", "Followup was cancelled before execution");
			record.turnId = randomUUID();
			return this.start(record, session, message, caller);
		});
	}

	private checkMailboxCapacity(snapshot: CollaborationSnapshot, target: string): void {
		const pending = (snapshot.messages ?? []).filter((message) => message.to === target).length;
		const reserved = snapshot.agents.filter((agent) => agent.parent === target && agent.completionPending).length;
		if (pending + reserved >= COLLABORATION_LIMITS.maxPendingMessages)
			throw new CollaborationError("limit_reached", "Mailbox is full, including reserved completion notifications");
	}

	send(caller: ChildSessionIdentity, target: string, text: string, signal?: AbortSignal): Promise<string> {
		validateCollaborationMessage(text);
		return this.serialize(() => {
			this.assertReady();
			if (signal?.aborted)
				throw new CollaborationError("interrupted", "Message send was cancelled before admission");
			this.assertCaller(caller);
			const path = resolveAgentPath(caller.agentPath, target);
			const snapshot = this.store.read();
			if (path !== "/root" && !snapshot.agents.some((agent) => agent.path === path && agent.status !== "closed"))
				throw new CollaborationError("unknown_agent", "Unknown receiving agent");
			this.checkMailboxCapacity(snapshot, path);
			const message: CollaborationMessage = {
				id: randomUUID(),
				rootSessionId: this.store.rootSessionId,
				from: caller.agentPath,
				to: path,
				turnId: snapshot.agents.find((agent) => agent.path === caller.agentPath)?.turnId ?? randomUUID(),
				kind: "message",
				text,
			};
			snapshot.messages ??= [];
			snapshot.messages.push(message);
			this.persist(snapshot);
			this.activity.notify(path);
			return message.id;
		});
	}

	pending(caller: ChildSessionIdentity): CollaborationMessage[] {
		this.assertReady();
		this.assertCaller(caller);
		return (this.store.read().messages ?? []).filter((message) => message.to === caller.agentPath);
	}

	/** Called only after durable native ingestion, never merely after enqueueing. */
	acknowledge(caller: ChildSessionIdentity, ids: readonly string[]): Promise<void> {
		return this.serialize(() => {
			this.assertReady();
			this.assertCaller(caller);
			const snapshot = this.store.read();
			const selected = new Set(ids);
			const messages = snapshot.messages ?? [];
			snapshot.messages = messages.filter((message) => message.to !== caller.agentPath || !selected.has(message.id));
			if (snapshot.messages.length !== messages.length) this.persist(snapshot);
		});
	}

	notifyUserInput(caller: ChildSessionIdentity): void {
		this.assertReady();
		this.assertCaller(caller);
		this.activity.notifyUserInput(caller.agentPath);
	}

	consumeUserInput(caller: ChildSessionIdentity): void {
		this.assertReady();
		this.assertCaller(caller);
		this.activity.consumeUserInput(caller.agentPath);
	}

	wait(caller: ChildSessionIdentity, timeout?: number, signal?: AbortSignal) {
		this.assertReady();
		this.assertCaller(caller);
		return this.activity.wait(caller.agentPath, () => this.pending(caller).length > 0, timeout, signal);
	}

	private checkCapacity(): void {
		if (this.active.size >= COLLABORATION_LIMITS.maxActiveSessions - 1)
			throw new CollaborationError("limit_reached", "Team execution limit reached");
	}

	private async load(record: StoredCollaborationAgent, fork?: AgentMessage[]): Promise<ChildSession> {
		const existing = this.sessions.get(record.path);
		if (existing) {
			this.sessions.delete(record.path);
			this.sessions.set(record.path, existing);
			return existing;
		}
		// Only persisted idle sessions can be evicted. Memory-only sessions are bounded by maxAgents.
		if (this.store.directory && this.sessions.size >= COLLABORATION_LIMITS.maxActiveSessions - 1) {
			const idle = [...this.sessions].find(([path, session]) => !this.active.has(path) && session.sessionFile);
			if (!idle) throw new CollaborationError("limit_reached", "No idle child session can be unloaded");
			await idle[1].dispose();
			this.sessions.delete(idle[0]);
		}
		const session = await this.host.create({
			rootSessionId: this.store.rootSessionId,
			agentPath: record.path,
			cwd: this.store.cwd,
			agentDir: this.agentDir,
			model: record.model,
			fork,
			getPermissions: this.getPermissions,
			storage: this.store.directory
				? {
						kind: "file",
						directory: join(this.store.directory, record.id),
						...(record.sessionFile
							? { sessionFile: join(this.store.directory, record.id, record.sessionFile) }
							: {}),
					}
				: { kind: "memory" },
		});
		if (session.identity.rootSessionId !== this.store.rootSessionId || session.identity.agentPath !== record.path) {
			await session.dispose();
			throw new CollaborationError("forbidden", "Child host returned a mismatched identity");
		}
		this.sessions.set(record.path, session);
		if (session.sessionFile)
			this.update(record.path, (current) => {
				current.sessionFile = basename(session.sessionFile!);
			});
		return session;
	}

	private update(path: string, edit: (record: StoredCollaborationAgent) => void): void {
		const snapshot = this.store.read();
		const record = snapshot.agents.find((agent) => agent.path === path);
		if (!record) throw new CollaborationError("unknown_agent", "Missing agent record");
		edit(record);
		this.persist(snapshot);
	}

	private persist(snapshot: CollaborationSnapshot): void {
		try {
			this.store.commit(snapshot);
		} catch (error) {
			this.failure = error;
			this.activity.close();
			// A failed durable update has an uncertain outcome. Stop rather than replay it.
			for (const session of this.sessions.values()) void session.abort().catch(() => undefined);
			throw new CollaborationError("storage_error", "Team persistence failed; inspect retained sessions");
		}
	}

	private start(
		record: StoredCollaborationAgent,
		session: ChildSession,
		text: string,
		caller: ChildSessionIdentity,
	): string {
		const taskMessage: CollaborationMessage = {
			id: randomUUID(),
			rootSessionId: this.store.rootSessionId,
			from: caller.agentPath,
			to: record.path,
			turnId: record.turnId,
			kind: "task",
			text,
		};
		this.update(record.path, (current) => {
			assertAgentTransition(current.status, "running");
			current.status = "running";
			current.turnId = record.turnId;
			current.completionPending = true;
			current.taskMessage = taskMessage;
			if (session.sessionFile) current.sessionFile = basename(session.sessionFile);
		});
		// Register execution synchronously, before the host or a nested tool can re-enter.
		const task = Promise.resolve()
			.then(() => session.run(text, taskMessage))
			.then(
				(result) => this.finish(record, result),
				() => this.finish(record, { status: "failed", text: "Child execution failed; inspect its session" }),
			)
			.catch((error: unknown) => {
				this.failure = error;
			})
			.finally(() => {
				this.active.delete(record.path);
			});
		this.active.set(record.path, task);
		return taskMessage.id;
	}

	private finish(record: StoredCollaborationAgent, result: ChildTurnResult): Promise<void> {
		return this.serialize(() => {
			const snapshot = this.store.read();
			const current = snapshot.agents.find((agent) => agent.path === record.path)!;
			if (current.turnId !== record.turnId) throw new CollaborationError("busy", "Stale child completion");
			if (current.status !== "interrupted") current.status = result.status;
			// The complete answer remains in the native session. Truncation is explicit.
			const suffix = "\n[Preview truncated; inspect child session for complete output.]";
			current.result =
				Buffer.byteLength(result.text) <= COLLABORATION_LIMITS.maxMessageBytes
					? result.text
					: Buffer.from(result.text)
							.subarray(0, COLLABORATION_LIMITS.maxMessageBytes - Buffer.byteLength(suffix) - 3)
							.toString("utf8") + suffix;
			current.completionPending = false;
			snapshot.messages ??= [];
			snapshot.messages.push({
				id: randomUUID(),
				rootSessionId: this.store.rootSessionId,
				from: current.path,
				to: current.parent,
				turnId: current.turnId,
				kind: "result",
				status: current.status,
				text: current.result,
			});
			this.persist(snapshot);
			this.activity.notify(current.parent);
		});
	}

	async interrupt(caller: ChildSessionIdentity, target: string): Promise<CollaborationStatus> {
		const { session, status } = await this.serialize(() => {
			this.assertReady();
			const record = this.target(caller, target);
			if (record.path === caller.agentPath)
				throw new CollaborationError("forbidden", "An agent cannot interrupt itself");
			if (!this.active.has(record.path)) return { status: record.status, session: undefined };
			this.update(record.path, (current) => {
				current.status = "interrupted";
			});
			return { session: this.sessions.get(record.path), status: record.status };
		});
		// abort may await a running child tool which itself needs the control queue.
		await session?.abort();
		return status;
	}

	/** Wait for already-admitted work only. Never starts or retries a child. */
	async settled(): Promise<void> {
		for (;;) {
			await this.queue;
			const active = [...this.active.values()];
			if (!active.length) break;
			await Promise.all(active);
		}
		if (this.failure) throw new CollaborationError("storage_error", "Failed to persist a child result");
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.stopping = true;
		this.activity.close();
		this.shutdownPromise = (async () => {
			await this.queue;
			// Do not hold the serialization queue while finish() persists an aborted turn.
			const aborts = await Promise.allSettled([...this.sessions.values()].map((session) => session.abort()));
			await Promise.all([...this.active.values()]);
			const disposals = await Promise.allSettled([...this.sessions.values()].map((session) => session.dispose()));
			this.sessions.clear();
			this.store.close();
			if ([...aborts, ...disposals].some((result) => result.status === "rejected")) {
				throw new CollaborationError("interrupted", "Child shutdown failed; inspect retained sessions");
			}
		})();
		return this.shutdownPromise;
	}
}
