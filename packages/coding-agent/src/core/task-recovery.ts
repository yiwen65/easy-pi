import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage, AgentToolCall } from "@earendil-works/pi-agent-core";
import { hasConfirmedBashExit } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { getTaskRecoveryResultReceipts, type SessionManager } from "./session-manager.ts";

const ENTRY_TYPE = "pi-task-recovery";
const driverOwners = new WeakSet<SessionManager>();

export interface RecoveryTool {
	call: AgentToolCall;
	/** Nested calls belong to the parent's response occurrence and are never transcript exchanges. */
	parentToolCallId?: string;
	safe: boolean;
	args?: unknown;
	dispatched: boolean;
	definition?: string;
	result?: ToolResultMessage;
	/** Reserved canonical receipt; publication requires a matching branch-visible message. */
	resultEntryId?: string;
	terminate?: boolean;
}

export interface TaskRecoveryState {
	version: 2;
	id: string;
	status: "running" | "interrupted" | "cancelled" | "needs_reconciliation" | "completed";
	/** A removed observation cannot be resumed; its missing result remains in the audit history. */
	retirement?: "computer_capture_tool_removed";
	sourceLeafId: string | null;
	prompt: AgentMessage[];
	promptEntryIds: string[];
	queued: Array<{
		kind: "steer" | "followUp" | "nextTurn";
		messages: AgentMessage[];
		entryIds: string[];
		label?: string;
		cancelled?: boolean;
	}>;
	systemPrompt?: string;
	retryAttempt: number;
	step?: {
		sourceLeafId: string | null;
		message?: AssistantMessage;
		assistantEntryId?: string;
		recoverable?: boolean;
		items: Array<{ index: number; block: AssistantMessage["content"][number] }>;
	};
	tools: RecoveryTool[];
	suspendedTasks?: SuspendedTaskRecovery[];
}

export interface SuspendedTaskRecovery {
	leafId: string;
	state: Omit<TaskRecoveryState, "suspendedTasks">;
}

type StoredTaskRecoveryState = Omit<TaskRecoveryState, "version" | "promptEntryIds" | "queued"> & {
	version: 1 | 2;
	promptEntryIds?: string[];
	queued?: TaskRecoveryState["queued"];
};

function isUnfinishedComputerCaptureTask(state: Pick<TaskRecoveryState, "tools">): boolean {
	const unfinished = state.tools.filter((tool) => !tool.result);
	return (
		unfinished.length > 0 &&
		unfinished.every((tool) => {
			const request = tool.call.arguments.request;
			return (
				tool.dispatched &&
				tool.call.name === "computer" &&
				request !== null &&
				typeof request === "object" &&
				"op" in request &&
				request.op === "capture"
			);
		})
	);
}

/** Branch-scoped execution facts. These entries never become model messages. */
export class TaskRecoveryJournal {
	private readonly manager: SessionManager;
	private lockPath?: string;
	private lockToken?: string;
	private ownsDriver = false;

	constructor(manager: SessionManager) {
		this.manager = manager;
	}

