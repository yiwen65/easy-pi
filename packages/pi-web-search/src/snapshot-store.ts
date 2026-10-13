import { randomBytes } from "node:crypto";
import {
	MAX_CAPTURE_BLOCKS,
	STRUCTURE_TYPES,
	type StructureBlock,
	type StructureLinkSpan,
	type StructureType,
} from "./content-format.ts";

export type SnapshotFormat = "text" | "markdown";

/**
 * WF08: the capture-time scan counters, kept with the snapshot so a continuation page can report
 * what the capture did instead of reporting 0 / "none" / null. The capture-time values are the only
 * values that exist for a continuation: nothing is read again, so there is no new measurement.
 */
export interface SnapshotCaptureMeta {
	framesRead: number;
	scrollSteps: number;
	blockedRequests: number;
	dnsMode: "pinned_public_ip" | "local_fake_ip_client" | "none";
	stabilized: boolean;
	ambiguities: readonly string[];
}

/** WF08: which document a stored block came from; indexed by StructureBlock.frame. */
export interface SnapshotFrameProvenance {
	url: string;
	status: string;
	reasons: readonly string[];
	role: "main" | "embedded";
}

/** Immutable capture result kept for later pagination; never HTML, cookies or a live browser handle. */
export interface SnapshotContent {
	/** Cleaned text of the whole capture in its own format, never only the current output page. */
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
	/** Capture-time counters; optional so a capture written without them stays readable. */
	meta?: SnapshotCaptureMeta;
	/** Structure of exactly `text`, with code point offsets into it (WF08). */
	blocks?: readonly StructureBlock[];
	/** Per-frame provenance indexed by `StructureBlock.frame` (WF08). */
	frames?: readonly SnapshotFrameProvenance[];
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
/** Bounded structure: at most a few links per block, and never an unbounded label list. */
const MAX_BLOCK_LINKS = 64;

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

/** A counter or offset: a finite non-negative integer, so no NaN, fraction or Infinity is stored. */
function counter(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

const DNS_MODES: readonly string[] = ["pinned_public_ip", "local_fake_ip_client", "none"];

function prepareMeta(value: unknown): SnapshotCaptureMeta | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object") return undefined;
	const meta = value as SnapshotCaptureMeta;
	if (!counter(meta.framesRead) || !counter(meta.scrollSteps) || !counter(meta.blockedRequests)) return undefined;
	if (typeof meta.dnsMode !== "string" || !DNS_MODES.includes(meta.dnsMode)) return undefined;
	if (typeof meta.stabilized !== "boolean" || !boundedStrings(meta.ambiguities)) return undefined;
	return Object.freeze({
		framesRead: meta.framesRead,
		scrollSteps: meta.scrollSteps,
		blockedRequests: meta.blockedRequests,
		dnsMode: meta.dnsMode,
		stabilized: meta.stabilized,
		ambiguities: Object.freeze([...meta.ambiguities]),
	});
}

function prepareLink(value: unknown): StructureLinkSpan | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const link = value as StructureLinkSpan;
	if (!counter(link.start) || !counter(link.end) || link.end <= link.start) return undefined;
	if (typeof link.href !== "string" || link.href.length === 0 || link.href.length > MAX_URL_CHARS) return undefined;
	if (link.title !== undefined && (typeof link.title !== "string" || link.title.length > MAX_TITLE_CHARS))
		return undefined;
	const prepared: StructureLinkSpan = { start: link.start, end: link.end, href: link.href };
	if (link.title !== undefined) prepared.title = link.title;
	return prepared;
}

