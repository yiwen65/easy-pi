import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ArtifactStore,
	FileSystemArtifactStore,
	getAgentMessageArtifact,
	InMemoryArtifactStore,
	makeArtifactRef,
	parseArtifactRef,
	putAgentMessageArtifact,
} from "../../src/core/compaction/subsystem/artifact-store.ts";

function storeSuite(name: string, makeStore: () => ArtifactStore) {
	describe(name, () => {
		it("put is content-addressed and get returns original bytes", () => {
			const store = makeStore();
			const data = new TextEncoder().encode("hello artifact world");
			const meta = store.put(data, { contentType: "text/plain", source: "toolCall:tc-1", tenant: "t-1" });
			expect(meta.ref.startsWith("artifact://sha256/")).toBe(true);
			expect(meta.size).toBe(data.length);
			const got = store.get(meta.ref, "t-1");
			expect(got).toBeDefined();
			expect(new TextDecoder().decode(got!.data)).toBe("hello artifact world");
		});

		it("same content yields the same ref (idempotent put)", () => {
			const store = makeStore();
			const a = store.put("same-bytes", { contentType: "text/plain", source: "s", tenant: "t-1" });
			const b = store.put("same-bytes", { contentType: "text/plain", source: "s", tenant: "t-1" });
			expect(a.ref).toBe(b.ref);
		});

		it("rejects cross-tenant access and malformed refs", () => {
			const store = makeStore();
			const meta = store.put("secret", { contentType: "text/plain", source: "s", tenant: "t-1" });
			expect(() => store.get(meta.ref, "t-2")).toThrow(/tenant/);
			expect(() => parseArtifactRef("artifact://md5/abc")).toThrow(/sha256/);
			expect(() => parseArtifactRef("not-a-ref")).toThrow(/artifact/);
			expect(store.get("artifact://sha256/deadbeef", "t-1")).toBeUndefined();
		});

		it("get verifies hash and fails closed on tampering", () => {
			const store = makeStore();
			const meta = store.put("original content", { contentType: "text/plain", source: "s", tenant: "t-1" });
			store.corruptForTest(meta.ref, "tampered content");
			expect(() => store.get(meta.ref, "t-1")).toThrow(/hash/i);
			expect(store.scanBroken()).toContain(meta.ref);
		});

		it("pinned artifacts survive garbage collection; unpinned are collected", () => {
			const store = makeStore();
			const pinned = store.put("keep me", { contentType: "text/plain", source: "s", tenant: "t-1" });
			const loose = store.put("drop me", { contentType: "text/plain", source: "s", tenant: "t-1" });
			store.pin(pinned.ref);
			const collected = store.collectGarbage();
			expect(collected).toContain(loose.ref);
			expect(collected).not.toContain(pinned.ref);
			expect(store.get(pinned.ref, "t-1")).toBeDefined();
			expect(store.get(loose.ref, "t-1")).toBeUndefined();
		});

		it("keeps metadata: preview, type, size, source, lifecycle", () => {
			const store = makeStore();
			const long = "x".repeat(1000);
			const meta = store.put(long, { contentType: "text/x-log", source: "toolCall:tc-9", tenant: "t-1" });
			expect(meta.preview.length).toBeLessThanOrEqual(200);
			expect(meta.contentType).toBe("text/x-log");
			expect(meta.size).toBe(1000);
			expect(meta.source).toBe("toolCall:tc-9");
			expect(store.resolve(meta.ref)?.ref).toBe(meta.ref);
		});
	});
}

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

storeSuite("InMemoryArtifactStore", () => new InMemoryArtifactStore());
storeSuite("FileSystemArtifactStore", () => {
	const dir = mkdtempSync(join(tmpdir(), "artifact-store-"));
	dirs.push(dir);
	return new FileSystemArtifactStore(dir);
});