	get state(): TaskRecoveryState | undefined {
		const branch = this.manager.getBranch();
		const entry = branch
			.slice()
			.reverse()
			.find(
				(entry) =>
					entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.sourceSessionId === undefined,
			);
		if (!entry || entry.type !== "custom") return undefined;
		const stored = entry.data as StoredTaskRecoveryState | undefined;
		if (
			!stored ||
			(stored.version !== 1 && stored.version !== 2) ||
			typeof stored.id !== "string" ||
			!Array.isArray(stored.prompt) ||
			!Array.isArray(stored.tools)
		)
			throw new Error("Invalid task recovery record");
		if (stored.version === 2 && (!Array.isArray(stored.promptEntryIds) || !Array.isArray(stored.queued)))
			throw new Error("Invalid task recovery record");
		let promptEntryIds = stored.promptEntryIds;
		if (stored.version === 1 && promptEntryIds === undefined) {
			const sourceIndex =
				stored.sourceLeafId === null ? -1 : branch.findIndex((entry) => entry.id === stored.sourceLeafId);
			if (stored.sourceLeafId !== null && sourceIndex < 0) throw new Error("Legacy task recovery anchor is missing");
			const own = branch.slice(sourceIndex + 1, branch.indexOf(entry));
			const assistantIndex = own.findIndex(
				(entry) => entry.type === "message" && entry.message.role === "assistant",
			);
			const inputs = (assistantIndex < 0 ? own : own.slice(0, assistantIndex)).filter(
				(entry) => (entry.type === "message" && entry.message.role === "user") || entry.type === "custom_message",
			);
			let cursor = 0;
			promptEntryIds = stored.prompt.map((message, index) => {
				const matches = inputs
					.slice(cursor)
					.filter((entry) =>
						entry.type === "message"
							? JSON.stringify(entry.message) === JSON.stringify(message)
							: entry.type === "custom_message" &&
								message.role === "custom" &&
								entry.customType === message.customType &&
								JSON.stringify(entry.content) === JSON.stringify(message.content) &&
								JSON.stringify(entry.details) === JSON.stringify(message.details),
					);
				if (matches.length === 1) {
					cursor = inputs.indexOf(matches[0]) + 1;
					return matches[0].id;
				}
				// A recorded assistant step proves the entire initial group was
				// delivered. Its one-to-one canonical prefix can include hook edits.
				if (matches.length === 0 && stored.step && inputs.length === stored.prompt.length && inputs[index]) {
					cursor = index + 1;
					return inputs[index].id;
				}
				if (matches.length === 0 && !stored.step && cursor === inputs.length)
					return `task_input_${stored.id}_${index}`;
				throw new Error("Legacy task input receipts are ambiguous; inspect the session before continuing");
			});
		}
		const state = {
			...stored,
			version: 2,
			promptEntryIds,
			queued: stored.version === 1 ? (stored.queued ?? []) : stored.queued,
		} as TaskRecoveryState;
		if (
			!state ||
			state.version !== 2 ||
			typeof state.id !== "string" ||
			!Array.isArray(state.tools) ||
			!Array.isArray(state.prompt) ||
			!Array.isArray(state.promptEntryIds) ||
			state.promptEntryIds.length !== state.prompt.length ||
			state.promptEntryIds.some((id) => typeof id !== "string" || id.trim().length === 0) ||
			!Array.isArray(state.queued) ||
			state.queued.some(
				(group) =>
					!group ||
					!["steer", "followUp", "nextTurn"].includes(group.kind) ||
					!Array.isArray(group.messages) ||
					!Array.isArray(group.entryIds) ||
					group.messages.length !== group.entryIds.length ||
					group.entryIds.some((id) => typeof id !== "string" || id.trim().length === 0),
			) ||
			!["running", "interrupted", "cancelled", "needs_reconciliation", "completed"].includes(state.status) ||
			!Number.isSafeInteger(state.retryAttempt) ||
			state.retryAttempt < 0 ||
			(state.suspendedTasks !== undefined &&
				(!Array.isArray(state.suspendedTasks) ||
					state.suspendedTasks.some(
						(task) =>
							!task ||
							typeof task.leafId !== "string" ||
							!branch.some((entry) => entry.id === task.leafId) ||
							!task.state ||
							task.state.version !== 2 ||
							typeof task.state.id !== "string" ||
							!Array.isArray(task.state.tools) ||
							!Array.isArray(task.state.prompt) ||
							!Array.isArray(task.state.promptEntryIds) ||
							!Array.isArray(task.state.queued) ||
							task.state.prompt.length !== task.state.promptEntryIds.length ||
							"suspendedTasks" in task.state,
					)))
		) {
			throw new Error("Invalid task recovery record");
		}
		const restored = structuredClone(state);
		// Older drivers saved confirmed Bash failures as diagnostic-only entries.
		// Recover that recorded outcome without changing the file or replaying Bash.
		for (const task of [restored, ...(restored.suspendedTasks ?? []).map((task) => task.state)]) {
			if (
				task.retirement !== undefined &&
				(task.retirement !== "computer_capture_tool_removed" ||
					task.status !== "cancelled" ||
					!isUnfinishedComputerCaptureTask(task))
			) {
				throw new Error("Invalid task retirement record");
			}
			const sourceLeafId = task.step ? task.step.sourceLeafId : task.sourceLeafId;
			const anchorIndex = sourceLeafId === null ? -1 : branch.findIndex((entry) => entry.id === sourceLeafId);
			if (sourceLeafId !== null && anchorIndex < 0) continue;
			for (const tool of task.tools) {
				if (!tool.dispatched || tool.safe || tool.result || tool.call.name !== "bash") continue;
				for (const entry of branch.slice(anchorIndex + 1).reverse()) {
					if (entry.type !== "custom" || entry.customType !== "pi-tool-interruption") continue;
					const message = (entry.data as { message?: ToolResultMessage } | undefined)?.message;
					if (
						!message ||
						message.role !== "toolResult" ||
						message.toolCallId !== tool.call.id ||
						message.nestedExecutionOutcome === "unknown" ||
						!hasConfirmedBashExit(message.toolName, message.details) ||
						message.details.command !== tool.call.arguments.command
					)
						continue;
					tool.result = structuredClone(message);
					break;
				}
			}
			if (
				task.status === "needs_reconciliation" &&
				!task.tools.some((tool) => tool.dispatched && !tool.safe && !tool.result)
			)
				task.status = "interrupted";
		}
		return restored;
	}