/** Reject rather than truncate, like every other stored shape: a malformed capture is never kept. */
function prepareBlock(value: unknown): StructureBlock | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const block = value as StructureBlock;
	if (typeof block.type !== "string" || !STRUCTURE_TYPES.includes(block.type as StructureType)) return undefined;
	if (!counter(block.start) || !counter(block.end) || block.end <= block.start) return undefined;
	const prepared: StructureBlock = { type: block.type, start: block.start, end: block.end };
	for (const name of ["level", "depth", "ordinal", "table", "row", "cell"] as const) {
		const value = block[name];
		if (value === undefined) continue;
		if (!counter(value) || value < (name === "level" ? 1 : 0) || (name === "level" && value > 6)) return undefined;
		prepared[name] = value;
	}
	if (block.ordered !== undefined) prepared.ordered = block.ordered === true;
	if (block.header !== undefined) prepared.header = block.header === true;
	if (block.frame !== undefined) {
		if (!counter(block.frame) || block.frame > MAX_LIST_ITEMS) return undefined;
		prepared.frame = block.frame;
	}
	if (block.id !== undefined) {
		if (typeof block.id !== "string" || block.id.length === 0 || block.id.length > MAX_LABEL_CHARS) return undefined;
		prepared.id = block.id;
	}
	if (block.links !== undefined) {
		if (!Array.isArray(block.links) || block.links.length > MAX_BLOCK_LINKS) return undefined;
		const links: StructureLinkSpan[] = [];
		for (const link of block.links) {
			const preparedLink = prepareLink(link);
			if (!preparedLink) return undefined;
			// A link span must lie inside the block that owns it: the renderer and the page block list
			// both rely on a link never reaching outside its own text.
			if (preparedLink.start < block.start || preparedLink.end > block.end) return undefined;
			// Every link is kept with the verdict that was computed for it, never re-derived later.
			if (link.allowed !== undefined) preparedLink.allowed = link.allowed === true;
			if (link.note !== undefined) {
				if (typeof link.note !== "string" || link.note.length > MAX_LABEL_CHARS * 2) return undefined;
				preparedLink.note = link.note;
			}
			links.push(preparedLink);
		}
		prepared.links = links;
	}
	return prepared;
}

function prepareBlocks(value: unknown): readonly StructureBlock[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_CAPTURE_BLOCKS) return undefined;
	const blocks: StructureBlock[] = [];
	for (const block of value) {
		const prepared = prepareBlock(block);
		if (!prepared) return undefined;
		blocks.push(prepared);
	}
	return Object.freeze(blocks);
}

function prepareFrames(value: unknown): readonly SnapshotFrameProvenance[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return undefined;
	const frames: SnapshotFrameProvenance[] = [];
	for (const frame of value) {
		if (frame === null || typeof frame !== "object") return undefined;
		const entry = frame as SnapshotFrameProvenance;
		if (typeof entry.url !== "string" || entry.url.length > MAX_URL_CHARS) return undefined;
		if (typeof entry.status !== "string" || entry.status.length > MAX_LABEL_CHARS) return undefined;
		if (entry.role !== "main" && entry.role !== "embedded") return undefined;
		if (!boundedStrings(entry.reasons)) return undefined;
		frames.push(
			Object.freeze({
				url: entry.url,
				status: entry.status,
				reasons: Object.freeze([...entry.reasons]),
				role: entry.role,
			}),
		);
	}
	return Object.freeze(frames);
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
	const meta = prepareMeta(value.meta);
	if (value.meta !== undefined && !meta) return undefined;
	const blocks = prepareBlocks(value.blocks);
	if (value.blocks !== undefined && !blocks) return undefined;
	const frames = prepareFrames(value.frames);
	if (value.frames !== undefined && !frames) return undefined;
	const prepared: SnapshotContent = {
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
	};
	if (meta) prepared.meta = meta;
	if (blocks) prepared.blocks = blocks;
	if (frames) prepared.frames = frames;
	return Object.freeze(prepared);
}

/** A frozen copy of one stored block; callers can never mutate stored structure or another page. */
function copyBlock(block: StructureBlock): StructureBlock {
	const copy: StructureBlock = { ...block };
	if (block.links) copy.links = block.links.map((link) => ({ ...link }));
	return Object.freeze(copy);
}

/** A detached copy; callers can never mutate stored state or another page of the same snapshot. */
function copyContent(content: SnapshotContent): SnapshotContent {
	const copy: SnapshotContent = {
		...content,
		incompleteReasons: Object.freeze([...content.incompleteReasons]),
		warnings: Object.freeze([...content.warnings]),
	};
	if (content.meta)
		copy.meta = Object.freeze({ ...content.meta, ambiguities: Object.freeze([...content.meta.ambiguities]) });
	if (content.blocks) copy.blocks = Object.freeze(content.blocks.map(copyBlock));
	if (content.frames)
		copy.frames = Object.freeze(
			content.frames.map((frame) => Object.freeze({ ...frame, reasons: Object.freeze([...frame.reasons]) })),
		);
	return Object.freeze(copy);
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
