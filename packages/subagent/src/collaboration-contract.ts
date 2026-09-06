import { Buffer } from "node:buffer";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** Product limits, not an OS sandbox or a guarantee against concurrent file edits. */
export const COLLABORATION_LIMITS = Object.freeze({
	maxActiveSessions: 4, // One slot is reserved for the root, even while it is idle.
	maxAgents: 32, // Includes the root and unloaded agents until explicit cleanup.
	maxDepth: 4,
	maxMessageBytes: 8 * 1024,
	maxPendingMessages: 64,
	maxForkBytes: 256 * 1024,
	minWaitMs: 10_000,
	defaultWaitMs: 30_000,
	maxWaitMs: 3_600_000,
});

export type CollaborationErrorCode =
	| "invalid_arguments"
	| "unknown_agent"
	| "forbidden"
	| "limit_reached"
	| "busy"
	| "interrupted"
	| "storage_error"
	| "context_unavailable";

/** Safe, fixed category; callers must not include credentials or arbitrary exception payloads. */
export class CollaborationError extends Error {
	readonly code: CollaborationErrorCode;
	constructor(code: CollaborationErrorCode, message: string) {
		super(message);
		this.name = "CollaborationError";
		this.code = code;
	}
}

const TaskName = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" });
const Target = Type.String({ minLength: 1, maxLength: 265 });
const Message = Type.String({ minLength: 1, maxLength: COLLABORATION_LIMITS.maxMessageBytes });
const Reasoning = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);

/** Provider-neutral contract: model overrides are explicitly qualified as provider/model. */
export const CollaborationSchemas = {
	spawn_agent: Type.Object(
		{
			task_name: TaskName,
			message: Message,
			fork_turns: Type.Optional(Type.String({ pattern: "^(all|none|[1-9][0-9]{0,5})$" })),
			model: Type.Optional(Type.String({ minLength: 3, maxLength: 256, pattern: "^[^/\\s]+/[^\\s]+$" })),
			reasoning_effort: Type.Optional(Reasoning),
		},
		{ additionalProperties: false },
	),
	send_message: Type.Object({ target: Target, message: Message }, { additionalProperties: false }),
	followup_task: Type.Object({ target: Target, message: Message }, { additionalProperties: false }),
	wait_agent: Type.Object(
		{ timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: COLLABORATION_LIMITS.maxWaitMs })) },
		{ additionalProperties: false },
	),
	interrupt_agent: Type.Object({ target: Target }, { additionalProperties: false }),
	list_agents: Type.Object({ path_prefix: Type.Optional(Target) }, { additionalProperties: false }),
} as const;

export type CollaborationToolName = keyof typeof CollaborationSchemas;
export type CollaborationArguments = {
	[Name in CollaborationToolName]: Static<(typeof CollaborationSchemas)[Name]>;
};

export function parseCollaborationArguments<Name extends CollaborationToolName>(
	name: Name,
	input: unknown,
): CollaborationArguments[Name] {
	if (!Value.Check(CollaborationSchemas[name], input)) {
		throw new CollaborationError("invalid_arguments", `Invalid ${name} arguments`);
	}
	const parsed = input as CollaborationArguments[Name];
	if ("message" in parsed) validateCollaborationMessage(parsed.message);
	return structuredClone(parsed);
}

export function validateCollaborationMessage(message: string): void {
	if (
		!message.trim() ||
		message.includes("\0") ||
		Buffer.byteLength(message, "utf8") > COLLABORATION_LIMITS.maxMessageBytes
	) {
		throw new CollaborationError("invalid_arguments", "Message must be nonblank text of at most 8192 UTF-8 bytes");
	}
}

/** IDs remain controller-private; model references are canonical, root-scoped logical paths. */
export function validateAgentPath(path: string): void {
	const segments = path.split("/");
	if (
		segments[0] !== "" ||
		segments[1] !== "root" ||
		segments.length > COLLABORATION_LIMITS.maxDepth + 2 ||
		segments.slice(2).some((segment) => !Value.Check(TaskName, segment))
	) {
		throw new CollaborationError("invalid_arguments", "Invalid agent path");
	}
}

