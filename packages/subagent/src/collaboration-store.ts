import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	COLLABORATION_HISTORY_LIMITS,
	COLLABORATION_LIMITS,
	CollaborationAdmissionError,
	CollaborationArtifactsSchema,
	CollaborationError,
	type CollaborationHistoryCoverage,
	type CollaborationTurnRecord,
	type CollaborationTurnView,
	DelegationSchema,
	ResultValidationSchema,
	validateAgentPath,
	validateDelegation,
} from "./collaboration-contract.ts";

const ModelSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		id: Type.String({ minLength: 1 }),
		thinkingLevel: Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
			Type.Literal("max"),
		]),
	},
	{ additionalProperties: false },
);
const MessageSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		rootSessionId: Type.String({ minLength: 1 }),
		from: Type.String(),
		to: Type.String(),
		turnId: Type.String({ minLength: 1 }),
		kind: Type.Union([Type.Literal("task"), Type.Literal("message"), Type.Literal("result")]),
		status: Type.Optional(
			Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("interrupted")]),
		),
		text: Type.String({ maxLength: COLLABORATION_LIMITS.maxTaskCharacters }),
		delegation: Type.Optional(DelegationSchema),
		parent: Type.Optional(Type.String()),
		contextUse: Type.Optional(Type.Union([Type.Literal("initial"), Type.Literal("existing")])),
		resultValidation: Type.Optional(ResultValidationSchema),
	},
	{ additionalProperties: false },
);
const AgentSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
		path: Type.String(),
		parent: Type.String(),
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("running"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("interrupted"),
			Type.Literal("closed"),
		]),
		model: ModelSchema,
		turnId: Type.String({ minLength: 1 }),
		completionPending: Type.Optional(Type.Boolean()),
		taskMessage: Type.Optional(MessageSchema),
		sessionFile: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9._-]+\\.jsonl$" })),
		result: Type.Optional(Type.String({ maxLength: COLLABORATION_LIMITS.maxMessageBytes })),
		delegation: Type.Optional(DelegationSchema),
		contextBytes: Type.Optional(Type.Integer({ minimum: 0 })),
		usage: Type.Optional(
			Type.Object(
				{
					input: Type.Number({ minimum: 0 }),
					output: Type.Number({ minimum: 0 }),
					cacheRead: Type.Number({ minimum: 0 }),
					cacheWrite: Type.Number({ minimum: 0 }),
				},
				{ additionalProperties: false },
			),
		),
		// Inherited native catalogs can exceed the model-facing explicit allowlist limit.
		tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
		resultValidation: Type.Optional(ResultValidationSchema),
	},
	{ additionalProperties: false },
);
const SnapshotSchema = Type.Object(
	{
		version: Type.Literal(1),
		rootSessionId: Type.String({ minLength: 1 }),
		cwd: Type.String(),
		revision: Type.Integer({ minimum: 0 }),
		agents: Type.Array(AgentSchema, {
			// Closed records are retained for audit; only open agents consume the live team slots.
			maxItems: COLLABORATION_LIMITS.maxRetainedAgents,
		}),
		messages: Type.Optional(
			Type.Array(MessageSchema, {
				maxItems: COLLABORATION_LIMITS.maxAgents * COLLABORATION_LIMITS.maxPendingMessages,
			}),
		),
	},
	{ additionalProperties: false },
);
export type StoredCollaborationAgent = Static<typeof AgentSchema>;
export type CollaborationSnapshot = Static<typeof SnapshotSchema>;
export type CollaborationAuthority = Readonly<Pick<StoredCollaborationAgent, "path" | "parent" | "status">> & {
	readonly tools?: readonly string[];
};

