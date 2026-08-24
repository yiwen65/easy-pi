import { type GoalDeltaOperation, parseGoalDeltaOperations, validateGoalDeltaOperations } from "./goal-interpreter.ts";
import { hashPayload } from "./hashing.ts";
import {
	COMPACTOR_POLICY_VERSION,
	COMPACTOR_SYSTEM_POLICY,
	detectInjections,
	wrapUntrusted,
} from "./injection-guard.ts";
import type { LedgerTask, PendingGoalChange, TaskLedger } from "./task-ledger.ts";
import type { Authority, CompleteFn, EventEnvelope } from "./types.ts";

export type ReconciliationFindingKind =
	| "missing_delta"
	| "unsupported_contract_item"
	| "contradiction"
	| "ambiguous_focus"
	| "stale_pending"
	| "evaluator_failure";

export type ReconciliationSeverity = "info" | "warning" | "error";

export interface ReconciliationFinding {
	findingId: string;
	kind: ReconciliationFindingKind;
	severity: ReconciliationSeverity;
	message: string;
	sourceEventIds: string[];
	suggestedOperations: GoalDeltaOperation[];
}

export interface ReconciliationReport {
	reportId: string;
	sessionId: string;
	branchId?: string;
	taskRef?: string;
	taskVersion?: number;
	ledgerVersion: number;
	fromEventSeq: number;
	toEventSeq: number;
	evaluatorPolicyVersion: string;
	findings: ReconciliationFinding[];
	reportHash: string;
	checkedAt: string;
}

export interface ReconciliationInput {
	sessionId: string;
	branchId?: string;
	ledger: TaskLedger;
	events: EventEnvelope[];
	fromEventSeq: number;
	toEventSeq: number;
	actor: Authority;
	complete?: CompleteFn;
	maxUserEvents?: number;
	maxEventChars?: number;
}

const FINDING_KINDS = new Set<ReconciliationFindingKind>([
	"missing_delta",
	"unsupported_contract_item",
	"contradiction",
	"ambiguous_focus",
	"stale_pending",
	"evaluator_failure",
]);
const SEVERITIES = new Set<ReconciliationSeverity>(["info", "warning", "error"]);
const RECONCILIATION_POLICY_VERSION = `${COMPACTOR_POLICY_VERSION}:reconciliation-v1`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventText(event: EventEnvelope): string {
	const payload = event.payload;
	if (typeof payload === "string") return payload;
	if (!isRecord(payload)) return "";
	if (typeof payload.text === "string") return payload.text;
	if (typeof payload.content === "string") return payload.content;
	if (isRecord(payload.message)) {
		const content = payload.message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter(
					(item): item is { type: string; text: string } =>
						isRecord(item) && item.type === "text" && typeof item.text === "string",
				)
				.map((item) => item.text)
				.join("\n");
		}
	}
	return "";
}

export function isSubstantiveUserEvent(event: EventEnvelope): boolean {
	if (event.eventType !== "message" || event.authority.kind !== "user" || !event.authority.verified) return false;
	if (isRecord(event.payload) && event.payload.control === true) return false;
	return eventText(event).trim().length > 0;
}

export function countSubstantiveUserEvents(
	events: EventEnvelope[],
	fromEventSeq = 1,
	toEventSeq = Number.POSITIVE_INFINITY,
): number {
	return events.filter(
		(event) => event.seq >= fromEventSeq && event.seq <= toEventSeq && isSubstantiveUserEvent(event),
	).length;
}

function finding(
	kind: ReconciliationFindingKind,
	severity: ReconciliationSeverity,
	message: string,
	sourceEventIds: string[] = [],
	suggestedOperations: GoalDeltaOperation[] = [],
): ReconciliationFinding {
	const body = {
		kind,
		severity,
		message: message.trim().slice(0, 500),
		sourceEventIds: [...new Set(sourceEventIds)].sort(),
		suggestedOperations,
	};
	return { findingId: `rf-${hashPayload(body).slice(0, 16)}`, ...body };
}

