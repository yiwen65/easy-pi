/**
 * DTOs for the local token-usage statistics (`epi stats`).
 *
 * The field names of `StatsSnapshot` are frozen by
 * `docs/tasks/2026-09-20-token-usage-stats-web-panel-task.md` ("冻结契约"):
 * the HTTP layer and the browser panel are built against them, so do not rename
 * or restructure them without updating that document.
 */

/** Why a session is left out of the default totals. */
export type StatsExcludedReason = "temp-cwd" | "faux-provider";

/** Entry kinds that carry billable usage. */
export type StatsRecordKind = "assistant" | "toolResult" | "compaction" | "branch_summary";

/** Token and cost values, accumulated verbatim from session entries. */
export interface UsageValues {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

/** One usage-bearing session entry. */
export interface StatsRecord extends UsageValues {
	/** Index of the owning session inside `ScanResult.sessions`. */
	sessionIndex: number;
	kind: StatsRecordKind;
	/** Epoch ms, from `message.timestamp` or the entry `timestamp`; null when unknown. */
	timestampMs: number | null;
	provider: string;
	/** `responseModel ?? model`; `(unknown)` for entries without model attribution. */
	model: string;
}

/** Per-session scan result. `excluded` flags are marking-only: records are kept. */
export interface ScannedSession extends UsageValues {
	path: string;
	id: string;
	cwd: string;
	project: string;
	startedAt: string | null;
	modifiedAt: string | null;
	/** Number of `message` entries in the file (all roles), after fork filtering. */
	messages: number;
	/** Number of usage-bearing entries counted for this session. */
	usageEntries: number;
	/** Distinct `provider/model` keys seen in this session. */
	models: string[];
	excluded: boolean;
	excludedReason: StatsExcludedReason | null;
	/** Entries skipped because they were inherited from the parent of a forked session. */
	forkInheritedEntries: number;
	parentSession: string | null;
}

export interface ScanStats {
	roots: string[];
	/** `*.jsonl` files discovered while walking the roots. */
	files: number;
	/** Bytes read from valid session files. */
	bytes: number;
	scanMs: number;
	/** Lines that failed to parse as JSON. */
	parseErrors: number;
	/** Files skipped because they were unreadable or not v3 session files. */
	skippedFiles: number;
}

/** Reusable, IO-free scan output: the HTTP layer caches this and re-aggregates per request. */
export interface ScanResult {
	stats: ScanStats;
	sessions: ScannedSession[];
	records: StatsRecord[];
}

export interface StatsQuery {
	/** Inclusive local calendar day, `YYYY-MM-DD`. */
	from?: string | null;
	/** Inclusive local calendar day, `YYYY-MM-DD`. */
	to?: string | null;
	/** Include sessions marked `excluded` (test/temp sessions). Default false. */
	includeAll?: boolean;
	/** Truncate `byModel`/`byProvider`/`byProject` to the top N rows by cost. Default: no truncation. */
	top?: number | null;
	/** Echoed into `scan.cached` by the caller that served a cached scan. */
	cached?: boolean;
}

export interface StatsBucket extends UsageValues {
	sessions: number;
	messages: number;
}

export interface DayBucket extends StatsBucket {
	/** Local calendar day, `YYYY-MM-DD`. */
	day: string;
}

export interface ModelBucket extends StatsBucket {
	/** `${provider}/${model}`. */
	key: string;
	provider: string;
	model: string;
}

export interface ProviderBucket extends StatsBucket {
	provider: string;
}

export interface ProjectBucket extends StatsBucket {
	cwd: string;
	/** `basename(cwd)`. */
	name: string;
	/** Newest record timestamp in this project, ISO; null when unknown. */
	lastUsedAt: string | null;
}

export interface SessionRow extends UsageValues {
	path: string;
	id: string;
	cwd: string;
	project: string;
	startedAt: string | null;
	modifiedAt: string | null;
	/** Usage-bearing entries in range for this session. */
	messages: number;
	models: string[];
	excluded: boolean;
	excludedReason: StatsExcludedReason | null;
}

export interface StatsSnapshot {
	generatedAt: string;
	scan: {
		roots: string[];
		files: number;
		bytes: number;
		scanMs: number;
		parseErrors: number;
		cached: boolean;
	};
	/** Effective range: requested bounds, otherwise the data span of included records. */
	range: { from: string | null; to: string | null };
	totals: StatsBucket & { cacheHitRate: number };
	byDay: DayBucket[];
	byModel: ModelBucket[];
	byProvider: ProviderBucket[];
	byProject: ProjectBucket[];
	sessions: SessionRow[];
	excluded: {
		sessions: number;
		cost: number;
		totalTokens: number;
		/** reason -> session count. */
		reasons: Record<string, number>;
	};
}
