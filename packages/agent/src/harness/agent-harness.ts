import type {
	Api,
	AssistantMessage,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	Models,
	RetryPolicy,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { getDefaultStreamFn } from "../stream-fn.ts";
import type {
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	QueueMode,
	StreamFn,
	ThinkingLevel,
	ToolExecutionInfo,
} from "../types.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization.ts";
import type { CompactionSettings } from "./compaction/compaction.ts";
import { prepareCompaction, compact as runCompactionSummary } from "./compaction/compaction.ts";
import { HarnessEventBus } from "./events.ts";
import { convertToLlm } from "./messages.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
import { type LaneReductionResult, type LaneState, reduceLaneState, type ToolBatchState } from "./reducer.ts";
import { Result, type Result as ResultValue, TaggedError } from "./result.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	Entry,
	JsonValue,
	MessageEntry,
	OperationStartedRecord,
	ProvisionedEntry,
	Session,
	SessionStopReason,
	SessionTree,
} from "./session/index.ts";
import { buildSessionContext } from "./session/index.ts";
import { formatSkillInvocation } from "./skills.ts";
import type { TelemetryContext } from "./telemetry.ts";
import type { AgentHarnessResources, PromptTemplate, Skill } from "./types.ts";

export class LaneBusy extends TaggedError("LaneBusy")<{
	lane: string;
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	message: string;
}> {}
export class MissingIdentities extends TaggedError("MissingIdentities")<{
	lane: string;
	tools: string[];
	models: string[];
	message: string;
}> {}
export class NoActiveRun extends TaggedError("NoActiveRun")<{ lane: string; message: string }> {}
export class NoActiveOperation extends TaggedError("NoActiveOperation")<{ lane: string; message: string }> {}
export class NothingToResume extends TaggedError("NothingToResume")<{ lane: string; message: string }> {}
export class InvalidMessage extends TaggedError("InvalidMessage")<{ lane: string; reason: string; message: string }> {}
export class UnknownSkill extends TaggedError("UnknownSkill")<{ name: string; message: string }> {}
export class UnknownTemplate extends TaggedError("UnknownTemplate")<{ name: string; message: string }> {}
export class UnknownTarget extends TaggedError("UnknownTarget")<{ targetId: string; message: string }> {}
export class UnknownQueueItem extends TaggedError("UnknownQueueItem")<{
	lane: string;
	entryId: string;
	message: string;
}> {}
export class LaneExists extends TaggedError("LaneExists")<{ lane: string; message: string }> {}
export class InvalidLane extends TaggedError("InvalidLane")<{ lane: string; reason: string; message: string }> {}
export class NothingToCompact extends TaggedError("NothingToCompact")<{ lane: string; message: string }> {}
export class Closed extends TaggedError("Closed")<{ message: string }> {}

export class HarnessFault extends Error {
	readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "HarnessFault";
		this.cause = cause;
	}
}

export class HarnessClosed extends Error {
	constructor() {
		super("AgentHarness was closed while the operation was active");
		this.name = "HarnessClosed";
	}
}

export class HarnessNotImplemented extends Error {
	readonly operation: string;

	constructor(operation: string) {
		super(`AgentHarness.${operation} is not implemented yet`);
		this.name = "HarnessNotImplemented";
		this.operation = operation;
	}
}

export interface OperationError {
	code: string;
	message: string;
}

export type RunOutcome =
	| { kind: "completed"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "aborted"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "failed"; leafId: string; error: OperationError; finalEntryId?: string; finalMessage?: AssistantMessage }
	| { kind: "paused"; leafId: string }
	| { kind: "suspended"; leafId: string; finalEntryId: string; deferred: DeferredHandle };

export type CompactionOutcome =
	| { kind: "completed"; leafId: string; entry: CompactionEntry }
	| { kind: "declined" | "aborted"; leafId: string }
	| { kind: "failed"; leafId: string; error: OperationError };

export type NavigationOutcome =
	| { kind: "completed"; newLeafId: string | null; summaryEntry?: BranchSummaryEntry }
	| { kind: "declined" | "aborted"; leafId: string | null }
	| { kind: "failed"; leafId: string | null; error: OperationError };

export type RunRejected = LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | Closed;
export type CompactionRejected = LaneBusy | NothingToCompact | Closed;
export type NavigationRejected = LaneBusy | UnknownTarget | Closed;
export type ResumeRejected = LaneBusy | NothingToResume | MissingIdentities | Closed;
export type QueueRejected = NoActiveRun | InvalidMessage | Closed;
export type CancelQueuedRejected = UnknownQueueItem | Closed;
export type AbortRejected = NoActiveOperation | Closed;

export type RunResult = ResultValue<{ runId: string } & RunOutcome, RunRejected>;
export type CompactionResult = ResultValue<{ runId: string } & CompactionOutcome, CompactionRejected>;
export type NavigationResult = ResultValue<{ runId: string } & NavigationOutcome, NavigationRejected>;
export type QueueResult = ResultValue<{ entryId: string }, QueueRejected>;
export type CancelQueuedResult = ResultValue<
	{ outcome: "cancelled" | "already_consumed" | "already_cleared" },
	CancelQueuedRejected
>;
export type RecordUsageResult = ResultValue<void, Closed>;
export type PauseResult = ResultValue<{ runId: string }, NoActiveRun | Closed>;

/** Bounded execution budgets enforced at driver safe points. */
export interface RunBudgets {
	maxTokens?: number;
	maxToolCalls?: number;
	maxDurationMs?: number;
	maxSteps?: number;
}
export type AbortResult = ResultValue<
	{ runId: string; steer: AgentMessage[]; followUp: AgentMessage[] },
	AbortRejected
>;

export type ResumeOutcome =
	| ({ operation: "run"; runId: string } & RunOutcome)
	| ({ operation: "compaction"; runId: string } & CompactionOutcome)
	| ({ operation: "navigation"; runId: string } & NavigationOutcome);
export type ResumeResult = ResultValue<ResumeOutcome, ResumeRejected>;
export type CreateLaneResult = ResultValue<AgentLane, LaneExists | InvalidLane | UnknownTarget | Closed>;

export interface NavigateOptions {
	summarize?: boolean;
	customInstructions?: string;
	label?: string;
}

export interface SuspendedOperation {
	lane: string;
	kind: "run" | "compaction" | "navigation";
	id: string;
	startedAt: number;
	reason: "crash" | "deferred";
	prompt?: AgentMessage[];
	deferred?: DeferredHandle;
	aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };
	missing: { tools: string[]; models: string[] };
}

export interface LaneInfo {
	name: string;
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		status: "running" | "suspended" | "aborting";
	};
}

export interface QueuedItem {
	entryId: string;
	message: AgentMessage;
}

export interface LaneSnapshot {
	lane: string;
	transcript: Entry[];
	leafId: string | null;
	operation: LaneInfo["operation"];
	queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
	pendingWrites: { id: string; entry: ProvisionedEntry }[];
	faulted: boolean;
}

export interface SessionSnapshot {
	lanes: (LaneInfo & { suspended?: SuspendedOperation })[];
	faulted: boolean;
}

export type ActionInfo =
	| { kind: "append_entry"; entryType: Entry["type"]; entryId: string }
	| { kind: "append_record"; recordType: string }
	| { kind: "move_lane"; to: string | null }
	| { kind: "set_fact"; fact: "name" | "label" }
	| { kind: "try_finish_run"; outcome: "completed" | "failed" }
	| { kind: "finish_operation"; outcome: "completed" | "declined" | "failed" | "aborted" }
	| { kind: "commit_follow_up" }
	| { kind: "consume_queue_item"; queue: "steer" | "followUp"; entryId: string }
	| { kind: "apply_pending_write"; entryId: string }
	| { kind: "stream_assistant"; step: "assistant" | "compaction" | "branch_summary"; attempt: number }
	| { kind: "execute_tool"; toolCallId: string; toolName: string }
	| { kind: "fetch_deferred" | "cancel_deferred"; provider: string; id: string }
	| { kind: "hook"; name: HookName }
	| { kind: "sleep"; delayMs: number };

export type HookName =
	| "before_run"
	| "before_resume"
	| "before_run_end"
	| "transform_context"
	| "before_request"
	| "before_payload"
	| "after_response"
	| "before_tool"
	| "after_tool"
	| "before_compaction"
	| "before_navigation";

export interface Hooks {
	on(name: HookName, handler: (event: unknown) => unknown | Promise<unknown>, options?: { id?: string }): () => void;
}

export interface Events {
	on(type: string, listener: (event: unknown) => void | Promise<void>): () => void;
}

