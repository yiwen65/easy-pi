import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { listBranchImageSources, readBranchImageSource } from "../src/core/images/attachments.ts";
import { getImageSourceMetadata } from "../src/core/images/storage-codec.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createImagePng } from "./helpers/image-fixtures.ts";

const image = (width = 4): ImageContent => ({
	type: "image",
	data: createImagePng(width, 4).toString("base64"),
	mimeType: "image/png",
});
const dimensions = { originalWidth: 8, originalHeight: 4, width: 4, height: 4 };
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function attach(manager: SessionManager, width = 8) {
	return manager.attachImageSource(image(), image(width), dimensions);
}

describe("active-branch original attachment inventory", () => {
	it("deduplicates known message/custom-message sources, not opaque details, and exposes no bytes or paths", () => {
		const manager = SessionManager.inMemory();
		const attached = attach(manager);
		const opaque = attach(manager, 9);
		manager.appendMessage({ role: "user", content: [attached], timestamp: 1 });
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [attached],
			isError: false,
			timestamp: 2,
		});
		manager.appendCustomMessageEntry("extension", [attached], false, { image: opaque });
		manager.appendCustomEntry("opaque", { image: opaque });
		const sourceId = getImageSourceMetadata(attached)!.asset.sha256;
		expect(listBranchImageSources(manager)).toEqual([
			{ sourceId, mimeType: "image/png", byteLength: createImagePng(8, 4).length, dimensions },
		]);
		expect(readBranchImageSource(manager, sourceId)).toEqual({
			...listBranchImageSources(manager)[0],
			data: image(8).data,
		});
		expect(readBranchImageSource(manager, sourceId.slice(0, 8), true).sourceId).toBe(sourceId);
		expect(() => readBranchImageSource(manager, sourceId.slice(0, 8))).toThrow(
			expect.objectContaining({ code: "invalid_image" }),
		);
		expect(manager.getImageSourcePath(getImageSourceMetadata(attached)!.asset)).toBeUndefined();
	});

	it("projects only declared summary dimensions, never extra provenance fields", () => {
		const manager = SessionManager.inMemory();
		const attached = attach(manager);
		const metadata = getImageSourceMetadata(attached)!;
		const image = {
			...attached,
			imageSource: {
				...metadata,
				dimensions: {
					...dimensions,
					privatePath: "/private/source.png",
					privateUrl: "https://example.invalid/?credential=secret",
				},
			},
		};
		manager.appendMessage({ role: "user", content: [image], timestamp: 1 });
		const reports = JSON.stringify(listBranchImageSources(manager));
		expect(reports).not.toContain("private");
		expect(reports).not.toContain("credential");
		expect(readBranchImageSource(manager, metadata.asset.sha256).dimensions).toEqual(dimensions);
	});

	it("includes checkpoint-only image content without walking opaque checkpoint details", () => {
		const manager = SessionManager.inMemory();
		const attached = attach(manager);
		const sourceId = getImageSourceMetadata(attached)!.asset.sha256;
		manager.appendCompactionCheckpoint([{ role: "user", content: [attached], timestamp: 1 }], 1);
		expect(listBranchImageSources(manager)).toMatchObject([{ sourceId }]);
		expect(readBranchImageSource(manager, sourceId).data).toBe(image(8).data);
		manager.resetLeaf();
		expect(() => readBranchImageSource(manager, sourceId)).toThrow(
			expect.objectContaining({ code: "storage_missing" }),
		);
	});

	it("rejects retained-but-unattached, arbitrary, and wrong-branch hashes", () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const attached = attach(manager);
		const sourceId = getImageSourceMetadata(attached)!.asset.sha256;
		expect(() => readBranchImageSource(manager, sourceId)).toThrow(
			expect.objectContaining({ code: "storage_missing" }),
		);
		const leaf = manager.appendCustomMessageEntry("visible", [attached], true);
		expect(readBranchImageSource(manager, sourceId).data).toBe(image(8).data);
		manager.branch(root);
		manager.appendMessage({ role: "user", content: "other branch", timestamp: 3 });
		expect(listBranchImageSources(manager)).toEqual([]);
		expect(() => readBranchImageSource(manager, sourceId)).toThrow(
			expect.objectContaining({ code: "storage_missing" }),
		);
		expect(() => readBranchImageSource(manager, "a".repeat(64))).toThrow(
			expect.objectContaining({ code: "storage_missing" }),
		);
		manager.branch(leaf);
		expect(readBranchImageSource(manager, sourceId).data).toBe(image(8).data);
	});

	it("does not treat another session's source metadata as source ownership", () => {
		const owner = SessionManager.inMemory();
		const other = SessionManager.inMemory();
		const attached = attach(owner);
		other.appendMessage({ role: "user", content: [attached], timestamp: 1 });
		expect(() => readBranchImageSource(other, getImageSourceMetadata(attached)!.asset.sha256)).toThrow(
			expect.objectContaining({ code: "storage_missing" }),
		);
	});

	it("classifies a corrupt durable source rather than substituting the prepared image", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-attachment-inventory-")));
		dirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		const attached = attach(manager);
		manager.appendMessage({ role: "user", content: [attached], timestamp: 1 });
		const ref = getImageSourceMetadata(attached)!.asset;
		writeFileSync(manager.getImageSourcePath(ref)!, Buffer.alloc(ref.byteLength));
		expect(listBranchImageSources(manager)).toHaveLength(1);
		expect(() => readBranchImageSource(manager, ref.sha256)).toThrow(
			expect.objectContaining({ code: "storage_invalid" }),
		);
	});
});
