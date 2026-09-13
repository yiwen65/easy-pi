import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	COLLABORATION_LIMITS,
	CollaborationError,
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
		text: Type.String({ maxLength: COLLABORATION_LIMITS.maxMessageBytes }),
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
		contextBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: COLLABORATION_LIMITS.maxForkBytes })),
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
			maxItems: COLLABORATION_LIMITS.maxAgents * COLLABORATION_LIMITS.maxPendingMessages,
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
			Buffer.byteLength(message.text, "utf8") > COLLABORATION_LIMITS.maxMessageBytes
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
 * One versioned team snapshot, unrelated to the legacy DAG database. Each commit is durable.
 * SQLite admission and owner-token checks prevent concurrent control of the same team.
 */
export class CollaborationStore {
	private readonly database: DatabaseSync;
	private readonly owner = randomUUID();
	private closed = false;
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
			} else {
				// Older registries predate the PID-reuse guard column; add it in place.
				const columns = this.database
					.prepare("PRAGMA table_info(team)")
					.all()
					.map((column) => (column as { name: string }).name);
				if (!columns.includes("owner_started_at")) {
					this.database.exec("ALTER TABLE team ADD COLUMN owner_started_at INTEGER");
				}
			}
			this.database.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
			try {
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
				for (const agent of snapshot.agents) {
					if (agent.status === "pending" || agent.status === "running") agent.status = "interrupted";
					if (agent.completionPending) {
						if (agent.delegation)
							agent.resultValidation = { contract: "not_completed", acceptance: "not_reviewed" };
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
				snapshot.revision++;
				this.database
					.prepare("UPDATE team SET snapshot=?, owner=?, pid=?, owner_started_at=? WHERE id=1")
					.run(JSON.stringify(snapshot), this.owner, process.pid, ownProcessStartMs());
				this.database.exec("COMMIT");
				this.cacheAuthority(snapshot, version);
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
	commit(snapshot: CollaborationSnapshot): CollaborationSnapshot {
		const next = validateSnapshot(snapshot);
		if (next.rootSessionId !== this.rootSessionId || next.cwd !== this.cwd)
			throw new CollaborationError("forbidden", "Invalid team owner");
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const version = this.dataVersion();
			const current = this.read();
			if (current.revision !== next.revision) throw new CollaborationError("busy", "Stale team revision");
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