class UnavailableRegistry implements Hooks, Events {
	private readonly operation: string;
	private readonly isClosed: () => boolean;

	constructor(operation: string, isClosed: () => boolean) {
		this.operation = operation;
		this.isClosed = isClosed;
	}

	on(
		_name: HookName | string,
		_handler: (event: unknown) => unknown | Promise<unknown>,
		_options?: { id?: string },
	): () => void {
		throw this.isClosed() ? new HarnessClosed() : new HarnessNotImplemented(this.operation);
	}
}

export type HarnessTool = AgentTool & {
	replay?: "never" | "safe";
	/**
	 * Optional identity-aware execution entry point. Durable drivers prefer it
	 * over `execute` so tools can use the stable operation id (e.g. as an
	 * external idempotency key) and observe the physical attempt number.
	 */
	executeWithInfo?: AgentTool["execute"] extends (...args: infer TArgs) => infer TResult
		? (
				toolCallId: TArgs[0],
				params: TArgs[1],
				signal: TArgs[2],
				onUpdate: TArgs[3],
				execution: ToolExecutionInfo,
			) => TResult
		: never;
};
export type Resources = AgentHarnessResources<Skill, PromptTemplate>;
export type StreamOptions = SimpleStreamOptions;
export type StreamOptionsPatch = Partial<SimpleStreamOptions>;
export type EntryProjector = (entry: Entry) => AgentMessage[] | Promise<AgentMessage[]>;

export interface AgentHarnessOptions {
	session: Session;
	models: Models;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	tools?: HarnessTool[];
	toolContext?: object | (() => object | Promise<object>);
	systemPrompt?: string | (() => string | Promise<string>);
	resources?: Resources;
	streamOptions?: StreamOptions;
	retry?: RetryPolicy;
	budgets?: RunBudgets;
	compaction?: CompactionSettings;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	toolExecution?: "sequential" | "parallel";
	drive?: "automatic" | "manual";
	/** Provider call seam. Defaults to the Agent-level default stream function. */
	streamFn?: StreamFn;
	toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	entryProjectors?: Record<string, EntryProjector>;
	context?: TelemetryContext;
}

export interface WatchHandle<TSnapshot> {
	snapshot: TSnapshot;
	start(listener: (event: unknown) => void): void;
	unsubscribe(): void;
}

export interface AgentLane {
	readonly name: string;
	getLeafId(): Promise<string | null>;
	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	skill(name: string, additionalInstructions?: string): Promise<RunResult>;
	promptFromTemplate(name: string, args?: string[]): Promise<RunResult>;
	compact(options?: { customInstructions?: string }): Promise<CompactionResult>;
	navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult>;
	resume(): Promise<ResumeResult>;
	abort(): Promise<AbortResult>;
	steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
	steer(message: AgentMessage): Promise<QueueResult>;
	followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
	followUp(message: AgentMessage): Promise<QueueResult>;
	nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
	nextRun(message: AgentMessage): Promise<QueueResult>;
	cancelQueued(entryId: string): Promise<CancelQueuedResult>;
	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult>;
	/** Interrupt: suspend the active run at the next safe point, keeping it resumable. */
	pause(): Promise<PauseResult>;
	waitForIdle(): Promise<void>;
	runWhenIdle(callback: () => void | Promise<void>): Promise<void>;
	peekAction(): Promise<ActionInfo | undefined>;
	executeAction(): Promise<ActionInfo | undefined>;
	runToCompletion(): Promise<void>;
	getModel(): Promise<Model<Api>>;
	setModel(model: Model<Api>): Promise<void>;
	getThinkingLevel(): Promise<ThinkingLevel>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	getActiveTools(): Promise<string[]>;
	setActiveTools(names: string[]): Promise<void>;
	readonly session: SessionTree;
	watch(): Promise<WatchHandle<LaneSnapshot>>;
}

export class AgentHarness implements AgentLane {
	readonly name = "main";
	readonly session: SessionTree;
	readonly hooks: Hooks;
	readonly events: Events;
	private readonly durableSession: Session;
	private readonly models: Models;
	private readonly eventBus = new HarnessEventBus();
	private readonly streamFn: StreamFn | undefined;
	private readonly systemPromptOption: string | (() => string | Promise<string>) | undefined;
	private readonly toProviderMessages: ((messages: AgentMessage[]) => Message[] | Promise<Message[]>) | undefined;
	private readonly entryProjectors: Record<string, EntryProjector> | undefined;
	private readonly driveMode: "automatic" | "manual";
	private model: Model<Api>;
	private thinkingLevel: ThinkingLevel;
	private activeToolNames: string[];
	private tools: HarnessTool[];
	private resources: Resources;
	private streamOptions: StreamOptions;
	private retryPolicy: RetryPolicy;
	private budgets: RunBudgets;
	private compactionSettings: CompactionSettings;
	private steeringMode: QueueMode;
	private followUpMode: QueueMode;
	private closed = false;
	/** Mirror of the durable main-lane leaf, refreshed after every committed mutation. */
	private laneLeaf: string | null = null;
	private activeOperation: { id: string; kind: "run" | "compaction" | "navigation" } | undefined;
	private activeAbort: AbortController | undefined;
	private driverPromise: Promise<void> | undefined;
	/** Resolves once the active operation's durable intent record is committed. */
	private operationReady: Promise<void> | undefined;
	/** Serializes queue consumption and cancellation so they never interleave into corruption. */
	private queueLock: Promise<void> = Promise.resolve();

	/** Progress fingerprints observed for the active driver, reset per drive. */
	private lastFingerprint: string | undefined;
	private fingerprintRepeats = 0;

