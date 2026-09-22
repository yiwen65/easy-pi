import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type {
	ScannedSession,
	ScanResult,
	ScanStats,
	StatsExcludedReason,
	StatsRecord,
	StatsRecordKind,
	UsageValues,
} from "./types.ts";

/** Provider/model label used when an entry carries no attribution. */
export const UNKNOWN_PROVIDER = "(unknown)";
export const UNKNOWN_MODEL = "(unknown)";

/** Directory prefixes whose sessions are test/temporary runs rather than real work. */
const TEMP_PATH_ROOTS = [
	"/var/folders",
	"/private/var/folders",
	"/tmp",
	"/private/tmp",
	"/var/tmp",
	"/private/var/tmp",
];

export interface ScanSessionsOptions {
	/** Session roots, e.g. `~/.epi/agent/sessions`. Every root is walked recursively. */
	roots: readonly string[];
}

interface SessionHeaderLike {
	type?: unknown;
	version?: unknown;
	id?: unknown;
	timestamp?: unknown;
	cwd?: unknown;
	parentSession?: unknown;
}

interface ExtractedUsage {
	kind: StatsRecordKind;
	provider: string;
	model: string;
	timestampMs: number | null;
	usage: UsageValues;
}

interface ScannedFile {
	session: ScannedSession;
	bytes: number;
	parseErrors: number;
}

/**
 * Walk every root recursively and read all `*.jsonl` session files.
 *
 * Pure IO + parsing: no caching, no filtering. Sessions that only look like test
 * runs (temporary cwd, `faux` provider) are marked via `excluded`/`excludedReason`
 * instead of being dropped, so callers can aggregate either way from one scan.
 */
export function scanSessions(options: ScanSessionsOptions): ScanResult {
	const startedAt = Date.now();
	const roots = options.roots.filter((root) => root.trim().length > 0).map((root) => resolve(root));
	const sessions: ScannedSession[] = [];
	const records: StatsRecord[] = [];
	let files = 0;
	let bytes = 0;
	let parseErrors = 0;
	let skippedFiles = 0;

	for (const root of roots) {
		for (const filePath of walkJsonlFiles(root)) {
			files++;
			const scanned = scanSessionFile(filePath, sessions.length);
			if (!scanned) {
				skippedFiles++;
				continue;
			}
			bytes += scanned.bytes;
			parseErrors += scanned.parseErrors;
			sessions.push(scanned.session);
			for (const record of scanned.records) records.push(record);
		}
	}

	const stats: ScanStats = {
		roots,
		files,
		bytes,
		scanMs: Date.now() - startedAt,
		parseErrors,
		skippedFiles,
	};
	return { stats, sessions, records };
}

/** Depth-first walk over `*.jsonl` files, with sorted entries for deterministic output. */
function* walkJsonlFiles(root: string): Generator<string> {
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) break;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				yield fullPath;
			}
		}
	}
}

function scanSessionFile(filePath: string, sessionIndex: number): (ScannedFile & { records: StatsRecord[] }) | null {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		return null;
	}

	const lines = text.split("\n");
	const headerIndex = lines.findIndex((line) => line.trim().length > 0);
	if (headerIndex < 0) return null;

	let header: SessionHeaderLike;
	try {
		header = JSON.parse(lines[headerIndex] as string) as SessionHeaderLike;
	} catch {
		return null;
	}
	if (header.type !== "session" || header.version !== 3) return null;

	const cwd = typeof header.cwd === "string" ? header.cwd : "";
	const startedAt = typeof header.timestamp === "string" ? header.timestamp : null;
	const parentSession = typeof header.parentSession === "string" ? header.parentSession : null;
	// Forked sessions copy the parent's entries verbatim; those keep their original
	// timestamps and were already billed in the parent file (createBranchedSession).
	const forkTimestampMs = parentSession !== null ? Date.parse(startedAt ?? "") : Number.NaN;
	const forkFilterEnabled = Number.isFinite(forkTimestampMs);

	const totals: UsageValues = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	const records: StatsRecord[] = [];
	const providers = new Set<string>();
	const models = new Set<string>();
	let messages = 0;
	let usageEntries = 0;
	let forkInheritedEntries = 0;
	let parseErrors = 0;
	let modifiedAt: string | null = startedAt;

	for (let index = headerIndex + 1; index < lines.length; index++) {
		const line = lines[index];
		if (line === undefined || line.trim().length === 0) continue;

		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			parseErrors++;
			continue;
		}

		const entryTimestampMs = parseTimestampMs(entry.timestamp);
		if (forkFilterEnabled && entryTimestampMs !== null && entryTimestampMs < forkTimestampMs) {
			forkInheritedEntries++;
			continue;
		}
		if (entryTimestampMs !== null) modifiedAt = new Date(entryTimestampMs).toISOString();

		const type = typeof entry.type === "string" ? entry.type : "";
		if (type === "message") messages++;
		if (type === "model_change" && typeof entry.provider === "string" && entry.provider.length > 0) {
			providers.add(entry.provider);
		}

		const extracted = extractUsage(entry);
		if (!extracted) continue;
		usageEntries++;
		addUsageValues(totals, extracted.usage);
		providers.add(extracted.provider);
		models.add(`${extracted.provider}/${extracted.model}`);
		records.push({
			sessionIndex,
			kind: extracted.kind,
			timestampMs: extracted.timestampMs,
			provider: extracted.provider,
			model: extracted.model,
			...extracted.usage,
		});
	}

	const excludedReason = excludedReasonFor(cwd, providers);
	const session: ScannedSession = {
		path: filePath,
		id: typeof header.id === "string" ? header.id : basename(filePath),
		cwd,
		project: cwd.length > 0 ? basename(cwd) : "(unknown)",
		startedAt,
		modifiedAt,
		messages,
		usageEntries,
		models: Array.from(models).sort(),
		excluded: excludedReason !== null,
		excludedReason,
		forkInheritedEntries,
		parentSession,
		...totals,
	};

	return { session, records, bytes: Buffer.byteLength(text), parseErrors };
}