function validateSnapshot(value: unknown): CollaborationSnapshot {
	if (!Value.Check(SnapshotSchema, value)) throw new CollaborationError("storage_error", "Invalid team snapshot");
	if (!isAbsolute(value.cwd)) throw new CollaborationError("storage_error", "Invalid team cwd");
	if (value.agents.filter((agent) => agent.status !== "closed").length > COLLABORATION_LIMITS.maxAgents - 1)
		throw new CollaborationError("storage_error", "Team agent limit exceeded");
	const paths = new Set<string>();
	const ids = new Set<string>();
	for (const agent of value.agents) {
		if (agent.delegation) validateDelegation(agent.delegation);
		validateAgentPath(agent.path);
		validateAgentPath(agent.parent);
		if (
			agent.path === "/root" ||
			posix.dirname(agent.path) !== agent.parent ||
			paths.has(agent.path) ||
			ids.has(agent.id)
		) {
			throw new CollaborationError("storage_error", "Invalid team graph");
		}
		paths.add(agent.path);
		ids.add(agent.id);
	}
	if (value.agents.some((agent) => agent.parent !== "/root" && !paths.has(agent.parent))) {
		throw new CollaborationError("storage_error", "Missing parent agent");
	}
	const messageIds = new Set<string>();
	const counts = new Map<string, number>();
	for (const message of [
		...(value.messages ?? []),
		...value.agents.flatMap((agent) => (agent.taskMessage ? [agent.taskMessage] : [])),
	]) {
		if (
			message.rootSessionId !== value.rootSessionId ||
			messageIds.has(message.id) ||
			![message.from, message.to].every((path) => path === "/root" || paths.has(path)) ||
			(message.kind === "task"
				? [...message.text].length > COLLABORATION_LIMITS.maxTaskCharacters
				: Buffer.byteLength(message.text, "utf8") > COLLABORATION_LIMITS.maxMessageBytes)
		)
			throw new CollaborationError("storage_error", "Invalid mailbox message");
		if (message.delegation) validateDelegation(message.delegation);
		if (message.parent !== undefined) validateAgentPath(message.parent);
		messageIds.add(message.id);
	}
	for (const message of value.messages ?? []) counts.set(message.to, (counts.get(message.to) ?? 0) + 1);
	for (const agent of value.agents) {
		if (
			agent.taskMessage &&
			(agent.taskMessage.to !== agent.path ||
				agent.taskMessage.turnId !== agent.turnId ||
				agent.taskMessage.kind !== "task")
		)
			throw new CollaborationError("storage_error", "Invalid task receipt");
		if (agent.completionPending) counts.set(agent.parent, (counts.get(agent.parent) ?? 0) + 1);
	}
	if ([...counts.values()].some((count) => count > COLLABORATION_LIMITS.maxPendingMessages))
		throw new CollaborationError("storage_error", "Mailbox capacity exceeded");
	return structuredClone(value);
}

