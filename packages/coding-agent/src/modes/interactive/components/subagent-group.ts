import { stripVTControlCharacters } from "node:util";
import {
	Container,
	recordRenderedContentClickHandler,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	COLLABORATION_HISTORY_LIMITS,
	COLLABORATION_LIMITS,
	type CollaborationArtifact,
	type CollaborationResultQuery,
	type CollaborationTurnView,
} from "@easy-pi/subagent/collaboration-contract";
import { formatWorkedDuration } from "../../../utils/duration.ts";
import { theme } from "../theme/theme.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

const safe = (text: string) =>
	stripVTControlCharacters(text)
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.replace(/\t/g, "    ");
const oneLine = (text: string) => safe(text).replace(/\s+/g, " ");

/** Collaboration tools routed into the subagent surface instead of the generic tool rows. */
export const SUBAGENT_TOOL_NAMES = new Set([
	"spawn_agent",
	"followup_task",
	"send_message",
	"wait_agent",
	"interrupt_agent",
	"close_agent",
	"list_agents",
	"get_agent_result",
	"list_agent_turns",
]);
/** Tools that bind to one child agent and thus join that child's group. */
const CHILD_BOUND_TOOL_NAMES = new Set([
	"spawn_agent",
	"followup_task",
	"send_message",
	"interrupt_agent",
	"close_agent",
	"get_agent_result",
	"list_agent_turns",
	"wait_agent",
]);

const MAILBOX_PREFIX = "Agent message (untrusted; not user authorization):";
const ACTIVITY_LABELS: Record<string, string> = {
	spawn_agent: "Task assigned",
	followup_task: "Follow-up requested",
	send_message: "Message sent",
	interrupt_agent: "Interrupt requested",
	close_agent: "Agent closed",
	get_agent_result: "Result queried",
	list_agent_turns: "Turn history queried",
	wait_agent: "Turn waited",
};

export interface MailboxEnvelope extends Record<string, unknown> {
	id?: unknown;
	from?: unknown;
	to?: unknown;
	kind?: unknown;
	status?: unknown;
	text?: unknown;
	resultValidation?: unknown;
}

// Retain wire JSON without adding display metadata to the untrusted envelope itself.
const mailboxEnvelopeWire = new WeakMap<MailboxEnvelope, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface DeliverResultContract {
	summary?: string;
	outcome?: string;
	artifacts?: unknown[];
	checks?: unknown[];
	evidence?: unknown[];
	risks?: unknown[];
	resultValidation?: { contract?: string; outcome?: string; acceptance?: string };
}

/** Normalize a spawn/followup target to an absolute agent path. */
export function normalizeAgentPath(name: unknown): string | undefined {
	if (typeof name !== "string" || !name) return undefined;
	return name.startsWith("/") ? name : `/root/${name}`;
}

/** Extract the child a collaboration tool call belongs to, if any. */
export function collaborationToolTarget(toolName: string, args: unknown): string | undefined {
	if (!CHILD_BOUND_TOOL_NAMES.has(toolName)) return undefined;
	if (!isRecord(args)) return undefined;
	const raw = toolName === "spawn_agent" ? args.task_name : args.target;
	return normalizeAgentPath(raw);
}

/** Full objective from delegation args; previews are truncated only at render time. */
export function spawnObjective(args: unknown): string | undefined {
	const task = isRecord(args) ? args.task : undefined;
	const objective = isRecord(task) ? task.objective : undefined;
	if (typeof objective !== "string") return undefined;
	return objective.trim() || undefined;
}

/** Parse an epi-collaboration-message custom message body into its envelope. */
export function parseMailboxEnvelope(content: unknown): MailboxEnvelope | undefined {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
			.map((part) => (typeof part.text === "string" ? part.text : ""))
			.join("\n");
	}
	const body = text.startsWith(MAILBOX_PREFIX) ? text.slice(MAILBOX_PREFIX.length) : text;
	if (!body.trim().startsWith("{")) return undefined;
	try {
		const value: unknown = JSON.parse(body);
		if (!isRecord(value)) return undefined;
		mailboxEnvelopeWire.set(value, body);
		return value;
	} catch {
		return undefined;
	}
}

type ResultOutcome = "succeeded" | "partial" | "blocked" | "failed";

function knownOutcome(value: unknown): ResultOutcome | undefined {
	return value === "succeeded" || value === "partial" || value === "blocked" || value === "failed" ? value : undefined;
}

function normalizeResultValidation(value: unknown): { outcome?: ResultOutcome; warning?: string } {
	if (value === undefined) return {};
	if (!isRecord(value)) return { warning: "Format warning: invalid resultValidation" };
	const outcome = knownOutcome(value.outcome);
	if (
		!["valid", "invalid", "not_completed"].includes(typeof value.contract === "string" ? value.contract : "") ||
		("outcome" in value && outcome === undefined) ||
		("acceptance" in value && value.acceptance !== "not_reviewed")
	)
		return { outcome, warning: "Format warning: invalid resultValidation" };
	if (value.contract === "invalid" || value.contract === "not_completed")
		return { outcome, warning: `Validation warning: ${value.contract}` };
	return { outcome };
}