	start(
		prompt: AgentMessage[],
		systemPrompt?: string,
		promptEntryIds: string[] = prompt.map(() => randomUUID()),
		/** A new host-owned assignment can retain prior inputs only as historical/suspended facts. */
		options?: { inheritQueuedInputs?: boolean },
	): void {
		const inheritQueuedInputs = options?.inheritQueuedInputs ?? true;
		const branchIds = new Set(this.manager.getBranch().map((entry) => entry.id));
		const previous = this.state;
		const suspendedTasks = previous?.suspendedTasks ?? [];
		const unknown = previous?.tools.some((tool) => tool.dispatched && !tool.safe && !tool.result);
		const suspending =
			previous &&
			!previous.retirement &&
			(unknown ||
				(previous.status !== "cancelled" && previous.status !== "completed" && this.hasUnaccountedCalls(previous)));
		if (previous && suspending) {
			const { suspendedTasks: _suspended, ...paused } = previous;
			const leafId = this.manager.getLeafId();
			if (!leafId) throw new Error("Paused task has no recovery anchor");
			suspendedTasks.push({
				leafId,
				state: {
					...paused,
					status: unknown ? "needs_reconciliation" : "interrupted",
					queued: inheritQueuedInputs ? paused.queued.filter((group) => group.kind !== "nextTurn") : paused.queued,
				},
			});
		}
		const queued = inheritQueuedInputs
			? (previous?.queued.filter(
					(group) =>
						(!suspending || group.kind === "nextTurn") &&
						!group.cancelled &&
						group.entryIds.some((id) => !branchIds.has(id)),
				) ?? [])
			: [];
		this.save({
			version: 2,
			id: randomUUID(),
			status: "running",
			sourceLeafId: this.manager.getLeafId(),
			prompt,
			promptEntryIds,
			queued,
			systemPrompt,
			retryAttempt: 0,
			tools: [],
			suspendedTasks,
		});
	}

	get suspendedTasks(): SuspendedTaskRecovery[] {
		return this.state?.suspendedTasks?.filter((task) => !task.state.retirement) ?? [];
	}

	get allUnknownTools(): RecoveryTool[] {
		return [this.state, ...this.suspendedTasks.map((task) => task.state)].flatMap((state) =>
			!state?.retirement ? (state?.tools.filter((tool) => tool.dispatched && !tool.safe && !tool.result) ?? []) : [],
		);
	}

