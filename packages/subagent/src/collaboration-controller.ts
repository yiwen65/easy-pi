import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	assertAgentTransition,
	COLLABORATION_LIMITS,
	type CollaborationAgentView,
	CollaborationError,
	childAgentPath,
	resolveAgentPath,
	validateCollaborationMessage,
} from "./collaboration-contract.ts";
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

	list(caller: ChildSessionIdentity): CollaborationAgentView[] {
		this.assertCaller(caller);
		return this.store.read().agents.map((agent) => ({
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
	): Promise<string> {
		validateCollaborationMessage(message);
		const context = fork ? prepareCollaborationFork(fork) : undefined;
		return this.serialize(async () => {
			this.assertReady();
			this.assertCaller(caller);
			const snapshot = this.store.read();
			const path = childAgentPath(caller.agentPath, taskName);
			if (snapshot.agents.some((agent) => agent.path === path))
				throw new CollaborationError("busy", "Agent name already exists");
			if (snapshot.agents.length >= COLLABORATION_LIMITS.maxAgents - 1)
				throw new CollaborationError("limit_reached", "Team agent limit reached");
			this.checkCapacity();
			const record: StoredCollaborationAgent = {
				id: randomUUID(),
				path,
				parent: caller.agentPath,
				model: structuredClone(model),
				status: "pending",
				turnId: randomUUID(),
			};
			snapshot.agents.push(record);
			this.persist(snapshot);
			try {
				const session = await this.load(record, context);
				this.start(record, session, message);
				return path;
			} catch (error) {
				this.update(record.path, (current) => {
					current.status = "failed";
				});
				throw error;
			}
		});
	}

	followup(caller: ChildSessionIdentity, target: string, message: string): Promise<void> {
		validateCollaborationMessage(message);
		return this.serialize(async () => {
			this.assertReady();
			const record = this.target(caller, target);
			if (this.active.has(record.path) || record.status === "pending" || record.status === "closed")
				throw new CollaborationError("busy", "Agent cannot accept a follow-up now");
			this.checkCapacity();
			const session = await this.load(record);
			record.turnId = randomUUID();
			this.start(record, session, message);
		});
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
			// A failed durable update has an uncertain outcome. Stop rather than replay it.
			for (const session of this.sessions.values()) void session.abort().catch(() => undefined);
			throw new CollaborationError("storage_error", "Team persistence failed; inspect retained sessions");
		}
	}

	private start(record: StoredCollaborationAgent, session: ChildSession, text: string): void {
		this.update(record.path, (current) => {
			assertAgentTransition(current.status, "running");
			current.status = "running";
			current.turnId = record.turnId;
			if (session.sessionFile) current.sessionFile = basename(session.sessionFile);
		});
		// Register execution synchronously, before the host or a nested tool can re-enter.
		const task = Promise.resolve()
			.then(() => session.run(text))
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
	}

	private finish(record: StoredCollaborationAgent, result: ChildTurnResult): Promise<void> {
		return this.serialize(() => {
			this.update(record.path, (current) => {
				if (current.turnId !== record.turnId) throw new CollaborationError("busy", "Stale child completion");
				if (current.status !== "interrupted") current.status = result.status;
				// Bounded index preview. The complete answer remains in the native session file.
				current.result = Buffer.from(result.text)
					.subarray(0, COLLABORATION_LIMITS.maxMessageBytes - 3)
					.toString("utf8");
			});
		});
	}

	async interrupt(caller: ChildSessionIdentity, target: string): Promise<void> {
		const session = await this.serialize(() => {
			this.assertReady();
			const record = this.target(caller, target);
			if (record.path === caller.agentPath)
				throw new CollaborationError("forbidden", "An agent cannot interrupt itself");
			if (!this.active.has(record.path)) return;
			this.update(record.path, (current) => {
				current.status = "interrupted";
			});
			return this.sessions.get(record.path);
		});
		// abort may await a running child tool which itself needs the control queue.
		await session?.abort();
	}

	/** Wait for already-admitted work only. Never starts or retries a child. */
	async settled(): Promise<void> {
		await this.queue;
		await Promise.all([...this.active.values()]);
		if (this.failure) throw new CollaborationError("storage_error", "Failed to persist a child result");
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.stopping = true;
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
