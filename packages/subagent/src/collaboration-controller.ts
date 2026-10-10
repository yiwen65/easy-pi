import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	assertAgentTransition,
	COLLABORATION_HISTORY_LIMITS,
	COLLABORATION_LIMITS,
	COLLABORATION_TEAM_TOOL_NAMES,
	CollaborationAdmissionError,
	type CollaborationArguments,
	CollaborationError,
	type CollaborationMessage,
	type CollaborationResultQuery,
	type CollaborationResults,
	type CollaborationStatus,
	type CollaborationTargetedWaitResult,
	type CollaborationTurnPage,
	childAgentPath,
	type Delegation,
	parseCollaborationArguments,
	parseDelegationResultText,
	resolveAgentPath,
	type StagedCollaborationAgentView,
	validateCollaborationMessage,
	validateCollaborationTask,
	validateDelegation,
	validateDelegationResult,
} from "./collaboration-contract.ts";
import { CollaborationMailboxActivity } from "./collaboration-mailbox.ts";
import type {
	CollaborationAuthority,
	CollaborationSnapshot,
	CollaborationStore,
	StoredCollaborationAgent,
	TurnPatch,
} from "./collaboration-store.ts";
import { prepareCollaborationFork } from "./context-fork.ts";
import type {
	ChildRequestPrefix,
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
	// Slow native lifecycle work is serialized separately, never holding control admission.
	private lifecycle: Promise<unknown> = Promise.resolve();
	private readonly loading = new Map<string, { abort: AbortController; done: Promise<string> }>();
	private stopping = false;
	private failure: unknown;
	private shutdownPromise: Promise<void> | undefined;
	private readonly activity = new CollaborationMailboxActivity();
	private readonly observers = new Set<() => void>();
	private readonly authorityObservers = new Set<() => void>();
	private readonly liveTools = new Map<string, () => readonly string[]>();

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

	private assertCaller(caller: ChildSessionIdentity, authority?: readonly CollaborationAuthority[]): void {
		if (caller.rootSessionId !== this.store.rootSessionId)
			throw new CollaborationError("forbidden", "Agent belongs to another root session");
		if (
			caller.agentPath !== "/root" &&
			!(authority ?? this.store.readAuthority()).some(
				(agent) => agent.path === caller.agentPath && agent.status !== "closed",
			)
		) {
			throw new CollaborationError("unknown_agent", "Unknown calling agent");
		}
	}

	private target(caller: ChildSessionIdentity, target: string): StoredCollaborationAgent {
		this.assertCaller(caller);
		const path = resolveAgentPath(caller.agentPath, target);
		const record = this.store.read().agents.find((agent) => agent.path === path);
		if (!record) throw new CollaborationAdmissionError("unknown_agent", "Unknown child agent");
		return record;
	}

	list(caller: ChildSessionIdentity, prefix?: string): StagedCollaborationAgentView[] {
		this.assertReady();
		this.assertCaller(caller);
		const path = prefix === undefined ? undefined : resolveAgentPath(caller.agentPath, prefix);
		return this.store
			.read()
			.agents.filter((agent) => !path || agent.path === path || agent.path.startsWith(`${path}/`))
			.map((agent) => {
				const turn = this.store.getTurn(agent.path, { turn_id: agent.turnId });
				if (!turn) throw new CollaborationError("storage_error", "Missing latest turn ledger");
				return {
					turn_id: turn.turn_id,
					task_message_id: turn.task_message_id,
					result_message_id: turn.result_message_id,
					history_coverage: turn.history_coverage,
					delivery: turn.delivery,
					turn_usage: turn.usage,
					usage_scope: "latest_turn" as const,
					task_name: agent.path,
					status: agent.status,
					loaded: this.sessions.has(agent.path),
					...(agent.delegation
						? {
								context: {
									mode: agent.delegation.context.mode,
									...(agent.contextBytes === undefined ? {} : { bytes: agent.contextBytes }),
									measured:
										agent.delegation.context.mode === "fork" && agent.delegation.context.prefix === "preserve"
											? ("request_prefix" as const)
											: ("messages" as const),
									prefix:
										agent.delegation.context.mode === "fork" && agent.delegation.context.prefix === "preserve"
											? ("required" as const)
											: ("rebuilt" as const),
								},
							}
						: {}),
					...(agent.resultValidation ? { resultValidation: agent.resultValidation } : {}),
					...(agent.usage ? { usage: agent.usage } : {}),
				};
			});
	}

	private assertRootQuery(
		caller: ChildSessionIdentity,
		tool: "get_agent_result" | "list_agent_turns" | "wait_agent",
	): void {
		this.assertReady();
		this.assertCaller(caller);
		if (caller.agentPath !== "/root")
			throw new CollaborationError("forbidden", "Only /root may query team history", "nested_delegation");
		if (!this.toolAllowed(caller, tool))
			throw new CollaborationError("forbidden", "History query tool was revoked", "tools_unavailable", [tool]);
	}

	private boundedResponse<T>(response: T, maxBytes: number): T {
		if (Buffer.byteLength(JSON.stringify(response)) > maxBytes)
			throw new CollaborationError("storage_error", "History response exceeds budget");
		return response;
	}

	/** Read-only lookup; resolve the latest selector once without loading or consuming anything. */
	getAgentResult(caller: ChildSessionIdentity, input: unknown): CollaborationResultQuery {
		this.assertRootQuery(caller, "get_agent_result");
		return this.readAgentResult(caller, parseCollaborationArguments("get_agent_result", input));
	}

	// Trusted readers (including future targeted wait) apply their own live capability guard.
	private readAgentResult(
		caller: ChildSessionIdentity,
		args: CollaborationArguments["get_agent_result"],
	): CollaborationResultQuery {
		const agent = this.target(caller, args.target);
		const selector =
			"message_id" in args
				? { message_id: args.message_id }
				: { turn_id: "turn_id" in args ? args.turn_id : agent.turnId };
		const record = this.store.getTurn(agent.path, selector);
		if (!record) {
			const known =
				this.store.hasTurnSelector(selector) ||
				(this.store.read().messages ?? []).some(
					(message) => message.id === (selector.turn_id ?? selector.message_id),
				);
			if (!known && this.store.historyCoverage() === "retained_only")
				return { state: "history_unavailable", target: agent.path, history_coverage: "retained_only" };
			throw new CollaborationError("invalid_arguments", "Unknown turn selector for this target", "unknown_turn");
		}
		const { rootSessionId: _root, delegation: _delegation, result: retained, ...turn } = record;
		let result = retained;
		if (result && result.truncated !== true && record.resultValidation?.contract === "valid") {
			try {
				const delivered = parseDelegationResultText(result.preview);
				if (delivered.artifacts) result = { ...result, artifacts: delivered.artifacts };
			} catch {
				// Legacy valid-format proof may use an older contract. Keep the original output.
			}
		}
		if (!result && record.status === "unknown") {
			if (record.history_coverage === "retained_only")
				return { state: "history_unavailable", target: agent.path, history_coverage: "retained_only" };
			throw new CollaborationError("storage_error", "Complete history lacks turn status proof");
		}
		const response: CollaborationResultQuery = result
			? { state: "found", turn, result }
			: { state: record.status === "pending" || record.status === "running" ? "pending" : "no_result", turn };
		return this.boundedResponse(response, COLLABORATION_HISTORY_LIMITS.maxResultResponseBytes);
	}

	/** Cursor fixes page membership, not the completion/ack metadata of existing turns. */
	listAgentTurns(caller: ChildSessionIdentity, input: unknown): CollaborationTurnPage {
		this.assertRootQuery(caller, "list_agent_turns");
		const args = parseCollaborationArguments("list_agent_turns", input);
		const agent = this.target(caller, args.target);
		const scope = createHash("sha256")
			.update(JSON.stringify([this.store.rootSessionId, agent.path]))
			.digest("hex");
		let after = 0;
		let highWater = this.store.highWater();
		if (args.cursor !== undefined) {
			let cursor: unknown;
			try {
				const decoded = Buffer.from(args.cursor, "base64url");
				if (decoded.toString("base64url") !== args.cursor) throw new Error("Noncanonical cursor");
				cursor = JSON.parse(decoded.toString("utf8"));
			} catch {
				throw new CollaborationError("invalid_arguments", "Invalid history cursor");
			}
			if (
				!cursor ||
				typeof cursor !== "object" ||
				Array.isArray(cursor) ||
				Object.keys(cursor).sort().join(",") !== "after,highWater,scope"
			)
				throw new CollaborationError("invalid_arguments", "Invalid history cursor shape");
			const data = cursor as { scope: unknown; after: unknown; highWater: unknown };
			if (
				data.scope !== scope ||
				typeof data.after !== "number" ||
				typeof data.highWater !== "number" ||
				!Number.isSafeInteger(data.after) ||
				!Number.isSafeInteger(data.highWater) ||
				data.after < 1 ||
				data.highWater < data.after ||
				data.highWater > highWater
			)
				throw new CollaborationError("invalid_arguments", "Foreign or invalid history cursor");
			after = data.after;
			highWater = data.highWater;
			if (this.store.pageTurns(agent.path, { after: after - 1, highWater: after, limit: 1 })[0]?.sequence !== after)
				throw new CollaborationError("invalid_arguments", "Cursor anchor belongs to another target");
		}
		const turns = this.store.pageTurns(agent.path, { after, highWater, limit: args.limit });
		const last = turns.at(-1)?.sequence;
		const more =
			last !== undefined && this.store.pageTurns(agent.path, { after: last, highWater, limit: 1 }).length > 0;
		const next_cursor = more
			? Buffer.from(JSON.stringify({ scope, after: last, highWater })).toString("base64url")
			: null;
		if (next_cursor && next_cursor.length > 512)
			throw new CollaborationError("storage_error", "History cursor exceeds budget");
		return this.boundedResponse(
			{ target: agent.path, history_coverage: this.store.historyCoverage(), turns, next_cursor },
			COLLABORATION_HISTORY_LIMITS.maxPageResponseBytes,
		);
	}

	/** Observation never loads a session, admits work, or consumes mailbox messages. */
	subscribe(listener: () => void): () => void {
		this.assertReady();
		this.observers.add(listener);
		return () => this.observers.delete(listener);
	}

	inspect(caller: ChildSessionIdentity, target: string): StoredCollaborationAgent & { sessionPath?: string } {
		this.assertReady();
		const record = this.target(caller, target);
		return {
			...record,
			...(this.store.directory && record.sessionFile
				? { sessionPath: join(this.store.directory, record.id, record.sessionFile) }
				: {}),
		};
	}

	private refreshAuthority(): void {
		for (const refresh of this.authorityObservers) refresh();
	}

	private changed(): void {
		// Native capability gates close before display observers can synchronously reenter.
		this.refreshAuthority();
		for (const listener of this.observers) {
			try {
				listener();
			} catch {
				/* A display observer is never execution authority. */
			}
		}
	}

	/** Trusted native-session binding; unloaded ancestors retain their persisted ceiling. */
	bindTools(caller: ChildSessionIdentity, getTools: () => readonly string[]): () => void {
		this.assertCaller(caller);
		if (this.liveTools.has(caller.agentPath)) throw new CollaborationError("busy", "Tool authority already bound");
		this.liveTools.set(caller.agentPath, getTools);
		this.refreshAuthority();
		return () => {
			if (this.liveTools.get(caller.agentPath) !== getTools) return;
			try {
				if (caller.agentPath !== "/root" && !this.failure) {
					let active: readonly string[];
					try {
						active = getTools();
					} catch {
						active = [];
					}
					const current = this.target(caller, ".");
					const narrowed = (current.tools ?? [...active]).filter((name) => active.includes(name));
					if (JSON.stringify(current.tools) !== JSON.stringify(narrowed))
						this.update(caller.agentPath, (record) => {
							record.tools = narrowed;
						});
				}
			} finally {
				this.liveTools.delete(caller.agentPath);
			}
		};
	}

	/** A live deny anywhere in the creation ancestry also denies descendant execution. */
	toolAllowed(caller: ChildSessionIdentity, name: string): boolean {
		this.assertReady();
		const records = this.store.readAuthority();
		this.assertCaller(caller, records);
		let path = caller.agentPath;
		while (path !== "/root") {
			const live = this.liveTools.get(path);
			if (live && !live().includes(name)) return false;
			const record = records.find((agent) => agent.path === path);
			if (!record || record.status === "closed" || (record.tools && !record.tools.includes(name))) return false;
			path = record.parent;
		}
		const root = this.liveTools.get("/root");
		return !root || root().includes(name);
	}

	/** Trusted controller API; model-facing callers must supply validated admission metadata. */
	spawn(
		caller: ChildSessionIdentity,
		taskName: string,
		message: string,
		model: ChildSessionModel,
		fork?: AgentMessage[],
		signal?: AbortSignal,
		admission?: { delegation: Delegation; tools: string[]; prefix?: ChildRequestPrefix },
	): Promise<string> {
		return this.spawnTurn(caller, taskName, message, model, fork, signal, admission).then(
			(receipt) => receipt.task_name,
		);
	}

	spawnTurn(
		caller: ChildSessionIdentity,
		taskName: string,
		message: string,
		model: ChildSessionModel,
		fork?: AgentMessage[],
		signal?: AbortSignal,
		admission?: { delegation: Delegation; tools: string[]; prefix?: ChildRequestPrefix },
	): Promise<CollaborationResults["spawn_agent"]> {
		validateCollaborationTask(message);
		const delegation = admission ? validateDelegation(admission.delegation) : undefined;
		const context = fork ? prepareCollaborationFork(fork) : undefined;
		return this.serialize(() => {
			this.assertReady();
			if (signal?.aborted) throw new CollaborationError("interrupted", "Spawn was cancelled before admission");
			this.assertCaller(caller);
			if (caller.agentPath !== "/root")
				throw new CollaborationAdmissionError("forbidden", "Only /root may create agents", "nested_delegation");
			const requestedTools = delegation?.capabilities.tools;
			if (requestedTools && requestedTools !== "inherit") {
				const teamTools = requestedTools.filter((name) => COLLABORATION_TEAM_TOOL_NAMES.has(name));
				if (teamTools.length > 0)
					throw new CollaborationError(
						"forbidden",
						"Team tools are usable by /root only; omit them from capabilities.tools",
						"nested_delegation",
						teamTools,
					);
			}
			const snapshot = this.store.read();
			const path = childAgentPath(caller.agentPath, taskName);
			if (snapshot.agents.some((agent) => agent.path === path))
				throw new CollaborationAdmissionError("busy", "Agent name already exists", undefined, [taskName]);
			// Closed records are retained for audit but free their team slot; names are never reused.
			if (snapshot.agents.filter((agent) => agent.status !== "closed").length >= COLLABORATION_LIMITS.maxAgents - 1)
				throw new CollaborationAdmissionError("limit_reached", "Team agent limit reached", "team_agents_full");
			if (snapshot.agents.length >= COLLABORATION_LIMITS.maxRetainedAgents)
				throw new CollaborationAdmissionError(
					"limit_reached",
					"Team retained-agent history limit reached",
					"team_history_full",
				);
			this.store.assertTurnCapacity();
			this.checkCapacity();
			this.checkMailboxCapacity(snapshot, caller.agentPath);
			const record: StoredCollaborationAgent = {
				id: randomUUID(),
				path,
				parent: caller.agentPath,
				model: structuredClone(model),
				...(delegation
					? {
							delegation,
							tools: [...new Set(admission!.tools)].filter(
								(name) =>
									this.toolAllowed(caller, name) &&
									(delegation.capabilities.tools === "inherit" ||
										delegation.capabilities.tools.includes(name)),
							),
						}
					: {}),
				contextBytes: Buffer.byteLength(JSON.stringify(admission?.prefix?.context ?? context ?? []), "utf8"),
				status: "pending",
				completionPending: true,
				turnId: randomUUID(),
			};
			this.reserve(record, message, caller, "initial");
			snapshot.agents.push(record);
			this.persist(snapshot);
			// Wrap the promise so the control queue does not adopt lifecycle work.
			return {
				receipt: { task_name: path, turn_id: record.turnId, message_id: record.taskMessage!.id },
				ready: this.schedule(record, signal, context, admission?.prefix),
			};
		}).then(async ({ receipt, ready }) => {
			await ready;
			return receipt;
		});
	}

	followup(
		caller: ChildSessionIdentity,
		target: string,
		message: string,
		signal?: AbortSignal,
		admission?: { delegation: Delegation; tools: string[] },
	): Promise<string> {
		return this.followupTurn(caller, target, message, signal, admission).then((receipt) => receipt.message_id);
	}

	followupTurn(
		caller: ChildSessionIdentity,
		target: string,
		message: string,
		signal?: AbortSignal,
		admission?: { delegation: Delegation; tools: string[] },
	): Promise<CollaborationResults["followup_task"]> {
		validateCollaborationTask(message);
		const delegation = admission ? validateDelegation(admission.delegation) : undefined;
		return this.serialize(() => {
			this.assertReady();
			if (signal?.aborted) throw new CollaborationError("interrupted", "Followup was cancelled before admission");
			if (caller.agentPath !== "/root")
				throw new CollaborationAdmissionError("forbidden", "Only /root may direct agents", "nested_delegation");
			const requestedTools = delegation?.capabilities.tools;
			if (requestedTools && requestedTools !== "inherit") {
				const teamTools = requestedTools.filter((name) => COLLABORATION_TEAM_TOOL_NAMES.has(name));
				if (teamTools.length > 0)
					throw new CollaborationError(
						"forbidden",
						"Team tools are usable by /root only; omit them from capabilities.tools",
						"nested_delegation",
						teamTools,
					);
			}
			const record = this.target(caller, target);
			if (
				this.active.has(record.path) ||
				this.loading.has(record.path) ||
				record.status === "pending" ||
				record.status === "closed"
			)
				throw new CollaborationAdmissionError("busy", "Agent cannot accept a follow-up now");
			this.store.assertTurnCapacity();
			this.checkCapacity();
			this.checkMailboxCapacity(this.store.read(), record.parent);
			if (delegation) {
				// Follow-ups retain child context and may only reduce its execution ceiling.
				if (
					(delegation.task.relationship === "verify" || delegation.task.relationship === "explore") &&
					(!record.delegation || record.delegation.task.relationship !== delegation.task.relationship)
				)
					throw new CollaborationError(
						"context_unavailable",
						"Independent work requires a fresh child, not a reused execution context",
						"fresh_child_required",
					);
				record.delegation = delegation;
				record.tools = [...new Set(admission!.tools)].filter(
					(name) =>
						this.toolAllowed(caller, name) &&
						(delegation.capabilities.tools === "inherit" || delegation.capabilities.tools.includes(name)) &&
						this.toolAllowed({ rootSessionId: caller.rootSessionId, agentPath: record.path }, name),
				);
			} else if (record.delegation) {
				throw new CollaborationError("invalid_arguments", "Follow-up requires an explicit task contract");
			}
			assertAgentTransition(record.status, "pending");
			record.turnId = randomUUID();
			this.reserve(record, message, caller, "existing");
			this.update(record.path, (current) => Object.assign(current, record));
			return {
				receipt: { message_id: record.taskMessage!.id, turn_id: record.turnId, status: "accepted" as const },
				ready: this.schedule(record, signal),
			};
		}).then(async ({ receipt, ready }) => {
			await ready;
			return receipt;
		});
	}

	private checkMailboxCapacity(snapshot: CollaborationSnapshot, target: string): void {
		const pending = (snapshot.messages ?? []).filter((message) => message.to === target).length;
		const reserved = snapshot.agents.filter((agent) => agent.parent === target && agent.completionPending).length;
		if (pending + reserved >= COLLABORATION_LIMITS.maxPendingMessages)
			throw new CollaborationAdmissionError(
				"limit_reached",
				"Mailbox is full, including reserved completion notifications",
				"mailbox_full",
			);
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
				throw new CollaborationAdmissionError("unknown_agent", "Unknown receiving agent");
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
			if (snapshot.messages.length !== messages.length)
				this.persist(
					snapshot,
					messages
						.filter(
							(message) =>
								message.kind === "result" && message.to === caller.agentPath && selected.has(message.id),
						)
						.map((message) => ({ target: message.from, turn_id: message.turnId, acknowledged: true })),
				);
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

	/** Pin one retained turn. Ending a wait never ends the child's execution. */
	waitForTurn(
		caller: ChildSessionIdentity,
		input: unknown,
		signal?: AbortSignal,
	): Promise<CollaborationTargetedWaitResult> {
		this.assertRootQuery(caller, "wait_agent");
		const args = parseCollaborationArguments("wait_agent", input);
		if (!("target" in args)) throw new CollaborationError("invalid_arguments", "Targeted wait requires target");
		const initial = this.readAgentResult(caller, {
			target: args.target,
			...(args.turn_id === undefined ? {} : { turn_id: args.turn_id }),
		});
		if (initial.state === "history_unavailable" || initial.turn.status === "unknown")
			throw new CollaborationError("context_unavailable", "Turn completion is not known", "history_unavailable");
		const target = initial.turn.target;
		const turn_id = initial.turn.turn_id;
		let latest = initial;
		// A change before waiter registration is caught by Activity.wait's initial check;
		// subsequent completion, startup cleanup and recovery changes wake the pinned check.
		const unsubscribe = this.subscribe(() => this.activity.notify(caller.agentPath));
		return this.activity
			.wait(
				caller.agentPath,
				() => {
					this.assertRootQuery(caller, "wait_agent");
					const observed = this.readAgentResult(caller, { target, turn_id });
					if (observed.state === "history_unavailable" || observed.turn.status === "unknown")
						throw new CollaborationError(
							"context_unavailable",
							"Turn completion is not known",
							"history_unavailable",
						);
					latest = observed;
					return ["completed", "failed", "interrupted"].includes(observed.turn.status);
				},
				args.timeout_ms,
				signal,
			)
			.then(
				(activity): CollaborationTargetedWaitResult =>
					activity.reason === "mailbox"
						? this.boundedResponse(
								{ reason: "terminal", timed_out: false, target, turn_id, result: latest },
								COLLABORATION_HISTORY_LIMITS.maxResultResponseBytes,
							)
						: activity.reason === "user_input"
							? { reason: "user_input", timed_out: false, target, turn_id }
							: { reason: "timeout", timed_out: true, target, turn_id },
			)
			.finally(unsubscribe);
	}

	private checkCapacity(): void {
		if (new Set([...this.active.keys(), ...this.loading.keys()]).size >= COLLABORATION_LIMITS.maxActiveSessions - 1)
			throw new CollaborationAdmissionError("limit_reached", "Team execution limit reached", "execution_slots_full");
	}

	/** A reserved turn owns capacity until startup settles, even if its host ignores cancellation. */
	private schedule(
		record: StoredCollaborationAgent,
		signal?: AbortSignal,
		fork?: AgentMessage[],
		prefix?: ChildRequestPrefix,
	): Promise<string> {
		const abort = new AbortController();
		const cancel = () => abort.abort();
		// Admission observers can synchronously stop the controller before this reservation is registered.
		if (this.stopping || this.failure || signal?.aborted) cancel();
		else signal?.addEventListener("abort", cancel, { once: true });
		const done = this.lifecycle.then(async () => {
			try {
				if (abort.signal.aborted) throw new CollaborationError("interrupted", "Startup cancelled");
				const session = await this.load(record, abort.signal, fork, prefix);
				return await this.serialize(() => {
					this.assertReady();
					const current = this.store.read().agents.find((agent) => agent.path === record.path)!;
					if (abort.signal.aborted || current.status !== "pending" || current.turnId !== record.turnId)
						throw new CollaborationError("interrupted", "Startup cancelled before execution");
					this.loading.delete(record.path);
					return this.start(current, session, abort.signal);
				});
			} catch (error) {
				await this.serialize(() => {
					if (this.failure) return;
					this.update(record.path, (current) => {
						current.status = abort.signal.aborted ? "interrupted" : "failed";
						current.completionPending = false;
						if (current.delegation) current.resultValidation = { contract: "not_completed" };
					});
				});
				if (abort.signal.aborted) throw new CollaborationError("interrupted", "Startup cancelled");
				throw error;
			} finally {
				signal?.removeEventListener("abort", cancel);
				if (this.loading.get(record.path)?.abort === abort) this.loading.delete(record.path);
				this.changed();
			}
		});
		this.loading.set(record.path, { abort, done });
		this.lifecycle = done.catch(() => undefined);
		return done;
	}

	private async load(
		record: StoredCollaborationAgent,
		signal: AbortSignal,
		fork?: AgentMessage[],
		prefix?: ChildRequestPrefix,
	): Promise<ChildSession> {
		const existing = this.sessions.get(record.path);
		if (existing) {
			this.sessions.delete(record.path);
			this.sessions.set(record.path, existing);
			return existing;
		}
		// Only persisted idle sessions can be evicted. Memory-only sessions are bounded by maxAgents.
		if (this.store.directory && this.sessions.size >= COLLABORATION_LIMITS.maxActiveSessions - 1) {
			const idle = [...this.sessions].find(
				([path, session]) =>
					!this.active.has(path) &&
					!this.loading.has(path) &&
					session.sessionFile &&
					(session.canUnload?.() ?? true),
			);
			if (!idle)
				throw new CollaborationError(
					"limit_reached",
					"No idle child session can be unloaded",
					"loaded_sessions_full",
				);
			await idle[1].dispose();
			this.sessions.delete(idle[0]);
			this.changed();
		}
		if (signal.aborted) throw new CollaborationError("interrupted", "Startup cancelled before creation");
		const session = await this.host.create({
			signal,
			rootSessionId: this.store.rootSessionId,
			agentPath: record.path,
			cwd: this.store.cwd,
			agentDir: this.agentDir,
			model: record.model,
			fork,
			prefix,
			toolAllowed: (name) =>
				this.toolAllowed({ rootSessionId: this.store.rootSessionId, agentPath: record.path }, name),
			subscribeAuthority: (refresh) => {
				this.authorityObservers.add(refresh);
				return () => this.authorityObservers.delete(refresh);
			},
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
		try {
			if (session.identity.rootSessionId !== this.store.rootSessionId || session.identity.agentPath !== record.path)
				throw new CollaborationError("forbidden", "Child host returned a mismatched identity");
			// Retain the validated native path even when cancelled before its first turn.
			if (session.sessionFile && !this.failure)
				this.update(record.path, (current) => {
					current.sessionFile = basename(session.sessionFile!);
				});
			if (signal.aborted || this.stopping || this.failure)
				throw new CollaborationError("interrupted", "Startup cancelled after creation");
		} catch (error) {
			await session.dispose();
			throw error;
		}
		this.sessions.set(record.path, session);
		this.changed();
		return session;
	}

	private update(path: string, edit: (record: StoredCollaborationAgent) => void): void {
		const snapshot = this.store.read();
		const record = snapshot.agents.find((agent) => agent.path === path);
		if (!record) throw new CollaborationError("unknown_agent", "Missing agent record");
		edit(record);
		this.persist(snapshot);
	}

	private persist(snapshot: CollaborationSnapshot, patches: readonly TurnPatch[] = []): void {
		try {
			this.store.commit(snapshot, patches);
		} catch (error) {
			this.failure = error;
			this.refreshAuthority();
			this.activity.close();
			// A failed durable update has an uncertain outcome. Stop rather than replay it.
			for (const loading of this.loading.values()) loading.abort.abort();
			for (const session of this.sessions.values()) void session.abort().catch(() => undefined);
			this.changed();
			throw new CollaborationError("storage_error", "Team persistence failed; inspect retained sessions");
		}
		this.changed();
	}

	private reserve(
		record: StoredCollaborationAgent,
		text: string,
		caller: ChildSessionIdentity,
		contextUse: "initial" | "existing",
	): void {
		const taskMessage: CollaborationMessage = {
			id: randomUUID(),
			rootSessionId: this.store.rootSessionId,
			from: caller.agentPath,
			to: record.path,
			turnId: record.turnId,
			kind: "task",
			text,
			parent: record.parent,
			contextUse,
			...(record.delegation ? { delegation: record.delegation } : {}),
		};
		record.status = "pending";
		record.completionPending = true;
		record.taskMessage = taskMessage;
		record.result = undefined;
		record.resultValidation = undefined;
		record.usage = undefined;
	}

	private start(record: StoredCollaborationAgent, session: ChildSession, signal: AbortSignal): string {
		const taskMessage = record.taskMessage!;
		this.update(record.path, (current) => {
			assertAgentTransition(current.status, "running");
			current.status = "running";
		});
		// Register execution synchronously, before the host or a nested tool can re-enter.
		const task = Promise.resolve()
			.then((): Promise<ChildTurnResult> | ChildTurnResult => {
				// The running notification can itself trigger shutdown or startup cancellation.
				if (this.stopping || this.failure || signal.aborted)
					return { status: "interrupted", text: "Child startup interrupted before execution" };
				return session.run(taskMessage.text, taskMessage);
			})
			.then(
				(result) => this.finish(record, result),
				() => this.finish(record, { status: "failed", text: "Child execution failed; inspect its session" }),
			)
			.catch((error: unknown) => {
				this.failure = error;
			})
			.finally(() => {
				this.active.delete(record.path);
				this.changed();
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
			const truncated = Buffer.byteLength(result.text) > COLLABORATION_LIMITS.maxMessageBytes;
			current.result = result.text;
			if (truncated) {
				const budget = COLLABORATION_LIMITS.maxMessageBytes - Buffer.byteLength(suffix);
				let bytes = 0;
				const characters: string[] = [];
				for (const character of result.text) {
					const size = Buffer.byteLength(character);
					if (bytes + size > budget) break;
					bytes += size;
					characters.push(character);
				}
				current.result = characters.join("") + suffix;
			}
			current.completionPending = false;
			if (current.delegation) current.resultValidation = validateDelegationResult(result.text, current.status);
			current.usage = result.usage
				? {
						input: result.usage.input,
						output: result.usage.output,
						cacheRead: result.usage.cacheRead,
						cacheWrite: result.usage.cacheWrite,
					}
				: undefined;
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
				...(current.resultValidation ? { resultValidation: current.resultValidation } : {}),
			});
			this.persist(snapshot, [{ target: current.path, turn_id: current.turnId, result: { truncated } }]);
			this.activity.notify(current.parent);
		});
	}

	async interrupt(caller: ChildSessionIdentity, target: string): Promise<CollaborationStatus> {
		const { session, status } = await this.serialize(() => {
			this.assertReady();
			const record = this.target(caller, target);
			if (record.path === caller.agentPath)
				throw new CollaborationAdmissionError("forbidden", "An agent cannot interrupt itself");
			const loading = this.loading.get(record.path);
			if (loading) {
				this.update(record.path, (current) => {
					current.status = "interrupted";
				});
				loading.abort.abort();
				return { status: record.status, session: undefined };
			}
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

	/**
	 * Retire a settled child agent: history and the record remain inspectable, the team slot and the
	 * native session are released, and the name is never reusable. Closed agents are terminal.
	 */
	async close(caller: ChildSessionIdentity, target: string): Promise<CollaborationStatus> {
		const { path, previous, session } = await this.serialize(() => {
			this.assertReady();
			const record = this.target(caller, target);
			if (record.path === caller.agentPath)
				throw new CollaborationAdmissionError("forbidden", "An agent cannot close itself");
			if (!record.path.startsWith(`${caller.agentPath}/`))
				throw new CollaborationAdmissionError("forbidden", "Agents can only close their own descendants");
			const session = this.sessions.get(record.path);
			if (record.status === "closed") return { path: record.path, previous: record.status, session };
			if (
				record.status === "pending" ||
				record.status === "running" ||
				this.active.has(record.path) ||
				this.loading.has(record.path)
			)
				throw new CollaborationAdmissionError("busy", "Interrupt a running child before closing it");
			const openDescendants = this.store
				.read()
				.agents.filter((agent) => agent.path.startsWith(`${record.path}/`) && agent.status !== "closed");
			if (openDescendants.length)
				throw new CollaborationAdmissionError("busy", "Close descendants before closing this agent");
			assertAgentTransition(record.status, "closed");
			this.update(record.path, (current) => {
				current.status = "closed";
				current.completionPending = false;
			});
			return { path: record.path, previous: record.status, session };
		});
		// Disposal can await native teardown; never hold the control queue for it.
		if (session) {
			await session.dispose();
			this.sessions.delete(path);
			this.changed();
		}
		return previous;
	}

	/** Wait for already-admitted work only. Never starts or retries a child. */
	async settled(): Promise<void> {
		for (;;) {
			await this.queue;
			const active = [...this.active.values(), ...[...this.loading.values()].map((loading) => loading.done)];
			if (!active.length) break;
			await Promise.allSettled(active);
		}
		if (this.failure) throw new CollaborationError("storage_error", "Failed to persist a child result");
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.stopping = true;
		this.shutdownPromise = Promise.resolve().then(async () => {
			await this.queue;
			// Do not hold the serialization queue while finish() persists an aborted turn.
			const aborting = Promise.allSettled([...this.sessions.values()].map((session) => session.abort()));
			await this.lifecycle;
			const aborts = await aborting;
			await Promise.all([...this.active.values()]);
			const disposals = await Promise.allSettled([...this.sessions.values()].map((session) => session.dispose()));
			if (disposals.some((result) => result.status === "rejected")) {
				// Failed disposal does not prove resources were released. Keep this live owner and
				// its session references instead of allowing another controller to acquire the team.
				throw new CollaborationError("interrupted", "Child shutdown failed; inspect retained sessions");
			}
			this.sessions.clear();
			this.authorityObservers.clear();
			this.liveTools.clear();
			this.store.close();
			if (aborts.some((result) => result.status === "rejected")) {
				throw new CollaborationError("interrupted", "Child shutdown failed; inspect retained sessions");
			}
		});
		this.refreshAuthority();
		for (const loading of this.loading.values()) loading.abort.abort();
		this.activity.close();
		this.changed();
		this.observers.clear();
		return this.shutdownPromise;
	}
}
