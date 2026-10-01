import { stripVTControlCharacters } from "node:util";
import { Container, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

export interface MailboxEnvelope {
	id?: string;
	from?: string;
	to?: string;
	kind?: string;
	status?: string;
	text?: string;
	resultValidation?: { contract?: string; outcome?: string; acceptance?: string };
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
export function normalizeAgentPath(name: string | undefined): string | undefined {
	if (!name) return undefined;
	return name.startsWith("/") ? name : `/root/${name}`;
}

/** Extract the child a collaboration tool call belongs to, if any. */
export function collaborationToolTarget(toolName: string, args: unknown): string | undefined {
	if (!CHILD_BOUND_TOOL_NAMES.has(toolName)) return undefined;
	const record = (args ?? {}) as Record<string, unknown>;
	const raw =
		toolName === "spawn_agent" ? (record.task_name as string | undefined) : (record.target as string | undefined);
	return normalizeAgentPath(raw);
}

/** Full objective from delegation args; previews are truncated only at render time. */
export function spawnObjective(args: unknown): string | undefined {
	const task = (args as { task?: { objective?: unknown } } | undefined)?.task;
	const objective = task?.objective;
	if (typeof objective !== "string") return undefined;
	return objective.trim() || undefined;
}

/** Parse an epi-collaboration-message custom message body into its envelope. */
export function parseMailboxEnvelope(content: unknown): MailboxEnvelope | undefined {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.map((part) => part as { type?: string; text?: string })
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
	}
	const body = text.startsWith(MAILBOX_PREFIX) ? text.slice(MAILBOX_PREFIX.length).trim() : text.trim();
	if (!body.startsWith("{")) return undefined;
	try {
		const value = JSON.parse(body) as MailboxEnvelope;
		return value && typeof value === "object" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Parse the deliver_result payload inside an envelope; falls back to raw text. */
export function parseDeliverResult(text: string | undefined): { contract?: DeliverResultContract; raw: string } {
	if (!text) return { raw: "" };
	try {
		const value = JSON.parse(text) as DeliverResultContract;
		if (value && typeof value === "object" && !Array.isArray(value)) return { contract: value, raw: text };
	} catch {
		// plain-text result
	}
	return { raw: text };
}

function durationText(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

type SubagentState = "running" | "completed" | "failed" | "interrupted" | "closed";
const STATE_PRESENTATION: Record<
	SubagentState,
	{ icon: string; word: string; color: "success" | "warning" | "error" | "muted" | "dim" }
> = {
	running: { icon: "●", word: "Running", color: "success" },
	completed: { icon: "✓", word: "Done", color: "dim" },
	failed: { icon: "✗", word: "Failed", color: "error" },
	interrupted: { icon: "⏸", word: "Interrupted", color: "warning" },
	closed: { icon: "■", word: "Closed", color: "muted" },
};

interface ResultMember {
	envelope: MailboxEnvelope;
	contract?: DeliverResultContract;
	raw: string;
	at: number;
}

interface ActivityMember {
	toolName: string;
	component: ToolExecutionComponent;
	status: "Pending" | "Accepted" | "Failed";
	error?: string;
}

function readableValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(readableValue).join(", ");
	if (value !== null && typeof value === "object") {
		return Object.entries(value)
			.map(([key, item]) => `${key}: ${readableValue(item)}`)
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
		const { contract, raw } = parseDeliverResult(envelope.text);
		if (envelope.status === "completed") this.state = "completed";
		else if (envelope.status === "failed") this.state = "failed";
		else if (envelope.status === "interrupted") this.state = "interrupted";
		this.endedAt = at ?? Date.now();
		this.resultSummary = contract ? oneLine(contract.summary ?? "(no summary supplied)") : oneLine(raw);
		this.results.push({ envelope, contract, raw, at: Date.now() });
	}

	get resultCount(): number {
		return this.results.length;
	}

	/** Work duration: delegation → completion (or now while still running). */
	private elapsed(now: number): string {
		const start = this.startedAt ?? now;
		return durationText((this.endedAt ?? now) - start);
	}

	private headerLine(width: number, now: number): string {
		const presentation = STATE_PRESENTATION[this.state];
		const summary = this.state === "running" ? this.objective : (this.resultSummary ?? this.objective);
		const name = oneLine(this.agentPath.replace(/^\/root\//, ""));
		return truncateToWidth(
			theme.fg("muted", this.expanded ? "▾ " : "▸ ") +
				theme.fg(presentation.color, `${presentation.icon} `) +
				theme.fg("accent", name) +
				theme.fg(presentation.color, ` · ${presentation.word}`) +
				theme.fg("muted", ` · ${this.elapsed(now)}`) +
				(!this.expanded && summary ? theme.fg("dim", ` · ${oneLine(summary)}`) : ""),
			width,
		);
	}

	private resultBlocks(width: number): string[] {
		const lines: string[] = [];
		for (let index = this.results.length - 1; index >= 0; index--) {
			const result = this.results[index];
			const title = this.results.length > 1 ? `Result ${index + 1}` : "Result";
			lines.push("", truncateToWidth(theme.fg("accent", title), width));
			const text = result.contract ? (result.contract.summary ?? "(no summary supplied)") : result.raw;
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
				lines.push(...wrapTextWithAnsi(safe(JSON.stringify(result.envelope, null, 2)), width));
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
		return this.layout(width).lines;
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