/** Narrow external fields before rendering; keep the original payload for diagnostics. */
export function parseDeliverResult(text: unknown): {
	contract?: DeliverResultContract;
	raw: string;
	displayText: string;
	outcome?: ResultOutcome;
	warning?: string;
} {
	if (text === undefined) return { raw: "", displayText: "" };
	if (typeof text !== "string") {
		let raw: string;
		try {
			raw = JSON.stringify(text) ?? String(text);
		} catch {
			raw = "(invalid result text; not serializable)";
		}
		return { raw, displayText: readableValue(text), warning: "Format warning: invalid result text" };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// Match the controller's tolerated fence/prose wrappers without changing the original text.
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start < 0 || end <= start) return { raw: text, displayText: text };
		try {
			value = JSON.parse(text.slice(start, end + 1));
		} catch {
			return { raw: text, displayText: text }; // plain-text result
		}
	}
	if (!isRecord(value))
		return { raw: text, displayText: readableValue(value), warning: "Format warning: invalid result object" };
	const knownFields = ["summary", "outcome", "artifacts", "checks", "evidence", "risks", "resultValidation"];
	if (!knownFields.some((field) => field in value)) return { raw: text, displayText: readableValue(value) };
	const invalid = ["summary", "outcome"].filter((field) => field in value && typeof value[field] !== "string");
	for (const field of ["artifacts", "checks", "evidence", "risks"]) {
		if (field in value && !Array.isArray(value[field])) invalid.push(field);
	}
	const payloadOutcome = knownOutcome(value.outcome);
	if ("outcome" in value && payloadOutcome === undefined && !invalid.includes("outcome")) invalid.push("outcome");
	const validation = normalizeResultValidation(value.resultValidation);
	const outcome = payloadOutcome ?? validation.outcome;
	if (invalid.length > 0 || validation.warning?.startsWith("Format warning"))
		return {
			raw: text,
			displayText: readableValue(value),
			outcome,
			warning: `Format warning: invalid ${invalid.join(", ") || "resultValidation"}`,
		};
	// All display-bearing fields have been checked; extra fields remain in raw diagnostics only.
	const contract: DeliverResultContract = {};
	if (typeof value.summary === "string") contract.summary = value.summary;
	if (typeof value.outcome === "string") contract.outcome = value.outcome;
	if (Array.isArray(value.artifacts)) contract.artifacts = value.artifacts;
	if (Array.isArray(value.checks)) contract.checks = value.checks;
	if (Array.isArray(value.evidence)) contract.evidence = value.evidence;
	if (Array.isArray(value.risks)) contract.risks = value.risks;
	return {
		contract,
		raw: text,
		displayText: contract.summary ?? "(no summary supplied)",
		outcome,
		warning: validation.warning,
	};
}

type SubagentState = "running" | "completed" | "failed" | "interrupted" | "closed";
const STATE_LABELS: Record<SubagentState, string> = {
	running: "Running",
	completed: "Completed",
	failed: "Ended",
	interrupted: "Interrupted",
	closed: "Closed",
};

function isTerminalStatus(value: unknown): value is "completed" | "failed" | "interrupted" {
	return value === "completed" || value === "failed" || value === "interrupted";
}

interface ResultMember {
	envelope: MailboxEnvelope;
	contract?: DeliverResultContract;
	raw: string;
	displayText: string;
	outcome?: ResultOutcome;
	warning?: string;
	at: number;
	turn?: CollaborationTurnView;
	query?: CollaborationResultQuery;
	mailbox?: boolean;
}

const nullableCounter = (value: unknown) =>
	value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[!-~]{1,128}$/.test(value);

function isTurnView(value: unknown): value is CollaborationTurnView {
	if (!isRecord(value) || !isRecord(value.usage) || !isRecord(value.delivery)) return false;
	const usage = value.usage;
	const delivery = value.delivery;
	const validation = value.resultValidation;
	return (
		identifier(value.turn_id) &&
		typeof value.target === "string" &&
		value.target.startsWith("/root/") &&
		typeof value.task_preview === "string" &&
		Array.from(value.task_preview).length <= COLLABORATION_HISTORY_LIMITS.maxTaskPreviewCharacters &&
		typeof value.task_truncated === "boolean" &&
		typeof value.sequence === "number" &&
		Number.isSafeInteger(value.sequence) &&
		value.sequence > 0 &&
		(value.task_message_id === null || identifier(value.task_message_id)) &&
		(value.result_message_id === null || identifier(value.result_message_id)) &&
		typeof value.status === "string" &&
		["pending", "running", "completed", "failed", "interrupted", "unknown"].includes(value.status) &&
		(value.history_coverage === "complete" || value.history_coverage === "retained_only") &&
		(usage.coverage === "complete" || usage.coverage === "partial" || usage.coverage === "unknown") &&
		typeof delivery.state === "string" &&
		["not_enqueued", "enqueued", "acknowledged", "unknown"].includes(delivery.state) &&
		nullableCounter(delivery.enqueued_at) &&
		nullableCounter(delivery.acknowledged_at) &&
		["input", "output", "cacheRead", "cacheWrite"].every((key) => nullableCounter(usage[key])) &&
		["admitted_at", "started_at", "finished_at"].every((key) => nullableCounter(value[key])) &&
		(validation === undefined ||
			(isRecord(validation) &&
				typeof validation.contract === "string" &&
				["valid", "invalid", "not_completed"].includes(validation.contract) &&
				(validation.outcome === undefined || knownOutcome(validation.outcome) !== undefined) &&
				(validation.acceptance === undefined || validation.acceptance === "not_reviewed")))
	);
}

