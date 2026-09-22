import { basename } from "node:path";
import type {
	DayBucket,
	ModelBucket,
	ProjectBucket,
	ProviderBucket,
	ScannedSession,
	ScanResult,
	SessionRow,
	StatsBucket,
	StatsQuery,
	StatsSnapshot,
	UsageValues,
} from "./types.ts";

/**
 * Costs are normalized to 1e-6 USD so repeated scans and per-bucket sums render
 * stable digits instead of float noise.
 */
const VALUE_PRECISION = 6;

/** Local calendar day of an epoch timestamp, `YYYY-MM-DD`. */
export function localDayKey(timestampMs: number): string {
	const date = new Date(timestampMs);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** Cache-read share of all prompt-side tokens: `cacheRead / (input + cacheRead + cacheWrite)`. */
export function usageCacheHitRate(values: Pick<UsageValues, "input" | "cacheRead" | "cacheWrite">): number {
	const denominator = values.input + values.cacheRead + values.cacheWrite;
	if (denominator <= 0) return 0;
	return values.cacheRead / denominator;
}

interface Bucket extends UsageValues {
	messages: number;
	sessionIndexes: Set<number>;
}

interface ModelAccumulator {
	bucket: Bucket;
	provider: string;
	model: string;
}

interface ProjectAccumulator {
	bucket: Bucket;
	cwd: string;
	name: string;
	lastUsedAtMs: number | null;
}

interface SessionAccumulator {
	bucket: Bucket;
	session: ScannedSession;
	models: Set<string>;
}

/**
 * Aggregate a reusable scan result into the frozen snapshot shape.
 *
 * Sessions flagged `excluded` (test/temp runs) stay out of every total unless
 * `includeAll` is set; they are still reported through the `excluded` summary.
 */
export function buildSnapshot(scanResult: ScanResult, query: StatsQuery = {}): StatsSnapshot {
	const includeAll = query.includeAll === true;
	const from = normalizeDay(query.from);
	const to = normalizeDay(query.to);
	const top = normalizeTop(query.top);

	const totals = createBucket();
	const dayBuckets = new Map<string, Bucket>();
	const modelBuckets = new Map<string, ModelAccumulator>();
	const providerBuckets = new Map<string, Bucket>();
	const projectBuckets = new Map<string, ProjectAccumulator>();
	const sessionAccs = new Map<number, SessionAccumulator>();
	let minDay: string | null = null;
	let maxDay: string | null = null;

	for (const record of scanResult.records) {
		const session = scanResult.sessions[record.sessionIndex];
		if (!session) continue;
		if (session.excluded && !includeAll) continue;

		let day: string | null = null;
		if (record.timestampMs !== null) {
			day = localDayKey(record.timestampMs);
			if (from !== null && day < from) continue;
			if (to !== null && day > to) continue;
			if (minDay === null || day < minDay) minDay = day;
			if (maxDay === null || day > maxDay) maxDay = day;
		}
		// Records without a timestamp cannot be placed on the calendar, but they
		// still belong to the totals.

		addRecord(totals, record);
		if (day !== null) addRecord(getOrCreate(dayBuckets, day, createBucket), record);

		const modelKey = `${record.provider}/${record.model}`;
		const modelAcc = getOrCreate(modelBuckets, modelKey, () => ({
			bucket: createBucket(),
			provider: record.provider,
			model: record.model,
		}));
		addRecord(modelAcc.bucket, record);

		addRecord(getOrCreate(providerBuckets, record.provider, createBucket), record);

		const projectAcc = getOrCreate(projectBuckets, session.cwd, () => ({
			bucket: createBucket(),
			cwd: session.cwd,
			name: session.cwd.length > 0 ? basename(session.cwd) : "(unknown)",
			lastUsedAtMs: null,
		}));
		addRecord(projectAcc.bucket, record);
		if (record.timestampMs !== null) {
			projectAcc.lastUsedAtMs = maxTimestamp(projectAcc.lastUsedAtMs, record.timestampMs);
		}

		const sessionAcc = getOrCreate(sessionAccs, record.sessionIndex, () => ({
			bucket: createBucket(),
			session,
			models: new Set<string>(),
		}));
		addRecord(sessionAcc.bucket, record);
		sessionAcc.models.add(modelKey);
	}

	const byDay: DayBucket[] = Array.from(dayBuckets, ([day, bucket]) => ({
		day,
		...finalizeBucket(bucket),
	})).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

	const byModel: ModelBucket[] = sortByCost(
		Array.from(modelBuckets, ([key, acc]) => ({
			key,
			provider: acc.provider,
			model: acc.model,
			...finalizeBucket(acc.bucket),
		})),
		(row) => row.key,
	);
	const byProvider: ProviderBucket[] = sortByCost(
		Array.from(providerBuckets, ([provider, bucket]) => ({ provider, ...finalizeBucket(bucket) })),
		(row) => row.provider,
	);
	const byProject: ProjectBucket[] = sortByCost(
		Array.from(projectBuckets.values(), (acc) => ({
			cwd: acc.cwd,
			name: acc.name,
			lastUsedAt: acc.lastUsedAtMs !== null ? new Date(acc.lastUsedAtMs).toISOString() : null,
			...finalizeBucket(acc.bucket),
		})),
		(row) => row.cwd,
	);

	const sessions: SessionRow[] = Array.from(sessionAccs.values(), (acc) => ({
		path: acc.session.path,
		id: acc.session.id,
		cwd: acc.session.cwd,
		project: acc.session.project,
		startedAt: acc.session.startedAt,
		modifiedAt: acc.session.modifiedAt,
		models: Array.from(acc.models).sort(),
		excluded: acc.session.excluded,
		excludedReason: acc.session.excludedReason,
		...finalizeBucket(acc.bucket),
	}))
		.filter((row) => includeAll || !row.excluded)
		.sort(compareSessionRows);

	const excluded = summarizeExcluded(scanResult.sessions);
	const totalsBucket = finalizeBucket(totals);

	return {
		generatedAt: new Date().toISOString(),
		scan: {
			roots: [...scanResult.stats.roots],
			files: scanResult.stats.files,
			bytes: scanResult.stats.bytes,
			scanMs: scanResult.stats.scanMs,
			parseErrors: scanResult.stats.parseErrors,
			cached: query.cached === true,
		},
		range: { from: from ?? minDay, to: to ?? maxDay },
		totals: { ...totalsBucket, cacheHitRate: roundValue(usageCacheHitRate(totals)) },
		byDay,
		byModel: top !== null ? byModel.slice(0, top) : byModel,
		byProvider: top !== null ? byProvider.slice(0, top) : byProvider,
		byProject: top !== null ? byProject.slice(0, top) : byProject,
		sessions,
		excluded,
	};
}

function createBucket(): Bucket {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		messages: 0,
		sessionIndexes: new Set(),
	};
}

