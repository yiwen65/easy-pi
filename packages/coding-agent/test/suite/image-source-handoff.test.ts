import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processFileArguments } from "../../src/cli/file-processor.ts";
import {
	getImageSourceHandoffStats,
	IMAGE_SOURCE_HANDOFF_LIMITS,
	prepareInputContent,
	prepareInputImages,
} from "../../src/core/images/pipeline.ts";
import { resolveImagePolicy } from "../../src/core/images/policy.ts";
import { getImageSourceMetadata, type ImageSourceDimensions } from "../../src/core/images/storage-codec.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import * as codec from "../../src/utils/image-process.ts";
import { normalizeToolResultImages } from "../../src/utils/tool-result-images.ts";
import { createImagePng } from "../helpers/image-fixtures.ts";
import { createHarness, type Harness } from "./harness.ts";

const image = (width = 4, height = 4): ImageContent => ({
	type: "image",
	data: createImagePng(width, height).toString("base64"),
	mimeType: "image/png",
});
const policy = resolveImagePolicy(undefined);
const harnesses: Harness[] = [];
const directories: string[] = [];
async function harness(options: Parameters<typeof createHarness>[0] = {}) {
	const h = await createHarness(options);
	harnesses.push(h);
	return h;
}
function directory(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-source-handoff-"));
	directories.push(path);
	return path;
}
function attachedImage(h: Harness): ImageContent {
	for (const message of h.session.messages) {
		if ("content" in message && typeof message.content !== "string") {
			const part = message.content.find((part): part is ImageContent => part.type === "image");
			if (part) return part;
		}
	}
	throw new Error("Expected admitted image");
}
function sourceBytes(manager: SessionManager, prepared: ImageContent): Buffer {
	const metadata = getImageSourceMetadata(prepared);
	if (!metadata) throw new Error("Expected source metadata");
	return manager.readImageSource(metadata.asset);
}
function mockResize() {
	return vi.spyOn(codec, "processImage").mockImplementation(async (bytes) => ({
		ok: true,
		data: image(2, 2).data,
		mimeType: "image/png",
		hints: ["[Synthetic resize hint.]"],
		dimensions: {
			originalWidth: Buffer.from(bytes).readUInt32BE(16),
			originalHeight: Buffer.from(bytes).readUInt32BE(20),
			width: 2,
			height: 2,
		},
	}));
}