function isArtifact(value: unknown): value is CollaborationArtifact {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		value.path.trim().length > 0 &&
		Array.from(value.path).length <= 2048 &&
		!value.path.includes("\0") &&
		typeof value.purpose === "string" &&
		value.purpose.trim().length > 0 &&
		Array.from(value.purpose).length <= 256 &&
		!value.purpose.includes("\0") &&
		(value.sha256 === undefined || (typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)))
	);
}

/** Reject malformed retained receipts before storing display-bearing metadata. Raw stays in Diagnostics. */
function retainedQuery(value: unknown): CollaborationResultQuery | undefined {
	if (!isRecord(value)) return undefined;
	if (value.state === "history_unavailable")
		return typeof value.target === "string" && value.history_coverage === "retained_only"
			? { state: value.state, target: value.target, history_coverage: value.history_coverage }
			: undefined;
	if (!isTurnView(value.turn)) return undefined;
	if (value.state === "pending" || value.state === "no_result") return { state: value.state, turn: value.turn };
	if (
		value.state !== "found" ||
		!isRecord(value.result) ||
		typeof value.result.preview !== "string" ||
		Buffer.byteLength(value.result.preview) > COLLABORATION_LIMITS.maxMessageBytes ||
		!(value.result.truncated === null || typeof value.result.truncated === "boolean") ||
		!isRecord(value.result.source)
	)
		return undefined;
	const source = value.result.source;
	const artifacts = value.result.artifacts;
	if (
		artifacts !== undefined &&
		(!Array.isArray(artifacts) ||
			artifacts.length > COLLABORATION_HISTORY_LIMITS.maxArtifacts ||
			!artifacts.every(isArtifact))
	)
		return undefined;
	if (
		(source.kind !== "native_history" && source.kind !== "unavailable") ||
		source.turn_id !== value.turn.turn_id ||
		(source.coverage !== "entry" && source.coverage !== "turn" && source.coverage !== "unknown") ||
		(source.session_path !== undefined &&
			(typeof source.session_path !== "string" ||
				Buffer.byteLength(source.session_path) > COLLABORATION_HISTORY_LIMITS.maxTurnMetadataBytes)) ||
		(source.entry_id !== undefined && !identifier(source.entry_id))
	)
		return undefined;
	return {
		state: "found",
		turn: value.turn,
		result: {
			preview: value.result.preview,
			truncated: value.result.truncated,
			...(Array.isArray(artifacts) && artifacts.every(isArtifact) ? { artifacts } : {}),
			source: {
				kind: source.kind,
				turn_id: value.turn.turn_id,
				coverage: source.coverage,
				...(typeof source.session_path === "string" ? { session_path: source.session_path } : {}),
				...(typeof source.entry_id === "string" ? { entry_id: source.entry_id } : {}),
			},
		},
	};
}

/** Report only provider counters and proven timestamp ranges; never infer costs or context. */
export function turnMetadata(turn: CollaborationTurnView): string[] {
	const usage = turn.usage;
	const duration =
		turn.started_at !== null && turn.finished_at !== null
			? formatWorkedDuration(Math.max(0, turn.finished_at - turn.started_at))
			: "unknown";
	return [
		`Turn: ${turn.turn_id} · sequence ${turn.sequence} · state ${turn.status}`,
		`Task message: ${turn.task_message_id ?? "unknown"} · Result message: ${turn.result_message_id ?? "unknown"}`,
		`Format: ${turn.resultValidation?.contract ?? "unknown"} · Outcome: ${turn.resultValidation?.outcome ?? "unknown"} · Delivery: ${turn.delivery.state} (not acceptance)`,
		`Duration: ${duration} · Usage: ${usage.coverage} · input ${usage.input ?? "unknown"} / output ${usage.output ?? "unknown"} / cache read ${usage.cacheRead ?? "unknown"} / write ${usage.cacheWrite ?? "unknown"}`,
	];
}

