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
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { canonicalJson, sha256Hex } from "./hashing.ts";

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
const AGENT_MESSAGE_MANIFEST_TYPE = "application/vnd.pi.agent-message-manifest+json;version=1";
const IMAGE_BLOCK_TYPE = "application/vnd.pi.image-content-base64;version=1";

interface StoredImageBlockV1 {
	type: "artifact_image";
	artifactRef: string;
	hash: string;
	mimeType: string;
}

interface AgentMessageManifestV1 {
	schema: "pi.agent-message.v1";
	message: Record<string, unknown> & { content?: unknown };
}

export interface AgentMessageArtifact {
	ref: string;
	hash: string;
	size: number;
	contentType: typeof AGENT_MESSAGE_MANIFEST_TYPE;
	/** Content-addressed image-block artifacts referenced by the manifest. */
	imageRefs: string[];
}

export interface AgentMessageArtifactOptions {
	source: string;
	tenant: string;
}

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

function isImageBlock(value: unknown): value is { type: "image"; data: string; mimeType: string } {
	return (
		value !== null &&
		typeof value === "object" &&
		"type" in value &&
		value.type === "image" &&
		"data" in value &&
		typeof value.data === "string" &&
		"mimeType" in value &&
		typeof value.mimeType === "string"
	);
}

function isStoredImageBlock(value: unknown): value is StoredImageBlockV1 {
	return (
		value !== null &&
		typeof value === "object" &&
		"type" in value &&
		value.type === "artifact_image" &&
		"artifactRef" in value &&
		typeof value.artifactRef === "string" &&
		"hash" in value &&
		typeof value.hash === "string" &&
		"mimeType" in value &&
		typeof value.mimeType === "string"
	);
}

/**
 * Store one AgentMessage without duplicating image bytes in the message manifest.
 * Both image blocks and the manifest are content-addressed and pinned as cold truth.
 */
export function putAgentMessageArtifact(
	store: ArtifactStore,
	message: AgentMessage,
	options: AgentMessageArtifactOptions,
): AgentMessageArtifact {
	const messageRecord = structuredClone(message) as unknown as Record<string, unknown> & { content?: unknown };
	const imageRefs: string[] = [];
	if (Array.isArray(messageRecord.content)) {
		messageRecord.content = messageRecord.content.map((block, index) => {
			if (!isImageBlock(block)) return block;
			const imageMeta = store.put(block.data, {
				contentType: IMAGE_BLOCK_TYPE,
				source: `${options.source}:image:${index}:${block.mimeType}`,
				tenant: options.tenant,
			});
			store.pin(imageMeta.ref);
			imageRefs.push(imageMeta.ref);
			return {
				type: "artifact_image",
				artifactRef: imageMeta.ref,
				hash: imageMeta.hash,
				mimeType: block.mimeType,
			} satisfies StoredImageBlockV1;
		});
	}

	const manifest: AgentMessageManifestV1 = { schema: "pi.agent-message.v1", message: messageRecord };
	const manifestMeta = store.put(canonicalJson(manifest), {
		contentType: AGENT_MESSAGE_MANIFEST_TYPE,
		source: options.source,
		tenant: options.tenant,
	});
	store.pin(manifestMeta.ref);
	return {
		ref: manifestMeta.ref,
		hash: manifestMeta.hash,
		size: manifestMeta.size,
		contentType: AGENT_MESSAGE_MANIFEST_TYPE,
		imageRefs: [...new Set(imageRefs)],
	};
}

/** Resolve and verify an AgentMessage manifest and every referenced image block. */
export function getAgentMessageArtifact(store: ArtifactStore, ref: string, tenant: string): AgentMessage {
	const stored = store.get(ref, tenant);
	if (!stored) throw new Error(`Agent message artifact missing for ${ref}`);
	if (stored.meta.contentType !== AGENT_MESSAGE_MANIFEST_TYPE) {
		throw new Error(`Artifact ${ref} is not an AgentMessage manifest`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(stored.data));
	} catch {
		throw new Error(`Agent message manifest is invalid JSON for ${ref}`);
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		!("schema" in parsed) ||
		parsed.schema !== "pi.agent-message.v1" ||
		!("message" in parsed) ||
		parsed.message === null ||
		typeof parsed.message !== "object"
	) {
		throw new Error(`Agent message manifest schema mismatch for ${ref}`);
	}
	const message = structuredClone(parsed.message) as Record<string, unknown> & { content?: unknown };
	if (Array.isArray(message.content)) {
		message.content = message.content.map((block) => {
			if (!isStoredImageBlock(block)) return block;
			const image = store.get(block.artifactRef, tenant);
			if (!image) throw new Error(`Image artifact missing for ${block.artifactRef}`);
			if (image.meta.hash !== block.hash) {
				throw new Error(`Image artifact hash mismatch for ${block.artifactRef}`);
			}
			return {
				type: "image",
				data: new TextDecoder().decode(image.data),
				mimeType: block.mimeType,
			};
		});
	}
	return message as unknown as AgentMessage;
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
