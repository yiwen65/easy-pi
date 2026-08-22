/**
 * CCTX-012: Artifact/Object Store with stable references.
 *
 * Content-addressed storage: put() derives the ref from the sha256 of the
 * bytes, get() re-verifies the hash and fails closed on mismatch. Referenced
 * (pinned) artifacts are never garbage-collected early. The artifact bytes are
 * truth; anything in context is only a ref + preview projection.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./hashing.ts";

export interface ArtifactMetadata {
	ref: string;
	hash: string;
	size: number;
	contentType: string;
	/** First bytes as text, capped at 200 chars. */
	preview: string;
	/** Origin, e.g. "toolCall:tc-1" or "event:ev-9". */
	source: string;
	tenant: string;
	createdAt: string;
}

export interface PutOptions {
	contentType: string;
	source: string;
	tenant: string;
}

export interface ArtifactStore {
	put(data: string | Uint8Array, options: PutOptions): ArtifactMetadata;
	/** Returns undefined when the ref does not exist; throws when bytes fail hash verification or tenant mismatches. */
	get(ref: string, tenant: string): { data: Uint8Array; meta: ArtifactMetadata } | undefined;
	resolve(ref: string): ArtifactMetadata | undefined;
	pin(ref: string): void;
	unpin(ref: string): void;
	isPinned(ref: string): boolean;
	/** Refs whose bytes are missing or whose stored bytes no longer match the ref hash. */
	scanBroken(): string[];
	/** Deletes unpinned artifacts; returns the collected refs. */
	collectGarbage(): string[];
	/** Test hook: overwrite stored bytes to simulate corruption. */
	corruptForTest(ref: string, data: string): void;
}

const REF_PREFIX = "artifact://sha256/";
const PREVIEW_CHARS = 200;

export function makeArtifactRef(hash: string): string {
	return `${REF_PREFIX}${hash}`;
}

export function parseArtifactRef(ref: string): { hash: string } {
	if (!ref.startsWith("artifact://")) {
		throw new Error(`Malformed artifact ref (expected artifact:// scheme): ${ref}`);
	}
	if (!ref.startsWith(REF_PREFIX)) {
		throw new Error(`Malformed artifact ref (only sha256 supported): ${ref}`);
	}
	const hash = ref.slice(REF_PREFIX.length);
	if (!/^[0-9a-f]{64}$/.test(hash)) {
		throw new Error(`Malformed artifact ref (bad sha256 hex): ${ref}`);
	}
	return { hash };
}

function toBytes(data: string | Uint8Array): Uint8Array {
	return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

function makePreview(bytes: Uint8Array): string {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, PREVIEW_CHARS * 2));
	return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
}

function makeMeta(hash: string, bytes: Uint8Array, options: PutOptions, createdAt: string): ArtifactMetadata {
	return {
		ref: makeArtifactRef(hash),
		hash,
		size: bytes.length,
		contentType: options.contentType,
		preview: makePreview(bytes),
		source: options.source,
		tenant: options.tenant,
		createdAt,
	};
}

export class InMemoryArtifactStore implements ArtifactStore {
	protected blobs = new Map<string, Uint8Array>();
	protected metas = new Map<string, ArtifactMetadata>();
	protected pinned = new Set<string>();

	put(data: string | Uint8Array, options: PutOptions): ArtifactMetadata {
		const bytes = toBytes(data);
		const hash = sha256Hex(bytes);
		const ref = makeArtifactRef(hash);
		const existing = this.metas.get(ref);
		if (existing) return existing;
		this.blobs.set(ref, bytes);
		const meta = makeMeta(hash, bytes, options, new Date().toISOString());
		this.metas.set(ref, meta);
		return meta;
	}

	get(ref: string, tenant: string): { data: Uint8Array; meta: ArtifactMetadata } | undefined {
		const meta = this.metas.get(ref);
		if (!meta) return undefined;
		if (meta.tenant !== tenant) {
			throw new Error(`Artifact tenant mismatch: ref belongs to tenant ${meta.tenant}, not ${tenant}`);
		}
		const bytes = this.readBytes(meta);
		if (!bytes) {
			throw new Error(`Artifact bytes missing for ${ref}`);
		}
		if (sha256Hex(bytes) !== meta.hash) {
			throw new Error(`Artifact hash mismatch for ${ref} (fail closed)`);
		}
		return { data: bytes, meta };
	}