export function resultQueryText(query: CollaborationResultQuery): string {
	if (query.state === "history_unavailable") return "Retained turn history unavailable (retained_only)";
	const lines = [
		...turnMetadata(query.turn),
		`Task preview${query.turn.task_truncated ? " (truncated)" : ""}: ${query.turn.task_preview || "unknown"}`,
	];
	if (query.state === "found") {
		const parsed = parseDeliverResult(query.result.preview);
		lines.unshift(parsed.displayText);
		lines.splice(
			1,
			0,
			`Source: ${query.result.source.kind} · ${query.result.source.session_path ?? "unavailable"} · turn ${query.result.source.turn_id} · entry ${query.result.source.entry_id ?? "unknown"} (${query.result.source.coverage})`,
		);
		lines.push(
			`Result preview: ${query.result.truncated === null ? "completeness unknown" : query.result.truncated ? "truncated" : "complete"}`,
		);
		for (const artifact of query.result.artifacts ?? parsed.contract?.artifacts ?? []) {
			lines.push(
				isArtifact(artifact)
					? `Artifact ref: ${artifact.path} · ${artifact.purpose} · hash claim: ${artifact.sha256 ?? "unknown"} (no auto-read or acceptance)`
					: `Artifact ref (legacy; untrusted): ${readableValue(artifact)}`,
			);
		}
	} else lines.unshift(`Result: ${query.state}`);
	return lines.join("\n");
}

interface ActivityMember {
	toolName: string;
	component: ToolExecutionComponent;
	status: "Pending" | "Accepted" | "Failed";
	error?: string;
	queryText?: string;
}

function readableValue(value: unknown, depth = 0): string {
	if (typeof value === "string") return value;
	if (value !== null && typeof value === "object") {
		// Display normalization must not recurse through arbitrary external JSON depth.
		// Original payloads stay intact in Diagnostics; shallow structured fields remain readable.
		if (depth >= 8) return "(nested data; open Diagnostics)";
		if (Array.isArray(value)) return value.map((item) => readableValue(item, depth + 1)).join(", ");
		return Object.entries(value)
			.map(([key, item]) => `${key}: ${readableValue(item, depth + 1)}`)
			.join(" · ");
	}
	return String(value);
}

function sectionLines(title: string, items: unknown[], width: number): string[] {
	if (!items || items.length === 0) return [];
	const lines = [truncateToWidth(theme.fg("muted", `${title}:`), width)];
	for (const item of items) {
		const text = readableValue(item);
		lines.push(...wrapTextWithAnsi(`  • ${safe(text)}`, width).map((line) => theme.fg("dim", line)));
	}
	return lines;
}

/**
 * One collapsible transcript block per child agent: the spawn/followup/message/interrupt/close
 * calls and the delivered results of a single child, grouped under a scannable header.
 * Collapsed: short name, state, elapsed time, and latest preview. Expanded: full task and
 * results first; human-readable activity and raw diagnostics are separate opt-in sections.
 * Click the header row (or ctrl+o) to toggle the card. Display-only: the block never affects
 * the underlying session or team state.
 */
export class SubagentGroupComponent extends Container {
	private expanded = false;
	private activityExpanded = false;
	private diagnosticsExpanded = false;
	private diagnosticTool: ToolExecutionComponent | undefined;
	private readonly activities: ActivityMember[] = [];
	private state: SubagentState = "running";
	private objective: string | undefined;
	private resultSummary: string | undefined;
	/** A successful child admission or result means a same-name spawn cannot replace this group. */
	private established = false;
	/** Delegation time (spawn); injected from the persisted message timestamp when rebuilt from history. */
	private startedAt: number | undefined;
	/** Terminal time (result delivered, interrupted, or closed). */
	private endedAt: number | undefined;
	private readonly results: ResultMember[] = [];
	private latestTurnId: string | undefined;
	readonly agentPath: string;

	constructor(agentPath: string) {
		super();
		this.agentPath = agentPath;
	}

