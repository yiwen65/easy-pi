import { createHash, randomUUID } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { IMAGE_LIMITS, ImageInputError } from "./types.ts";

/** Portable metadata only; the owning session chooses the asset directory. */
export interface ImageAssetRef {
	readonly version: 1;
	readonly sha256: string;
	readonly byteLength: number;
	readonly mimeType: string;
}

const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);
const REF_KEYS = new Set(["version", "sha256", "byteLength", "mimeType"]);
type Identity = Pick<BigIntStats, "dev" | "ino">;
interface DirectoryScope {
	fd: number;
	assertAvailable(): void;
}

function sameIdentity(left: Identity, right: Identity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function validateRef(ref: ImageAssetRef): ImageAssetRef {
	if (
		typeof ref !== "object" ||
		ref === null ||
		Object.keys(ref).some((key) => !REF_KEYS.has(key)) ||
		ref.version !== 1 ||
		typeof ref.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(ref.sha256) ||
		!Number.isSafeInteger(ref.byteLength) ||
		ref.byteLength <= 0 ||
		ref.byteLength > IMAGE_LIMITS.maxInputBytes ||
		!MIME_TYPES.has(ref.mimeType)
	) {
		throw new ImageInputError("storage_invalid", "Invalid image asset reference.");
	}
	return Object.freeze({ version: 1, sha256: ref.sha256, byteLength: ref.byteLength, mimeType: ref.mimeType });
}

function directoryInfo(path: string): BigIntStats {
	const info = lstatSync(path, { bigint: true });
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new ImageInputError("storage_invalid", "Unsafe image asset directory.");
	}
	return info;
}

/** This is a convention, not permission to create the session's parent directories. */
export function imageAssetsDirectory(sessionFile: string): string {
	return `${sessionFile}.images`;
}

/**
 * Session-local binary storage, not an image decoder. Callers supply admitted image bytes.
 * Existing corrupt assets are rejected, never repaired or overwritten deliberately.
 * Failed publication may leave a complete orphan, but never returns a successful reference.
 * Callers hold their session/team lifecycle lock; the optional guard checks owner availability.
 */
export class ImageSourceStore {
	private readonly directory: string;
	private readonly assertOwnerAvailable: (() => void) | undefined;

	constructor(directory: string, assertOwnerAvailable?: () => void) {
		if (typeof directory !== "string" || !directory.trim() || directory.includes("\0")) {
			throw new ImageInputError("storage_invalid", "Invalid image asset directory.");
		}
		this.directory = resolve(directory);
		this.assertOwnerAvailable = assertOwnerAvailable;
	}

	put(bytes: Uint8Array, mimeType: string): ImageAssetRef {
		if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
			throw new ImageInputError("storage_invalid", "Image asset bytes must not be empty.");
		}
		if (bytes.byteLength > IMAGE_LIMITS.maxInputBytes) {
			throw new ImageInputError("input_limit", "Image asset exceeds the input byte limit.");
		}
		const normalizedMime = typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
		const mime = normalizedMime === "image/jpg" ? "image/jpeg" : normalizedMime;
		if (!MIME_TYPES.has(mime)) {
			throw new ImageInputError("storage_invalid", "Unsupported image asset MIME type.");
		}
		// Copy before callbacks or filesystem work; never retain or transfer caller-owned bytes.
		const snapshot = Buffer.from(bytes);
		const ref: ImageAssetRef = Object.freeze({
			version: 1,
			sha256: createHash("sha256").update(snapshot).digest("hex"),
			byteLength: snapshot.byteLength,
			mimeType: mime,
		});
		return this.withDirectory(true, (scope) => {
			const target = join(this.directory, ref.sha256);
			if (this.hasAsset(target)) {
				this.verifyAsset(target, ref, scope, true);
				return ref;
			}
			const temporary = join(this.directory, `.${ref.sha256}.${randomUUID()}.tmp`);
			const fd = openSync(
				temporary,
				constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			let identity: Identity | undefined;
			try {
				identity = fstatSync(fd, { bigint: true });
				scope.assertAvailable();
				writeFileSync(fd, snapshot);
				fsyncSync(fd);
				// Verify the complete unpublished bytes before any canonical name becomes visible.
				this.verifyAsset(temporary, ref, scope);
				const current = lstatSync(temporary, { bigint: true });
				if (
					!current.isFile() ||
					current.isSymbolicLink() ||
					current.nlink !== 1n ||
					!sameIdentity(current, identity)
				) {
					throw new ImageInputError("storage_invalid", "Image asset temporary file changed.");
				}
				// A concurrent writer may have already published the same content. Verify it in full.
				if (this.hasAsset(target)) {
					this.verifyAsset(target, ref, scope, true);
					return ref;
				}
				renameSync(temporary, target);
				fsyncSync(scope.fd);
				this.verifyAsset(target, ref, scope);
				return ref;
			} finally {
				try {
					// Keep fd open until cleanup: an unlinked inode cannot be reused underneath us.
					const current = lstatSync(temporary, { bigint: true });
					if (identity && current.isFile() && !current.isSymbolicLink() && sameIdentity(current, identity))
						unlinkSync(temporary);
				} catch {
					// Missing, relocated or inaccessible temporaries are not permission to remove anything else.
				} finally {
					closeSync(fd);
				}
			}
		});
	}

