import { randomBytes } from "node:crypto";

export type SnapshotFormat = "text" | "markdown";

/** Immutable capture result kept for later pagination; never HTML, cookies or a live browser handle. */
export interface SnapshotContent {
	/** Cleaned text of the whole capture, never only the current output page. */
	text: string;
	requestedUrl: string;
	url: string;
	title: string;
	capturedAt: string;
	format: SnapshotFormat;
	scanComplete: boolean;
	captureTruncated: boolean;
	incompleteReasons: readonly string[];
	warnings: readonly string[];
	contentStatus: string;
}

export interface SnapshotStoreOptions {
	/** Injectable clock; defaults to Date.now. Used only for absolute TTL checks. */
	now?: () => number;
	ttlMs?: number;
	maxPerOwner?: number;
	maxOwnerBytes?: number;
	maxProcessCount?: number;
	maxProcessBytes?: number;
	/** Injectable id generator; must return a non-empty, unpredictable string. */
	idFactory?: () => string;
	/** Process-wide accounting shared with other stores; when omitted a private pool is created. */
	pool?: SnapshotPool;
}

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_MAX_PER_OWNER = 8;
const DEFAULT_MAX_OWNER_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PROCESS_COUNT = 32;
const DEFAULT_MAX_PROCESS_BYTES = 32 * 1024 * 1024;
const MAX_TITLE_CHARS = 512;
const MAX_URL_CHARS = 2048;
const MAX_LABEL_CHARS = 64;
const MAX_LIST_ITEMS = 64;
const MAX_ID_CHARS = 128;

interface StoredEntry {
	id: string;
	bytes: number;
	expiresAt: number;
	store: SnapshotStore;
}

interface OwnedEntry extends StoredEntry {
	content: SnapshotContent;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
	return value;
}

function isOwner(value: unknown): value is object {
	return value !== null && (typeof value === "object" || typeof value === "function");
}

function boundedString(value: unknown, maxChars: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxChars;
}

function boundedStrings(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_LIST_ITEMS &&
		value.every((item) => typeof item === "string" && item.length <= MAX_TITLE_CHARS)
	);
}

/** Bound the stored shape: metadata is clamped by rejection, text only by the byte budget. */
function prepareContent(value: SnapshotContent): SnapshotContent | undefined {
	if (value === null || typeof value !== "object") return undefined;
	if (typeof value.text !== "string" || value.text.length === 0) return undefined;
	if (value.format !== "text" && value.format !== "markdown") return undefined;
	if (!boundedString(value.requestedUrl, MAX_URL_CHARS) || !boundedString(value.url, MAX_URL_CHARS)) return undefined;
	if (typeof value.title !== "string" || value.title.length > MAX_TITLE_CHARS) return undefined;
	if (!boundedString(value.capturedAt, MAX_LABEL_CHARS) || !boundedString(value.contentStatus, MAX_LABEL_CHARS))
		return undefined;
	if (typeof value.scanComplete !== "boolean" || typeof value.captureTruncated !== "boolean") return undefined;
	if (!boundedStrings(value.incompleteReasons) || !boundedStrings(value.warnings)) return undefined;
	return Object.freeze({
		text: value.text,
		requestedUrl: value.requestedUrl,
		url: value.url,
		title: value.title,
		capturedAt: value.capturedAt,
		format: value.format,
		scanComplete: value.scanComplete,
		captureTruncated: value.captureTruncated,
		incompleteReasons: Object.freeze([...value.incompleteReasons]),
		warnings: Object.freeze([...value.warnings]),
		contentStatus: value.contentStatus,
	});
}

/** A detached copy; callers can never mutate stored state or another page of the same snapshot. */
function copyContent(content: SnapshotContent): SnapshotContent {
	return Object.freeze({
		...content,
		incompleteReasons: Object.freeze([...content.incompleteReasons]),
		warnings: Object.freeze([...content.warnings]),
	});
}

function byteSize(content: SnapshotContent): number {
	return Buffer.byteLength(JSON.stringify(content), "utf8");
}

/**
 * Process-wide snapshot accounting shared by every store of one host process.
 *
 * Entries are ordered by last access: the first entry is the least recently used
 * one and is evicted first, whichever owner it belongs to. Limits are per host
 * process, not machine-wide. The pool holds at most `maxCount` strong references,
 * so an idle session object can be retained no longer than the snapshot TTL.
 */
export class SnapshotPool {
	readonly maxCount: number;
	readonly maxBytes: number;
	private entries = new Set<StoredEntry>();
	private used = 0;

	constructor(limits: { maxCount?: number; maxBytes?: number } = {}) {
		this.maxCount = positiveInteger(limits.maxCount, DEFAULT_MAX_PROCESS_COUNT, "maxCount");
		this.maxBytes = positiveInteger(limits.maxBytes, DEFAULT_MAX_PROCESS_BYTES, "maxBytes");
	}

	get count(): number {
		return this.entries.size;
	}

	get bytes(): number {
		return this.used;
	}

	/** Internal: register a stored entry as the most recently used one and enforce the pool limits. */
	insert(entry: StoredEntry): void {
		this.entries.delete(entry);
		this.entries.add(entry);
		this.used += entry.bytes;
		this.enforce();
	}

	/** Internal: mark an entry as most recently used. */
	touch(entry: StoredEntry): void {
		if (!this.entries.has(entry)) return;
		this.entries.delete(entry);
		this.entries.add(entry);
	}

	/** Internal: forget an entry that its store removed. */
	remove(entry: StoredEntry): void {
		if (this.entries.delete(entry)) this.used -= entry.bytes;
	}