	/** Register a collaboration tool execution belonging to this child. */
	addTool(toolName: string, component: ToolExecutionComponent, args: unknown, at?: number): void {
		if (toolName === "spawn_agent" && !this.established) {
			this.objective ??= spawnObjective(args);
			this.startedAt = at ?? Date.now();
			this.state = "running";
			this.endedAt = undefined;
		}
		// Tool calls are pending until a final result; failed controls must not change the child's state.
		const activity: ActivityMember = { toolName, component, status: "Pending" };
		this.activities.push(activity);
		const resultCountAtCall = this.results.filter(
			(item) => item.mailbox && isTerminalStatus(item.envelope.status),
		).length;
		type UpdateResult = ToolExecutionComponent["updateResult"];
		const original = component.updateResult.bind(component) as UpdateResult;
		component.updateResult = ((result: Parameters<UpdateResult>[0], isPartial?: boolean) => {
			if (!isPartial) {
				activity.status = result.isError ? "Failed" : "Accepted";
				if (result.isError) {
					const text = result.content.map((part) => part.text ?? "").join(" ");
					try {
						activity.error = oneLine(readableValue(JSON.parse(text)));
					} catch {
						activity.error = oneLine(text);
					}
				} else if (["get_agent_result", "list_agent_turns", "wait_agent"].includes(toolName)) {
					activity.queryText = "Retained query response unavailable";
					try {
						const value: unknown = JSON.parse(result.content.find((part) => part.type === "text")?.text ?? "");
						if (isRecord(value)) {
							const query = toolName === "wait_agent" ? value.result : value;
							const retained = retainedQuery(query);
							if (
								retained &&
								(retained.state === "history_unavailable" ? retained.target : retained.turn.target) ===
									this.agentPath
							) {
								if (retained.state === "found") {
									this.addQueriedResult(retained);
									activity.queryText = undefined;
								} else activity.queryText = resultQueryText(retained);
							} else if (
								toolName === "list_agent_turns" &&
								value.target === this.agentPath &&
								Array.isArray(value.turns) &&
								value.turns.length <= COLLABORATION_HISTORY_LIMITS.maxPageSize &&
								value.turns.every((turn) => isTurnView(turn) && turn.target === this.agentPath) &&
								(value.history_coverage === "complete" || value.history_coverage === "retained_only") &&
								(value.next_cursor === null || typeof value.next_cursor === "string")
							) {
								activity.queryText = `History: ${value.history_coverage} · page only · ${value.next_cursor ? "more pages available" : "traversal exhausted"}\n${(value.turns as CollaborationTurnView[]).flatMap((turn) => [...turnMetadata(turn), `Task preview${turn.task_truncated ? " (truncated)" : ""}: ${turn.task_preview || "unknown"}`]).join("\n")}\nResult body/source: query the selected turn with get_agent_result`;
							} else
								activity.queryText =
									toolName === "wait_agent"
										? `Wait: ${typeof value.reason === "string" ? value.reason : "unknown"} · Turn: ${typeof value.turn_id === "string" ? value.turn_id : "unknown"}`
										: "Retained query response unavailable";
						}
					} catch {
						activity.queryText = "Retained query response unavailable";
					}
				} else if (toolName === "followup_task") {
					this.objective = spawnObjective(args) ?? this.objective;
					this.startedAt = at ?? Date.now();
				}
				let receiptTurnId: string | undefined;
				if (!result.isError && (toolName === "spawn_agent" || toolName === "followup_task")) {
					try {
						const receipt: unknown = JSON.parse(result.content.find((part) => part.type === "text")?.text ?? "");
						if (isRecord(receipt) && typeof receipt.turn_id === "string") {
							receiptTurnId = receipt.turn_id;
							this.latestTurnId = receipt.turn_id;
						}
					} catch {
						/* Legacy receipts have no turn identity. */
					}
				}
				if (toolName === "spawn_agent") {
					if (!result.isError) this.established = true;
					else if (!this.established) {
						this.state = "failed";
						this.endedAt = Date.now();
						this.resultSummary = activity.error || "spawn failed";
					}
				} else if (!result.isError && toolName === "followup_task") {
					this.established = true;
					const delivered = receiptTurnId
						? this.results.find((item) => item.mailbox && item.envelope.turnId === receiptTurnId)
						: undefined;
					const deliveredStatus = delivered?.envelope.status;
					if (delivered && isTerminalStatus(deliveredStatus)) {
						this.state = deliveredStatus;
						this.endedAt = delivered.at;
						this.resultSummary = oneLine(delivered.displayText);
						this.results.splice(this.results.indexOf(delivered), 1);
						this.results.push(delivered);
					} else if (
						receiptTurnId ||
						this.results.filter((item) => item.mailbox && isTerminalStatus(item.envelope.status)).length ===
							resultCountAtCall
					) {
						this.state = "running";
						this.endedAt = undefined;
					}
				} else if (!result.isError && toolName === "close_agent") {
					this.established = true;
					this.state = "closed";
					this.endedAt = at ?? Date.now();
				} else if (!result.isError && toolName === "interrupt_agent") {
					this.established = true;
					// A successful interrupt can be a no-op for an already settled child.
					let previousStatus = (result.details as { previous_status?: unknown } | undefined)?.previous_status;
					if (typeof previousStatus !== "string") {
						try {
							const parsed = JSON.parse(result.content.find((part) => part.type === "text")?.text ?? "") as {
								previous_status?: unknown;
							};
							previousStatus = parsed.previous_status;
						} catch {
							// Keep the last known state if the result has no status.
						}
					}
					if (previousStatus === "running" || previousStatus === "pending") this.state = "interrupted";
					else if (
						previousStatus === "completed" ||
						previousStatus === "failed" ||
						previousStatus === "interrupted" ||
						previousStatus === "closed"
					)
						this.state = previousStatus;
					if (this.state !== "running") this.endedAt = at ?? Date.now();
				}
			}
			return original(result, isPartial as never);
		}) as ToolExecutionComponent["updateResult"];
		this.addChild(component);
		component.setExpanded(false);
	}

	private addQueriedResult(query: Extract<CollaborationResultQuery, { state: "found" }>): void {
		const turn = query.turn;
		const existing = this.results.find(
			(item) => item.envelope.turnId === turn.turn_id && item.envelope.id === turn.result_message_id,
		);
		if (existing) {
			existing.turn = turn;
			existing.query = query;
			return;
		}
		const parsed = parseDeliverResult(query.result.preview);
		this.results.unshift({
			...parsed,
			envelope: { id: turn.result_message_id, turnId: turn.turn_id, text: query.result.preview },
			at: turn.finished_at ?? 0,
			turn,
			query,
		});
		// Explicit reads never change the live child's task/status/preview, even for an old terminal turn.
	}