	private constructor(options: AgentHarnessOptions) {
		this.durableSession = options.session;
		this.session = options.session;
		this.models = options.models;
		this.hooks = new UnavailableRegistry("hooks.on", () => this.closed);
		this.events = this.eventBus;
		this.streamFn = options.streamFn;
		this.systemPromptOption = options.systemPrompt;
		this.toProviderMessages = options.toProviderMessages;
		this.entryProjectors = options.entryProjectors;
		this.driveMode = options.drive ?? "automatic";
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.activeToolNames = [...(options.activeToolNames ?? options.tools?.map((tool) => tool.name) ?? [])];
		this.tools = [...(options.tools ?? [])];
		this.resources = {
			skills: options.resources?.skills ? [...options.resources.skills] : undefined,
			promptTemplates: options.resources?.promptTemplates ? [...options.resources.promptTemplates] : undefined,
		};
		this.streamOptions = { ...(options.streamOptions ?? {}) };
		this.retryPolicy = options.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 1000 };
		this.budgets = { ...(options.budgets ?? {}) };
		this.compactionSettings = options.compaction ?? {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		};
		this.steeringMode = options.steeringMode ?? "one-at-a-time";
		this.followUpMode = options.followUpMode ?? "one-at-a-time";
	}

	static async create(
		options: AgentHarnessOptions,
	): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
		const metadata = await options.session.getMetadata();
		const harness = new AgentHarness({
			...options,
			streamOptions: {
				...options.streamOptions,
				sessionId: options.streamOptions?.sessionId ?? metadata.id,
			},
		});
		const suspended = await harness.restoreFromLog();
		return { harness, suspended };
	}

	private unavailable<T>(operation: string): Promise<T> {
		return Promise.reject(this.closed ? new HarnessClosed() : new HarnessNotImplemented(operation));
	}

	async getLeafId(): Promise<string | null> {
		return this.durableSession.getLeafId();
	}

	async prompt(_text: string, _images?: ImageContent[]): Promise<RunResult>;
	async prompt(_message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		if (this.closed) throw new HarnessClosed();
		if (this.driveMode === "manual") throw new HarnessNotImplemented("prompt.manual");
		const messages = normalizePrompt(input, images);
		if (messages.length === 0) {
			return Result.err(
				new InvalidMessage({ lane: "main", reason: "empty", message: "Prompt requires at least one message" }),
			);
		}
		if (this.activeOperation) {
			return Result.err(
				new LaneBusy({
					lane: "main",
					operationId: this.activeOperation.id,
					operationKind: this.activeOperation.kind,
					message: `Lane main is busy with ${this.activeOperation.kind} ${this.activeOperation.id}`,
				}),
			);
		}
		const runId = this.nextId();
		// Mark the lane busy before the first await so a concurrent prompt()
		// observes LaneBusy instead of racing the durable append.
		this.activeOperation = { id: runId, kind: "run" };
		this.activeAbort = new AbortController();
		const ready = (async () => {
			// Commands queued via nextRun are captured as this run's first messages.
			const pendingNextRun = (await this.reduceCurrent()).laneState.pendingNextRun;
			const initialMessages = [
				...pendingNextRun,
				...messages.map(
					(message) => ({ type: "message", id: this.nextId(), message }) as ProvisionedEntry<MessageEntry>,
				),
			];
			// Intent is durable before any model/tool I/O; a crash here is resumed by
			// applying the provisioned-but-missing initial messages.
			await this.durableSession.appendRecord({
				type: "operation_started",
				id: runId,
				lane: "main",
				sourceLeafId: this.laneLeaf,
				intent: { kind: "run", originalPrompt: messages, initialMessages },
			});
		})();
		this.operationReady = ready;
		try {
			await ready;
		} catch (error) {
			this.activeOperation = undefined;
			this.activeAbort = undefined;
			throw error;
		}
		this.eventBus.emit({ type: "run_start", lane: "main", runId });
		const driving = this.drive();
		this.driverPromise = driving.then(
			() => undefined,
			() => undefined,
		);
		try {
			const outcome = await driving;
			return Result.ok({ runId, ...outcome });
		} finally {
			this.driverPromise = undefined;
		}
	}
	async skill(name: string, additionalInstructions?: string): Promise<RunResult> {
		if (this.closed) throw new HarnessClosed();
		const skill = this.resources.skills?.find((candidate) => candidate.name === name);
		if (!skill) {
			return Result.err(new UnknownSkill({ name, message: `Unknown skill: ${name}` }));
		}
		return this.prompt(formatSkillInvocation(skill, additionalInstructions));
	}
	async promptFromTemplate(name: string, args: string[] = []): Promise<RunResult> {
		if (this.closed) throw new HarnessClosed();
		const template = this.resources.promptTemplates?.find((candidate) => candidate.name === name);
		if (!template) {
			return Result.err(new UnknownTemplate({ name, message: `Unknown prompt template: ${name}` }));
		}
		return this.prompt(formatPromptTemplateInvocation(template, args));
	}
	async compact(options?: { customInstructions?: string }): Promise<CompactionResult> {
		if (this.closed) throw new HarnessClosed();
		if (this.driveMode === "manual") throw new HarnessNotImplemented("compact.manual");
		const busy = this.busyError();
		if (busy) return Result.err(busy);
		const runId = this.nextId();
		const resultEntryId = this.nextId();
		this.activeOperation = { id: runId, kind: "compaction" };
		this.activeAbort = new AbortController();
		const ready = (async () => {
			await this.durableSession.appendRecord({
				type: "operation_started",
				id: runId,
				lane: "main",
				sourceLeafId: this.laneLeaf,
				intent: {
					kind: "compaction",
					...(options?.customInstructions !== undefined ? { customInstructions: options.customInstructions } : {}),
					resultEntryId,
				},
			});
		})();
		this.operationReady = ready;
		try {
			await ready;
		} catch (error) {
			this.activeOperation = undefined;
			this.activeAbort = undefined;
			throw error;
		}
		const driving = this.driveCompaction();
		this.driverPromise = driving.then(
			() => undefined,
			() => undefined,
		);
		try {
			const outcome = await driving;
			return Result.ok({ runId, ...outcome });
		} finally {
			this.driverPromise = undefined;
		}
	}
	async navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult> {
		if (this.closed) throw new HarnessClosed();
		if (this.driveMode === "manual") throw new HarnessNotImplemented("navigateTree.manual");
		const busy = this.busyError();
		if (busy) return Result.err(busy);
		if (targetId !== null && !(await this.durableSession.getEntry(targetId))) {
			return Result.err(new UnknownTarget({ targetId, message: `Entry not found: ${targetId}` }));
		}
		const runId = this.nextId();
		const summaryEntryId = options?.summarize ? this.nextId() : undefined;
		this.activeOperation = { id: runId, kind: "navigation" };
		this.activeAbort = new AbortController();
		const ready = (async () => {
			await this.durableSession.appendRecord({
				type: "operation_started",
				id: runId,
				lane: "main",
				sourceLeafId: this.laneLeaf,
				intent: {
					kind: "navigation",
					targetId,
					summarize: options?.summarize ?? false,
					...(options?.customInstructions !== undefined ? { customInstructions: options.customInstructions } : {}),
					...(options?.label !== undefined ? { label: options.label } : {}),
					...(summaryEntryId !== undefined ? { summaryEntryId } : {}),
				},
			});
		})();
		this.operationReady = ready;
		try {
			await ready;
		} catch (error) {
			this.activeOperation = undefined;
			this.activeAbort = undefined;
			throw error;
		}
		const driving = this.driveNavigation();
		this.driverPromise = driving.then(
			() => undefined,
			() => undefined,
		);
		try {
			const outcome = await driving;
			return Result.ok({ runId, ...outcome });
		} finally {
			this.driverPromise = undefined;
		}
	}

	private busyError(): LaneBusy | undefined {
		if (!this.activeOperation) return undefined;
		return new LaneBusy({
			lane: "main",
			operationId: this.activeOperation.id,
			operationKind: this.activeOperation.kind,
			message: `Lane main is busy with ${this.activeOperation.kind} ${this.activeOperation.id}`,
		});
	}
	async resume(): Promise<ResumeResult> {
		if (this.closed) throw new HarnessClosed();
		if (this.driveMode === "manual") throw new HarnessNotImplemented("resume.manual");
		if (this.driverPromise) {
			return Result.err(
				new LaneBusy({
					lane: "main",
					operationId: this.activeOperation?.id ?? "unknown",
					operationKind: this.activeOperation?.kind ?? "run",
					message: "A driver is already running on this lane",
				}),
			);
		}
		const reduction = await this.reduceCurrent();
		const op = reduction.laneState.operation;
		if (!op) {
			return Result.err(new NothingToResume({ lane: "main", message: "No suspended operation on lane main" }));
		}
		if (op.kind === "run") {
			const missing = this.findMissingIdentities(reduction);
			if (missing.tools.length > 0 || missing.models.length > 0) {
				return Result.err(
					new MissingIdentities({
						lane: "main",
						tools: missing.tools,
						models: missing.models,
						message: "Suspended run references tools or models that are not available",
					}),
				);
			}
		}
		this.activeOperation = { id: op.id, kind: op.kind };
		this.activeAbort = new AbortController();
		if (op.pausing) {
			// Resume clears the interrupt intent; queue state is untouched.
			await this.durableSession.appendRecord({
				type: "pause_cleared",
				id: this.nextId(),
				lane: "main",
				runId: op.id,
			});
		}
		const driving =
			op.kind === "run" ? this.drive() : op.kind === "compaction" ? this.driveCompaction() : this.driveNavigation();
		this.driverPromise = driving.then(
			() => undefined,
			() => undefined,
		);
		try {
			const outcome = await driving;
			return Result.ok({ operation: op.kind, runId: op.id, ...outcome } as ResumeOutcome);
		} finally {
			this.driverPromise = undefined;
		}
	}
	async pause(): Promise<PauseResult> {
		if (this.closed) throw new HarnessClosed();
		if (!this.activeOperation || this.activeOperation.kind !== "run") {
			return Result.err(new NoActiveRun({ lane: "main", message: "No active run on lane main to pause" }));
		}
		const runId = this.activeOperation.id;
		await this.operationReady;
		// Durable interrupt intent; the driver suspends at the next safe point.
		// Unlike abort, queues and in-flight work are preserved for resume().
		await this.durableSession.appendRecord({ type: "pause_requested", id: this.nextId(), lane: "main", runId });
		return Result.ok({ runId });
	}

	async abort(): Promise<AbortResult> {
		if (this.closed) throw new HarnessClosed();
		if (!this.activeOperation) {
			return Result.err(new NoActiveOperation({ lane: "main", message: "No active operation on lane main" }));
		}
		const runId = this.activeOperation.id;
		// The intent record must be durable before the abort record references it.
		await this.operationReady;
		// Cancel has priority over steer/follow-up: the abort intent is durable
		// first, then undelivered queue items are cancelled (by the driver when one
		// is active, otherwise here) and their messages returned to the caller.
		await this.durableSession.appendRecord({ type: "abort_requested", id: this.nextId(), lane: "main", runId });
		this.activeAbort?.abort();
		const undelivered = await this.undeliveredQueueItems(runId);
		if (!this.driverPromise) {
			await this.cancelUndelivered(runId, [...undelivered.steer, ...undelivered.followUp]);
			await this.finishRun(runId, "aborted", {});
		}
		return Result.ok({
			runId,
			steer: undelivered.steer.map(queuedMessage),
			followUp: undelivered.followUp.map(queuedMessage),
		});
	}
	async steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
	async steer(message: AgentMessage): Promise<QueueResult>;
	async steer(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.enqueue("steer", input, images);
	}
	async followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
	async followUp(message: AgentMessage): Promise<QueueResult>;
	async followUp(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.enqueue("followUp", input, images);
	}
	async nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
	async nextRun(message: AgentMessage): Promise<QueueResult>;
	async nextRun(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.enqueue("nextRun", input, images);
	}

	/** Persist a control command. Acceptance is durable; the driver applies it at the next safe point. */
	private async enqueue(
		queue: "steer" | "followUp" | "nextRun",
		input: string | AgentMessage,
		images?: ImageContent[],
	): Promise<QueueResult> {
		if (this.closed) throw new HarnessClosed();
		const messages = normalizePrompt(input, images);
		if (messages.length !== 1) {
			return Result.err(
				new InvalidMessage({
					lane: "main",
					reason: "empty",
					message: "A queued command requires exactly one message",
				}),
			);
		}
		let runId: string | undefined;
		if (queue !== "nextRun") {
			const op = this.activeOperation;
			if (!op || op.kind !== "run") {
				return Result.err(
					new NoActiveRun({ lane: "main", message: `${queue} requires an active run on lane main` }),
				);
			}
			runId = op.id;
			// The intent record must be durable before any record that references it.
			await this.operationReady;
		}
		const target = {
			type: "message",
			id: this.nextId(),
			message: messages[0]!,
		} as ProvisionedEntry<MessageEntry>;
		const base = { type: "queue_enqueued" as const, id: this.nextId(), lane: "main", target };
		await this.durableSession.appendRecord(
			queue === "nextRun" ? { ...base, queue } : { ...base, queue, runId: runId! },
		);
		return Result.ok({ entryId: target.id });
	}

	async cancelQueued(entryId: string): Promise<CancelQueuedResult> {
		if (this.closed) throw new HarnessClosed();
		const enqueued = await this.durableSession.findRecords({ lane: "main", type: "queue_enqueued" });
		const enqueue = enqueued.find((record) => record.target.id === entryId);
		if (!enqueue) {
			return Result.err(
				new UnknownQueueItem({ lane: "main", entryId, message: `No queued item with entry id ${entryId}` }),
			);
		}
		return this.withQueueLock(async () => {
			if (await this.durableSession.getEntry(entryId)) {
				return Result.ok({ outcome: "already_consumed" as const });
			}
			const cancelled = await this.durableSession.findRecords({ lane: "main", type: "queue_cancelled" });
			if (cancelled.some((record) => record.entryId === entryId)) {
				return Result.ok({ outcome: "already_cleared" as const });
			}
			await this.durableSession.appendRecord({
				type: "queue_cancelled",
				id: this.nextId(),
				lane: "main",
				...(enqueue.queue === "nextRun" ? {} : { runId: enqueue.runId }),
				entryId,
			});
			return Result.ok({ outcome: "cancelled" as const });
		});
	}

	private withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queueLock.then(fn, fn);
		this.queueLock = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Queue items for this run that were neither consumed nor cancelled yet. */
	private async undeliveredQueueItems(
		runId: string,
	): Promise<{ steer: ProvisionedEntry[]; followUp: ProvisionedEntry[] }> {
		const enqueued = await this.durableSession.findRecords({ lane: "main", type: "queue_enqueued" });
		const cancelled = await this.durableSession.findRecords({ lane: "main", type: "queue_cancelled" });
		const cancelledIds = new Set(cancelled.map((record) => record.entryId));
		const steer: ProvisionedEntry[] = [];
		const followUp: ProvisionedEntry[] = [];
		for (const record of enqueued) {
			if (record.queue === "nextRun" || record.runId !== runId || cancelledIds.has(record.target.id)) continue;
			if (await this.durableSession.getEntry(record.target.id)) continue;
			(record.queue === "steer" ? steer : followUp).push(record.target);
		}
		return { steer, followUp };
	}

	/** Cancel each still-undelivered queue item; entry existence is re-checked inside the lock. */
	private async cancelUndelivered(runId: string, items: ProvisionedEntry[]): Promise<void> {
		for (const target of items) {
			await this.withQueueLock(async () => {
				if (await this.durableSession.getEntry(target.id)) return;
				await this.durableSession.appendRecord({
					type: "queue_cancelled",
					id: this.nextId(),
					lane: "main",
					runId,
					entryId: target.id,
				});
			});
		}
	}
	async recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		if (this.closed) throw new HarnessClosed();
		await this.durableSession.appendRecord({
			type: "usage",
			id: this.nextId(),
			lane: "main",
			cause: "adjustment",
			usage,
			...(options?.entryId ? { entryId: options.entryId } : {}),
			...(options?.details ? { details: options.details } : {}),
		});
		return Result.ok(undefined);
	}
	async waitForIdle(): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		await this.driverPromise;
	}
	async runWhenIdle(callback: () => void | Promise<void>): Promise<void> {
		if (this.closed) throw new HarnessClosed();
		await this.waitForIdle();
		await callback();
	}
	async peekAction(): Promise<ActionInfo | undefined> {
		return this.unavailable("peekAction");
	}
	async executeAction(): Promise<ActionInfo | undefined> {
		return this.unavailable("executeAction");
	}
	async runToCompletion(): Promise<void> {
		return this.unavailable("runToCompletion");
	}
	async getModel(): Promise<Model<Api>> {
		return this.model;
	}
	async setModel(model: Model<Api>): Promise<void> {
		this.model = model;
	}
	async getThinkingLevel(): Promise<ThinkingLevel> {
		return this.thinkingLevel;
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.thinkingLevel = level;
	}
	async getActiveTools(): Promise<string[]> {
		return [...this.activeToolNames];
	}
	async setActiveTools(names: string[]): Promise<void> {
		this.activeToolNames = [...names];
	}
	async watch(): Promise<WatchHandle<LaneSnapshot>> {
		if (this.closed) throw new HarnessClosed();
		const snapshot = await this.captureLaneSnapshot();
		return this.eventBus.watch(() => snapshot);
	}

	private async captureLaneSnapshot(): Promise<LaneSnapshot> {
		const reduction = await this.reduceCurrent();
		const op = reduction.laneState.operation;
		const transcript = await this.durableSession.findEntriesOnBranch({
			start: this.laneLeaf ?? undefined,
			order: "oldestFirst",
		});
		const queued = (items: ProvisionedEntry[]): QueuedItem[] =>
			items.map((target) => ({ entryId: target.id, message: queuedMessage(target) }));
		return {
			lane: "main",
			transcript,
			leafId: this.laneLeaf,
			operation: op
				? {
						id: op.id,
						kind: op.kind,
						status: op.aborting ? "aborting" : this.driverPromise ? "running" : "suspended",
					}
				: null,
			queues: {
				steer: queued(op?.pendingSteer ?? []),
				followUp: queued(op?.pendingFollowUp ?? []),
				nextRun: queued(reduction.laneState.pendingNextRun),
			},
			pendingWrites: (op?.pendingWrites ?? []).map((entry) => ({ id: entry.id, entry })),
			faulted: false,
		};
	}

	async lane(_name: string): Promise<AgentLane | undefined> {
		return this.unavailable("lane");
	}
	async createLane(_name: string, _at: string | null): Promise<CreateLaneResult> {
		return this.unavailable("createLane");
	}
	async lanes(): Promise<LaneInfo[]> {
		if (this.closed) throw new HarnessClosed();
		const pointers = await this.durableSession.getLanes();
		return Promise.all(
			pointers.map(async (pointer) => {
				const [open] = await this.durableSession.findOpenOperations(pointer.lane, { limit: 1 });
				return {
					name: pointer.lane,
					leafId: pointer.leafId,
					operation: open
						? {
								id: open.id,
								kind: open.intent.kind,
								status: this.activeOperation?.id === open.id && this.driverPromise ? "running" : "suspended",
							}
						: null,
				};
			}),
		);
	}
	async getTools(): Promise<HarnessTool[]> {
		return [...this.tools];
	}
	async setTools(tools: HarnessTool[], activeNames?: string[]): Promise<void> {
		this.tools = [...tools];
		this.activeToolNames = [...(activeNames ?? tools.map((tool) => tool.name))];
	}
	async getResources(): Promise<Resources> {
		return {
			skills: this.resources.skills ? [...this.resources.skills] : undefined,
			promptTemplates: this.resources.promptTemplates ? [...this.resources.promptTemplates] : undefined,
		};
	}
	async setResources(resources: Resources): Promise<void> {
		this.resources = {
			skills: resources.skills ? [...resources.skills] : undefined,
			promptTemplates: resources.promptTemplates ? [...resources.promptTemplates] : undefined,
		};
	}
	async getStreamOptions(): Promise<StreamOptions> {
		return { ...this.streamOptions };
	}
	async setStreamOptions(options: StreamOptions): Promise<void> {
		this.streamOptions = {
			...options,
			sessionId: options.sessionId ?? this.streamOptions.sessionId,
		};
	}
	async getRetryPolicy(): Promise<RetryPolicy> {
		return { ...this.retryPolicy };
	}
	async setRetryPolicy(policy: RetryPolicy): Promise<void> {
		this.retryPolicy = { ...policy };
	}
	async getCompactionSettings(): Promise<CompactionSettings> {
		return { ...this.compactionSettings };
	}
	async setCompactionSettings(settings: CompactionSettings): Promise<void> {
		this.compactionSettings = { ...settings };
	}
	async getSteeringMode(): Promise<QueueMode> {
		return this.steeringMode;
	}
	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringMode = mode;
	}
	async getFollowUpMode(): Promise<QueueMode> {
		return this.followUpMode;
	}
	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpMode = mode;
	}
	async watchSession(): Promise<WatchHandle<SessionSnapshot>> {
		if (this.closed) throw new HarnessClosed();
		const snapshot: SessionSnapshot = { lanes: await this.lanes(), faulted: false };
		return this.eventBus.watch(() => snapshot);
	}
	async close(): Promise<void> {
		this.closed = true;
	}

	// =========================================================================
	// Durable driver (slice 1: single-lane run + crash recovery)
	//
	// The durable log is the only source of truth. The driver re-reduces lane
	// state after every committed mutation, so a crash at any point leaves a
	// prefix that resume() can continue without duplicating semantic entries.
	// =========================================================================

	private nextId(): string {
		return this.durableSession.idGenerator.next();
	}

	private async appendOwnedEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>): Promise<TEntry> {
		const committed = await this.durableSession.appendEntry(entry, "main");
		this.laneLeaf = committed.id;
		return committed;
	}

	/** Restore in-memory lane state from the durable log; throws on corruption. */
	private async restoreFromLog(): Promise<SuspendedOperation[]> {
		this.laneLeaf = await this.durableSession.getLeafId();
		const open = await this.durableSession.findOpenOperations("main", { limit: 2 });
		const started = open[0];
		const reduction = await this.reduceCurrent(open);
		const op = reduction.laneState.operation;
		if (!op || !started) return [];
		this.activeOperation = { id: op.id, kind: op.kind };
		return [
			{
				lane: "main",
				kind: op.kind,
				id: op.id,
				startedAt: started.timestamp,
				reason: "crash",
				...(op.intent.kind === "run" ? { prompt: op.intent.originalPrompt } : {}),
				...(op.aborting ? { aborting: { steer: [], followUp: [] } } : {}),
				missing: this.findMissingIdentities(reduction),
			},
		];
	}

	/** Assemble the bounded recovery slice and reduce the current lane state. */
	private async reduceCurrent(openOperations?: OperationStartedRecord[]): Promise<LaneReductionResult> {
		const open = openOperations ?? (await this.durableSession.findOpenOperations("main", { limit: 2 }));
		const started = open[0];
		const records = await this.durableSession.findRecords({ lane: "main" });
		const leafId = this.laneLeaf;

		let ownEntries: Entry[] = [];
		if (started && leafId !== null) {
			// Newest-first walk stops after yielding the anchor (inclusive);
			// oldestFirst + stopAtId would scan from the root and drop everything
			// newer than the anchor, so the anchor is sliced off here instead.
			const walk = await this.durableSession.findEntriesOnBranch({
				start: leafId,
				stopAtId: started.sourceLeafId ?? undefined,
			});
			const anchorIndex =
				started.sourceLeafId === null ? -1 : walk.findIndex((entry) => entry.id === started.sourceLeafId);
			const own = anchorIndex === -1 ? walk : walk.slice(0, anchorIndex);
			ownEntries = own.reverse();
		}

		const referenced = new Set<string>();
		if (started) {
			if (started.intent.kind === "run") {
				for (const target of started.intent.initialMessages) referenced.add(target.id);
			} else if (started.intent.kind === "compaction") {
				referenced.add(started.intent.resultEntryId);
			} else if (started.intent.summaryEntryId) {
				referenced.add(started.intent.summaryEntryId);
			}
		}
		for (const record of records) {
			if (record.type === "step_attempt") referenced.add(record.resultEntryId);
			else if (record.type === "tool_started") {
				referenced.add(record.assistantEntryId);
				referenced.add(record.resultEntryId);
			} else if (record.type === "queue_enqueued" || record.type === "write_deferred")
				referenced.add(record.target.id);
		}
		const ownIds = new Set(ownEntries.map((entry) => entry.id));
		const entries: Entry[] = [...ownEntries];
		for (const id of referenced) {
			if (ownIds.has(id)) continue;
			const entry = await this.durableSession.getEntry(id);
			if (entry) entries.push(entry);
		}

		const anchor = started?.sourceLeafId ?? leafId;
		const configurationEntries = await this.durableSession.findEntriesOnBranch({
			start: anchor ?? undefined,
			order: "oldestFirst",
		});

		return reduceLaneState({
			lane: "main",
			openOperations: open,
			records,
			entries,
			leafId,
			ownEntries,
			configurationEntries,
			defaults: {
				model: { provider: this.model.provider, modelId: this.model.id },
				thinkingLevel: this.thinkingLevel,
				activeToolNames: [...this.activeToolNames],
			},
		});
	}

	private findMissingIdentities(reduction: LaneReductionResult): { tools: string[]; models: string[] } {
		const tools = new Set<string>();
		const batch = reduction.laneState.operation?.toolBatch;
		if (batch) {
			for (const call of batch.calls) {
				const available =
					this.activeToolNames.includes(call.toolCall.name) &&
					this.tools.some((t) => t.name === call.toolCall.name);
				if (!available) tools.add(call.toolCall.name);
			}
		}
		// Models: slice 1 always drives with the configured harness model, so model
		// identity is available by construction. Persisted model_change entries and
		// per-step model resolution arrive with a later coordinator slice.
		return { tools: [...tools], models: [] };
	}

	/** Budget check at a safe point. Returns a violation message or undefined. */
	private async checkBudgets(runId: string): Promise<string | undefined> {
		const budgets = this.budgets;
		if (
			budgets.maxTokens === undefined &&
			budgets.maxToolCalls === undefined &&
			budgets.maxDurationMs === undefined &&
			budgets.maxSteps === undefined
		) {
			return undefined;
		}
		const records = await this.durableSession.findRecords({ lane: "main", runId });
		if (budgets.maxSteps !== undefined) {
			const steps = records.filter((record) => record.type === "step_attempt").length;
			if (steps >= budgets.maxSteps) return `step budget exceeded (${steps} >= ${budgets.maxSteps})`;
		}
		if (budgets.maxToolCalls !== undefined) {
			const toolCalls = records.filter((record) => record.type === "tool_started").length;
			if (toolCalls >= budgets.maxToolCalls)
				return `tool-call budget exceeded (${toolCalls} >= ${budgets.maxToolCalls})`;
		}
		if (budgets.maxTokens !== undefined) {
			let tokens = 0;
			for (const record of records) {
				if (record.type === "usage") tokens += record.usage.totalTokens;
			}
			if (tokens >= budgets.maxTokens) return `token budget exceeded (${tokens} >= ${budgets.maxTokens})`;
		}
		if (budgets.maxDurationMs !== undefined) {
			const started = records.find((record) => record.type === "operation_started");
			if (started && Date.now() - started.timestamp >= budgets.maxDurationMs) {
				return `duration budget exceeded (>= ${budgets.maxDurationMs}ms)`;
			}
		}
		return undefined;
	}

	/**
	 * No-progress detection: fingerprint the newest turn (assistant message plus
	 * its tool results, without ids/timestamps). Three identical consecutive
	 * fingerprints mean the model is repeating a plan that produces no new state.
	 */
	private async detectNoProgress(): Promise<boolean> {
		const branch = await this.durableSession.findEntriesOnBranch({ start: this.laneLeaf ?? undefined });
		const turn: Entry[] = [];
		for (const entry of branch) {
			turn.push(entry);
			if (entry.type === "message" && entry.message.role === "assistant") break;
		}
		const assistant = turn.at(-1);
		if (!assistant || assistant.type !== "message" || assistant.message.role !== "assistant") {
			return false;
		}
		const signature = turn
			.map((entry) => {
				if (entry.type !== "message") return entry.type;
				const message = entry.message as unknown as Record<string, unknown>;
				const { timestamp: _timestamp, ...rest } = message;
				return JSON.stringify(rest);
			})
			.join("\n");
		if (signature === this.lastFingerprint) {
			this.fingerprintRepeats += 1;
		} else {
			this.lastFingerprint = signature;
			this.fingerprintRepeats = 1;
		}
		return this.fingerprintRepeats >= 3;
	}

	private async drive(): Promise<RunOutcome> {
		while (true) {
			const reduction = await this.reduceCurrent();
			const op = reduction.laneState.operation;
			if (!op || !this.activeOperation || op.id !== this.activeOperation.id) {
				throw new HarnessFault("Active operation disappeared from the durable log", undefined);
			}
			// Control safe point: an accepted abort takes effect before any further
			// model request or tool dispatch. The driver owns queue cancellation so
			// cancellation and consumption never interleave into a corrupt log.
			if (op.aborting) {
				const undelivered = await this.undeliveredQueueItems(op.id);
				await this.cancelUndelivered(op.id, [...undelivered.steer, ...undelivered.followUp]);
				return await this.finishRun(op.id, "aborted", {});
			}
			// Interrupt: stop driving at this safe point; the operation stays open
			// and resumable. Abort has priority over pause.
			if (op.pausing) {
				this.activeOperation = undefined;
				this.activeAbort = undefined;
				this.laneLeaf = await this.durableSession.getLeafId();
				return { kind: "paused", leafId: this.laneLeaf ?? "" };
			}
			const budgetViolation = await this.checkBudgets(op.id);
			if (budgetViolation) {
				return await this.finishRun(op.id, "failed", {
					error: { code: "budget_exceeded", message: budgetViolation },
				});
			}
			if (reduction.terminalFailure) {
				const failure = reduction.terminalFailure;
				return await this.finishRun(op.id, "failed", {
					error: { code: "step_failed", message: failure.message.errorMessage ?? "Assistant step failed" },
					finalEntryId: failure.entryId,
					finalMessage: failure.message,
				});
			}
			if (op.missingInitialMessages.length > 0) {
				for (const target of op.missingInitialMessages) await this.appendOwnedEntry(target);
				continue;
			}
			const batch = op.toolBatch;
			if (batch?.unresolved) {
				await this.advanceToolBatch(op.id, batch);
				continue;
			}
			if (batch && batch.calls.length > 0 && batch.calls.every((call) => call.terminate === true)) {
				const assistant = await this.durableSession.getEntry(batch.assistantEntryId);
				if (assistant?.type !== "message" || assistant.message.role !== "assistant") {
					throw new HarnessFault("Tool batch anchor entry is missing", undefined);
				}
				return await this.finishRun(op.id, "completed", {
					finalEntryId: this.laneLeaf ?? batch.assistantEntryId,
					finalMessage: assistant.message,
				});
			}
			const newest = op.newestOwn;
			if (newest?.type === "message" && newest.role === "assistant") {
				if (newest.stopReason === "deferred") {
					return await this.finishRun(op.id, "failed", {
						error: {
							code: "deferred_unsupported",
							message: "Deferred provider responses are not supported by this driver yet",
						},
						finalEntryId: newest.entryId,
					});
				}
				if (newest.stopReason === "aborted") {
					return await this.finishRun(op.id, "aborted", {});
				}
				// The reducer anchors toolBatch on the newest assistant WITH tool calls.
				// When it points at an older assistant, the newest assistant has no tool
				// calls and the run would stop here: steer first, then follow-up.
				if (!batch || batch.assistantEntryId !== newest.entryId) {
					if (op.pendingSteer.length > 0) {
						await this.drainQueued(op.pendingSteer, this.steeringMode);
						continue;
					}
					if (op.pendingFollowUp.length > 0) {
						await this.drainQueued(op.pendingFollowUp, this.followUpMode);
						continue;
					}
					const entry = await this.durableSession.getEntry(newest.entryId);
					if (entry?.type === "message" && entry.message.role === "assistant") {
						return await this.finishRun(op.id, "completed", {
							finalEntryId: newest.entryId,
							finalMessage: entry.message,
						});
					}
				}
			}
			// SP0: accepted steering commands take effect before the next model request.
			if (op.pendingSteer.length > 0 && this.steerEligible(newest, op)) {
				await this.drainQueued(op.pendingSteer, this.steeringMode);
				continue;
			}
			// No-progress check at the consistent pre-step point: the fingerprint
			// always covers the latest assistant turn plus its resolved tool results.
			if (await this.detectNoProgress()) {
				return await this.finishRun(op.id, "failed", {
					error: {
						code: "no_progress",
						message:
							"The same plan and outcome repeated without producing new state; stopping instead of looping.",
					},
				});
			}
			await this.runAssistantStep(op);
		}
	}

	/** Finish a non-run operation: terminal record, clear driver state, refresh the leaf. */
	private async finishOperation(
		runId: string,
		outcome: "completed" | "declined" | "aborted" | "failed",
		error?: OperationError,
	): Promise<void> {
		await this.durableSession.appendRecord({
			type: "operation_finished",
			id: this.nextId(),
			lane: "main",
			runId,
			outcome,
			...(error ? { error } : {}),
		});
		this.activeOperation = undefined;
		this.activeAbort = undefined;
		this.laneLeaf = await this.durableSession.getLeafId();
	}

	private async driveCompaction(): Promise<CompactionOutcome> {
		while (true) {
			const reduction = await this.reduceCurrent();
			const op = reduction.laneState.operation;
			if (!op || op.intent.kind !== "compaction" || op.id !== this.activeOperation?.id) {
				throw new HarnessFault("Active compaction disappeared from the durable log", undefined);
			}
			const intent = op.intent;
			if (op.aborting) {
				await this.finishOperation(op.id, "aborted");
				return { kind: "aborted", leafId: this.laneLeaf ?? "" };
			}
			if (op.targets.result) {
				const entry = await this.durableSession.getEntry(intent.resultEntryId);
				if (entry?.type !== "compaction") throw new HarnessFault("Compaction result entry is missing", undefined);
				await this.finishOperation(op.id, "completed");
				return { kind: "completed", leafId: this.laneLeaf ?? "", entry };
			}
			const attempt = op.step ? op.step.attempts + 1 : 1;
			const resultEntryId = op.step?.resultEntryId ?? intent.resultEntryId;
			await this.durableSession.appendRecord({
				type: "step_attempt",
				id: this.nextId(),
				lane: "main",
				runId: op.id,
				step: "compaction",
				attempt,
				resultEntryId,
				compactionReason: "manual",
			});
			const branch = await this.durableSession.findEntriesOnBranch({
				start: this.laneLeaf ?? undefined,
				order: "oldestFirst",
			});
			const prepared = prepareCompaction(branch, this.compactionSettings);
			if (!prepared.ok) {
				const error = { code: prepared.error.code, message: prepared.error.message };
				await this.finishOperation(op.id, "failed", error);
				return { kind: "failed", leafId: this.laneLeaf ?? "", error };
			}
			if (!prepared.value) {
				await this.finishOperation(op.id, "declined");
				return { kind: "declined", leafId: this.laneLeaf ?? "" };
			}
			const result = await runCompactionSummary(
				prepared.value,
				this.models,
				this.model,
				intent.customInstructions,
				this.activeAbort?.signal,
				this.thinkingLevel,
				this.retryPolicy,
			);
			if (!result.ok) {
				if (result.error.code === "aborted") {
					await this.finishOperation(op.id, "aborted");
					return { kind: "aborted", leafId: this.laneLeaf ?? "" };
				}
				const error = { code: result.error.code, message: result.error.message };
				await this.finishOperation(op.id, "failed", error);
				return { kind: "failed", leafId: this.laneLeaf ?? "", error };
			}
			const value = result.value;
			await this.appendOwnedEntry({
				type: "compaction",
				id: resultEntryId,
				summary: value.summary,
				retainedTail: value.retainedTail,
				tokensBefore: value.tokensBefore,
				...(value.usage ? { usage: value.usage } : {}),
				...(value.details !== undefined ? { details: value.details } : {}),
			});
			if (value.usage) {
				await this.durableSession.appendRecord({
					type: "usage",
					id: this.nextId(),
					lane: "main",
					runId: op.id,
					cause: "compaction",
					entryId: resultEntryId,
					attempt,
					stopReason: "stop",
					usage: value.usage,
				});
			}
		}
	}

	private async driveNavigation(): Promise<NavigationOutcome> {
		while (true) {
			const reduction = await this.reduceCurrent();
			const op = reduction.laneState.operation;
			if (!op || op.intent.kind !== "navigation" || op.id !== this.activeOperation?.id) {
				throw new HarnessFault("Active navigation disappeared from the durable log", undefined);
			}
			const intent = op.intent;
			if (op.aborting) {
				await this.finishOperation(op.id, "aborted");
				return { kind: "aborted", leafId: this.laneLeaf ?? "" };
			}
			if (intent.summarize && intent.summaryEntryId && intent.targetId !== null && !op.targets.summary) {
				const attempt = op.step ? op.step.attempts + 1 : 1;
				const resultEntryId = op.step?.resultEntryId ?? intent.summaryEntryId;
				await this.durableSession.appendRecord({
					type: "step_attempt",
					id: this.nextId(),
					lane: "main",
					runId: op.id,
					step: "branch_summary",
					attempt,
					resultEntryId,
				});
				const { entries } = await collectEntriesForBranchSummary(
					this.durableSession,
					this.laneLeaf,
					intent.targetId,
				);
				const generated = await generateBranchSummary(entries, {
					models: this.models,
					model: this.model,
					signal: this.activeAbort?.signal ?? new AbortController().signal,
					...(intent.customInstructions !== undefined ? { customInstructions: intent.customInstructions } : {}),
					retry: this.retryPolicy,
				});
				if (!generated.ok) {
					if (generated.error.code === "aborted") {
						await this.finishOperation(op.id, "aborted");
						return { kind: "aborted", leafId: this.laneLeaf ?? "" };
					}
					const error = { code: generated.error.code, message: generated.error.message };
					await this.finishOperation(op.id, "failed", error);
					return { kind: "failed", leafId: this.laneLeaf ?? "", error };
				}
				const value = generated.value;
				await this.appendOwnedEntry({
					type: "branch_summary",
					id: resultEntryId,
					fromId: this.laneLeaf ?? "",
					summary: value.summary,
					details: { readFiles: value.readFiles, modifiedFiles: value.modifiedFiles },
					...(value.usage ? { usage: value.usage } : {}),
				});
				if (value.usage) {
					await this.durableSession.appendRecord({
						type: "usage",
						id: this.nextId(),
						lane: "main",
						runId: op.id,
						cause: "branch_summary",
						entryId: resultEntryId,
						attempt,
						stopReason: "stop",
						usage: value.usage,
					});
				}
				continue;
			}
			await this.durableSession.moveLane("main", intent.targetId);
			this.laneLeaf = intent.targetId;
			if (intent.label && intent.targetId) {
				await this.durableSession.setLabel(intent.targetId, intent.label);
			}
			await this.finishOperation(op.id, "completed");
			const summaryEntry = intent.summaryEntryId
				? await this.durableSession.getEntry(intent.summaryEntryId)
				: undefined;
			return {
				kind: "completed",
				newLeafId: intent.targetId,
				...(summaryEntry?.type === "branch_summary" ? { summaryEntry } : {}),
			};
		}
	}

	private async finishRun(
		runId: string,
		outcome: "completed" | "aborted" | "failed",
		info: { error?: OperationError; finalEntryId?: string; finalMessage?: AssistantMessage },
	): Promise<RunOutcome> {
		await this.durableSession.appendRecord({
			type: "operation_finished",
			id: this.nextId(),
			lane: "main",
			runId,
			outcome,
			...(info.error ? { error: info.error } : {}),
		});
		this.activeOperation = undefined;
		this.activeAbort = undefined;
		this.laneLeaf = await this.durableSession.getLeafId();
		const leafId = this.laneLeaf ?? "";
		this.eventBus.emit({ type: "run_end", lane: "main", runId, outcome, leafId });
		if (outcome === "failed") {
			return {
				kind: "failed",
				leafId,
				error: info.error ?? { code: "unknown", message: "Operation failed" },
				...(info.finalEntryId ? { finalEntryId: info.finalEntryId } : {}),
				...(info.finalMessage ? { finalMessage: info.finalMessage } : {}),
			};
		}
		const newest = info.finalMessage ? undefined : await this.newestAssistantMessage();
		const finalMessage = info.finalMessage ?? newest?.message ?? syntheticAbortedMessage(this.model);
		const finalEntryId = info.finalEntryId ?? newest?.entryId ?? leafId;
		return { kind: outcome, leafId, finalEntryId, finalMessage };
	}

	private async newestAssistantMessage(): Promise<{ entryId: string; message: AssistantMessage } | undefined> {
		const entries = await this.durableSession.findEntriesOnBranch({ start: this.laneLeaf ?? undefined });
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				return { entryId: entry.id, message: entry.message };
			}
		}
		return undefined;
	}

	private async isAborting(runId: string): Promise<boolean> {
		const aborts = await this.durableSession.findRecords({ lane: "main", type: "abort_requested" });
		return aborts.some((record) => record.runId === runId);
	}

	private async runAssistantStep(op: NonNullable<LaneState["operation"]>): Promise<void> {
		// A pending step (attempt committed, result entry missing) retries with the
		// same provisioned result id; a completed step starts a new attempt series.
		let attempt = op.step ? op.step.attempts + 1 : 1;
		const resultEntryId = op.step?.resultEntryId ?? this.nextId();
		while (true) {
			await this.durableSession.appendRecord({
				type: "step_attempt",
				id: this.nextId(),
				lane: "main",
				runId: op.id,
				step: "assistant",
				attempt,
				resultEntryId,
			});

			const branch = await this.durableSession.findEntriesOnBranch({
				start: this.laneLeaf ?? undefined,
				order: "oldestFirst",
			});
			const context = buildSessionContext(branch, { entryProjectors: this.contextEntryProjectors() });
			const messages = this.toProviderMessages
				? await this.toProviderMessages(context.messages)
				: convertToLlm(context.messages);
			const systemPrompt =
				typeof this.systemPromptOption === "function"
					? await this.systemPromptOption()
					: (this.systemPromptOption ?? "");
			const tools = this.tools.filter((tool) => this.activeToolNames.includes(tool.name));
			const streamFn = this.streamFn ?? getDefaultStreamFn();
			const stream = await streamFn(
				this.model,
				{ systemPrompt, messages, tools },
				{
					...this.streamOptions,
					reasoning: this.thinkingLevel === "off" ? undefined : this.thinkingLevel,
					signal: this.activeAbort?.signal,
				},
			);
			const message = await stream.result();
			// Stream-level exceptions propagate without finishing the operation: the
			// committed attempt prefix stays resumable.
			if (
				message.stopReason === "error" &&
				this.retryPolicy.enabled &&
				attempt <= this.retryPolicy.maxRetries &&
				!(await this.isAborting(op.id))
			) {
				// Bounded retry: same logical step, new physical attempt; the
				// transient error message is never persisted.
				const delayMs = this.retryPolicy.baseDelayMs * 2 ** (attempt - 1);
				const slept = await sleepAbortable(delayMs, this.activeAbort?.signal);
				if (slept) {
					attempt += 1;
					continue;
				}
			}
			// Provider SDKs may materialize absent optional fields as `undefined`,
			// while the durable session contract accepts strict JSON only.
			const durableMessage = stripUndefined(message) as AssistantMessage;
			await this.appendOwnedEntry({ type: "message", id: resultEntryId, message: durableMessage });
			await this.durableSession.appendRecord({
				type: "usage",
				id: this.nextId(),
				lane: "main",
				runId: op.id,
				cause: "assistant",
				entryId: resultEntryId,
				attempt,
				stopReason: durableMessage.stopReason as SessionStopReason,
				usage: durableMessage.usage,
			});
			return;
		}
	}

	/** Commit queued commands as entries; the entry's existence marks consumption. */
	private async drainQueued(items: ProvisionedEntry[], mode: QueueMode): Promise<void> {
		const selected = mode === "all" ? items : items.slice(0, 1);
		for (const target of selected) {
			await this.withQueueLock(async () => {
				if (await this.durableSession.getEntry(target.id)) return;
				await this.appendOwnedEntry(target as ProvisionedEntry<MessageEntry>);
			});
		}
	}

	/**
	 * Steering applies at turn boundaries and at run start — never twice in a
	 * row without a model turn in between (one-at-a-time fairness).
	 */
	private steerEligible(
		newest: NonNullable<LaneState["operation"]>["newestOwn"],
		op: NonNullable<LaneState["operation"]>,
	): boolean {
		if (!newest || newest.type !== "message") return true;
		if (newest.role !== "user") return true;
		if (op.intent.kind !== "run") return false;
		return op.intent.initialMessages.some((target) => target.id === newest.entryId);
	}

	private contextEntryProjectors(): Record<string, (entry: CustomEntry) => readonly AgentMessage[] | undefined> {
		if (!this.entryProjectors) return {};
		return Object.fromEntries(
			Object.entries(this.entryProjectors).map(([customType, projector]) => [
				customType,
				(entry: CustomEntry) => {
					const projected = projector(entry);
					// The context builder is synchronous; async projectors are a later slice.
					return projected instanceof Promise ? undefined : projected;
				},
			]),
		);
	}

	private async advanceToolBatch(runId: string, batch: ToolBatchState): Promise<void> {
		const call = batch.calls.find((candidate) => !candidate.resultExists);
		if (!call) return;

		if (batch.truncated) {
			await this.appendOwnedEntry({
				type: "message",
				id: this.nextId(),
				message: errorToolResult(
					call.toolCall,
					`Tool call "${call.toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
				),
			});
			return;
		}

		const started = call.started;
		if (started) {
			if (started.replay === "never") {
				// Never blindly replay a side-effecting call whose outcome is unknown.
				await this.appendOwnedEntry({
					type: "message",
					id: started.resultEntryId,
					message: errorToolResult(
						call.toolCall,
						"Tool execution was interrupted after dispatch and is not replay-safe; the external outcome is unknown. Verify the external state before retrying.",
					),
				});
				return;
			}
			await this.executeToolCall(
				runId,
				call.toolCall,
				started.effectiveArgs,
				started.resultEntryId,
				started.operationId ?? defaultOperationId(runId, batch.assistantEntryId, call.toolIndex),
			);
			return;
		}

		const tool = this.tools.find(
			(candidate) => candidate.name === call.toolCall.name && this.activeToolNames.includes(candidate.name),
		);
		if (!tool) {
			await this.appendOwnedEntry({
				type: "message",
				id: this.nextId(),
				message: errorToolResult(call.toolCall, `Tool ${call.toolCall.name} not found`),
			});
			return;
		}
		if (tool.contract?.approval === "required") {
			// Fail closed: no approval channel is wired into this host yet.
			await this.appendOwnedEntry({
				type: "message",
				id: this.nextId(),
				message: errorToolResult(
					call.toolCall,
					`Tool "${call.toolCall.name}" requires approval, but no approval channel is configured in this host. The call was not executed.`,
				),
			});
			return;
		}
		let args: Record<string, unknown>;
		try {
			const prepared = tool.prepareArguments
				? { ...call.toolCall, arguments: tool.prepareArguments(call.toolCall.arguments) as Record<string, unknown> }
				: call.toolCall;
			args = validateToolArguments(tool, prepared) as Record<string, unknown>;
		} catch (error) {
			await this.appendOwnedEntry({
				type: "message",
				id: this.nextId(),
				message: errorToolResult(call.toolCall, error instanceof Error ? error.message : String(error)),
			});
			return;
		}
		const resultEntryId = this.nextId();
		const operationId = defaultOperationId(runId, batch.assistantEntryId, call.toolIndex);
		await this.durableSession.appendRecord({
			type: "tool_started",
			id: this.nextId(),
			lane: "main",
			runId,
			assistantEntryId: batch.assistantEntryId,
			toolIndex: call.toolIndex,
			toolCallId: call.toolCall.id,
			toolName: call.toolCall.name,
			effectiveArgs: args,
			resultEntryId,
			operationId,
			replay: tool.replay ?? defaultReplay(tool),
		});
		await this.executeToolCall(runId, call.toolCall, args, resultEntryId, operationId);
	}

	private async executeToolCall(
		runId: string,
		toolCall: AgentToolCall,
		args: Record<string, unknown>,
		resultEntryId: string,
		operationId: string,
	): Promise<void> {
		const tool = this.tools.find((candidate) => candidate.name === toolCall.name);
		if (!tool) throw new HarnessFault(`Tool ${toolCall.name} disappeared during execution`, undefined);
		const contract = tool.contract;
		// Retry budgets apply only to calls that are safe to repeat.
		const maxRetries =
			contract?.retry &&
			(contract.idempotent === true || contract.readOnly === true || contract.sideEffects === "none")
				? contract.retry.maxRetries
				: 0;
		let result: AgentToolResult<unknown>;
		let isError = false;
		for (let attempt = 1; ; attempt++) {
			const execution: ToolExecutionInfo = { runId, toolCallId: toolCall.id, operationId, attempt };
			try {
				result = await this.executeWithTimeout(tool, toolCall.id, args, execution);
				isError = false;
				break;
			} catch (error) {
				// A HarnessFault models a crash: the result stays uncommitted so resume
				// can apply the tool's replay policy. Ordinary tool errors are results.
				if (error instanceof HarnessFault) throw error;
				isError = true;
				if (error instanceof ToolTimeoutError) {
					// A timeout is never "not executed": the outcome is unknown.
					result = {
						content: [
							{
								type: "text",
								text: `Tool "${toolCall.name}" exceeded its ${contract?.timeoutMs}ms timeout; the outcome is unknown. Verify external state before retrying.`,
							},
						],
						details: {},
					};
					break;
				}
				if (attempt <= maxRetries) continue;
				result = {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
				};
				break;
			}
		}
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			// details may be undefined or contain undefined fields; the durable log
			// is strict JSON, so strip them.
			...(result.details !== undefined ? { details: stripUndefined(result.details) } : {}),
			isError,
			timestamp: Date.now(),
			...(result.usage ? { usage: result.usage } : {}),
		};
		await this.appendOwnedEntry({
			type: "message",
			id: resultEntryId,
			message,
			...(result.terminate === true ? { terminate: true as const } : {}),
		});
		if (result.usage) {
			await this.durableSession.appendRecord({
				type: "usage",
				id: this.nextId(),
				lane: "main",
				runId,
				cause: "tool",
				entryId: resultEntryId,
				toolCallId: toolCall.id,
				usage: result.usage,
			});
		}
	}

	private async executeWithTimeout(
		tool: HarnessTool,
		toolCallId: string,
		args: Record<string, unknown>,
		execution: ToolExecutionInfo,
	): Promise<AgentToolResult<unknown>> {
		const invoke = () =>
			tool.executeWithInfo
				? tool.executeWithInfo(toolCallId, args as never, this.activeAbort?.signal, undefined, execution)
				: tool.execute(toolCallId, args as never, this.activeAbort?.signal, undefined);
		const timeoutMs = tool.contract?.timeoutMs;
		if (!timeoutMs) {
			return invoke();
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				invoke(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new ToolTimeoutError()), timeoutMs);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
}

function queuedMessage(target: ProvisionedEntry): AgentMessage {
	return (target as ProvisionedEntry<MessageEntry>).message;
}

class ToolTimeoutError extends Error {
	constructor() {
		super("Tool execution timed out");
		this.name = "ToolTimeoutError";
	}
}

function defaultOperationId(runId: string, assistantEntryId: string, toolIndex: number): string {
	return `${runId}:${assistantEntryId}:${toolIndex}`;
}

function defaultReplay(tool: HarnessTool): "never" | "safe" {
	const contract = tool.contract;
	if (contract && (contract.readOnly === true || contract.idempotent === true || contract.sideEffects === "none")) {
		return "safe";
	}
	return "never";
}

function normalizePrompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): AgentMessage[] {
	if (typeof input === "string") {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: input }];
		if (images) content.push(...images);
		return [{ role: "user", content, timestamp: Date.now() }];
	}
	if (Array.isArray(input)) return input;
	return [input];
}

function errorToolResult(toolCall: AgentToolCall, message: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: message }],
		isError: true,
		timestamp: Date.now(),
	};
}

function syntheticAbortedMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		timestamp: Date.now(),
	};
}

/** Sleep that resolves false when the signal aborts before the delay elapses. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		timer.unref?.();
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Deep-strip undefined values so Provider/tool data satisfies strict-JSON durability. */
function stripUndefined(value: unknown): unknown {
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		for (const item of value) {
			if (item !== undefined) out.push(stripUndefined(item));
		}
		return out;
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (item !== undefined) out[key] = stripUndefined(item);
		}
		return out;
	}
	return value;
}