describe("FileSystemArtifactStore specifics", () => {
	it("persists bytes across reopen and exposes stored hash", () => {
		const dir = mkdtempSync(join(tmpdir(), "artifact-reopen-"));
		dirs.push(dir);
		const s1 = new FileSystemArtifactStore(dir);
		const meta = s1.put("durable bytes", { contentType: "text/plain", source: "s", tenant: "t-1" });
		s1.pin(meta.ref);
		const s2 = new FileSystemArtifactStore(dir);
		const got = s2.get(meta.ref, "t-1");
		expect(new TextDecoder().decode(got!.data)).toBe("durable bytes");
		expect(s2.isPinned(meta.ref)).toBe(true);
		// tamper on disk: scanBroken must find it
		const { hash } = parseArtifactRef(meta.ref);
		const blobFile = readdirSync(dir).find((f) => f.startsWith(hash));
		writeFileSync(join(dir, blobFile!), "tampered");
		expect(s2.scanBroken()).toContain(meta.ref);
	});

	it("makeArtifactRef/parseArtifactRef round-trip", () => {
		const store = new InMemoryArtifactStore();
		const meta = store.put("roundtrip", { contentType: "text/plain", source: "s", tenant: "t-1" });
		const { hash } = parseArtifactRef(meta.ref);
		expect(makeArtifactRef(hash)).toBe(meta.ref);
	});
});

describe("AgentMessage cold artifacts", () => {
	it("round-trips multi-block messages and deduplicates image bytes", () => {
		const store = new InMemoryArtifactStore();
		const imageData = "aW1hZ2UtYnl0ZXM=";
		const first: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "before" },
				{ type: "image", data: imageData, mimeType: "image/png" },
				{ type: "text", text: "after" },
			],
			timestamp: 1,
		};
		const second: AgentMessage = {
			...first,
			content: [{ type: "image", data: imageData, mimeType: "image/png" }],
			timestamp: 2,
		};
		const storedFirst = putAgentMessageArtifact(store, first, { source: "entry:m-1", tenant: "t-1" });
		const storedAgain = putAgentMessageArtifact(store, first, { source: "entry:m-2", tenant: "t-1" });
		const storedSecond = putAgentMessageArtifact(store, second, { source: "entry:m-3", tenant: "t-1" });

		expect(storedAgain.ref).toBe(storedFirst.ref);
		expect(storedAgain.hash).toBe(storedFirst.hash);
		expect(storedSecond.imageRefs).toEqual(storedFirst.imageRefs);
		expect(storedFirst.imageRefs).toHaveLength(1);
		expect(getAgentMessageArtifact(store, storedFirst.ref, "t-1")).toEqual(first);
		expect(getAgentMessageArtifact(store, storedSecond.ref, "t-1")).toEqual(second);
	});

	it("fails closed when a referenced image artifact is corrupted", () => {
		const store = new InMemoryArtifactStore();
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "image", data: "b3JpZ2luYWw=", mimeType: "image/jpeg" }],
			timestamp: 1,
		};
		const stored = putAgentMessageArtifact(store, message, { source: "entry:m-1", tenant: "t-1" });
		store.corruptForTest(stored.imageRefs[0], "tampered");
		expect(() => getAgentMessageArtifact(store, stored.ref, "t-1")).toThrow(/hash/i);
	});

	it("survives a filesystem-store restart with manifest and image pins intact", () => {
		const dir = mkdtempSync(join(tmpdir(), "message-artifact-reopen-"));
		dirs.push(dir);
		const first = new FileSystemArtifactStore(dir);
		const message: AgentMessage = {
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "view_image",
			content: [
				{ type: "text", text: "captured" },
				{ type: "image", data: "cGl4ZWxz", mimeType: "image/webp" },
			],
			isError: false,
			timestamp: 3,
		};
		const stored = putAgentMessageArtifact(first, message, { source: "entry:tr-1", tenant: "t-1" });
		const reopened = new FileSystemArtifactStore(dir);

		expect(reopened.isPinned(stored.ref)).toBe(true);
		expect(stored.imageRefs.every((ref) => reopened.isPinned(ref))).toBe(true);
		expect(getAgentMessageArtifact(reopened, stored.ref, "t-1")).toEqual(message);
	});
});
