import { createHash } from "node:crypto";
import type * as Fs from "node:fs";
import {
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ImageAssetRef, ImageSourceStore, imageAssetsDirectory } from "../src/core/images/source-store.ts";
import { IMAGE_LIMITS, ImageInputError } from "../src/core/images/types.ts";

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof Fs>();
	return {
		...fs,
		fsyncSync: vi.fn(fs.fsyncSync),
		mkdirSync: vi.fn(fs.mkdirSync),
		readSync: vi.fn(fs.readSync),
		renameSync: vi.fn(fs.renameSync),
		writeFileSync: vi.fn(fs.writeFileSync),
	};
});

const originalSync = vi.mocked(fsyncSync).getMockImplementation()!;
const originalMkdir = vi.mocked(mkdirSync).getMockImplementation()!;
const originalRead = vi.mocked(readSync).getMockImplementation()!;
const originalRename = vi.mocked(renameSync).getMockImplementation()!;
const originalWrite = vi.mocked(writeFileSync).getMockImplementation()!;

function errorCode(action: () => unknown, code: string): void {
	try {
		action();
		expect.fail("Expected a classified image storage error");
	} catch (error) {
		expect(error).toBeInstanceOf(ImageInputError);
		expect(error).toMatchObject({ code });
	}
}

// Storage is deliberately not a decoder: admission validates image containers before put().
const source = Buffer.from("admitted source image bytes");
const derived = Buffer.from("admitted derived image bytes");

function reference(bytes = source): ImageAssetRef {
	return {
		version: 1,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		byteLength: bytes.length,
		mimeType: "image/png",
	};
}

