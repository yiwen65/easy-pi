import { stripVTControlCharacters } from "node:util";
import { Container, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

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
const MAX_SECTION_ITEMS = 8;
const MAX_SECTION_LINES = 30;

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

/** Spawn objective preview from delegation args (first line of task.objective). */
export function spawnObjective(args: unknown): string | undefined {
	const delegation = (args as Record<string, unknown> | undefined)?.delegation as
		| { task?: { objective?: string } }
		| undefined;
	const objective = delegation?.task?.objective;
	if (!objective) return undefined;
	const line = objective.split("\n", 1)[0].trim();
	return line.length > 96 ? `${line.slice(0, 93)}...` : line || undefined;
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

function sectionLines(title: string, items: unknown[], width: number): string[] {
	if (!items || items.length === 0) return [];
	const lines = [truncateToWidth(theme.fg("muted", `${title}:`), width)];
	const shown = items.slice(0, MAX_SECTION_ITEMS);
	for (const item of shown) {
		const text = oneLine(typeof item === "string" ? item : JSON.stringify(item));
		lines.push(...wrapTextWithAnsi(`  • ${safe(text)}`, width).map((line) => theme.fg("dim", line)));
	}
	if (items.length > shown.length) {
		lines.push(truncateToWidth(theme.fg("muted", `  … +${items.length - shown.length} more`), width));
	}
	return lines.slice(0, MAX_SECTION_LINES + 1);
}

/**
 * One collapsible transcript block per child agent: the spawn/followup/message/interrupt/close
 * calls and the delivered results of a single child, grouped under a scannable header.
 * Collapsed: one header line with state, elapsed time, and a one-line summary. Expanded:
 * objective, activity, and deliver_result contract partitions. Click the header row (or ctrl+o)
 * to toggle. Display-only: the block never affects the underlying session or team state.
 */
export class SubagentGroupComponent extends Container {
	private expanded = false;
	private state: SubagentState = "running";
	private objective: string | undefined;
	private resultSummary: string | undefined;
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
		if (toolName === "spawn_agent") {
			this.objective ??= spawnObjective(args);
			this.startedAt = at ?? Date.now();
			this.state = "running";
			this.endedAt = undefined;
		} else if (toolName === "interrupt_agent") {
			this.state = "interrupted";
			this.endedAt = at ?? Date.now();
		} else if (toolName === "close_agent") {
			this.state = "closed";
			this.endedAt = at ?? Date.now();
		} else if (toolName === "followup_task") {
			if (this.state !== "running") {
				this.state = "running";
				this.endedAt = undefined;
			}
		}
		// A rejected spawn never creates a child: reflect the tool failure instead of hanging at Running.
		if (toolName === "spawn_agent") {
			type UpdateResult = ToolExecutionComponent["updateResult"];
			const original = component.updateResult.bind(component) as UpdateResult;
			component.updateResult = ((result: Parameters<UpdateResult>[0], isPartial?: boolean) => {
				if (!isPartial && result.isError) {
					this.state = "failed";
					this.endedAt = Date.now();
					const text = (result.content ?? []).map((part) => part.text ?? "").join(" ");
					this.resultSummary = oneLine(text).slice(0, 96) || "spawn failed";
				}
				return original(result, isPartial as never);
			}) as ToolExecutionComponent["updateResult"];
		}
		this.addChild(component);
		component.setExpanded(this.expanded);
	}

	/** Register a delivered mailbox result belonging to this child. */
	addMailboxResult(envelope: MailboxEnvelope, at?: number): void {
		const { contract, raw } = parseDeliverResult(envelope.text);
		if (envelope.status === "completed") this.state = "completed";
		else if (envelope.status === "failed") this.state = "failed";
		else if (envelope.status === "interrupted") this.state = "interrupted";
		this.endedAt = at ?? Date.now();
		this.resultSummary = contract?.summary ? oneLine(contract.summary) : oneLine(raw);
		if (this.resultSummary.length > 96) this.resultSummary = `${this.resultSummary.slice(0, 93)}...`;
		this.results.push({ envelope, contract, raw, at: Date.now() });
	}

	get resultCount(): number {
		return this.results.length;
	}

	private members(): ToolExecutionComponent[] {
		return this.children.filter((child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent);
	}

	/** Work duration: delegation → completion (or now while still running). */
	private elapsed(now: number): string {
		const start = this.startedAt ?? now;
		return durationText((this.endedAt ?? now) - start);
	}

	private headerLines(width: number, now: number): string[] {
		const presentation = STATE_PRESENTATION[this.state];
		const summary = this.state === "running" ? this.objective : (this.resultSummary ?? this.objective);
		const line = truncateToWidth(
			theme.fg(presentation.color, `${presentation.icon} `) +
				theme.fg("accent", this.agentPath) +
				theme.fg(presentation.color, ` · ${presentation.word}`) +
				theme.fg("muted", ` · ${this.elapsed(now)}`) +
				(summary ? theme.fg("dim", ` · ${oneLine(summary)}`) : ""),
			width,
		);
		const lines = [line];
		if (this.expanded && this.objective) {
			lines.push(truncateToWidth(theme.fg("muted", `Task: ${oneLine(this.objective)}`), width));
		}
		return lines;
	}

	private resultBlocks(width: number): string[] {
		const lines: string[] = [];
		for (const [index, result] of this.results.entries()) {
			const validation = result.envelope.resultValidation;
			const status = result.envelope.status ?? "completed";
			const meta = [
				`result${this.results.length > 1 ? ` ${index + 1}` : ""}`,
				status,
				validation?.contract ? `contract: ${validation.contract}` : undefined,
				validation?.outcome ? `outcome: ${validation.outcome}` : undefined,
			]
				.filter(Boolean)
				.join(" · ");
			lines.push(
				truncateToWidth(
					theme.fg("dim", `── ${meta} ${"─".repeat(Math.max(2, width - visibleWidth(meta) - 5))}`),
					width,
				),
			);
			if (result.contract) {
				if (result.contract.summary) {
					const wrapped = wrapTextWithAnsi(safe(result.contract.summary), width).slice(0, MAX_SECTION_LINES);
					lines.push(...wrapped.map((line) => theme.fg("text", line)));
				}
				lines.push(...sectionLines("artifacts", result.contract.artifacts ?? [], width));
				lines.push(...sectionLines("checks", result.contract.checks ?? [], width));
				lines.push(...sectionLines("evidence", result.contract.evidence ?? [], width));
				lines.push(...sectionLines("risks", result.contract.risks ?? [], width));
			} else {
				const wrapped = wrapTextWithAnsi(safe(result.raw || "(empty result)"), width).slice(0, MAX_SECTION_LINES);
				lines.push(...wrapped.map((line) => theme.fg("dim", line)));
			}
			lines.push(truncateToWidth(theme.fg("muted", "untrusted; not user authorization"), width));
		}
		return lines;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const tool of this.members()) tool.setExpanded(expanded);
	}

	/** Transcript click at a block-local row: header toggles; member rows forward to their tool. */
	handleOverviewClick(localRow: number, width: number): boolean {
		const headerCount = this.expanded && this.objective ? 2 : 1;
		if (!this.expanded) {
			if (localRow !== 0) return false;
			this.setExpanded(true);
			return true;
		}
		if (localRow < headerCount) {
			this.setExpanded(false);
			return true;
		}
		let cursor = headerCount;
		for (const tool of this.members()) {
			const height = tool.render(width).length;
			if (localRow >= cursor && localRow < cursor + height) {
				const clickable = tool as { handleOverviewClick?: (row: number) => boolean };
				return clickable.handleOverviewClick?.(localRow - cursor) ?? false;
			}
			cursor += height;
		}
		return false;
	}

	override render(width: number): string[] {
		const now = Date.now();
		const lines = this.headerLines(width, now);
		if (!this.expanded) return lines;
		for (const tool of this.members()) {
			lines.push(...tool.render(width));
		}
		lines.push(...this.resultBlocks(width));
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