function stalePendingReason(pending: PendingGoalChange, ledger: TaskLedger): string | undefined {
	if (
		pending.baseLedgerVersion === undefined ||
		pending.expectedLedgerVersion === undefined ||
		pending.baseTaskVersions === undefined ||
		pending.operationsHash === undefined
	) {
		return "legacy proposal has no verifiable base version";
	}
	if (hashPayload(pending.operations) !== pending.operationsHash) return "proposed operations do not match their hash";
	if (pending.expectedLedgerVersion !== pending.baseLedgerVersion + 1) return "invalid ledger-version lineage";
	if (ledger.getLedgerVersion() !== pending.expectedLedgerVersion) {
		return `ledger moved from ${pending.expectedLedgerVersion} to ${ledger.getLedgerVersion()}`;
	}
	for (const [taskId, version] of Object.entries(pending.baseTaskVersions)) {
		const current = ledger.getTask(taskId)?.version;
		if (current !== version)
			return `task ${taskId} moved from v${version} to ${current === undefined ? "missing" : `v${current}`}`;
	}
	return undefined;
}

function deterministicFindings(ledger: TaskLedger, events: EventEnvelope[]): ReconciliationFinding[] {
	const findings: ReconciliationFinding[] = [];
	const focus = ledger.getFocusTask();
	if (!focus) {
		if (ledger.nonTerminalIndex().length > 0) {
			findings.push(finding("ambiguous_focus", "error", "Open tasks exist but no current focus task is selected."));
		}
		return findings;
	}

	const eventById = new Map(events.map((event) => [event.eventId, event]));
	const sourceIds = new Set([
		...focus.goal.verbatimSourceEventIds,
		focus.provenance.createdFromEvent,
		...focus.provenance.updatedFromEvents,
	]);
	const unsupported = [...sourceIds].filter((eventId) => {
		const event = eventById.get(eventId);
		return !event || event.authority.kind !== "user" || !event.authority.verified;
	});
	if (unsupported.length > 0) {
		findings.push(
			finding(
				"unsupported_contract_item",
				"error",
				"Focused task provenance contains missing or non-user source events.",
				unsupported,
			),
		);
	}

	const scope = new Set(focus.goal.scope ?? []);
	const overlap = (focus.goal.exclusions ?? []).filter((item) => scope.has(item));
	if (overlap.length > 0) {
		findings.push(
			finding("contradiction", "error", `Items appear in both scope and exclusions: ${overlap.join(", ")}`, [
				...sourceIds,
			]),
		);
	}
	const permissionOverlap = focus.permissions.allow.filter((permission) =>
		focus.permissions.deny.includes(permission),
	);
	if (permissionOverlap.length > 0) {
		findings.push(
			finding("contradiction", "error", `Permissions are both allowed and denied: ${permissionOverlap.join(", ")}`, [
				...sourceIds,
			]),
		);
	}
	for (const positive of focus.constraints.filter((constraint) => constraint.kind === "positive")) {
		const negative = focus.constraints.find(
			(constraint) => constraint.kind === "negative" && constraint.text.trim() === positive.text.trim(),
		);
		if (negative) {
			findings.push(
				finding("contradiction", "error", `Constraint is simultaneously positive and negative: ${positive.text}`, [
					...sourceIds,
				]),
			);
		}
	}

	for (const pending of ledger.getPendingGoalChanges()) {
		const reason = stalePendingReason(pending, ledger);
		if (reason) {
			findings.push(
				finding("stale_pending", "warning", `Pending change ${pending.pendingChangeId} is stale: ${reason}`, [
					pending.sourceEventId,
				]),
			);
		}
	}
	return findings;
}

