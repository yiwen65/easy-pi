import { execFileSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processFileArguments } from "../../src/cli/file-processor.ts";
import {
	detectImageInputMimeType,
	prepareInputContent,
	prepareInputImages,
	readImageInputFile,
} from "../../src/core/images/pipeline.ts";
import { resolveImagePolicy } from "../../src/core/images/policy.ts";
import { ImageInputError } from "../../src/core/images/types.ts";
import * as codec from "../../src/utils/image-process.ts";
import { createImagePng } from "../helpers/image-fixtures.ts";
import { createHarness, type Harness } from "./harness.ts";

const image = (width = 4, height = 4): ImageContent => ({
	type: "image",
	data: createImagePng(width, height).toString("base64"),
	mimeType: "image/png",
});
const invalid: ImageContent = { type: "image", data: "not base64", mimeType: "image/png" };
const policy = resolveImagePolicy(undefined);
const harnesses: Harness[] = [];
async function harness(options: Parameters<typeof createHarness>[0] = {}) {
	const h = await createHarness(options);
	harnesses.push(h);
	return h;
}

afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()!.cleanup();
});

describe("unified image input preparation", () => {
	it("bounds local file reads and preserves symlink-to-regular-file inputs", async () => {
		const h = await harness();
		const source = createImagePng();
		const path = join(h.tempDir, "regular.png");
		const link = join(h.tempDir, "linked.png");
		writeFileSync(path, source);
		symlinkSync(path, link);
		expect(await readImageInputFile(link, source.length)).toEqual(source);
		expect(await detectImageInputMimeType(link)).toBe("image/png");
		await expect(readImageInputFile(path, source.length - 1)).rejects.toMatchObject({ code: "input_limit" });
		await expect(readImageInputFile(h.tempDir, 1024)).rejects.toMatchObject({ code: "invalid_image" });
	});

	it.skipIf(process.platform === "win32")(
		"rejects FIFO image reads and sniffing without waiting for a writer",
		async () => {
			const h = await harness();
			const path = join(h.tempDir, "pipe.png");
			execFileSync("mkfifo", [path]);
			await expect(readImageInputFile(path, 1024)).rejects.toMatchObject({ code: "invalid_image" });
			await expect(detectImageInputMimeType(path)).rejects.toMatchObject({ code: "invalid_image" });
			await expect(processFileArguments([path])).rejects.toMatchObject({ code: "invalid_image" });
		},
	);
	it("validates runtime shape, count, and raw batch bytes before image work", async () => {
		const process = vi.spyOn(codec, "processImage");
		await expect(prepareInputImages({} as ImageContent[], policy)).rejects.toMatchObject({ code: "invalid_image" });
		await expect(
			prepareInputImages([{ type: "text", text: "not an image" } as unknown as ImageContent], policy),
		).rejects.toMatchObject({ code: "invalid_image" });
		await expect(prepareInputImages([image(), image()], { ...policy, maxImages: 1 })).rejects.toMatchObject({
			code: "input_limit",
		});
		await expect(
			prepareInputImages([image(), image()], { ...policy, maxBatchInputBytes: 100 }),
		).rejects.toMatchObject({ code: "input_limit" });
		expect(process).not.toHaveBeenCalled();
	});

	it.each([
		[invalid, "invalid_base64"],
		[{ ...image(), mimeType: "image/jpeg" }, "mime_mismatch"],
		[{ type: "image", data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" }, "invalid_image"],
	] as const)("rejects invalid attachment %# with a classified error", async (attachment, code) => {
		await expect(prepareInputImages([attachment], policy)).rejects.toMatchObject({ name: "ImageInputError", code });
	});

	it("preserves image order and source snapshots without processing prose or repeated codec work", async () => {
		const a = image(2400, 3);
		const b = image(5, 6);
		const process = vi.spyOn(codec, "processImage");
		const result = await prepareInputImages([a, b], policy);
		expect(result.sources).toEqual([a, b]);
		expect(result.sources[0]).not.toBe(a);
		expect(result.content.map((part) => part.type)).toEqual(["image", "image"]);
		expect(result.content).toEqual(result.images);
		expect(result.decisions.find((decision) => decision.stage === "accepted")).toMatchObject({
			width: 2400,
			height: 3,
			encodedBytes: a.data.length,
		});
		expect(
			result.decisions
				.filter((decision) => decision.stage === "prepared")
				.map((decision) => [decision.width, decision.height]),
		).toEqual([
			[2000, 3],
			[5, 6],
		]);
		const reentry = await prepareInputContent(
			[{ type: "text", text: "before" }, ...result.content, { type: "text", text: "after" }],
			policy,
		);
		expect(reentry.content).toEqual([
			{ type: "text", text: "before" },
			...result.content,
			{ type: "text", text: "after" },
		]);
		expect(process).toHaveBeenCalledTimes(2);
		result.images![1].data = "broken";
		await expect(prepareInputImages([result.images![1]], policy)).rejects.toMatchObject({ code: "invalid_base64" });
	});

	it("snapshots caller-owned image fields before awaiting the codec", async () => {
		const original = image();
		const data = original.data;
		let release!: () => void;
		vi.spyOn(codec, "processImage").mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return {
				ok: true,
				data,
				mimeType: "image/png",
				hints: [],
				dimensions: { originalWidth: 4, originalHeight: 4, width: 4, height: 4 },
			};
		});
		const pending = prepareInputImages([original], policy);
		original.data = "mutated during await";
		release();
		const result = await pending;
		expect(result.images![0].data).toBe(data);
		expect(result.sources[0].data).toBe(data);
	});

	it("does not let a prepared derivative bypass a tighter source pixel policy", async () => {
		const result = await prepareInputImages([image(2400, 3)], policy);
		await expect(prepareInputImages(result.images, { ...policy, maxInputPixels: 6500 })).rejects.toMatchObject({
			code: "pixel_limit",
		});
	});

	it("cancels the shared batch deadline without processing later images", async () => {
		const process = vi.spyOn(codec, "processImage").mockImplementation(
			(_bytes, _mime, options) =>
				new Promise((_resolve, reject) => {
					options!.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {
						once: true,
					});
				}),
		);
		await expect(prepareInputImages([image(), image()], { ...policy, batchTimeoutMs: 5 })).rejects.toMatchObject({
			code: "timeout",
		});
		expect(process).toHaveBeenCalledOnce();
	});
});