	/** Register a delivered mailbox result belonging to this child. */
	addMailboxResult(envelope: MailboxEnvelope, at?: number): void {
		const duplicate = this.results.find(
			(item) =>
				typeof envelope.id === "string" &&
				item.envelope.id === envelope.id &&
				item.envelope.turnId === envelope.turnId,
		);
		if (duplicate?.mailbox) return;
		if (duplicate) this.results.splice(this.results.indexOf(duplicate), 1);
		this.established = true;
		const { contract, raw, displayText, outcome, warning } = parseDeliverResult(envelope.text);
		const validation = normalizeResultValidation(envelope.resultValidation);
		const latest = !this.latestTurnId || envelope.turnId === this.latestTurnId;
		if (latest && envelope.status === "completed") this.state = "completed";
		else if (latest && envelope.status === "failed") this.state = "failed";
		else if (latest && envelope.status === "interrupted") this.state = "interrupted";
		const terminalStatus = isTerminalStatus(envelope.status);
		if (latest && terminalStatus) {
			this.endedAt = at ?? Date.now();
			this.resultSummary = oneLine(displayText);
		}
		const member: ResultMember = {
			envelope,
			contract,
			raw,
			displayText,
			outcome: outcome ?? validation.outcome,
			warning:
				[
					...new Set(
						[
							warning,
							validation.warning,
							envelope.status !== undefined && !terminalStatus ? "Format warning: invalid status" : undefined,
						].filter((item) => item !== undefined),
					),
				].join(" · ") || undefined,
			at: at ?? Date.now(),
			mailbox: true,
			turn: duplicate?.turn,
			query: duplicate?.query,
		};
		if (latest) this.results.push(member);
		else this.results.unshift(member);
	}

	get resultCount(): number {
		return this.results.length;
	}

	/** Work duration: delegation → completion (or now while still running). */
	private elapsed(now: number): string {
		const turn = (
			this.latestTurnId
				? this.results.find((item) => item.envelope.turnId === this.latestTurnId)
				: this.results.at(-1)
		)?.turn;
		if (turn)
			return turn.started_at !== null && turn.finished_at !== null
				? formatWorkedDuration(Math.max(0, turn.finished_at - turn.started_at))
				: "unknown";
		if (this.startedAt === undefined) return "unknown";
		return formatWorkedDuration((this.endedAt ?? now) - this.startedAt);
	}