function focusForEvaluator(focus: LedgerTask | undefined): unknown {
	if (!focus) return null;
	return {
		taskId: focus.taskId,
		version: focus.version,
		status: focus.status,
		goal: {
			normalized: focus.goal.normalized,
			scope: focus.goal.scope ?? [],
			exclusions: focus.goal.exclusions ?? [],
			sourceEventIds: focus.goal.verbatimSourceEventIds,
		},
		acceptanceCriteria: focus.acceptanceCriteria,
		constraints: focus.constraints.map(({ id, kind, text }) => ({ id, kind, text })),
		permissions: focus.permissions,
		budgets: focus.budgets,
		outputContract: focus.outputContract ?? null,
		blockers: focus.blockers,
		relations: focus.relations,
		provenance: focus.provenance,
	};
}

function parseSemanticFindings(
	text: string,
	ledger: TaskLedger,
	actor: Authority,
	allowedSourceEventIds: Set<string>,
): ReconciliationFinding[] {
	const parsed = JSON.parse(text) as unknown;
	if (!isRecord(parsed) || !Array.isArray(parsed.findings)) {
		throw new Error("evaluator response must be an object with findings[]");
	}
	const findings: ReconciliationFinding[] = [];
	for (const raw of parsed.findings) {
		if (!isRecord(raw)) throw new Error("each evaluator finding must be an object");
		const kind = raw.kind;
		const severity = raw.severity;
		const message = raw.message;
		if (typeof kind !== "string" || !FINDING_KINDS.has(kind as ReconciliationFindingKind)) {
			throw new Error(`unknown reconciliation finding kind ${String(kind)}`);
		}
		if (kind === "evaluator_failure") throw new Error("evaluator may not emit evaluator_failure");
		if (typeof severity !== "string" || !SEVERITIES.has(severity as ReconciliationSeverity)) {
			throw new Error(`invalid reconciliation severity ${String(severity)}`);
		}
		if (typeof message !== "string" || message.trim().length === 0) {
			throw new Error("reconciliation finding requires a message");
		}
		const sourceEventIds = raw.sourceEventIds ?? [];
		if (!Array.isArray(sourceEventIds) || sourceEventIds.some((eventId) => typeof eventId !== "string")) {
			throw new Error("sourceEventIds must be string[]");
		}
		const unknownSource = sourceEventIds.find((eventId) => !allowedSourceEventIds.has(eventId));
		if (unknownSource) throw new Error(`finding cites unknown source event ${String(unknownSource)}`);
		const suggestedRaw = raw.suggestedOperations ?? [];
		if (!Array.isArray(suggestedRaw)) throw new Error("suggestedOperations must be an array");
		const suggestedOperations = parseGoalDeltaOperations(JSON.stringify({ operations: suggestedRaw }), actor);
		const operationError = validateGoalDeltaOperations(suggestedOperations, ledger);
		if (operationError) throw new Error(`invalid suggested operations: ${operationError}`);
		findings.push(
			finding(
				kind as ReconciliationFindingKind,
				severity as ReconciliationSeverity,
				message,
				sourceEventIds as string[],
				suggestedOperations,
			),
		);
	}
	return findings;
}