	/** Narrow migration for the removed capture component, never for unavailable write tools. */
	retireRemovedComputerCaptures(installedTools: ReadonlySet<string>): void {
		if (installedTools.has("computer")) return;
		const initial = this.state;
		if (!initial) return;
		const notices = new Set(
			this.manager.getBranch().flatMap((entry) => {
				if (entry.type !== "custom_message" || entry.customType !== "task-retirement") return [];
				const details = entry.details as { taskId?: string } | undefined;
				return details?.taskId ? [details.taskId] : [];
			}),
		);
		const candidates = [initial, ...(initial.suspendedTasks ?? []).map((task) => task.state)].filter(
			(task) => task.retirement || isUnfinishedComputerCaptureTask(task),
		);
		if (candidates.every((task) => task.retirement && notices.has(task.id))) return;
		const owned = this.ownsDriver;
		if (!owned) this.acquire();
		try {
			const state = this.state;
			if (!state) return;
			const retired = [state, ...(state.suspendedTasks ?? []).map((task) => task.state)].filter(
				(task) => task.retirement || isUnfinishedComputerCaptureTask(task),
			);
			let changed = false;
			for (const task of retired) {
				if (task.retirement) continue;
				task.retirement = "computer_capture_tool_removed";
				task.status = "cancelled";
				for (const group of task.queued) group.cancelled = true;
				changed = true;
			}
			if (changed) this.save(state);
			for (const task of retired) {
				if (notices.has(task.id)) continue;
				const toolCallIds = task.tools.filter((tool) => !tool.result).map((tool) => tool.call.id);
				this.manager.appendCustomMessageEntry(
					"task-retirement",
					`Historical task ${task.id} was interrupted. Its computer capture calls (${toolCallIds.join(", ")}) have no recorded observation. The computer tool has been removed, so recovery of this task is closed. No successful result is claimed. Continue the current request without resuming this historical task.`,
					false,
					{ taskId: task.id, reason: task.retirement, toolCallIds },
				);
			}
		} finally {
			if (!owned) this.release();
		}
	}

	/** Caller owns the driver; archived updates must also work when the active task completed. */
	reconcile(toolCallId: string, resolution: { kind: "retry" } | { kind: "result"; result: ToolResultMessage }): void {
		const active = this.state;
		if (!active) throw new Error(`No unknown tool call ${toolCallId}`);
		const matches = [active, ...(active.suspendedTasks ?? []).map((task) => task.state)].filter(
			(state) =>
				!state.retirement &&
				state.tools.some((tool) => tool.call.id === toolCallId && tool.dispatched && !tool.result && !tool.safe),
		);
		if (matches.length !== 1) throw new Error(`No unique unknown tool call ${toolCallId}`);
		const state = matches[0];
		const tool = state.tools.find((tool) => tool.call.id === toolCallId)!;
		if (resolution.kind === "retry" && tool.parentToolCallId)
			throw new Error("Nested operations cannot be independently retried; inspect their external outcome");
		if (resolution.kind === "retry") tool.dispatched = false;
		else {
			if (resolution.result.toolCallId !== toolCallId || resolution.result.toolName !== tool.call.name)
				throw new Error("Reconciled result does not match the tool call");
			tool.result = resolution.result;
		}
		state.status = state.tools.some((tool) => tool.dispatched && !tool.safe && !tool.result)
			? "needs_reconciliation"
			: "interrupted";
		this.save(active);
	}