	protected readBytes(meta: ArtifactMetadata): Uint8Array | undefined {
		return this.blobs.get(meta.ref);
	}

	resolve(ref: string): ArtifactMetadata | undefined {
		return this.metas.get(ref);
	}

	pin(ref: string): void {
		this.pinned.add(ref);
	}

	unpin(ref: string): void {
		this.pinned.delete(ref);
	}

	isPinned(ref: string): boolean {
		return this.pinned.has(ref);
	}

	scanBroken(): string[] {
		const broken: string[] = [];
		for (const [ref, meta] of this.metas) {
			const bytes = this.readBytes(meta);
			if (!bytes || sha256Hex(bytes) !== meta.hash) {
				broken.push(ref);
			}
		}
		return broken;
	}

	collectGarbage(): string[] {
		const collected: string[] = [];
		for (const ref of this.metas.keys()) {
			if (!this.pinned.has(ref)) {
				collected.push(ref);
				this.removeRef(ref);
			}
		}
		return collected;
	}

	corruptForTest(ref: string, data: string): void {
		if (this.blobs.has(ref)) {
			this.blobs.set(ref, toBytes(data));
		}
	}

	protected removeRef(ref: string): void {
		this.blobs.delete(ref);
		this.metas.delete(ref);
		this.pinned.delete(ref);
	}
}

interface FileStoreIndex {
	metas: Record<string, ArtifactMetadata>;
	pinned: string[];
}

/**
 * Filesystem-backed store: one blob file per hash plus an index JSON holding
 * metadata and pins. Bytes are the source of truth; the index can be rebuilt
 * by scanning blob files (metadata then degrades to hash/size only).
 */
export class FileSystemArtifactStore extends InMemoryArtifactStore {
	private readonly dir: string;

	constructor(dir: string) {
		super();
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
		this.loadFromDisk();
	}

	private blobPath(hash: string): string {
		return join(this.dir, `${hash}.blob`);
	}

	private indexPath(): string {
		return join(this.dir, "index.json");
	}

	private loadFromDisk(): void {
		const indexPath = this.indexPath();
		if (existsSync(indexPath)) {
			const index = JSON.parse(readFileSync(indexPath, "utf-8")) as FileStoreIndex;
			for (const [ref, meta] of Object.entries(index.metas)) {
				this.metas.set(ref, meta);
			}
			for (const ref of index.pinned) {
				this.pinned.add(ref);
			}
		}
	}

	/** Bytes live on disk only; every read is fresh so tampering is detected. */
	protected override readBytes(meta: ArtifactMetadata): Uint8Array | undefined {
		const path = this.blobPath(meta.hash);
		if (!existsSync(path)) return undefined;
		return readFileSync(path);
	}

	private persistIndex(): void {
		const index: FileStoreIndex = {
			metas: Object.fromEntries(this.metas),
			pinned: [...this.pinned],
		};
		writeFileSync(this.indexPath(), JSON.stringify(index, null, 2));
	}

	override put(data: string | Uint8Array, options: PutOptions): ArtifactMetadata {
		const bytes = toBytes(data);
		const hash = sha256Hex(bytes);
		const ref = makeArtifactRef(hash);
		const existing = this.metas.get(ref);
		if (existing) return existing;
		// Write bytes before the index: a crash leaves an unindexed blob (harmless)
		// rather than metadata pointing at missing bytes.
		writeFileSync(this.blobPath(hash), bytes);
		const meta = makeMeta(hash, bytes, options, new Date().toISOString());
		this.metas.set(ref, meta);
		this.persistIndex();
		return meta;
	}

	override pin(ref: string): void {
		super.pin(ref);
		this.persistIndex();
	}

	override unpin(ref: string): void {
		super.unpin(ref);
		this.persistIndex();
	}

	override corruptForTest(ref: string, data: string): void {
		const meta = this.metas.get(ref);
		if (meta) {
			writeFileSync(this.blobPath(meta.hash), toBytes(data));
		}
	}

	protected override removeRef(ref: string): void {
		const meta = this.metas.get(ref);
		super.removeRef(ref);
		if (meta) {
			rmSync(this.blobPath(meta.hash), { force: true });
			this.persistIndex();
		}
	}
}