/** Mark test/temporary sessions. Order matters: temp cwd wins over provider heuristics. */
function excludedReasonFor(cwd: string, providers: ReadonlySet<string>): StatsExcludedReason | null {
	if (cwd.length > 0 && isTempPath(cwd)) return "temp-cwd";
	if (providers.size === 1 && providers.has("faux")) return "faux-provider";
	return null;
}

/** True when `target` is a temporary directory itself or lives below one. */
export function isTempPath(target: string): boolean {
	const normalized = resolve(target);
	const candidates = [tmpdir(), ...TEMP_PATH_ROOTS];
	for (const candidate of candidates) {
		const root = resolve(candidate);
		if (normalized === root) return true;
		if (normalized.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return true;
	}
	return false;
}

function extractUsage(entry: Record<string, unknown>): ExtractedUsage | null {
	const type = entry.type;
	if (type === "message") {
		const message = asRecord(entry.message);
		if (!message) return null;
		const usage = asUsageValues(message.usage);
		if (!usage) return null;
		if (message.role === "assistant") {
			return {
				kind: "assistant",
				provider: asNonEmptyString(message.provider) ?? UNKNOWN_PROVIDER,
				model: asNonEmptyString(message.responseModel) ?? asNonEmptyString(message.model) ?? UNKNOWN_MODEL,
				timestampMs: parseTimestampMs(message.timestamp) ?? parseTimestampMs(entry.timestamp),
				usage,
			};
		}
		if (message.role === "toolResult") {
			return {
				kind: "toolResult",
				provider: UNKNOWN_PROVIDER,
				model: UNKNOWN_MODEL,
				timestampMs: parseTimestampMs(message.timestamp) ?? parseTimestampMs(entry.timestamp),
				usage,
			};
		}
		return null;
	}
	if (type === "compaction" || type === "branch_summary") {
		const usage = asUsageValues(entry.usage);
		if (!usage) return null;
		return {
			kind: type,
			provider: UNKNOWN_PROVIDER,
			model: UNKNOWN_MODEL,
			timestampMs: parseTimestampMs(entry.timestamp),
			usage,
		};
	}
	return null;
}

function asUsageValues(value: unknown): UsageValues | null {
	const usage = asRecord(value);
	if (!usage) return null;
	// Values are consumed verbatim (the frozen contract forbids estimation), so a
	// malformed object degrades to 0 for the individual missing field only.
	const costRecord = asRecord(usage.cost);
	return {
		input: asFiniteNumber(usage.input),
		output: asFiniteNumber(usage.output),
		cacheRead: asFiniteNumber(usage.cacheRead),
		cacheWrite: asFiniteNumber(usage.cacheWrite),
		totalTokens: asFiniteNumber(usage.totalTokens),
		cost: asFiniteNumber(costRecord?.total),
	};
}

function addUsageValues(target: UsageValues, values: UsageValues): void {
	target.input += values.input;
	target.output += values.output;
	target.cacheRead += values.cacheRead;
	target.cacheWrite += values.cacheWrite;
	target.totalTokens += values.totalTokens;
	target.cost += values.cost;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseTimestampMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}