function addRecord(bucket: Bucket, record: UsageValues & { sessionIndex: number }): void {
	bucket.input += record.input;
	bucket.output += record.output;
	bucket.cacheRead += record.cacheRead;
	bucket.cacheWrite += record.cacheWrite;
	bucket.totalTokens += record.totalTokens;
	bucket.cost += record.cost;
	bucket.messages++;
	bucket.sessionIndexes.add(record.sessionIndex);
}

/** Drop the internal session set and normalize float noise. */
function finalizeBucket(bucket: Bucket): StatsBucket {
	return {
		input: bucket.input,
		output: bucket.output,
		cacheRead: bucket.cacheRead,
		cacheWrite: bucket.cacheWrite,
		totalTokens: bucket.totalTokens,
		cost: roundValue(bucket.cost),
		sessions: bucket.sessionIndexes.size,
		messages: bucket.messages,
	};
}

function summarizeExcluded(sessions: readonly ScannedSession[]): StatsSnapshot["excluded"] {
	let count = 0;
	let cost = 0;
	let totalTokens = 0;
	const reasons: Record<string, number> = {};
	for (const session of sessions) {
		if (!session.excluded) continue;
		count++;
		cost += session.cost;
		totalTokens += session.totalTokens;
		const reason = session.excludedReason ?? "unknown";
		reasons[reason] = (reasons[reason] ?? 0) + 1;
	}
	return { sessions: count, cost: roundValue(cost), totalTokens, reasons };
}

function sortByCost<T extends UsageValues>(rows: T[], keyOf: (row: T) => string): T[] {
	return rows.sort((a, b) => {
		if (b.cost !== a.cost) return b.cost - a.cost;
		if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
		const keyA = keyOf(a);
		const keyB = keyOf(b);
		return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
	});
}

function compareSessionRows(a: SessionRow, b: SessionRow): number {
	if (b.cost !== a.cost) return b.cost - a.cost;
	if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
	const startedA = a.startedAt ?? "";
	const startedB = b.startedAt ?? "";
	if (startedA !== startedB) return startedA < startedB ? -1 : 1;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
	const existing = map.get(key);
	if (existing !== undefined) return existing;
	const created = create();
	map.set(key, created);
	return created;
}

function maxTimestamp(current: number | null, candidate: number): number {
	if (current === null || candidate > current) return candidate;
	return current;
}

function roundValue(value: number): number {
	if (!Number.isFinite(value) || value === 0) return 0;
	return Math.round(value * 10 ** VALUE_PRECISION) / 10 ** VALUE_PRECISION;
}

function normalizeDay(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function normalizeTop(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return Math.floor(value);
}