	/** A model may record an observed outcome, but cannot authorize an unsafe retry. */
	reconcileFromEvidence(toolCallId: string, evidenceIds: string[], conclusion: string, failed = false): void {
		const tool = this.allUnknownTools.find((tool) => tool.call.id === toolCallId);
		if (!tool) throw new Error(`No unknown tool call ${toolCallId}`);
		if (evidenceIds.length === 0 || conclusion.trim().length === 0)
			throw new Error("An observed outcome and recorded read-only evidence are required");
		const all = this.manager.getBranch();
		const anchor = this.state?.sourceLeafId;
		const branch = all.slice(anchor === null ? 0 : all.findIndex((entry) => entry.id === anchor) + 1);
		const evidence = evidenceIds.map((id) => {
			for (const entry of branch.slice().reverse()) {
				if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
				const state = entry.data as TaskRecoveryState;
				const observed = state.tools.find((candidate) => candidate.call.id === id && candidate.result);
				if (!observed) continue;
				const definition = observed.definition
					? (JSON.parse(observed.definition) as { contract?: { readOnly?: boolean } })
					: undefined;
				if (!observed.safe || observed.result?.isError || definition?.contract?.readOnly !== true)
					throw new Error(`Evidence ${id} is not a successful read-only inspection`);
				return { call: observed.call, result: observed.result };
			}
			throw new Error(`No recorded evidence ${id}`);
		});
		this.reconcile(toolCallId, {
			kind: "result",
			result: {
				role: "toolResult",
				toolCallId,
				toolName: tool.call.name,
				content: [
					{
						type: "text",
						text: `Observed outcome: ${conclusion}\nInspection evidence: ${JSON.stringify(evidence)}`,
					},
				],
				details: { reconciliation: "inspection", evidence },
				isError: failed,
				timestamp: Date.now(),
			},
		});
	}

	/** Explicit recovery switches branches; subsequent work remains in the session tree. */
	activateSuspended(taskId: string): void {
		if (this.state?.suspendedTasks?.find((task) => task.state.id === taskId)?.state.retirement)
			throw new Error(`Task ${taskId} was retired because its capture tool was removed`);
		const suspended = this.suspendedTasks;
		const task = suspended.find((task) => task.state.id === taskId);
		if (!task) throw new Error(`No suspended task ${taskId}`);
		if (task.state.tools.some((tool) => tool.dispatched && !tool.safe && !tool.result))
			throw new Error(`Unknown tool effects in task ${taskId}; inspect external state before resuming`);
		const previousLeaf = this.manager.getLeafId();
		this.manager.branch(task.leafId);
		const branchIds = new Set(this.manager.getBranch().map((entry) => entry.id));
		try {
			this.save({
				...task.state,
				suspendedTasks: suspended.filter((other) => other.state.id !== taskId && branchIds.has(other.leafId)),
			});
		} catch (error) {
			if (previousLeaf) this.manager.branch(previousLeaf);
			throw error;
		}
	}

	queue(kind: "steer" | "followUp" | "nextTurn", messages: AgentMessage[], label?: string): string[] {
		const owned = this.ownsDriver;
		if (!owned) this.acquire();
		try {
			if (!this.state || this.state.status === "completed") {
				this.start([]);
				this.update((state) => {
					state.status = "interrupted";
				});
			}
			const entryIds = messages.map(() => randomUUID());
			this.update((state) => {
				state.queued.push({ kind, messages, label, entryIds });
			});
			return entryIds;
		} finally {
			if (!owned) this.release();
		}
	}

	/** Replaying an ancestor's pending group creates delivery receipts on its new branch. */
	rebindQueuedReceipts(): void {
		const initial = this.state;
		const branchIds = new Set(this.manager.getBranch().map((entry) => entry.id));
		if (
			!initial?.queued.some(
				(group) => !group.cancelled && group.entryIds.some((id) => this.manager.getEntry(id) && !branchIds.has(id)),
			)
		)
			return;
		const owned = this.ownsDriver;
		if (!owned) this.acquire();
		try {
			const state = this.state;
			if (!state) return;
			let changed = false;
			for (const group of state.queued) {
				if (group.cancelled) continue;
				group.entryIds = group.entryIds.map((id) => {
					if (!this.manager.getEntry(id) || branchIds.has(id)) return id;
					changed = true;
					return randomUUID();
				});
			}
			// Also applies to queued snapshots whose original driver completed.
			// Append on the selected branch; old branches retain their own receipts.
			if (changed) this.save(state);
		} finally {
			if (!owned) this.release();
		}
	}