afterEach(async () => {
	vi.restoreAllMocks();
	while (harnesses.length) {
		const h = harnesses.pop()!;
		await h.session.shutdown();
		h.cleanup();
	}
	while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("original image snapshot handoff", () => {
	it.each(["mutate", "delete"] as const)("retains the CLI 2400px original after the file is %sd", async (change) => {
		const h = await harness();
		const original = createImagePng(2400, 3);
		const path = join(h.tempDir, "wide.png");
		writeFileSync(path, original);
		const process = vi.spyOn(codec, "processImage");
		const input = await processFileArguments([path]);
		expect(Buffer.from(input.images[0].data, "base64").readUInt32BE(16)).toBe(2000);
		if (change === "delete") unlinkSync(path);
		else writeFileSync(path, createImagePng(9, 9));
		h.setResponses([fauxAssistantMessage("ok")]);
		await h.session.prompt(input.text, { images: input.images });
		const output = attachedImage(h);
		expect(sourceBytes(h.sessionManager, output)).toEqual(original);
		expect(getImageSourceMetadata(output)?.dimensions).toEqual({
			originalWidth: 2400,
			originalHeight: 3,
			width: 2000,
			height: 3,
		});
		expect(process).toHaveBeenCalledOnce();
		expect(JSON.stringify(h.session.messages[0]).match(/original 2400x3/g)).toHaveLength(1);
	});

	it("publishes immutable original snapshots, sanitizes callback fields and skips committed memo re-entry", async () => {
		const manager = SessionManager.inMemory();
		const original = image(2400, 4);
		const early = await prepareInputImages([original], policy);
		const pending = getImageSourceHandoffStats();
		const sink = vi.fn((output: ImageContent, source: ImageContent, dimensions: ImageSourceDimensions) => {
			expect(Object.isFrozen(source)).toBe(true);
			expect(source).toEqual(original);
			return { ...manager.attachImageSource(output, source, dimensions), arbitraryProviderField: "drop" };
		});
		const content = [
			{ type: "text" as const, text: "before" },
			...early.content,
			{ type: "text" as const, text: "after" },
		];
		const committed = await prepareInputContent(content, policy, { onPrepared: sink });
		expect(sink).toHaveBeenCalledOnce();
		expect(committed.content.map((part) => part.type)).toEqual(["text", "image", "text", "text"]);
		const output = committed.content[1] as ImageContent;
		expect(Object.keys(output).sort()).toEqual(["data", "imageSource", "mimeType", "type"]);
		expect(sourceBytes(manager, output)).toEqual(Buffer.from(original.data, "base64"));
		expect(getImageSourceHandoffStats().bytes).toBe(pending.bytes - Buffer.from(original.data, "base64").length);
		const reentry = await prepareInputContent(committed.content, policy, { onPrepared: sink });
		const retryOriginalOwner = await prepareInputImages(early.images, policy, { onPrepared: sink });
		expect(sink).toHaveBeenCalledOnce();
		expect(reentry.content).toEqual(committed.content);
		expect(getImageSourceMetadata(retryOriginalOwner.images![0])).toEqual(getImageSourceMetadata(output));
		expect(retryOriginalOwner.sources).toEqual([]);
	});

	it("does not read a later memoized image from a caller-mutated owner after an earlier await", async () => {
		const known = await prepareInputImages([image(5, 5)], policy);
		const originalData = known.images![0].data;
		const slow = image(31, 31);
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(codec, "processImage").mockImplementationOnce(async () => {
			await blocked;
			return {
				ok: true,
				data: slow.data,
				mimeType: slow.mimeType,
				hints: [],
				dimensions: { originalWidth: 31, originalHeight: 31, width: 31, height: 31 },
			};
		});
		const pending = prepareInputImages([slow, known.images![0]], policy);
		known.images![0].data = image(6, 6).data;
		release();
		const result = await pending;
		expect(result.images![1].data).toBe(originalData);
	});

	it("keeps conversion input bytes as the source, not the PNG derivative", async () => {
		const bytes = Buffer.alloc(58);
		bytes.write("BM");
		bytes.writeUInt32LE(58, 2);
		bytes.writeUInt32LE(54, 10);
		bytes.writeUInt32LE(40, 14);
		bytes.writeInt32LE(1, 18);
		bytes.writeInt32LE(1, 22);
		bytes.writeUInt16LE(1, 26);
		bytes.writeUInt16LE(24, 28);
		bytes.writeUInt32LE(4, 34);
		bytes[56] = 255;
		const manager = SessionManager.inMemory();
		const original: ImageContent = { type: "image", data: bytes.toString("base64"), mimeType: "image/bmp" };
		const early = await prepareInputImages([original], policy);
		expect(early.images![0].mimeType).toBe("image/png");
		const result = await prepareInputImages(early.images, policy, {
			onPrepared: (output, source, dimensions) => manager.attachImageSource(output, source, dimensions),
		});
		expect(sourceBytes(manager, result.images![0])).toEqual(bytes);
		expect(getImageSourceMetadata(result.images![0])?.asset.mimeType).toBe("image/bmp");
	});

	it("retains provenance across JSON clone, v4 persistence and independent reopen", async () => {
		const dir = directory();
		const manager = SessionManager.create(dir, dir);
		const original = image(2400, 5);
		const result = await prepareInputImages([original], policy, {
			onPrepared: (output, source, dimensions) => manager.attachImageSource(output, source, dimensions),
		});
		const clone: ImageContent = JSON.parse(JSON.stringify(result.images![0]));
		manager.appendMessage({ role: "user", content: [clone], timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("ok"));
		const path = manager.getSessionFile()!;
		expect(readFileSync(path, "utf8")).not.toContain(original.data);
		const reopened = SessionManager.open(path);
		const message = reopened.buildSessionContext().messages[0];
		if (message.role !== "user" || typeof message.content === "string") throw new Error("Expected persisted user");
		const output = message.content[0] as ImageContent;
		expect(sourceBytes(reopened, output)).toEqual(Buffer.from(original.data, "base64"));
		expect(Buffer.from(output.data, "base64").readUInt32BE(16)).toBe(2000);
	});

	it("rejects caller-forged source metadata and attaches the actual received bytes", async () => {
		const h = await harness();
		const actual = image(7, 9);
		const forged = {
			...actual,
			imageSource: {
				version: 1,
				asset: { version: 1, sha256: "a".repeat(64), byteLength: 1, mimeType: "image/png" },
				dimensions: { originalWidth: 1, originalHeight: 1, width: 1, height: 1 },
			},
			arbitraryProviderField: "untrusted",
		};
		h.setResponses([fauxAssistantMessage("ok")]);
		await h.session.prompt("actual", { images: [forged] });
		const output = attachedImage(h);
		expect(sourceBytes(h.sessionManager, output)).toEqual(Buffer.from(actual.data, "base64"));
		expect(getImageSourceMetadata(output)?.asset.sha256).toBe(
			createHash("sha256").update(Buffer.from(actual.data, "base64")).digest("hex"),
		);
		expect(getImageSourceMetadata(output)?.dimensions?.originalWidth).toBe(7);
		expect(output).not.toHaveProperty("arbitraryProviderField");
	});

	it("bounds pending sources by count, rejects evicted derivatives and supports reattachment retry", async () => {
		mockResize();
		const original = image(2700, 2);
		const first = await prepareInputImages([original], policy);
		for (let i = 0; i < IMAGE_SOURCE_HANDOFF_LIMITS.maxEntries; i++) {
			await prepareInputImages([image(2800 + i, 2)], policy);
			expect(getImageSourceHandoffStats().entries).toBeLessThanOrEqual(32);
			expect(getImageSourceHandoffStats().bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
		}
		const sink = vi.fn((output: ImageContent, _source: ImageContent) => output);
		await expect(prepareInputImages(first.images, policy, { onPrepared: sink })).rejects.toMatchObject({
			code: "storage_missing",
			message: expect.stringContaining("Reattach the original"),
		});
		expect(sink).not.toHaveBeenCalled();
		await prepareInputImages([original], policy);
		await prepareInputImages(first.images, policy, { onPrepared: sink });
		expect(sink.mock.calls[0][1]).toEqual(original);
	});

	it("bounds pending original Buffer payloads to 32MiB independently of entry count", async () => {
		const output = image(2, 2);
		vi.spyOn(codec, "processImage").mockResolvedValue({
			ok: true,
			data: output.data,
			mimeType: "image/png",
			hints: [],
			dimensions: { originalWidth: 4, originalHeight: 4, width: 2, height: 2 },
		});
		const original = {
			type: "image" as const,
			data: Buffer.alloc(17 * 1024 * 1024, 1).toString("base64"),
			mimeType: "image/png",
		};
		const first = await prepareInputImages([original], policy);
		await prepareInputImages([{ ...original, data: Buffer.alloc(17 * 1024 * 1024, 2).toString("base64") }], policy);
		expect(getImageSourceHandoffStats()).toEqual({ entries: 1, bytes: 17 * 1024 * 1024 });
		await expect(prepareInputImages(first.images, policy, { onPrepared: (image) => image })).rejects.toMatchObject({
			code: "storage_missing",
		});
	});
});

describe("session source publication boundaries", () => {
	it("retains a shared SHA snapshot until both distinct early-prepared outputs commit", async () => {
		const original = image(2400, 13);
		const a = await prepareInputImages([original], policy);
		const b = await prepareInputImages([{ ...original }], policy);
		const pending = getImageSourceHandoffStats();
		const first = await harness();
		const second = await harness();
		first.setResponses([fauxAssistantMessage("ok")]);
		second.setResponses([fauxAssistantMessage("ok")]);
		await first.session.prompt("first", { images: a.images });
		expect(getImageSourceHandoffStats()).toEqual(pending);
		await second.session.prompt("second", { images: b.images });
		expect(sourceBytes(first.sessionManager, attachedImage(first))).toEqual(Buffer.from(original.data, "base64"));
		expect(sourceBytes(second.sessionManager, attachedImage(second))).toEqual(Buffer.from(original.data, "base64"));
		expect(getImageSourceHandoffStats().bytes).toBe(pending.bytes - Buffer.from(original.data, "base64").length);
	});

	it("can publish the same pending CLI object concurrently to two session owners", async () => {
		const original = image(2400, 14);
		const early = await prepareInputImages([original], policy);
		const first = await harness();
		const second = await harness();
		first.setResponses([fauxAssistantMessage("ok")]);
		second.setResponses([fauxAssistantMessage("ok")]);
		await Promise.all([
			first.session.prompt("first", { images: early.images }),
			second.session.prompt("second", { images: early.images }),
		]);
		expect(sourceBytes(first.sessionManager, attachedImage(first))).toEqual(Buffer.from(original.data, "base64"));
		expect(sourceBytes(second.sessionManager, attachedImage(second))).toEqual(Buffer.from(original.data, "base64"));
	});

	it("never reuses another session's committed source reference; asks for original reattachment", async () => {
		const original = image(2400, 15);
		const early = await prepareInputImages([original], policy);
		const first = await harness();
		const second = await harness();
		first.setResponses([fauxAssistantMessage("ok")]);
		await first.session.prompt("first", { images: early.images });
		const sink = vi.spyOn(second.sessionManager, "attachImageSource");
		await expect(second.session.prompt("second", { images: early.images })).rejects.toMatchObject({
			code: "storage_missing",
		});
		expect(sink).not.toHaveBeenCalled();
		expect(second.session.messages).toEqual([]);
		second.setResponses([fauxAssistantMessage("ok")]);
		await second.session.prompt("reattached", { images: [original] });
		expect(sourceBytes(second.sessionManager, attachedImage(second))).toEqual(Buffer.from(original.data, "base64"));
	});

	it("retains foreign tool image bytes as bounded evidence without committing a foreign source reference", async () => {
		const first = SessionManager.inMemory();
		const second = SessionManager.inMemory();
		const original = image(2400, 17);
		const committed = await prepareInputImages([original], policy, {
			sourceOwner: first.getSessionId(),
			onPrepared: (output, source, dimensions) => first.attachImageSource(output, source, dimensions),
		});
		const sink = vi.spyOn(second, "attachImageSource");
		const result = await normalizeToolResultImages([{ type: "text", text: "executed fact" }, committed.images![0]], {
			sourceOwner: second.getSessionId(),
			onPrepared: (output, source, dimensions) => second.attachImageSource(output, source, dimensions),
		});
		expect(sink).not.toHaveBeenCalled();
		expect(result[1]).toEqual({ type: "image", data: committed.images![0].data, mimeType: "image/png" });
		expect(JSON.stringify(result)).toContain("storage_missing");
		expect(JSON.stringify(result)).toContain("Do not rerun the tool");
	});

	it.each(["steer", "followUp"] as const)(
		"attaches post-input-hook sources before durable %s queue admission",
		async (method) => {
			const replacement = image(2300, 2);
			const h = await harness({
				extensionFactories: [
					(pi) => {
						pi.on("input", () => ({ action: "transform", text: "replacement", images: [replacement] }));
					},
				],
			});
			await h.session[method]("original", [image()]);
			const queued = h.session.taskRecovery!.queued[0].messages[0];
			if (!("content" in queued) || typeof queued.content === "string") throw new Error("Expected queued blocks");
			const output = queued.content.find((part): part is ImageContent => part.type === "image")!;
			expect(sourceBytes(h.sessionManager, output)).toEqual(Buffer.from(replacement.data, "base64"));
		},
	);

	it("attaches custom and before_agent_start extension sources before durable admission", async () => {
		const original = image(2400, 6);
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({
						message: { customType: "injected", content: [original], display: false },
					}));
				},
			],
		});
		await h.session.sendCustomMessage(
			{ customType: "queued", content: [original], display: true },
			{ deliverAs: "nextTurn" },
		);
		h.setResponses([fauxAssistantMessage("ok")]);
		await h.session.prompt("start");
		const messages = h.session.messages.filter((message) => message.role === "custom");
		expect(messages).toHaveLength(2);
		for (const message of messages) {
			if (typeof message.content === "string") throw new Error("Expected custom blocks");
			expect(sourceBytes(h.sessionManager, message.content[0] as ImageContent)).toEqual(
				Buffer.from(original.data, "base64"),
			);
		}
	});

	it("attaches the post-tool_result-hook original and never reruns on classified source sink failure", async () => {
		const replacement = image(2400, 7);
		let executions = 0;
		const tool: AgentTool = {
			name: "capture",
			label: "capture",
			description: "capture",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "executed fact" }, image()], details: { executed: true } };
			},
		};
		const h = await harness({
			tools: [tool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", () => ({ content: [{ type: "text", text: "post hook fact" }, replacement] }));
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("capture", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("capture");
		const result = h.session.messages.find((message) => message.role === "toolResult")!;
		if (typeof result.content === "string") throw new Error("Expected tool blocks");
		const output = result.content.find((part): part is ImageContent => part.type === "image")!;
		expect(sourceBytes(h.sessionManager, output)).toEqual(Buffer.from(replacement.data, "base64"));
		expect(executions).toBe(1);
		vi.spyOn(h.sessionManager, "attachImageSource").mockImplementation(() => {
			throw new Error("disk failure");
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("capture", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("capture again");
		const failed = h.session.messages.filter((message) => message.role === "toolResult").at(-1)!;
		expect(failed).toMatchObject({ isError: false, details: { executed: true } });
		expect(JSON.stringify(failed.content)).toContain("post hook fact");
		expect(JSON.stringify(failed.content)).toContain("storage_invalid");
		expect(h.session.getImageDecisions()).toContainEqual(
			expect.objectContaining({ code: "storage_invalid", stage: "omitted" }),
		);
		expect(executions).toBe(2);
	});

	it("rejects a source sink failure before user task admission, preserving a retryable draft", async () => {
		const h = await harness();
		const source = image(2400, 8);
		const input = await prepareInputImages([source], policy);
		const sink = vi.spyOn(h.sessionManager, "attachImageSource").mockImplementationOnce(() => {
			throw new Error("disk failure");
		});
		const preflight = vi.fn();
		await expect(
			h.session.prompt("draft", { images: input.images, preflightResult: preflight }),
		).rejects.toMatchObject({ code: "storage_invalid" });
		expect(preflight).toHaveBeenCalledExactlyOnceWith(false);
		expect(h.session.messages).toEqual([]);
		expect(h.session.taskRecovery).toBeUndefined();
		h.setResponses([fauxAssistantMessage("ok")]);
		await h.session.prompt("draft", { images: input.images });
		expect(sink).toHaveBeenCalledTimes(2);
		expect(sourceBytes(h.sessionManager, attachedImage(h))).toEqual(Buffer.from(source.data, "base64"));
	});

	it("does not admit a prompt cancelled during source publication even if the sink commits", async () => {
		const h = await harness();
		const attach = h.sessionManager.attachImageSource.bind(h.sessionManager);
		vi.spyOn(h.sessionManager, "attachImageSource").mockImplementation((output, source, dimensions) => {
			const attached = attach(output, source, dimensions);
			void h.session.abort();
			return attached;
		});
		await expect(h.session.prompt("cancelled", { images: [image(2400, 9)] })).rejects.toMatchObject({
			code: "aborted",
		});
		expect(h.session.messages).toEqual([]);
		expect(h.session.taskRecovery).toBeUndefined();
	});

	it("drains pending image preparation before tree navigation and cannot revive it on the selected branch", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("ok")]);
		await h.session.prompt("first");
		const target = h.sessionManager.getLeafId()!;
		h.sessionManager.appendCustomEntry("later", {});
		let started!: () => void;
		const processing = new Promise<void>((resolve) => {
			started = resolve;
		});
		vi.spyOn(codec, "processImage").mockImplementationOnce(
			(_bytes, _mime, options) =>
				new Promise((_resolve, reject) => {
					started();
					options!.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {
						once: true,
					});
				}),
		);
		const sink = vi.spyOn(h.sessionManager, "attachImageSource");
		const prompt = h.session.prompt("must not revive", { images: [image(2400, 10)] });
		const rejected = expect(prompt).rejects.toMatchObject({ code: "aborted" });
		await processing;
		await h.session.navigateTree(target);
		await rejected;
		expect(h.sessionManager.getLeafId()).toBe(target);
		expect(sink).not.toHaveBeenCalled();
		expect(JSON.stringify(h.session.messages)).not.toContain("must not revive");
	});

	it.each(["newSession", "setSessionFile"] as const)(
		"rejects a source publication after %s changes its session during preparation",
		async (change) => {
			const h = await harness();
			let release!: () => void;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const source = image(2400, 11);
			vi.spyOn(codec, "processImage").mockImplementationOnce(async () => {
				await blocked;
				return {
					ok: true,
					data: image().data,
					mimeType: "image/png",
					hints: [],
					dimensions: { originalWidth: 2400, originalHeight: 11, width: 4, height: 4 },
				};
			});
			const sink = vi.spyOn(h.sessionManager, "attachImageSource");
			const prompt = h.session.prompt("old session", { images: [source] });
			const rejected = expect(prompt).rejects.toMatchObject({ code: "aborted" });
			if (change === "newSession") h.sessionManager.newSession();
			else {
				const dir = directory();
				const other = SessionManager.create(dir, dir);
				other.appendMessage({ role: "user", content: "other", timestamp: 1 });
				other.appendMessage(fauxAssistantMessage("ok"));
				h.sessionManager.setSessionFile(other.getSessionFile()!);
			}
			release();
			await rejected;
			expect(sink).not.toHaveBeenCalled();
			expect(h.session.messages).toEqual([]);
			expect(h.session.taskRecovery).toBeUndefined();
		},
	);
});