describe("session-local image source store", () => {
	let parent: string;
	let directory: string;
	let store: ImageSourceStore;

	beforeEach(() => {
		vi.mocked(fsyncSync).mockReset().mockImplementation(originalSync);
		vi.mocked(mkdirSync).mockReset().mockImplementation(originalMkdir);
		vi.mocked(readSync).mockReset().mockImplementation(originalRead);
		vi.mocked(renameSync).mockReset().mockImplementation(originalRename);
		vi.mocked(writeFileSync).mockReset().mockImplementation(originalWrite);
		parent = mkdtempSync(join(tmpdir(), "pi-image-store-"));
		directory = imageAssetsDirectory(join(parent, "session.jsonl"));
		store = new ImageSourceStore(directory);
	});

	afterEach(() => {
		rmSync(parent, { recursive: true, force: true });
	});

	it("round-trips a portable immutable reference through a new store instance", () => {
		const ref = store.put(source, "image/png");
		expect(ref).toEqual(reference());
		expect(Object.isFrozen(ref)).toBe(true);
		expect(JSON.stringify(ref)).not.toContain(parent);
		expect(readdirSync(directory)).toEqual([ref.sha256]);
		expect(new ImageSourceStore(directory).read(JSON.parse(JSON.stringify(ref)))).toEqual(source);
		expect(store.getPath(ref)).toBe(join(directory, ref.sha256));
		expect(lstatSync(directory).mode & 0o777).toBe(0o700);
		expect(lstatSync(store.getPath(ref)).mode & 0o777).toBe(0o600);
	});

	it("deduplicates identical source bytes without rewriting the canonical inode", () => {
		const ref = store.put(source, "image/png");
		const before = lstatSync(store.getPath(ref), { bigint: true });
		const repeated = store.put(new Uint8Array(source), "image/png");
		const after = lstatSync(store.getPath(ref), { bigint: true });
		expect(repeated).toEqual(ref);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeNs).toBe(before.mtimeNs);
		expect(readdirSync(directory)).toEqual([ref.sha256]);
	});

	it("keeps source and derived identities separate, with no cross-session fallback", () => {
		const original = store.put(source, "image/png");
		const prepared = store.put(derived, "image/jpeg");
		expect(original.sha256).not.toBe(prepared.sha256);
		expect(store.read(original)).toEqual(source);
		expect(store.read(prepared)).toEqual(derived);
		const other = new ImageSourceStore(imageAssetsDirectory(join(parent, "other.jsonl")));
		errorCode(() => other.read(original), "storage_missing");
		const ownCopy = other.put(source, "image/png");
		expect(other.getPath(ownCopy)).not.toBe(store.getPath(original));
		expect(lstatSync(other.getPath(ownCopy)).ino).not.toBe(lstatSync(store.getPath(original)).ino);
	});

	it("copies caller bytes before owner callbacks and returns independently owned reads", () => {
		const caller = new Uint8Array(source);
		const guarded = new ImageSourceStore(directory, () => caller.fill(0));
		const ref = guarded.put(caller, "image/png");
		expect(ref).toEqual(reference());
		expect(caller.buffer.byteLength).toBe(source.length);
		expect(caller.every((byte) => byte === 0)).toBe(true);
		const read = store.read(ref);
		read.fill(255);
		expect(store.read(ref)).toEqual(source);
	});

	it("snapshots reference fields before invoking owner callbacks", () => {
		const ref = { ...store.put(source, "image/png") };
		const guarded = new ImageSourceStore(directory, () => {
			ref.sha256 = "../outside";
		});
		expect(guarded.getPath(ref)).toBe(join(directory, reference().sha256));
	});

	it.each([
		[" IMAGE/PNG ", "image/png"],
		["image/jpg", "image/jpeg"],
		["image/jpeg", "image/jpeg"],
		["image/webp", "image/webp"],
		["image/gif", "image/gif"],
		["image/bmp", "image/bmp"],
	])("normalizes supported MIME %s", (mime, expected) => {
		const ref = store.put(source, mime);
		expect(ref.mimeType).toBe(expected);
		expect(store.read(ref)).toEqual(source);
	});

	it.each(["text/plain", "image/svg+xml", "image/png; charset=utf-8", "../image/png", "", "image/avif"])(
		"rejects unsupported MIME %s without creating a directory",
		(mime) => {
			errorCode(() => store.put(source, mime), "storage_invalid");
			expect(existsSync(directory)).toBe(false);
		},
	);

	it("enforces the exact 20 MiB source bound before creating storage", () => {
		errorCode(() => store.put(new Uint8Array(0), "image/png"), "storage_invalid");
		errorCode(() => store.put(new Uint8Array(IMAGE_LIMITS.maxInputBytes + 1), "image/png"), "input_limit");
		expect(existsSync(directory)).toBe(false);
		const bytes = new Uint8Array(IMAGE_LIMITS.maxInputBytes).fill(42);
		const ref = store.put(bytes, "image/png");
		expect(ref.byteLength).toBe(IMAGE_LIMITS.maxInputBytes);
		expect(store.read(ref).equals(Buffer.from(bytes))).toBe(true);
	});

	it("reports a missing canonical asset and refuses to expose its path", () => {
		const ref = store.put(source, "image/png");
		unlinkSync(store.getPath(ref));
		errorCode(() => store.read(ref), "storage_missing");
		errorCode(() => store.getPath(ref), "storage_missing");
	});

	it.each(["truncated", "same-size", "larger"])("rejects %s corruption, including a repeated put", (kind) => {
		const ref = store.put(source, "image/png");
		const path = store.getPath(ref);
		const corrupt =
			kind === "truncated" ? source.subarray(1) : Buffer.alloc(source.length + (kind === "larger" ? 1 : 0));
		writeFileSync(path, corrupt);
		errorCode(() => store.read(ref), "storage_invalid");
		errorCode(() => store.getPath(ref), "storage_invalid");
		errorCode(() => store.put(source, "image/png"), "storage_invalid");
		expect(readFileSync(path)).toEqual(corrupt);
		expect(readdirSync(directory)).toEqual([ref.sha256]);
	});

	it.each([
		{ version: 2 },
		{ sha256: "../outside" },
		{ sha256: "a".repeat(63) },
		{ sha256: "A".repeat(64) },
		{ sha256: `/tmp/${"a".repeat(64)}` },
		{ byteLength: 0 },
		{ byteLength: -1 },
		{ byteLength: 1.5 },
		{ byteLength: Number.NaN },
		{ byteLength: Number.MAX_SAFE_INTEGER + 1 },
		{ byteLength: IMAGE_LIMITS.maxInputBytes + 1 },
		{ mimeType: "text/plain" },
		{ mimeType: "IMAGE/PNG" },
		{ mimeType: "image/png; charset=utf-8" },
		{ path: "/private/foreign/image" },
		{ url: "https://example.com/image" },
		{ providerId: "file-provider" },
	])("rejects invalid reference metadata %j", (patch) => {
		const invalid = { ...reference(), ...patch } as ImageAssetRef;
		errorCode(() => store.read(invalid), "storage_invalid");
		errorCode(() => store.getPath(invalid), "storage_invalid");
		expect(existsSync(directory)).toBe(false);
	});

	it.each([null, undefined, [], {}, "not a reference"])("rejects malformed raw references %j", (value) => {
		errorCode(() => store.read(value as ImageAssetRef), "storage_invalid");
	});

	it("rejects a regular file at the asset root", () => {
		writeFileSync(directory, "unrelated");
		errorCode(() => store.put(source, "image/png"), "storage_invalid");
		errorCode(() => store.read(reference()), "storage_invalid");
		expect(readFileSync(directory, "utf8")).toBe("unrelated");
	});

	it("rejects a symlink root without touching its target", () => {
		const outside = join(parent, "outside");
		mkdirSync(outside);
		symlinkSync(outside, directory, "dir");
		errorCode(() => store.put(source, "image/png"), "storage_invalid");
		errorCode(() => store.read(reference()), "storage_invalid");
		expect(readdirSync(outside)).toEqual([]);
	});

	it("rejects a symlink canonical file without following, replacing or deleting it", () => {
		mkdirSync(directory);
		const outside = join(parent, "outside-image");
		writeFileSync(outside, source);
		const path = join(directory, reference().sha256);
		symlinkSync(outside, path);
		errorCode(() => store.read(reference()), "storage_invalid");
		errorCode(() => store.put(source, "image/png"), "storage_invalid");
		expect(lstatSync(path).isSymbolicLink()).toBe(true);
		expect(readFileSync(outside)).toEqual(source);
	});

	it("rejects hardlinked canonical files instead of sharing mutable session ownership", () => {
		const ref = store.put(source, "image/png");
		linkSync(store.getPath(ref), join(parent, "foreign-link"));
		errorCode(() => store.read(ref), "storage_invalid");
		errorCode(() => store.put(source, "image/png"), "storage_invalid");
	});

	it("never creates missing parent session directories or recreates a deleted parent", () => {
		const absent = join(parent, "missing-session", "session.jsonl.images");
		errorCode(() => new ImageSourceStore(absent).put(source, "image/png"), "storage_missing");
		expect(existsSync(join(parent, "missing-session"))).toBe(false);
		rmSync(parent, { recursive: true });
		errorCode(() => store.put(source, "image/png"), "storage_missing");
		errorCode(() => store.read(reference()), "storage_missing");
		expect(existsSync(parent)).toBe(false);
	});

	it("rejects a symlink parent directory", () => {
		const link = join(parent, "parent-link");
		symlinkSync(parent, link, "dir");
		const guarded = new ImageSourceStore(join(link, "session.images"));
		errorCode(() => guarded.put(source, "image/png"), "storage_invalid");
		expect(existsSync(join(parent, "session.images"))).toBe(false);
	});

	it("sanitizes filesystem and owner failures and never writes for a refused owner", () => {
		const guard = vi.fn(() => {
			throw new Error(`/private/secret/native-team?token=secret`);
		});
		const guarded = new ImageSourceStore(directory, guard);
		for (const action of [() => guarded.put(source, "image/png"), () => guarded.read(reference())]) {
			errorCode(action, "storage_invalid");
			expect(action).toThrow("Image asset owner is unavailable.");
		}
		expect(existsSync(directory)).toBe(false);
		try {
			new ImageSourceStore(join(parent, "secret-missing", "assets")).read(reference());
		} catch (error) {
			expect(String(error)).not.toContain(parent);
			expect(String(error)).not.toContain("secret-missing");
		}
	});

	it("checks the owner again before publication and leaves no canonical or temporary file on refusal", () => {
		let refused = false;
		vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
			originalWrite(file, data, options);
			refused = true;
		});
		const guarded = new ImageSourceStore(directory, () => {
			if (refused) throw new Error("Owner has been deleted");
		});
		errorCode(() => guarded.put(source, "image/png"), "storage_invalid");
		expect(readdirSync(directory)).toEqual([]);
	});

	it("rejects owner invalidation during a read rather than returning bytes", () => {
		const ref = store.put(source, "image/png");
		let refused = false;
		vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
			const count = originalRead(...args);
			refused = true;
			return count;
		});
		const guarded = new ImageSourceStore(directory, () => {
			if (refused) throw new Error("Owner has been deleted");
		});
		errorCode(() => guarded.read(ref), "storage_invalid");
	});

	it("does not recreate a parent removed between admission and nonrecursive mkdir", () => {
		vi.mocked(mkdirSync).mockImplementation((path, options) => {
			if (String(path) === directory) rmSync(parent, { recursive: true });
			return originalMkdir(path, options);
		});
		errorCode(() => store.put(source, "image/png"), "storage_missing");
		expect(existsSync(parent)).toBe(false);
	});

	it("detects a root replaced during a write and preserves the replacement directory", () => {
		let relocated = "";
		vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
			originalWrite(file, data, options);
			relocated = `${directory}.relocated`;
			renameSync(directory, relocated);
			mkdirSync(directory);
			originalWrite(join(directory, "preserve.txt"), "unrelated");
		});
		errorCode(() => store.put(source, "image/png"), "storage_invalid");
		expect(readdirSync(directory)).toEqual(["preserve.txt"]);
		expect(readFileSync(join(directory, "preserve.txt"), "utf8")).toBe("unrelated");
		expect(readdirSync(relocated)).toHaveLength(1); // Unknown relocation is an orphan, never a cleanup target.
	});

	it("cleans its exclusive temp after a partial write and never publishes partial content", () => {
		vi.mocked(writeFileSync).mockImplementation((file) => {
			originalWrite(file, source.subarray(0, 3));
			throw new Error("injected interrupted write /private/secret");
		});
		errorCode(() => store.put(source, "image/png"), "storage_invalid");
		expect(readdirSync(directory)).toEqual([]);
		expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
	});

	it.each(["truncated", "same-size"])("rejects %s unpublished bytes before any canonical rename", (kind) => {
		vi.mocked(writeFileSync).mockImplementation((file) => {
			originalWrite(file, kind === "truncated" ? source.subarray(1) : Buffer.alloc(source.length));
		});
		errorCode(() => store.put(source, "image/png"), "storage_invalid");
		expect(readdirSync(directory)).toEqual([]);
		expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
	});

	it("syncs the parent again when retrying after failed root directory publication", () => {
		vi.mocked(fsyncSync).mockImplementationOnce(() => {
			throw new Error("injected parent fsync failure");
		});
		errorCode(() => store.put(source, "image/png"), "storage_invalid");
		expect(readdirSync(directory)).toEqual([]);
		const parentIdentity = lstatSync(parent, { bigint: true });
		let parentSynced = false;
		vi.mocked(fsyncSync).mockImplementation((fd) => {
			const current = fstatSync(fd, { bigint: true });
			if (current.dev === parentIdentity.dev && current.ino === parentIdentity.ino) parentSynced = true;
			originalSync(fd);
		});
		const ref = store.put(source, "image/png");
		expect(parentSynced).toBe(true);
		expect(store.read(ref)).toEqual(source);
	});

	it("cleans its temp when file fsync fails before rename", () => {
		vi.mocked(fsyncSync).mockImplementation((fd) => {
			if (fstatSync(fd).isFile()) throw new Error("injected fsync failure");
			originalSync(fd);
		});
		errorCode(() => store.put(source, "image/png"), "storage_invalid");
		expect(readdirSync(directory)).toEqual([]);
		expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
	});

	it("leaves only a complete orphan and no successful ref if directory fsync fails after rename", () => {
		let published = false;
		vi.mocked(renameSync).mockImplementation((from, to) => {
			originalRename(from, to);
			published = true;
		});
		vi.mocked(fsyncSync).mockImplementation((fd) => {
			if (published && fstatSync(fd).isDirectory()) throw new Error("injected directory fsync failure");
			originalSync(fd);
		});
		errorCode(() => store.put(source, "image/png"), "storage_invalid");
		expect(readdirSync(directory)).toEqual([reference().sha256]);
		expect(readFileSync(join(directory, reference().sha256))).toEqual(source);
	});

	it.each(["throws", "returns"])("preserves a temp pathname replacement when the write %s", (mode) => {
		let temporary = "";
		vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
			originalWrite(file, data, options);
			temporary = join(directory, readdirSync(directory).find((name) => name.endsWith(".tmp"))!);
			unlinkSync(temporary);
			originalWrite(temporary, source); // Even identical bytes do not grant ownership of a replacement inode.
			if (mode === "throws") throw new Error("injected interruption");
		});
		errorCode(() => store.put(source, "image/png"), "storage_invalid");
		expect(readFileSync(temporary)).toEqual(source);
		expect(existsSync(join(directory, reference().sha256))).toBe(false);
	});

	it("verifies a concurrent same-content publication before returning the same reference", () => {
		const other = new ImageSourceStore(directory);
		let concurrent: ImageAssetRef | undefined;
		let publishing = false;
		vi.mocked(renameSync).mockImplementation((from, to) => {
			if (!publishing) {
				publishing = true;
				concurrent = other.put(source, "image/png");
			}
			originalRename(from, to);
		});
		const ref = store.put(source, "image/png");
		expect(concurrent).toEqual(ref);
		expect(store.read(ref)).toEqual(source);
		expect(readdirSync(directory)).toEqual([ref.sha256]);
	});

	it("detects a same-size content change during a read", () => {
		const ref = store.put(source, "image/png");
		const path = store.getPath(ref);
		vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
			const count = originalRead(...args);
			originalWrite(path, Buffer.alloc(source.length));
			return count;
		});
		errorCode(() => store.read(ref), "storage_invalid");
	});
});
