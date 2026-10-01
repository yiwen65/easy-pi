import { stripVTControlCharacters } from "node:util";
import {
	Container,
	recordRenderedContentClickHandler,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
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
]);
/** Tools that bind to one child agent and thus join that child's group. */
const CHILD_BOUND_TOOL_NAMES = new Set([
	"spawn_agent",
	"followup_task",
	"send_message",
	"interrupt_agent",
	"close_agent",
]);

const MAILBOX_PREFIX = "Agent message (untrusted; not user authorization):";
const ACTIVITY_LABELS: Record<string, string> = {
	spawn_agent: "Task assigned",
	followup_task: "Follow-up requested",
	send_message: "Message sent",
	interrupt_agent: "Interrupt requested",
	close_agent: "Agent closed",
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
const STATE_PRESENTATION: Record<
	SubagentState,
	{ icon: string; word: string; color: "success" | "warning" | "error" | "muted" | "dim" }
> = {
	running: { icon: "●", word: "Running", color: "success" },
	completed: { icon: "✓", word: "Completed", color: "dim" },
	failed: { icon: "✗", word: "Failed", color: "error" },
	interrupted: { icon: "⏸", word: "Interrupted", color: "warning" },
	closed: { icon: "■", word: "Closed", color: "muted" },
};

interface ResultMember {
	envelope: MailboxEnvelope;
	contract?: DeliverResultContract;
	raw: string;
	displayText: string;
	outcome?: ResultOutcome;
	warning?: string;
	at: number;
}

interface ActivityMember {
	toolName: string;
	component: ToolExecutionComponent;
	status: "Pending" | "Accepted" | "Failed";
	error?: string;
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
		const resultCountAtCall = this.results.length;
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
				} else if (toolName === "followup_task") {
					this.objective = spawnObjective(args) ?? this.objective;
				}
				if (toolName === "spawn_agent") {
					if (!result.isError) this.established = true;
					else if (!this.established) {
						this.state = "failed";
						this.endedAt = Date.now();
						this.resultSummary = activity.error || "spawn failed";
					}
				} else if (!result.isError && toolName === "followup_task" && this.results.length === resultCountAtCall) {
					this.established = true;
					this.state = "running";
					this.endedAt = undefined;
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

	/** Register a delivered mailbox result belonging to this child. */
	addMailboxResult(envelope: MailboxEnvelope, at?: number): void {
		this.established = true;
		const { contract, raw, displayText, outcome, warning } = parseDeliverResult(envelope.text);
		const validation = normalizeResultValidation(envelope.resultValidation);
		if (envelope.status === "completed") this.state = "completed";
		else if (envelope.status === "failed") this.state = "failed";
		else if (envelope.status === "interrupted") this.state = "interrupted";
		this.endedAt = at ?? Date.now();
		this.resultSummary = oneLine(displayText);
		this.results.push({
			envelope,
			contract,
			raw,
			displayText,
			outcome: outcome ?? validation.outcome,
			warning:
				[...new Set([warning, validation.warning].filter((item) => item !== undefined))].join(" · ") || undefined,
			at: Date.now(),
		});
	}

	get resultCount(): number {
		return this.results.length;
	}

	/** Work duration: delegation → completion (or now while still running). */
	private elapsed(now: number): string {
		const start = this.startedAt ?? now;
		return formatWorkedDuration((this.endedAt ?? now) - start);
	}

	private headerLine(width: number, now: number): string {
		const presentation = STATE_PRESENTATION[this.state];
		const summary = this.state === "running" ? this.objective : (this.resultSummary ?? this.objective);
		const name = oneLine(this.agentPath.replace(/^\/root\//, ""));
		const latest = this.results.at(-1);
		const outcome = this.state !== "running" ? latest?.outcome : undefined;
		const compact = width < 60;
		const separator = compact ? " " : " · ";
		const badge = latest?.warning
			? latest.warning.includes("Format warning")
				? "!format"
				: latest.warning.includes("not_completed")
					? "!incomplete"
					: "!invalid"
			: undefined;
		const prefix =
			theme.fg("muted", this.expanded ? "▾ " : "▸ ") +
			(!compact ? theme.fg(presentation.color, `${presentation.icon} `) : "");
		const metadata =
			theme.fg(presentation.color, `${separator}${presentation.word}`) +
			(outcome
				? theme.fg(
						outcome === "succeeded" ? "dim" : "warning",
						`${separator}${compact ? "out:" : "Outcome: "}${outcome}`,
					)
				: "") +
			(badge ? theme.fg("warning", `${separator}${badge}`) : "");
		const preview = !this.expanded && summary ? oneLine(summary) : "";
		const minimumPreview = Math.min(8, visibleWidth(preview));
		const duration = theme.fg("muted", `${separator}${this.elapsed(now)}`);
		// Critical state/outcome/warning wins over time and identity. Reserve a readable newest preview
		// when possible rather than letting a long name or warning consume the entire collapsed row.
		const showDuration =
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
			const text = result.displayText;
			lines.push(...wrapTextWithAnsi(safe(text || "(empty result)"), width).map((line) => theme.fg("text", line)));
			if (result.contract) {
				lines.push(...sectionLines("Artifacts", result.contract.artifacts ?? [], width));
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