	read(ref: ImageAssetRef): Buffer {
		const validated = validateRef(ref);
		return this.withDirectory(false, (scope) =>
			this.verifyAsset(join(this.directory, validated.sha256), validated, scope),
		);
	}

	/** Validates ownership, length and digest before exposing a local path; never a portable identity. */
	getPath(ref: ImageAssetRef): string {
		const validated = validateRef(ref);
		return this.withDirectory(false, (scope) => {
			const path = join(this.directory, validated.sha256);
			this.verifyAsset(path, validated, scope);
			return path;
		});
	}

	private checkOwner(): void {
		try {
			this.assertOwnerAvailable?.();
		} catch {
			throw new ImageInputError("storage_invalid", "Image asset owner is unavailable.");
		}
	}

	private withDirectory<T>(create: boolean, action: (scope: DirectoryScope) => T): T {
		let parentFd: number | undefined;
		let rootFd: number | undefined;
		try {
			this.checkOwner();
			const parentPath = dirname(this.directory);
			const parent = directoryInfo(parentPath);
			parentFd = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			if (!sameIdentity(fstatSync(parentFd, { bigint: true }), parent)) {
				throw new ImageInputError("storage_invalid", "Image asset parent changed.");
			}
			this.checkOwner();
			if (!sameIdentity(directoryInfo(parentPath), parent)) {
				throw new ImageInputError("storage_invalid", "Image asset parent changed.");
			}
			if (create) {
				try {
					// Never recursively recreate a missing session or deleted native team.
					mkdirSync(this.directory, { mode: 0o700, recursive: false });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
				// Also covers an existing directory left by an earlier failed parent fsync.
				fsyncSync(parentFd);
			}
			const root = directoryInfo(this.directory);
			rootFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			if (!sameIdentity(fstatSync(rootFd, { bigint: true }), root)) {
				throw new ImageInputError("storage_invalid", "Image asset directory changed.");
			}
			const scope: DirectoryScope = {
				fd: rootFd,
				assertAvailable: () => {
					this.checkOwner();
					if (
						!sameIdentity(directoryInfo(parentPath), parent) ||
						!sameIdentity(directoryInfo(this.directory), root)
					) {
						throw new ImageInputError("storage_invalid", "Image asset directory changed.");
					}
				},
			};
			scope.assertAvailable();
			return action(scope);
		} catch (error) {
			if (error instanceof ImageInputError) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new ImageInputError("storage_missing", "Image asset or its owning directory is missing.");
			}
			throw new ImageInputError("storage_invalid", "Image asset storage operation failed.");
		} finally {
			if (rootFd !== undefined) closeSync(rootFd);
			if (parentFd !== undefined) closeSync(parentFd);
		}
	}

	private hasAsset(path: string): boolean {
		try {
			lstatSync(path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	private verifyAsset(path: string, ref: ImageAssetRef, scope: DirectoryScope, durable = false): Buffer {
		scope.assertAvailable();
		const initial = lstatSync(path, { bigint: true });
		if (
			!initial.isFile() ||
			initial.isSymbolicLink() ||
			initial.nlink !== 1n ||
			initial.size !== BigInt(ref.byteLength)
		) {
			throw new ImageInputError("storage_invalid", "Invalid image asset file.");
		}
		// O_NONBLOCK also prevents a substituted FIFO from blocking before fstat can reject it.
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const opened = fstatSync(fd, { bigint: true });
			if (
				!sameIdentity(opened, initial) ||
				!opened.isFile() ||
				opened.nlink !== 1n ||
				opened.size !== initial.size
			) {
				throw new ImageInputError("storage_invalid", "Image asset file changed.");
			}
			const bytes = Buffer.alloc(ref.byteLength);
			let offset = 0;
			while (offset < bytes.length) {
				const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
				if (!count) throw new ImageInputError("storage_invalid", "Image asset file is truncated.");
				offset += count;
			}
			if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) {
				throw new ImageInputError("storage_invalid", "Image asset digest does not match.");
			}
			if (durable) {
				fsyncSync(fd);
				fsyncSync(scope.fd);
			}
			scope.assertAvailable();
			const after = fstatSync(fd, { bigint: true });
			const current = lstatSync(path, { bigint: true });
			if (
				!sameIdentity(current, opened) ||
				!current.isFile() ||
				current.isSymbolicLink() ||
				current.nlink !== 1n ||
				current.size !== opened.size ||
				current.mtimeNs !== opened.mtimeNs ||
				current.ctimeNs !== opened.ctimeNs ||
				after.size !== opened.size ||
				after.mtimeNs !== opened.mtimeNs ||
				after.ctimeNs !== opened.ctimeNs
			) {
				throw new ImageInputError("storage_invalid", "Image asset file changed while reading.");
			}
			return bytes;
		} finally {
			closeSync(fd);
		}
	}
}