const NullableTime = Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]);
const NullableId = Type.Union([
	Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
	Type.Null(),
]);
const NullableCounter = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
const TurnSchema = Type.Object(
	{
		rootSessionId: Type.String(),
		target: Type.String(),
		turn_id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
		sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		task_message_id: NullableId,
		result_message_id: NullableId,
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("running"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("interrupted"),
			Type.Literal("unknown"),
		]),
		history_coverage: Type.Union([Type.Literal("complete"), Type.Literal("retained_only")]),
		task_preview: Type.String(),
		task_truncated: Type.Boolean(),
		admitted_at: NullableTime,
		started_at: NullableTime,
		finished_at: NullableTime,
		delivery: Type.Object(
			{
				state: Type.Union([
					Type.Literal("not_enqueued"),
					Type.Literal("enqueued"),
					Type.Literal("acknowledged"),
					Type.Literal("unknown"),
				]),
				enqueued_at: NullableTime,
				acknowledged_at: NullableTime,
			},
			{ additionalProperties: false },
		),
		usage: Type.Object(
			{
				coverage: Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("unknown")]),
				input: NullableCounter,
				output: NullableCounter,
				cacheRead: NullableCounter,
				cacheWrite: NullableCounter,
			},
			{ additionalProperties: false },
		),
		resultValidation: Type.Optional(ResultValidationSchema),
		delegation: Type.Optional(DelegationSchema),
		result: Type.Optional(
			Type.Object(
				{
					preview: Type.String(),
					truncated: Type.Union([Type.Boolean(), Type.Null()]),
					source: Type.Object(
						{
							kind: Type.Union([Type.Literal("native_history"), Type.Literal("unavailable")]),
							session_path: Type.Optional(Type.String()),
							turn_id: Type.String(),
							entry_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
							coverage: Type.Union([Type.Literal("entry"), Type.Literal("turn"), Type.Literal("unknown")]),
						},
						{ additionalProperties: false },
					),
					artifacts: Type.Optional(CollaborationArtifactsSchema),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

interface TurnRow {
	sequence: number;
	target: string;
	turn_id: string;
	task_message_id: string | null;
	result_message_id: string | null;
	record: string;
}

export interface TurnPatch {
	target: string;
	turn_id: string;
	result?: Pick<NonNullable<CollaborationTurnRecord["result"]>, "truncated">;
	acknowledged?: true;
}

interface Row {
	snapshot: string;
	owner: string | null;
	pid: number | null;
	owner_started_at?: number | null;
}

/**
 * Process start time of `pid` in epoch milliseconds, via elapsed-time probing. Undefined when the
 * platform cannot answer (win32, ps failure): callers then fall back to the kill(pid, 0) probe.
 * Guards against PID reuse: a recycled pid necessarily starts later than the recorded owner.
 */
function probeProcessStartMs(pid: number): number | undefined {
	if (process.platform === "win32") return undefined;
	try {
		// ps etime renders [[dd-]hh:]mm:ss; etimes is not portable (absent on macOS).
		const out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const match = out.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
		if (!match) return undefined;
		const seconds =
			Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3]) * 60 + Number(match[4]);
		return Date.now() - seconds * 1000;
	} catch {
		return undefined;
	}
}

/** This process's own start time in epoch milliseconds (second-resolution tolerance is fine). */
function ownProcessStartMs(): number {
	return Date.now() - Math.floor(process.uptime() * 1000);
}

/**
 * Current team snapshot and incremental indexed turn ledger, unrelated to the legacy DAG database.
 * Both commit durably in one SQLite owner/CAS-checked transaction; history is never pruned.
 */
export class CollaborationStore {
	private readonly database: DatabaseSync;
	private readonly owner = randomUUID();
	private closed = false;
	private initializing = true;
	private authority: readonly CollaborationAuthority[] = [];
	private authorityVersion = -1;
	readonly directory: string | undefined;
	readonly rootSessionId: string;
	readonly cwd: string;

	constructor(options: { path: string; rootSessionId: string; cwd: string; recoverInterruptedOwner?: boolean }) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.rootSessionId) || !isAbsolute(options.cwd)) {
			throw new CollaborationError("invalid_arguments", "Invalid team identity");
		}
		this.rootSessionId = options.rootSessionId;
		this.cwd = realpathSync(options.cwd);
		let path = options.path;
		let fresh = path === ":memory:";
		if (!fresh) {
			if (!isAbsolute(path))
				throw new CollaborationError("invalid_arguments", "Team database path must be absolute");
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			if (lstatSync(dirname(path)).isSymbolicLink())
				throw new CollaborationError("forbidden", "Unsafe team directory");
			this.directory = realpathSync(dirname(path));
			path = join(this.directory, basename(path));
			for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
				try {
					const metadata = lstatSync(candidate);
					if (!metadata.isFile() || metadata.isSymbolicLink())
						throw new CollaborationError("forbidden", "Unsafe team database file");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			if (!existsSync(path)) {
				closeSync(openSync(path, "wx", 0o600));
				fresh = true;
			}
		}
		this.database = new DatabaseSync(path);
		try {
			if (fresh) {
				this.database.exec(
					"CREATE TABLE team (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL, owner TEXT, pid INTEGER, owner_started_at INTEGER)",
				);
				const snapshot: CollaborationSnapshot = {
					version: 1,
					rootSessionId: this.rootSessionId,
					cwd: this.cwd,
					revision: 0,
					agents: [],
				};
				this.database.prepare("INSERT INTO team VALUES (1, ?, NULL, NULL, NULL)").run(JSON.stringify(snapshot));
			}
			this.database.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
			try {
				// Schema upgrade and seed proof share the acquisition transaction.
				const columns = this.database
					.prepare("PRAGMA table_info(team)")
					.all()
					.map((column) => String(column.name));
				if (!columns.includes("owner_started_at"))
					this.database.exec("ALTER TABLE team ADD COLUMN owner_started_at INTEGER");
				const legacy = !this.database
					.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='turns'")
					.get();
				this.database.exec(
					"CREATE TABLE IF NOT EXISTS turns (sequence INTEGER PRIMARY KEY, target TEXT NOT NULL, turn_id TEXT NOT NULL, task_message_id TEXT, result_message_id TEXT UNIQUE, record TEXT NOT NULL, UNIQUE(target, turn_id)); CREATE INDEX IF NOT EXISTS turns_target_sequence ON turns(target, sequence); CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY CHECK(id=1), coverage TEXT NOT NULL)",
				);
				if (legacy)
					this.database.prepare("INSERT INTO history VALUES (1, ?)").run(fresh ? "complete" : "retained_only");
				const version = this.dataVersion();
				const row = this.readRow();
				const snapshot = this.decode(row);
				if (row.owner !== null) {
					if (!Number.isSafeInteger(row.pid) || (row.pid ?? 0) <= 0)
						throw new CollaborationError("storage_error", "Invalid team owner");
					let alive = true;
					try {
						process.kill(row.pid!, 0);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
					}
					if (alive && row.owner_started_at !== null && row.owner_started_at !== undefined) {
						// PID-reuse guard: a recycled pid starts later than the recorded owner process.
						const startedAt = probeProcessStartMs(row.pid!);
						if (startedAt !== undefined && Math.abs(startedAt - row.owner_started_at) > 10_000) alive = false;
					}
					if (alive) throw new CollaborationError("busy", "Team is owned by a live controller");
					if (!options.recoverInterruptedOwner)
						throw new CollaborationError("interrupted", "Explicit recovery of the interrupted team is required");
				}
				if (legacy) this.seedHistory(snapshot);
				const beforeRecovery = structuredClone(snapshot);
				for (const agent of snapshot.agents) {
					if (agent.status === "pending" || agent.status === "running") agent.status = "interrupted";
					if (agent.completionPending) {
						if (agent.delegation) agent.resultValidation = { contract: "not_completed" };
						snapshot.messages ??= [];
						snapshot.messages.push({
							id: randomUUID(),
							rootSessionId: snapshot.rootSessionId,
							from: agent.path,
							to: agent.parent,
							turnId: agent.turnId,
							kind: "result",
							status: "interrupted",
							text: "Interrupted controller; inspect retained child history. No task was resumed.",
							...(agent.resultValidation ? { resultValidation: agent.resultValidation } : {}),
						});
						agent.completionPending = false;
					}
				}
				this.syncHistory(beforeRecovery, snapshot);
				snapshot.revision++;
				this.database
					.prepare("UPDATE team SET snapshot=?, owner=?, pid=?, owner_started_at=? WHERE id=1")
					.run(JSON.stringify(snapshot), this.owner, process.pid, ownProcessStartMs());
				this.database.exec("COMMIT");
				this.cacheAuthority(snapshot, version);
				this.initializing = false;
			} catch (error) {
				this.database.exec("ROLLBACK");
				throw error;
			}
		} catch (error) {
			this.database.close();
			throw error;
		}
	}

	private readRow(): Row {
		if (this.closed) throw new CollaborationError("storage_error", "Team store is closed");
		const row = this.database
			.prepare("SELECT snapshot, owner, pid, owner_started_at FROM team WHERE id=1")
			.get() as unknown as Row | undefined;
		if (!row) throw new CollaborationError("storage_error", "Missing team metadata");
		return row;
	}

	private decode(row: Row): CollaborationSnapshot {
		const snapshot = validateSnapshot(JSON.parse(row.snapshot));
		if (snapshot.rootSessionId !== this.rootSessionId || snapshot.cwd !== this.cwd) {
			throw new CollaborationError("forbidden", "Team belongs to another root session or workspace");
		}
		return snapshot;
	}

	read(): CollaborationSnapshot {
		const row = this.readRow();
		if (row.owner !== this.owner) throw new CollaborationError("forbidden", "Team ownership was lost");
		return this.decode(row);
	}

	private dataVersion(): number {
		return Number(this.database.prepare("PRAGMA data_version").get()!.data_version);
	}

	private cacheAuthority(snapshot: CollaborationSnapshot, version: number): void {
		this.authority = Object.freeze(
			snapshot.agents.map(({ path, parent, status, tools }) =>
				Object.freeze({
					path,
					parent,
					status,
					...(tools ? { tools: Object.freeze([...tools]) } : {}),
				}),
			),
		);
		this.authorityVersion = version;
	}

	/** Small immutable projection; live tool getters are deliberately not cached here. */
	readAuthority(): readonly CollaborationAuthority[] {
		if (this.closed) throw new CollaborationError("storage_error", "Team store is closed");
		const version = this.dataVersion();
		const row = this.database.prepare("SELECT owner FROM team WHERE id=1").get();
		if (!row) throw new CollaborationError("storage_error", "Missing team metadata");
		if (row.owner !== this.owner) throw new CollaborationError("forbidden", "Team ownership was lost");
		// Another connection changed the database: validate once before reusing a projection.
		if (version !== this.authorityVersion) this.cacheAuthority(this.read(), version);
		return this.authority;
	}

	/** CAS prevents stale callers from overwriting a newer turn or terminal result. */
	commit(snapshot: CollaborationSnapshot, patches: readonly TurnPatch[] = []): CollaborationSnapshot {
		const next = validateSnapshot(snapshot);
		if (next.rootSessionId !== this.rootSessionId || next.cwd !== this.cwd)
			throw new CollaborationError("forbidden", "Invalid team owner");
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const version = this.dataVersion();
			const current = this.read();
			if (current.revision !== next.revision) throw new CollaborationError("busy", "Stale team revision");
			this.syncHistory(current, next, patches);
			next.revision++;
			this.database
				.prepare("UPDATE team SET snapshot=? WHERE id=1 AND owner=?")
				.run(JSON.stringify(next), this.owner);
			this.database.exec("COMMIT");
			this.cacheAuthority(next, version);
			return structuredClone(next);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	/** Admission must call this before persistence so exhaustion does not poison the controller. */
	assertTurnCapacity(): void {
		if (this.countTurns() >= COLLABORATION_HISTORY_LIMITS.maxRetainedTurns)
			throw new CollaborationAdmissionError("limit_reached", "Retained turn history is full", "turn_history_full");
	}

	countTurns(target?: string): number {
		this.assertOwned();
		return Number(
			target === undefined
				? this.database.prepare("SELECT count(*) AS count FROM turns").get()!.count
				: this.database.prepare("SELECT count(*) AS count FROM turns WHERE target=?").get(target)!.count,
		);
	}

	historyCoverage(): CollaborationHistoryCoverage {
		this.assertOwned();
		const row = this.database.prepare("SELECT coverage FROM history WHERE id=1").get();
		if (!row || (row.coverage !== "complete" && row.coverage !== "retained_only"))
			throw new CollaborationError("storage_error", "Invalid history coverage");
		return row.coverage;
	}

	private assertOwned(): void {
		if (!this.initializing && this.readRow().owner !== this.owner)
			throw new CollaborationError("forbidden", "Team ownership was lost");
	}

	getTurn(target: string, selector: { turn_id?: string; message_id?: string }): CollaborationTurnRecord | undefined {
		this.assertOwned();
		if (!!selector.turn_id === !!selector.message_id)
			throw new CollaborationError("invalid_arguments", "Supply exactly one turn selector");
		const row = selector.turn_id
			? this.database.prepare("SELECT * FROM turns WHERE target=? AND turn_id=?").get(target, selector.turn_id)
			: this.database
					.prepare("SELECT * FROM turns WHERE target=? AND result_message_id=?")
					.get(target, selector.message_id!);
		return row ? this.decodeTurn(row as unknown as TurnRow) : undefined;
	}

	/** Distinguish a known mismatched/wrong-kind selector from unretained legacy history.
	 * This bounded index-only probe does not decode historical delegations or return other targets.
	 */
	hasTurnSelector(selector: { turn_id?: string; message_id?: string }): boolean {
		this.assertOwned();
		if (!!selector.turn_id === !!selector.message_id)
			throw new CollaborationError("invalid_arguments", "Supply exactly one selector");
		const id = selector.turn_id ?? selector.message_id!;
		return Boolean(
			this.database
				.prepare("SELECT 1 FROM turns WHERE turn_id=? OR result_message_id=? OR task_message_id=? LIMIT 1")
				.get(id, id, id),
		);
	}

	highWater(): number {
		this.assertOwned();
		const sequence = Number(
			this.database.prepare("SELECT coalesce(max(sequence), 0) AS sequence FROM turns").get()!.sequence,
		);
		if (!Number.isSafeInteger(sequence) || sequence < 0)
			throw new CollaborationError("storage_error", "Invalid history sequence");
		return sequence;
	}

	pageTurns(
		target: string,
		options: { after?: number; highWater?: number; limit?: number } = {},
	): CollaborationTurnView[] {
		this.assertOwned();
		const after = options.after ?? 0;
		const highWater = options.highWater ?? this.highWater();
		const limit = options.limit ?? COLLABORATION_HISTORY_LIMITS.defaultPageSize;
		if (
			![after, highWater, limit].every(Number.isSafeInteger) ||
			after < 0 ||
			highWater < after ||
			highWater > this.highWater() ||
			limit < 1 ||
			limit > COLLABORATION_HISTORY_LIMITS.maxPageSize
		)
			throw new CollaborationError("invalid_arguments", "Invalid history page bounds");
		const candidates = this.database
			.prepare("SELECT * FROM turns WHERE target=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?")
			.all(target, after, highWater, limit)
			.map((row) => {
				const {
					rootSessionId: _root,
					delegation: _delegation,
					result: _result,
					...view
				} = this.decodeTurn(row as unknown as TurnRow);
				return view;
			});
		const page: CollaborationTurnView[] = [];
		let bytes = 1024; // Leaves room for downstream target, coverage and bounded cursor wrapper.
		for (const view of candidates) {
			const size = Buffer.byteLength(JSON.stringify(view)) + 1;
			if (size + 1024 > COLLABORATION_HISTORY_LIMITS.maxPageResponseBytes)
				throw new CollaborationError("storage_error", "History record cannot fit page");
			if (bytes + size > COLLABORATION_HISTORY_LIMITS.maxPageResponseBytes) break;
			page.push(view);
			bytes += size;
		}
		return page;
	}

	private newTurn(agent: StoredCollaborationAgent, legacy: boolean): CollaborationTurnRecord {
		const text = agent.taskMessage?.text ?? "";
		return {
			rootSessionId: this.rootSessionId,
			target: agent.path,
			turn_id: agent.turnId,
			sequence: this.highWater() + 1,
			task_message_id: agent.taskMessage?.id ?? null,
			result_message_id: null,
			status: agent.status === "closed" ? "unknown" : agent.status,
			history_coverage: legacy ? "retained_only" : this.historyCoverage(),
			task_preview: [...text].slice(0, COLLABORATION_HISTORY_LIMITS.maxTaskPreviewCharacters).join(""),
			task_truncated: [...text].length > COLLABORATION_HISTORY_LIMITS.maxTaskPreviewCharacters,
			admitted_at: legacy ? null : Date.now(),
			started_at: null,
			finished_at:
				!legacy && !agent.completionPending && ["completed", "failed", "interrupted"].includes(agent.status)
					? Date.now()
					: null,
			delivery: { state: legacy ? "unknown" : "not_enqueued", enqueued_at: null, acknowledged_at: null },
			usage: { coverage: "unknown", input: null, output: null, cacheRead: null, cacheWrite: null },
			...(agent.delegation ? { delegation: agent.delegation } : {}),
		};
	}

	private decodeTurn(row: TurnRow): CollaborationTurnRecord {
		let value: unknown;
		try {
			value = JSON.parse(row.record);
		} catch {
			throw new CollaborationError("storage_error", "Invalid turn record");
		}
		if (!Value.Check(TurnSchema, value)) throw new CollaborationError("storage_error", "Invalid turn record");
		const record = value as CollaborationTurnRecord;
		if (
			record.sequence !== row.sequence ||
			record.target !== row.target ||
			record.turn_id !== row.turn_id ||
			record.task_message_id !== row.task_message_id ||
			record.result_message_id !== row.result_message_id
		)
			throw new CollaborationError("storage_error", "Invalid turn index");
		this.validateTurn(record);
		return record;
	}

	private validateTurn(record: CollaborationTurnRecord): void {
		if (
			!Value.Check(TurnSchema, record) ||
			record.rootSessionId !== this.rootSessionId ||
			record.history_coverage !== this.historyCoverage() ||
			[...record.task_preview].length > COLLABORATION_HISTORY_LIMITS.maxTaskPreviewCharacters
		)
			throw new CollaborationError("storage_error", "Invalid turn identity or shape");
		try {
			validateAgentPath(record.target);
			if (record.delegation) validateDelegation(record.delegation);
		} catch {
			throw new CollaborationError("storage_error", "Invalid turn contract");
		}
		if (record.target === "/root") throw new CollaborationError("storage_error", "Invalid turn target");
		if (record.result) {
			const source = record.result.source;
			if (
				source.turn_id !== record.turn_id ||
				(source.kind === "native_history"
					? !source.session_path || !isAbsolute(source.session_path)
					: source.session_path !== undefined || source.entry_id !== undefined) ||
				(source.coverage === "entry") !== (source.entry_id !== undefined)
			)
				throw new CollaborationError("storage_error", "Invalid result source");
		}
		const { delegation, result, ...metadata } = record;
		const { preview: _preview, ...resultMetadata } = result ?? {};
		if (
			Buffer.byteLength(JSON.stringify({ ...metadata, ...(result ? { result: resultMetadata } : {}) })) >
				COLLABORATION_HISTORY_LIMITS.maxTurnMetadataBytes ||
			(delegation && Buffer.byteLength(JSON.stringify(delegation)) > COLLABORATION_LIMITS.maxDelegationBytes) ||
			(result && Buffer.byteLength(result.preview) > COLLABORATION_LIMITS.maxMessageBytes)
		)
			throw new CollaborationError("storage_error", "Turn exceeds history budget");
	}

	private writeTurn(record: CollaborationTurnRecord): void {
		this.validateTurn(record);
		if (!this.database.prepare("SELECT 1 FROM turns WHERE target=? AND turn_id=?").get(record.target, record.turn_id))
			this.assertTurnCapacity();
		this.database
			.prepare(
				"INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(target, turn_id) DO UPDATE SET task_message_id=excluded.task_message_id, result_message_id=excluded.result_message_id, record=excluded.record",
			)
			.run(
				record.sequence,
				record.target,
				record.turn_id,
				record.task_message_id,
				record.result_message_id,
				JSON.stringify(record),
			);
	}

	private source(agent: StoredCollaborationAgent): NonNullable<CollaborationTurnRecord["result"]>["source"] {
		return this.directory && agent.sessionFile
			? {
					kind: "native_history",
					session_path: join(this.directory, agent.id, agent.sessionFile),
					turn_id: agent.turnId,
					coverage: "turn",
				}
			: { kind: "unavailable", turn_id: agent.turnId, coverage: "unknown" };
	}

	private seedHistory(snapshot: CollaborationSnapshot): void {
		for (const agent of snapshot.agents) {
			const turn = this.newTurn(agent, true);
			if (agent.result !== undefined)
				turn.result = { preview: agent.result, truncated: null, source: this.source(agent) };
			if (agent.resultValidation) turn.resultValidation = agent.resultValidation;
			if (agent.usage) turn.usage = { ...agent.usage, coverage: "partial" };
			this.writeTurn(turn);
		}
		for (const message of snapshot.messages ?? []) {
			if (message.kind !== "result") continue;
			const agent = snapshot.agents.find((agent) => agent.path === message.from);
			if (!agent || message.to !== agent.parent)
				throw new CollaborationError("storage_error", "Invalid retained result owner");
			const turn =
				this.getTurn(agent.path, { turn_id: message.turnId }) ??
				this.newTurn(
					{ ...agent, turnId: message.turnId, status: "closed", taskMessage: undefined, delegation: undefined },
					true,
				);
			if (
				turn.result_message_id ||
				(turn.result && turn.result.preview !== message.text) ||
				(message.status !== undefined && turn.status !== "unknown" && turn.status !== message.status) ||
				(turn.resultValidation &&
					message.resultValidation &&
					(turn.resultValidation.contract !== message.resultValidation.contract ||
						(turn.resultValidation.outcome !== undefined &&
							message.resultValidation.outcome !== undefined &&
							turn.resultValidation.outcome !== message.resultValidation.outcome)))
			)
				throw new CollaborationError("storage_error", "Conflicting retained result proof");
			turn.result_message_id = message.id;
			turn.status = message.status ?? turn.status;
			turn.result = {
				preview: message.text,
				truncated: null,
				source: this.source({ ...agent, turnId: message.turnId }),
			};
			turn.delivery.state = "enqueued";
			if (message.resultValidation)
				turn.resultValidation = { ...turn.resultValidation, ...message.resultValidation };
			this.writeTurn(turn);
		}
	}

	private syncHistory(
		previous: CollaborationSnapshot,
		next: CollaborationSnapshot,
		patches: readonly TurnPatch[] = [],
	): void {
		const now = Date.now();
		for (const agent of next.agents) {
			const old = previous.agents.find((old) => old.path === agent.path);
			if (
				old &&
				JSON.stringify(old) === JSON.stringify(agent) &&
				!patches.some((p) => p.target === agent.path && p.turn_id === agent.turnId)
			)
				continue;
			let turn = this.getTurn(agent.path, { turn_id: agent.turnId });
			if (turn && agent.status === "closed") continue;
			if (!turn) turn = this.newTurn(agent, false);
			// Interrupt requests revoke agent authority immediately, but the turn is not terminal
			// until the running host or pending-startup cleanup actually settles.
			if (agent.status !== "closed" && !(agent.status === "interrupted" && agent.completionPending)) {
				if (turn.status !== agent.status) {
					if (agent.status === "running") turn.started_at = now;
					if (["completed", "failed", "interrupted"].includes(agent.status)) turn.finished_at = now;
				}
				turn.status = agent.status;
			}
			if (agent.resultValidation) turn.resultValidation = agent.resultValidation;
			if (
				agent.usage &&
				(old?.turnId !== agent.turnId ||
					JSON.stringify(old.usage) !== JSON.stringify(agent.usage) ||
					(old.completionPending && !agent.completionPending))
			)
				turn.usage = { ...agent.usage, coverage: agent.status === "completed" ? "complete" : "partial" };
			else if (agent.status === "interrupted" && !agent.completionPending) turn.usage.coverage = "partial";
			if (
				agent.result !== undefined &&
				(!turn.result || old?.turnId !== agent.turnId || old.result !== agent.result)
			)
				turn.result = { preview: agent.result, truncated: false, source: this.source(agent) };
			const patch = patches.find((p) => p.target === agent.path && p.turn_id === agent.turnId);
			if (patch?.result && turn.result) Object.assign(turn.result, patch.result);
			this.writeTurn(turn);
		}
		for (const message of next.messages ?? []) {
			if (message.kind !== "result" || (previous.messages ?? []).some((old) => old.id === message.id)) continue;
			const turn = this.getTurn(message.from, { turn_id: message.turnId });
			const producer = next.agents.find((agent) => agent.path === message.from);
			if (
				!turn ||
				!producer ||
				message.to !== producer.parent ||
				(turn.result_message_id && turn.result_message_id !== message.id) ||
				(turn.result && turn.result.preview !== message.text) ||
				(message.status !== undefined && turn.status !== message.status) ||
				(turn.resultValidation &&
					message.resultValidation &&
					(turn.resultValidation.contract !== message.resultValidation.contract ||
						(turn.resultValidation.outcome !== undefined &&
							message.resultValidation.outcome !== undefined &&
							turn.resultValidation.outcome !== message.resultValidation.outcome)))
			)
				throw new CollaborationError("storage_error", "Conflicting result notification");
			turn.result_message_id = message.id;
			turn.result ??= {
				preview: message.text,
				truncated: false,
				source: this.source({ ...producer, turnId: message.turnId }),
			};
			turn.delivery = { state: "enqueued", enqueued_at: now, acknowledged_at: null };
			this.writeTurn(turn);
		}
		for (const message of previous.messages ?? []) {
			if (
				message.kind !== "result" ||
				(next.messages ?? []).some((current) => current.id === message.id) ||
				!patches.some((p) => p.target === message.from && p.turn_id === message.turnId && p.acknowledged)
			)
				continue;
			const turn = this.getTurn(message.from, { message_id: message.id });
			if (!turn) throw new CollaborationError("storage_error", "Missing acknowledged turn");
			if (turn.delivery.state !== "acknowledged") {
				turn.delivery.state = "acknowledged";
				turn.delivery.acknowledged_at = now;
				this.writeTurn(turn);
			}
		}
	}

	close(): void {
		if (this.closed) return;
		try {
			this.database
				.prepare("UPDATE team SET owner=NULL, pid=NULL, owner_started_at=NULL WHERE id=1 AND owner=?")
				.run(this.owner);
		} finally {
			this.closed = true;
			this.database.close();
		}
	}
}