describe("AgentSession image admission", () => {
	it("keeps submitted text unchanged after resizing an uploaded image and retains structured size reports", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("ok")]);
		await h.session.prompt("只发送这段正文", { images: [image(2400, 3)] });
		const user = h.session.messages[0];
		if (user.role !== "user" || typeof user.content === "string") throw new Error("Expected user content blocks");
		expect(user.content).toHaveLength(2);
		expect(user.content[0]).toEqual({ type: "text", text: "只发送这段正文" });
		expect(user.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(h.session.getImageDecisions()).toContainEqual(
			expect.objectContaining({ stage: "accepted", width: 2400, height: 3 }),
		);
		expect(h.session.getImageDecisions()).toContainEqual(
			expect.objectContaining({ stage: "prepared", width: 2000, height: 3 }),
		);
	});

	it("rejects before task admission and preflight success, then accepts a normal turn", async () => {
		const h = await harness();
		const preflight = vi.fn();
		await expect(
			h.session.prompt("keep this draft", { images: [invalid], preflightResult: preflight }),
		).rejects.toBeInstanceOf(ImageInputError);
		expect(preflight).toHaveBeenCalledExactlyOnceWith(false);
		expect(h.session.messages).toEqual([]);
		expect(h.session.taskRecovery).toBeUndefined();
		h.setResponses([fauxAssistantMessage("recovered")]);
		await h.session.prompt("normal");
		expect(h.session.messages).toHaveLength(2);
	});

	it("rejects a current user group that cannot fit its request budget before task admission", async () => {
		const h = await harness({ settings: { images: { limits: { maxRequestEncodedBytes: 10 } } } });
		await expect(h.session.prompt("too many bytes", { images: [image()] })).rejects.toMatchObject({
			code: "image_budget",
		});
		expect(h.session.messages).toEqual([]);
		expect(h.session.taskRecovery).toBeUndefined();
	});

	it("admits the transformed input, not the pre-hook attachment", async () => {
		const transformed = image();
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "transform", text: "transformed", images: [transformed] }));
				},
			],
		});
		h.setResponses([fauxAssistantMessage("ok")]);
		await h.session.prompt("original", { images: [invalid] });
		expect(h.session.messages[0]).toMatchObject({ content: [{ type: "text", text: "transformed" }, transformed] });
	});

	it.each(["steer", "followUp"] as const)(
		"rejects invalid %s images without durable queue entries",
		async (method) => {
			const h = await harness();
			await expect(h.session[method]("queue", [invalid])).rejects.toMatchObject({ code: "invalid_base64" });
			expect(h.session.pendingMessageCount).toBe(0);
			expect(h.session.taskRecovery).toBeUndefined();
			await h.session[method]("queue valid", [image()]);
			expect(h.session.pendingMessageCount).toBe(1);
		},
	);

	it.each(["steer", "followUp"] as const)("runs the input transform before direct %s admission", async (method) => {
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "transform", text: "changed", images: [image()] }));
				},
			],
		});
		await h.session[method]("raw", [invalid]);
		expect(method === "steer" ? h.session.getSteeringMessages() : h.session.getFollowUpMessages()).toEqual([
			"changed",
		]);
	});

	it.each(["steer", "followUp"] as const)("rejects then admits %s image groups while streaming", async (mode) => {
		let release!: () => void;
		let started!: () => void;
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tool: AgentTool = {
			name: "wait",
			label: "wait",
			description: "wait",
			parameters: Type.Object({}),
			execute: async () => {
				started();
				await blocked;
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const h = await harness({ tools: [tool] });
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("queued done"),
		]);
		const prompt = h.session.prompt("start");
		await running;
		try {
			const preflight = vi.fn();
			await expect(
				h.session.prompt("bad queued", { images: [invalid], streamingBehavior: mode, preflightResult: preflight }),
			).rejects.toMatchObject({ code: "invalid_base64" });
			expect(preflight).toHaveBeenCalledExactlyOnceWith(false);
			expect(h.session.pendingMessageCount).toBe(0);
			await h.session.prompt("valid queued", { images: [image()], streamingBehavior: mode });
			expect(h.session.pendingMessageCount).toBe(1);
		} finally {
			release();
		}
		await prompt;
		expect(h.session.messages).toContainEqual(
			expect.objectContaining({
				role: "user",
				content: [{ type: "text", text: "valid queued" }, expect.objectContaining(image())],
			}),
		);
	});

	it("covers extension user/custom messages and before_agent_start injected images", async () => {
		const h = await harness();
		await expect(h.session.sendUserMessage([invalid])).rejects.toMatchObject({ code: "invalid_base64" });
		await expect(
			h.session.sendCustomMessage(
				{ customType: "attachment", content: [invalid], display: true },
				{ deliverAs: "nextTurn" },
			),
		).rejects.toMatchObject({ code: "invalid_base64" });
		expect(h.session.messages).toEqual([]);
		expect(h.session.taskRecovery).toBeUndefined();
		const injected = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({
						message: { customType: "injected", content: [invalid], display: false },
					}));
				},
			],
		});
		await expect(injected.session.prompt("test")).rejects.toMatchObject({ code: "invalid_base64" });
		expect(injected.session.messages).toEqual([]);
	});

	it.each(["abort", "dispose"] as const)("cannot revive a prompt after %s during preparation", async (method) => {
		let started!: () => void;
		const processing = new Promise<void>((resolve) => {
			started = resolve;
		});
		vi.spyOn(codec, "processImage").mockImplementation(
			(_bytes, _mime, options) =>
				new Promise((_resolve, reject) => {
					started();
					options!.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {
						once: true,
					});
				}),
		);
		const h = await harness();
		const preflight = vi.fn();
		const prompt = h.session.prompt("cancelled", { images: [image()], preflightResult: preflight });
		const rejected = expect(prompt).rejects.toMatchObject({ code: "aborted" });
		await processing;
		await h.session[method]();
		await rejected;
		expect(preflight).toHaveBeenCalledExactlyOnceWith(false);
		expect(h.session.messages).toEqual([]);
		expect(h.session.taskRecovery).toBeUndefined();
	});

	it("shares @file preparation with prompt admission without processing prose or repeated codec work", async () => {
		const h = await harness();
		const path = join(h.tempDir, "wide.png");
		writeFileSync(path, createImagePng(2400, 3));
		const process = vi.spyOn(codec, "processImage");
		const input = await processFileArguments([path]);
		h.setResponses([fauxAssistantMessage("ok")]);
		await h.session.prompt(input.text, { images: input.images });
		expect(process).toHaveBeenCalledOnce();
		const user = h.session.messages[0];
		expect(user.role).toBe("user");
		if (user.role !== "user") throw new Error("Expected admitted user message");
		const content = user.content;
		expect(input.text).toBe(`<file name="${path}"></file>\n`);
		expect(content).toHaveLength(2);
		expect(JSON.stringify(content)).not.toContain("[Image:");
	});

	it("defers builtin read image preparation until after the tool_result hook, exactly once", async () => {
		let observedImage: ImageContent | undefined;
		const h = await harness({
			initialActiveToolNames: ["read"],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", (event) => {
						observedImage = event.content.find((part): part is ImageContent => part.type === "image");
					});
				},
			],
		});
		const source = createImagePng(2400, 3);
		const path = join(h.tempDir, "read-image.png");
		writeFileSync(path, source);
		const process = vi.spyOn(codec, "processImage");
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("read this image");
		expect(observedImage?.data).toBe(source.toString("base64"));
		expect(process).toHaveBeenCalledOnce();
		const tool = h.session.messages.find((message) => message.role === "toolResult");
		expect(tool).toMatchObject({
			content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image" }],
		});
		expect(tool?.content).toHaveLength(2);
		expect(JSON.stringify(tool)).not.toContain("[Image:");
	});

	it("prepares only the post-hook tool result and retains a bad tool fact without rerunning", async () => {
		let executions = 0;
		const tool: AgentTool = {
			name: "capture",
			label: "capture",
			description: "capture",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return {
					content: [{ type: "text", text: "external operation completed" }, image()],
					details: { completed: true },
				};
			},
		};
		const h = await harness({
			tools: [tool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", () => ({ content: [{ type: "text", text: "post hook fact" }, invalid] }));
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("capture", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("capture");
		const result = h.session.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({
			isError: false,
			details: { completed: true },
			content: [
				{ type: "text", text: "post hook fact" },
				invalid,
				{ type: "text", text: expect.stringContaining("invalid_base64") },
			],
		});
		expect(executions).toBe(1);
	});

	it("selection/report state is copied, bounded, rejects wire IDs and resets off its branch", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("ok")]);
		await h.session.prompt("first");
		const id = `image_${"a".repeat(24)}`;
		const ids = [id];
		h.session.setImageSelection(ids);
		ids.length = 0;
		expect(h.session.getImageSelection()).toEqual({ omitImageIds: [id] });
		expect(() => h.session.setImageSelection(["wire:0"])).toThrow(ImageInputError);
		h.session.recordImageDecisions([{ imageId: id, stage: "accepted" }]);
		const reports = h.session.getImageDecisions();
		reports[0].stage = "omitted";
		expect(h.session.getImageDecisions()[0].stage).toBe("accepted");
		h.sessionManager.resetLeaf();
		expect(h.session.getImageSelection().omitImageIds).toEqual([]);
		expect(h.session.getImageDecisions()).toEqual([]);
	});
});