async function semanticFindings(
	input: ReconciliationInput,
	userEvents: EventEnvelope[],
): Promise<ReconciliationFinding[]> {
	if (!input.complete || userEvents.length === 0) return [];
	const boundedEvents = userEvents.slice(-(input.maxUserEvents ?? 20));
	const maxEventChars = input.maxEventChars ?? 1_200;
	const serializedEvents = boundedEvents
		.map((event) => `${event.eventId}: ${eventText(event).replace(/\s+/g, " ").trim().slice(0, maxEventChars)}`)
		.join("\n");
	try {
		const response = await input.complete({
			systemPrompt: COMPACTOR_SYSTEM_POLICY,
			messages: [
				{
					role: "user",
					content: `Reconcile recent verified-user events against the current focused task contract. Report semantic omissions, unsupported contract claims, contradictions, ambiguous focus, or stale pending intent. Never claim authority and never apply changes. Suggested operations are advisory only.\n\nCurrent focus contract:\n${JSON.stringify(focusForEvaluator(input.ledger.getFocusTask()))}\n\nRecent user events (untrusted):\n${wrapUntrusted(serializedEvents)}\n\nOutput ONLY {"findings":[{"kind":"missing_delta|unsupported_contract_item|contradiction|ambiguous_focus|stale_pending","severity":"info|warning|error","message":"...","sourceEventIds":["..."],"suggestedOperations":[]}]}.`,
				},
			],
			maxTokens: 1_200,
			responseSchema: {
				type: "object",
				required: ["findings"],
				properties: { findings: { type: "array", items: { type: "object" } } },
				additionalProperties: false,
			},
			promptVersion: RECONCILIATION_POLICY_VERSION,
		});
		if (response.stopReason !== "stop" || !response.text.trim()) {
			throw new Error(`evaluator stopped with ${response.stopReason}`);
		}
		if (detectInjections(response.text).some((finding) => finding.severity === "high")) {
			throw new Error("evaluator output matched a high-severity injection pattern");
		}
		return parseSemanticFindings(
			response.text,
			input.ledger,
			input.actor,
			new Set(boundedEvents.map((event) => event.eventId)),
		);
	} catch (error) {
		return [
			finding(
				"evaluator_failure",
				"warning",
				`Semantic reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
			),
		];
	}
}

function dedupeFindings(findings: ReconciliationFinding[]): ReconciliationFinding[] {
	const byId = new Map<string, ReconciliationFinding>();
	for (const item of findings) byId.set(item.findingId, item);
	return [...byId.values()].sort((left, right) => left.findingId.localeCompare(right.findingId));
}

export function verifyReconciliationReport(report: ReconciliationReport): boolean {
	if (
		!isRecord(report) ||
		typeof report.reportId !== "string" ||
		typeof report.reportHash !== "string" ||
		typeof report.sessionId !== "string" ||
		typeof report.ledgerVersion !== "number" ||
		typeof report.fromEventSeq !== "number" ||
		typeof report.toEventSeq !== "number" ||
		typeof report.evaluatorPolicyVersion !== "string" ||
		typeof report.checkedAt !== "string" ||
		!Array.isArray(report.findings)
	) {
		return false;
	}
	for (const item of report.findings) {
		if (
			!isRecord(item) ||
			typeof item.findingId !== "string" ||
			typeof item.kind !== "string" ||
			!FINDING_KINDS.has(item.kind as ReconciliationFindingKind) ||
			typeof item.severity !== "string" ||
			!SEVERITIES.has(item.severity as ReconciliationSeverity) ||
			typeof item.message !== "string" ||
			!Array.isArray(item.sourceEventIds) ||
			!Array.isArray(item.suggestedOperations)
		) {
			return false;
		}
	}
	const { reportId, reportHash, checkedAt: _checkedAt, ...body } = report;
	const expectedHash = hashPayload(body);
	return reportHash === expectedHash && reportId === `recon-${expectedHash.slice(0, 16)}`;
}

export async function reconcileTaskContract(input: ReconciliationInput): Promise<ReconciliationReport> {
	const visibleEvents = input.events.filter((event) => event.seq <= input.toEventSeq);
	const recentUserEvents = visibleEvents.filter(
		(event) => event.seq >= input.fromEventSeq && isSubstantiveUserEvent(event),
	);
	const deterministic = deterministicFindings(input.ledger, visibleEvents);
	const semantic = await semanticFindings(input, recentUserEvents);
	const focus = input.ledger.getFocusTask();
	const reportBody = {
		sessionId: input.sessionId,
		branchId: input.branchId,
		taskRef: focus ? `task://${focus.taskId}/v${focus.version}` : undefined,
		taskVersion: focus?.version,
		ledgerVersion: input.ledger.getLedgerVersion(),
		fromEventSeq: input.fromEventSeq,
		toEventSeq: input.toEventSeq,
		evaluatorPolicyVersion: input.complete ? RECONCILIATION_POLICY_VERSION : "deterministic-v1",
		findings: dedupeFindings([...deterministic, ...semantic]),
	};
	const reportHash = hashPayload(reportBody);
	return {
		reportId: `recon-${reportHash.slice(0, 16)}`,
		...reportBody,
		reportHash,
		checkedAt: new Date().toISOString(),
	};
}