describe("ordinary same-branch append during image admission", () => {
	it("does not cancel a pending prompt merely because the path gained entries", async () => {
		const h = await harness();
		h.sessionManager.appendCustomEntry("anchor", {});
		const source = image(2400, 16);
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(codec, "processImage").mockImplementationOnce(async () => {
			await blocked;
			return {
				ok: true,
				data: image().data,
				mimeType: "image/png",
				hints: [],
				dimensions: { originalWidth: 2400, originalHeight: 16, width: 4, height: 4 },
			};
		});
		h.setResponses([fauxAssistantMessage("ok")]);
		const prompt = h.session.prompt("same branch", { images: [source] });
		h.sessionManager.appendCustomEntry("ordinary append", {});
		release();
		await prompt;
		expect(sourceBytes(h.sessionManager, attachedImage(h))).toEqual(Buffer.from(source.data, "base64"));
	});
});

describe("branch-scoped image report anchor", () => {
	it("clears reports without any selection after rewind/sibling navigation, but preserves ordinary appends", async () => {
		const h = await harness();
		const root = h.sessionManager.appendCustomEntry("root", {});
		h.sessionManager.appendCustomEntry("report branch", {});
		const decision = { imageId: `image_${"a".repeat(24)}`, stage: "prepared" as const };
		h.session.recordImageDecisions([decision]);
		h.sessionManager.appendCustomEntry("ordinary append", {});
		expect(h.session.getImageDecisions()).toEqual([decision]);
		h.sessionManager.branch(root);
		h.sessionManager.appendCustomEntry("sibling", {});
		expect(h.session.getImageDecisions()).toEqual([]);
	});

	it("binds reports prepared before the first durable image prompt and clears them on reset", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("ok")]);
		await h.session.prompt("image", { images: [image()] });
		expect(h.session.getImageDecisions().length).toBeGreaterThan(0);
		h.sessionManager.resetLeaf();
		expect(h.session.getImageDecisions()).toEqual([]);
	});

	it("keeps selection and reports anchored independently", async () => {
		const h = await harness();
		const root = h.sessionManager.appendCustomEntry("selection", {});
		const id = `image_${"b".repeat(24)}`;
		h.session.setImageSelection([id]);
		h.sessionManager.appendCustomEntry("report", {});
		h.session.recordImageDecisions([{ imageId: id, stage: "prepared" }]);
		h.sessionManager.branch(root);
		expect(h.session.getImageSelection()).toEqual({ omitImageIds: [id] });
		expect(h.session.getImageDecisions()).toEqual([]);
	});
});