	/** Internal: drop every expired entry. Called from reads and writes, so no timer keeps the host alive. */
	sweep(now: number): void {
		for (const entry of [...this.entries]) if (now >= entry.expiresAt) entry.store.drop(entry);
	}

	/** Internal: entries in least-recently-used-first order. */
	entriesInOrder(): StoredEntry[] {
		return [...this.entries];
	}

	private enforce(): void {
		while (this.entries.size > this.maxCount || this.used > this.maxBytes) {
			const oldest = this.entries.values().next();
			if (oldest.done) return;
			oldest.value.store.drop(oldest.value);
		}
	}
}

/**
 * Bounded, immutable snapshot storage for one owner (session host object).
 *
 * One store serves exactly one owner object, fixed on the first write; a call with
 * a different owner is refused, so a random id can never stand in for authorization.
 * `size` and `bytes` report process-wide totals of the shared pool, while the
 * per-owner limits are enforced on this store's own entries.
 */
export class SnapshotStore {
	private now: () => number;
	private ttlMs: number;
	private maxPerOwner: number;
	private maxOwnerBytes: number;
	private idFactory: () => string;
	private pool: SnapshotPool;
	private entries = new Map<string, OwnedEntry>();
	private owner: object | undefined;

	constructor(options: SnapshotStoreOptions = {}) {
		this.now = options.now ?? Date.now;
		this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS, "ttlMs");
		this.maxPerOwner = positiveInteger(options.maxPerOwner, DEFAULT_MAX_PER_OWNER, "maxPerOwner");
		this.maxOwnerBytes = positiveInteger(options.maxOwnerBytes, DEFAULT_MAX_OWNER_BYTES, "maxOwnerBytes");
		this.idFactory = options.idFactory ?? (() => randomBytes(16).toString("hex"));
		this.pool =
			options.pool ?? new SnapshotPool({ maxCount: options.maxProcessCount, maxBytes: options.maxProcessBytes });
	}

	get size(): number {
		return this.pool.count;
	}

	get bytes(): number {
		return this.pool.bytes;
	}

	/** Store a capture result. Returns its handle, or undefined when it cannot be stored safely. */
	put(owner: object, content: SnapshotContent): string | undefined {
		if (!isOwner(owner)) return undefined;
		if (this.owner === undefined) this.owner = owner;
		else if (this.owner !== owner) return undefined;
		const prepared = prepareContent(content);
		if (!prepared) return undefined;
		const bytes = byteSize(prepared);
		if (bytes > this.maxOwnerBytes || bytes > this.pool.maxBytes) return undefined;
		const id = this.nextId();
		if (id === undefined) return undefined;
		const now = this.now();
		this.pool.sweep(now);
		const entry: OwnedEntry = {
			id,
			bytes,
			expiresAt: now + this.ttlMs,
			store: this,
			content: prepared,
		};
		this.entries.set(id, entry);
		this.pool.insert(entry);
		this.enforceOwnerLimits();
		return this.entries.has(id) ? id : undefined;
	}

	/** Read one page source by handle. Unknown owners, unknown ids and expired entries are indistinguishable. */
	get(owner: object, id: string): SnapshotContent | undefined {
		if (!isOwner(owner) || this.owner !== owner || typeof id !== "string" || id.length === 0) return undefined;
		const now = this.now();
		this.pool.sweep(now);
		const entry = this.entries.get(id);
		if (!entry) return undefined;
		if (now >= entry.expiresAt) {
			this.drop(entry);
			return undefined;
		}
		this.pool.touch(entry);
		return copyContent(entry.content);
	}

	/** Internal: remove one entry, called by pool eviction and expiry. */
	drop(entry: StoredEntry): void {
		if (this.entries.get(entry.id) !== entry) return;
		this.entries.delete(entry.id);
		this.pool.remove(entry);
	}

	private nextId(): string | undefined {
		for (let attempt = 0; attempt < 3; attempt++) {
			const id = this.idFactory();
			if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_CHARS) continue;
			if (!this.entries.has(id)) return id;
		}
		return undefined;
	}

	private enforceOwnerLimits(): void {
		while (this.entries.size > this.maxPerOwner || this.ownerBytes() > this.maxOwnerBytes) {
			const oldest = this.oldestOwnEntry();
			if (!oldest) return;
			this.drop(oldest);
		}
	}

	private oldestOwnEntry(): StoredEntry | undefined {
		for (const entry of this.pool.entriesInOrder()) if (entry.store === this) return entry;
		return undefined;
	}

	private ownerBytes(): number {
		let used = 0;
		for (const entry of this.entries.values()) used += entry.bytes;
		return used;
	}
}

const stores = new WeakMap<object, SnapshotStore>();
const defaultPool = new SnapshotPool();

/**
 * Snapshot storage is a host setting: only the launcher environment can disable it.
 * A page or tool argument can never enable, disable or widen it.
 */
export function snapshotsEnabled(): boolean {
	return process.env.PI_WEB_FETCH_SNAPSHOTS !== "0";
}

/**
 * The store of one session host object. Different objects never share a store; a
 * missing or unusable owner yields undefined instead of a shared fallback store.
 */
export function snapshotStore(owner: object): SnapshotStore | undefined {
	if (!snapshotsEnabled() || !isOwner(owner)) return undefined;
	let store = stores.get(owner);
	if (!store) {
		store = new SnapshotStore({ pool: defaultPool });
		stores.set(owner, store);
	}
	return store;
}