	cancelQueued(entryIds: ReadonlySet<string>): void {
		if (entryIds.size === 0) return;
		const owned = this.ownsDriver;
		if (!owned) this.acquire();
		try {
			const state = this.state;
			if (!state) return;
			for (const group of state.queued)
				if (group.kind !== "nextTurn" && group.entryIds.some((id) => entryIds.has(id))) group.cancelled = true;
			this.save(state);
		} finally {
			if (!owned) this.release();
		}
	}

	update(change: (state: TaskRecoveryState) => void): void {
		const state = this.state;
		if (!state || state.status === "completed") return;
		change(state);
		this.save(state);
	}

	beginStep(message: AssistantMessage): void {
		this.update((state) => {
			if (state.status === "needs_reconciliation")
				throw new Error("Cannot start a model step before tool reconciliation");
			state.step = { sourceLeafId: this.manager.getLeafId(), message, items: [] };
			state.tools = [];
		});
	}

	completeItem(index: number, block: AssistantMessage["content"][number], message: AssistantMessage): void {
		this.update((state) => {
			state.step ??= { sourceLeafId: this.manager.getLeafId(), items: [] };
			state.step.message = message;
			state.step.items = [...state.step.items.filter((item) => item.index !== index), { index, block }];
		});
	}

	commitAssistant(message: AssistantMessage, entryId: string): void {
		this.update((state) => {
			state.step ??= { sourceLeafId: this.manager.getLeafId(), items: [] };
			state.step.recoverable =
				message.stopReason !== "length" && (message.stopReason !== "error" || isRetryableAssistantError(message));
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				state.step.message = message;
				state.step.assistantEntryId = entryId;
			}
		});
	}

	dispatch(call: AgentToolCall, args: unknown, safe: boolean, definition?: string, parentToolCallId?: string): void {
		const pending = this.suspendedTasks
			.flatMap((task) => task.state.tools)
			.find(
				(tool) =>
					tool.dispatched &&
					!tool.safe &&
					!tool.result &&
					tool.call.name === call.name &&
					(isDeepStrictEqual(tool.args, args) || isDeepStrictEqual(tool.call.arguments, call.arguments)),
			);
		if (pending) {
			const text = `Tool ${pending.call.id} has an unknown outcome; inspect it before repeating this operation`;
			// This call was rejected before dispatch, unlike the unresolved original.
			this.result(
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text }],
					isError: true,
					timestamp: Date.now(),
				},
				call,
				false,
				false,
				parentToolCallId,
			);
			throw new Error(text);
		}
		const previous = this.state?.tools.find((tool) => tool.call.id === call.id);
		if (previous && (previous.call.name !== call.name || previous.parentToolCallId !== parentToolCallId))
			throw new Error(`Tool call ${call.id} belongs to a different execution occurrence`);
		if (
			previous?.dispatched &&
			!previous.result &&
			previous.safe &&
			(!safe ||
				previous.definition !== definition ||
				!definition ||
				JSON.stringify(previous.args) !== JSON.stringify(args))
		) {
			this.update((state) => {
				const tool = state.tools.find((tool) => tool.call.id === call.id);
				if (tool) tool.safe = false;
				state.status = "needs_reconciliation";
			});
			throw new Error(`Tool ${call.id} changed since dispatch; verify its external outcome before retry`);
		}
		this.update((state) => {
			if (state.status !== "running") throw new Error(`Task is ${state.status}; tool dispatch is paused`);
			if (parentToolCallId) {
				let parentId: string | undefined = parentToolCallId;
				while (parentId) {
					const parent = state.tools.find((tool) => tool.call.id === parentId);
					if (!parent?.dispatched || parent.result)
						throw new Error("Nested dispatch has no active parent occurrence");
					// A composed execution cannot promise safe replay of the complete script.
					parent.safe = false;
					parentId = parent.parentToolCallId;
				}
			}
			const old = state.tools.find((tool) => tool.call.id === call.id);
			if (old?.result) throw new Error(`Tool ${call.id} already has a committed result`);
			if (old?.dispatched && !old.safe) throw new Error(`Tool ${call.id} requires reconciliation before retry`);
			state.tools = [
				...state.tools.filter((tool) => tool.call.id !== call.id),
				{ call, args, safe, definition, dispatched: true, ...(parentToolCallId ? { parentToolCallId } : {}) },
			];
		});
	}

	result(
		message: ToolResultMessage,
		call: AgentToolCall,
		terminate: boolean,
		uncertain: boolean,
		parentToolCallId?: string,
	): void {
		this.update((state) => {
			const old = state.tools.find((tool) => tool.call.id === call.id);
			if (old && (old.call.name !== call.name || old.parentToolCallId !== parentToolCallId))
				throw new Error(`Tool result ${call.id} does not match its dispatch owner`);
			if (uncertain && old?.dispatched && !old.safe && !old.result) {
				if (state.status !== "cancelled") state.status = "needs_reconciliation";
				return;
			}
			state.tools = [
				...state.tools.filter((tool) => tool.call.id !== call.id),
				{
					...old,
					call,
					...(parentToolCallId ? { parentToolCallId } : {}),
					safe: old?.safe ?? false,
					dispatched: old?.dispatched ?? false,
					result: message,
					terminate,
				},
			];
		});
	}

	/** A result belongs to this response occurrence, not every response reusing its call ID. */
	findResultEntry(assistantEntryId: string, toolCallId: string): string | undefined {
		const branch = this.manager.getBranch();
		const sources = this.resultEntrySources;
		const recorded = branch.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId &&
				sources.get(entry.id) === assistantEntryId,
		);
		if (recorded) return recorded.id;
		const index = branch.findIndex((entry) => entry.id === assistantEntryId);
		if (index < 0) return undefined;
		for (const entry of branch.slice(index + 1)) {
			if (entry.type === "custom_message") break;
			if (entry.type !== "message") continue;
			if (entry.message.role !== "toolResult") break;
			if (entry.message.toolCallId === toolCallId) return entry.id;
		}
		return undefined;
	}

	/** Persist occurrence ownership before publication, without changing execution certainty or task status. */
	recordResultEntry(assistantEntryId: string, message: ToolResultMessage, resultEntryId?: string): string | undefined {
		const active = this.state;
		if (!active) return;
		const task = [active, ...(active.suspendedTasks ?? []).map((task) => task.state)].find(
			(task) => task.step?.assistantEntryId === assistantEntryId,
		);
		const tool = task?.tools.find(
			(tool) => tool.call.id === message.toolCallId && tool.call.name === message.toolName,
		);
		if (!tool?.result || tool.parentToolCallId) return;
		tool.result = message;
		const receipt = resultEntryId ?? tool.resultEntryId;
		// An ancestor can reserve a receipt later consumed on another branch.
		// Keep that branch's canonical audit, but publish on this branch with a fresh ID.
		tool.resultEntryId =
			receipt && (!this.manager.getEntry(receipt) || this.manager.getBranch().some((entry) => entry.id === receipt))
				? receipt
				: randomUUID();
		this.save(active);
		return tool.resultEntryId;
	}

	/** Published occurrence ownership requires a canonical message, not just a reserved receipt. */
	get resultEntrySources(): Map<string, string> {
		const branch = this.manager.getBranch();
		const visible = new Set(branch.map((entry) => entry.id));
		const sources = new Map<string, string>();
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			for (const receipt of getTaskRecoveryResultReceipts(entry)) {
				const assistantId = receipt.assistantEntryId;
				if (!visible.has(assistantId) || !visible.has(receipt.resultEntryId)) continue;
				const assistant = this.manager.getEntry(assistantId);
				if (assistant?.type !== "message" || assistant.message.role !== "assistant") continue;
				const result = this.manager.getEntry(receipt.resultEntryId);
				if (
					result?.type === "message" &&
					result.message.role === "toolResult" &&
					result.message.toolCallId === receipt.callId &&
					result.message.toolName === receipt.toolName &&
					assistant.message.content.some(
						(block) =>
							block.type === "toolCall" && block.id === receipt.callId && block.name === receipt.toolName,
					)
				)
					sources.set(receipt.resultEntryId, assistantId);
			}
		}
		return sources;
	}

	get unknownTools(): RecoveryTool[] {
		const state = this.state;
		return !state?.retirement
			? (state?.tools.filter((tool) => tool.dispatched && !tool.safe && !tool.result) ?? [])
			: [];
	}

	/** The full committed/checkpoint plan, not just calls that reached dispatch. */
	plannedCalls(state: Pick<TaskRecoveryState, "step">): AgentToolCall[] {
		const entry = state.step?.assistantEntryId ? this.manager.getEntry(state.step.assistantEntryId) : undefined;
		const content =
			entry?.type === "message" && entry.message.role === "assistant"
				? entry.message.content
				: state.step?.recoverable !== false
					? [...(state.step?.items ?? [])].sort((a, b) => a.index - b.index).map((item) => item.block)
					: [];
		return content.filter((block) => block.type === "toolCall");
	}

	hasUnaccountedCalls(state: Pick<TaskRecoveryState, "step" | "tools">): boolean {
		return (
			state.tools.some((tool) => !tool.result) ||
			this.plannedCalls(state).some((call) => !state.tools.some((tool) => tool.call.id === call.id && tool.result))
		);
	}

	/** One native task driver owns this session until all its tool promises settle. */
	acquire(): void {
		if (this.ownsDriver || driverOwners.has(this.manager)) throw new Error("Task recovery driver is already active");
		const sessionFile = this.manager.getSessionFile();
		if (!this.manager.isPersisted() || !sessionFile) {
			this.ownsDriver = true;
			driverOwners.add(this.manager);
			return;
		}
		const path = `${sessionFile}.task.lock`;
		const token = randomUUID();
		// Fresh claims and dead-owner reclamation share one gate, so a stale
		// observation cannot delete another driver's newly acquired lock.
		const claimPath = `${path}.claim`;
		try {
			mkdirSync(claimPath, { mode: 0o700 });
		} catch {
			throw new Error("Task ownership is being claimed; verify the owner before retrying");
		}
		try {
			if (existsSync(path)) {
				const owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
				if (typeof owner.pid !== "number")
					throw new Error("Invalid task writer lock; verify its owner before recovery");
				let dead = false;
				try {
					process.kill(owner.pid, 0);
				} catch (ownerError) {
					if (ownerError instanceof Error && "code" in ownerError && ownerError.code === "ESRCH") {
						dead = true;
					} else throw ownerError;
				}
				if (!dead) throw new Error("Another process owns this session task");
				unlinkSync(path);
			}
			const fd = openSync(path, "wx", 0o600);
			try {
				writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			this.lockPath = path;
			this.lockToken = token;
			this.ownsDriver = true;
			driverOwners.add(this.manager);
		} finally {
			rmdirSync(claimPath);
		}
	}

	release(): void {
		if (this.lockPath && existsSync(this.lockPath)) {
			const owner = JSON.parse(readFileSync(this.lockPath, "utf8")) as { token?: string };
			if (owner.token === this.lockToken) unlinkSync(this.lockPath);
		}
		this.lockPath = undefined;
		this.lockToken = undefined;
		if (this.ownsDriver) driverOwners.delete(this.manager);
		this.ownsDriver = false;
	}

	private save(state: TaskRecoveryState): void {
		// Durable managers serialize immediately and retain a file-backed snapshot.
		// Only ephemeral sessions need a JSON copy to isolate subsequent mutations
		// and strip absent optional provider fields.
		this.manager.appendCustomEntry(
			ENTRY_TYPE,
			this.manager.isPersisted() ? state : (JSON.parse(JSON.stringify(state)) as TaskRecoveryState),
		);
	}
}