	private headerLine(width: number, now: number): string {
		const queryOnly =
			!this.established &&
			this.activities.length > 0 &&
			this.activities.every((item) =>
				["get_agent_result", "list_agent_turns", "wait_agent"].includes(item.toolName),
			);
		const stateLabel = queryOnly ? "State unknown" : STATE_LABELS[this.state];
		const summary =
			queryOnly && this.results[0]
				? `Read: ${this.results[0].displayText}`
				: this.state === "running"
					? this.objective
					: (this.resultSummary ?? this.objective);
		const name = oneLine(this.agentPath.replace(/^\/root\//, ""));
		const latest = this.latestTurnId
			? this.results.find((item) => item.envelope.turnId === this.latestTurnId && item.mailbox)
			: this.results.at(-1);
		const outcome =
			this.state !== "running" && latest?.outcome !== "succeeded" && latest?.outcome !== "failed"
				? latest?.outcome
				: undefined;
		const compact = width < 60;
		const separator = compact ? " " : " · ";
		const badge = latest?.warning
			? latest.warning.includes("Format warning")
				? "!format"
				: latest.warning.includes("not_completed")
					? "!incomplete"
					: "!invalid"
			: undefined;
		const prefix = theme.fg("success", "↳ ");
		const metadata =
			theme.fg("muted", `${separator}${stateLabel}`) +
			(outcome ? theme.fg("warning", `${separator}${outcome}`) : "") +
			(badge ? theme.fg("warning", `${separator}${badge}`) : "");
		const preview = !this.expanded && summary ? oneLine(summary) : "";
		const minimumPreview = Math.min(8, visibleWidth(preview));
		const elapsed = this.elapsed(now);
		const duration = elapsed === "unknown" ? "" : theme.fg("muted", `${separator}${elapsed}`);
		// Critical state/outcome/warning wins over time and identity. Reserve a readable newest preview
		// when possible rather than letting a long name or warning consume the entire collapsed row.
		const showDuration =
			duration.length > 0 &&
			visibleWidth(prefix + metadata + duration) + 1 + (preview ? separator.length + minimumPreview : 0) <= width;
		const available = Math.max(0, width - visibleWidth(prefix + metadata + (showDuration ? duration : "")));
		const previewReserve =
			preview && available >= 1 + separator.length + minimumPreview
				? Math.min(20, visibleWidth(preview), available - 1 - separator.length)
				: 0;
		const nameWidth = Math.min(
			visibleWidth(name),
			Math.max(0, available - (previewReserve ? separator.length + previewReserve : 0)),
		);
		const previewWidth = Math.max(0, available - nameWidth - separator.length);
		return truncateToWidth(
			prefix +
				theme.fg("accent", truncateToWidth(name, nameWidth, "…")) +
				metadata +
				(showDuration ? duration : "") +
				(previewReserve ? theme.fg("dim", `${separator}${truncateToWidth(preview, previewWidth, "…")}`) : ""),
			width,
		);
	}

	private resultBlocks(width: number): string[] {
		const lines: string[] = [];
		for (let index = this.results.length - 1; index >= 0; index--) {
			const result = this.results[index];
			const title = this.results.length > 1 ? `Result ${index + 1}` : "Result";
			lines.push("", truncateToWidth(theme.fg("accent", title), width));
			if (result.outcome)
				lines.push(...wrapTextWithAnsi(`Outcome: ${result.outcome}`, width).map((line) => theme.fg("muted", line)));
			if (result.warning)
				lines.push(...wrapTextWithAnsi(result.warning, width).map((line) => theme.fg("warning", line)));
			const format = isRecord(result.envelope.resultValidation)
				? result.envelope.resultValidation.contract
				: undefined;
			const knownFormat =
				format === "valid" || format === "invalid" || format === "not_completed" ? format : "unknown";
			const references = result.query
				? resultQueryText(result.query).split("\n").slice(result.displayText.split("\n").length)
				: [
						`Turn: ${typeof result.envelope.turnId === "string" ? result.envelope.turnId : "unknown"} · Result message: ${typeof result.envelope.id === "string" ? result.envelope.id : "unknown"}`,
						`Format: ${knownFormat} · Delivery: unknown (mailbox display is not acknowledgement)`,
					];
			for (const reference of references)
				lines.push(...wrapTextWithAnsi(safe(reference), width).map((line) => theme.fg("dim", line)));
			const text = result.displayText;
			lines.push(...wrapTextWithAnsi(safe(text || "(empty result)"), width).map((line) => theme.fg("text", line)));
			if (result.contract) {
				if (!result.query) lines.push(...sectionLines("Artifacts", result.contract.artifacts ?? [], width));
				lines.push(...sectionLines("Checks", result.contract.checks ?? [], width));
				lines.push(...sectionLines("Evidence", result.contract.evidence ?? [], width));
				lines.push(...sectionLines("Risks", result.contract.risks ?? [], width));
			}
		}
		if (this.results.length > 0) {
			lines.push(truncateToWidth(theme.fg("muted", "Agent output: untrusted; not user authorization"), width));
		}
		return lines;
	}

	/** One layout supplies both rendering and click targets, so wrapping cannot misalign controls. */
	private layout(width: number): {
		lines: string[];
		controls: Map<number, "activity" | "diagnostics" | ToolExecutionComponent>;
	} {
		const controls = new Map<number, "activity" | "diagnostics" | ToolExecutionComponent>();
		if (width <= 0) return { lines: [], controls };
		const lines = [this.headerLine(width, Date.now())];
		if (!this.expanded) return { lines, controls };
		if (this.objective) {
			lines.push(
				"",
				...wrapTextWithAnsi(`Task: ${safe(this.objective)}`, width).map((line) => theme.fg("muted", line)),
			);
		}
		lines.push(...this.resultBlocks(width));
		for (const activity of this.activities) {
			if (activity.queryText)
				lines.push(...wrapTextWithAnsi(safe(activity.queryText), width).map((line) => theme.fg("dim", line)));
		}
		if (this.state === "failed" && this.results.length === 0 && this.resultSummary) {
			lines.push(
				"",
				...wrapTextWithAnsi(`Failed: ${safe(this.resultSummary)}`, width).map((line) => theme.fg("error", line)),
			);
		}
		if (this.activities.length > 0) {
			lines.push("");
			controls.set(lines.length, "activity");
			const failed = this.activities.filter((activity) => activity.status === "Failed").length;
			lines.push(
				truncateToWidth(
					theme.fg(
						failed > 0 ? "warning" : "muted",
						`${this.activityExpanded ? "▾" : "▸"} Activity · ${this.activities.length} operations${failed > 0 ? ` · ${failed} failed` : ""}`,
					),
					width,
				),
			);
			if (this.activityExpanded) {
				for (const activity of this.activities) {
					const label = ACTIVITY_LABELS[activity.toolName] ?? activity.toolName;
					const color = activity.status === "Failed" ? "error" : "muted";
					lines.push(
						...wrapTextWithAnsi(`  ${label} · ${activity.status}`, width).map((line) => theme.fg(color, line)),
					);
					if (activity.error)
						lines.push(...wrapTextWithAnsi(safe(activity.error), width).map((line) => theme.fg("error", line)));
				}
			}
		}
		lines.push("");
		controls.set(lines.length, "diagnostics");
		lines.push(truncateToWidth(theme.fg("dim", `${this.diagnosticsExpanded ? "▾" : "▸"} Diagnostics`), width));
		if (this.diagnosticsExpanded) {
			lines.push(...wrapTextWithAnsi(`Agent: ${safe(this.agentPath)}`, width));
			if (this.activities.length > 0) {
				lines.push(truncateToWidth(theme.fg("muted", "Tool receipts"), width));
				for (const activity of this.activities) {
					controls.set(lines.length, activity.component);
					const open = this.diagnosticTool === activity.component;
					lines.push(
						truncateToWidth(
							theme.fg("dim", `  ${open ? "▾" : "▸"} ${activity.toolName} · ${activity.status}`),
							width,
						),
					);
					if (open) lines.push(...activity.component.render(width));
				}
			}
			if (this.results.length > 0) lines.push(truncateToWidth(theme.fg("muted", "Result envelopes"), width));
			for (const result of this.results) {
				let diagnostic: string;
				try {
					diagnostic = JSON.stringify(result.envelope, null, 2);
				} catch {
					// Deep JSON can exceed stringify's stack even though the original wire was valid.
					diagnostic =
						mailboxEnvelopeWire.get(result.envelope) ??
						"(Format warning: result envelope not serializable; original JSON unavailable)";
				}
				lines.push(...wrapTextWithAnsi(safe(diagnostic), width));
			}
		}
		return { lines, controls };
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (!expanded) {
			this.activityExpanded = false;
			this.diagnosticsExpanded = false;
			this.diagnosticTool?.setExpanded(false);
			this.diagnosticTool = undefined;
		}
	}

	/** Header toggles the card; secondary sections require their own explicit clicks. */
	handleOverviewClick(localRow: number, width: number): boolean {
		if (width <= 0 || localRow < 0) return false;
		if (localRow === 0) {
			this.setExpanded(!this.expanded);
			return true;
		}
		const target = this.layout(width).controls.get(localRow);
		if (!target) return false;
		if (target === "activity") this.activityExpanded = !this.activityExpanded;
		else if (target === "diagnostics") this.diagnosticsExpanded = !this.diagnosticsExpanded;
		else {
			const open = this.diagnosticTool !== target;
			this.diagnosticTool?.setExpanded(false);
			this.diagnosticTool = open ? target : undefined;
			target.setExpanded(open);
		}
		return true;
	}

	override render(width: number): string[] {
		const { lines, controls } = this.layout(width);
		const expanded = this.expanded;
		const activityExpanded = this.activityExpanded;
		const diagnosticsExpanded = this.diagnosticsExpanded;
		const diagnosticTool = this.diagnosticTool;
		const rowCount = lines.length;
		recordRenderedContentClickHandler(this, lines, (localRow) => {
			if (localRow < 0 || localRow >= rowCount || this.expanded !== expanded) return false;
			if (localRow === 0) {
				this.setExpanded(!expanded);
				return true;
			}
			const target = controls.get(localRow);
			if (!target) return false;
			if (target === "activity") this.activityExpanded = !activityExpanded;
			else if (target === "diagnostics") this.diagnosticsExpanded = !diagnosticsExpanded;
			else {
				if (
					this.diagnosticsExpanded !== diagnosticsExpanded ||
					!this.activities.some((activity) => activity.component === target) ||
					!this.children.includes(target)
				)
					return false;
				const open = diagnosticTool !== target;
				this.diagnosticTool?.setExpanded(false);
				this.diagnosticTool = open ? target : undefined;
				target.setExpanded(open);
			}
			return true;
		});
		return lines;
	}
}

/** Route decisions and group lifecycle for subagent transcript display. */
export class SubagentTranscriptRouter {
	private readonly groups = new Map<string, SubagentGroupComponent>();
	private readonly container: Container;
	private readonly getExpanded: () => boolean;

	constructor(container: Container, getExpanded: () => boolean) {
		this.container = container;
		this.getExpanded = getExpanded;
	}

	clear(): void {
		this.groups.clear();
	}

	groupFor(path: string): SubagentGroupComponent {
		let group = this.groups.get(path);
		if (!group) {
			group = new SubagentGroupComponent(path);
			group.setExpanded(this.getExpanded());
			this.groups.set(path, group);
			this.container.addChild(group);
		} else if (this.container.children.at(-1) !== group) {
			// Keep the live group at the latest chronological position, like the turn tool group.
			this.container.removeChild(group);
			this.container.addChild(group);
		}
		return group;
	}

	/** Collaboration tool executions join their child's group. Returns true when routed. */
	handleTool(toolName: string, args: unknown, component: ToolExecutionComponent, at?: number): boolean {
		if (!SUBAGENT_TOOL_NAMES.has(toolName)) return false;
		const target = collaborationToolTarget(toolName, args);
		if (!target) return false;
		this.groupFor(target).addTool(toolName, component, args, at);
		return true;
	}

	/** Mailbox results join the sender child's group. Returns true when routed. */
	handleMailboxMessage(message: {
		customType?: string;
		display?: boolean;
		content: unknown;
		timestamp?: number;
	}): boolean {
		if (message.customType !== "epi-collaboration-message" || message.display === false) return false;
		const envelope = parseMailboxEnvelope(message.content);
		const path = normalizeAgentPath(envelope?.from);
		if (!envelope || !path) return false;
		this.groupFor(path).addMailboxResult(envelope, message.timestamp);
		return true;
	}

	/** Test/introspection access to current groups in creation order. */
	currentGroups(): SubagentGroupComponent[] {
		return [...this.groups.values()];
	}
}