export function childAgentPath(parent: string, taskName: string): string {
	validateAgentPath(parent);
	if (!Value.Check(TaskName, taskName)) throw new CollaborationError("invalid_arguments", "Invalid task name");
	if (parent.split("/").length - 2 >= COLLABORATION_LIMITS.maxDepth) {
		throw new CollaborationError("limit_reached", "Agent nesting limit reached");
	}
	return `${parent}/${taskName}`;
}

/** Relative targets resolve from the sender; '..' is allowed only within its root tree. */
export function resolveAgentPath(sender: string, target: string): string {
	validateAgentPath(sender);
	if (target.startsWith("/")) {
		validateAgentPath(target);
		return target;
	}
	const result = sender.split("/");
	for (const segment of target.split("/")) {
		if (segment === ".") continue;
		if (segment === "..") {
			if (result.length <= 2) throw new CollaborationError("forbidden", "Cannot address outside the root tree");
			result.pop();
		} else {
			if (!Value.Check(TaskName, segment)) throw new CollaborationError("invalid_arguments", "Invalid agent target");
			result.push(segment);
		}
	}
	const resolved = result.join("/");
	validateAgentPath(resolved);
	return resolved;
}

export type ForkSelection = { mode: "all" } | { mode: "none" } | { mode: "last-turns"; turns: number };
export function parseForkSelection(value: string = "all"): ForkSelection {
	if (value === "all" || value === "none") return { mode: value };
	if (!/^[1-9][0-9]{0,5}$/.test(value)) throw new CollaborationError("invalid_arguments", "Invalid fork_turns");
	return { mode: "last-turns", turns: Number(value) };
}

export function collaborationWaitMs(requested?: number): number {
	if (requested === undefined) return COLLABORATION_LIMITS.defaultWaitMs;
	if (!Number.isSafeInteger(requested) || requested < 0 || requested > COLLABORATION_LIMITS.maxWaitMs) {
		throw new CollaborationError("invalid_arguments", "Invalid wait timeout");
	}
	return Math.max(requested, COLLABORATION_LIMITS.minWaitMs);
}

/** These states describe the latest turn, not delivery or a verdict on the edits. */
export type CollaborationStatus = "pending" | "running" | "completed" | "failed" | "interrupted" | "closed";
const TRANSITIONS: Record<CollaborationStatus, readonly CollaborationStatus[]> = {
	pending: ["running", "failed", "interrupted"],
	running: ["completed", "failed", "interrupted"],
	completed: ["running", "closed"],
	failed: ["running", "closed"],
	interrupted: ["running", "closed"],
	closed: [],
};

export function assertAgentTransition(from: CollaborationStatus, to: CollaborationStatus): void {
	if (!TRANSITIONS[from].includes(to)) {
		throw new CollaborationError("busy", `Cannot transition an agent from ${from} to ${to}`);
	}
}

export type CollaborationMessageKind = "task" | "message" | "result";
export interface CollaborationMessage {
	id: string;
	rootSessionId: string;
	from: string;
	to: string;
	turnId: string;
	kind: CollaborationMessageKind;
	text: string;
}

export interface CollaborationAgentView {
	task_name: string;
	status: CollaborationStatus;
	loaded: boolean;
}

/** Unlike a message receipt, a completed tool call never asserts that edits have been delivered. */
export interface CollaborationResults {
	spawn_agent: { task_name: string };
	send_message: { message_id: string; status: "accepted" };
	followup_task: { message_id: string; status: "accepted" };
	wait_agent: { reason: "mailbox" | "user_input" | "timeout"; timed_out: boolean };
	interrupt_agent: { previous_status: CollaborationStatus };
	list_agents: { agents: CollaborationAgentView[] };
}
