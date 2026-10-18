import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { decodeImageData } from "../src/core/images/input.ts";
import { guardImagePayload, prepareImageContext } from "../src/core/images/request-guard.ts";
import * as imageProcess from "../src/utils/image-process.ts";
import { createImagePng } from "./helpers/image-fixtures.ts";

const model: Model<Api> = {
	id: "guard",
	name: "Guard",
	provider: "guard",
	api: "openai-completions",
	baseUrl: "https://guard.invalid/v1",
	input: ["text", "image"],
	reasoning: false,
	contextWindow: 100000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const valid = { type: "image" as const, mimeType: "image/png", data: createImagePng().toString("base64") };
const invalid = { type: "image" as const, mimeType: "image/png", data: Buffer.from("not-an-image").toString("base64") };

describe("request-only image repair and final wire validation", () => {
	it("degrades a bad historical image without changing history, valid siblings, or tool facts", async () => {
		const context: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "already-executed",
					toolName: "capture",
					content: [invalid, { type: "text", text: "capture completed" }],
					isError: false,
					timestamp: 0,
				},
				{ role: "user", content: [{ type: "text", text: "new request" }, valid], timestamp: 1 },
			],
		};
		const original = JSON.stringify(context);
		const prepared = await prepareImageContext(context, model, {});
		expect(JSON.stringify(context)).toBe(original);
		expect(prepared.context.messages[0]).toMatchObject({ toolCallId: "already-executed", isError: false });
		expect(prepared.context.messages[0].content[0]).toMatchObject({ type: "text" });
		expect(prepared.context.messages[1]).toBe(context.messages[1]);
		expect(
			prepared.decisions.some((decision) => decision.stage === "omitted" && decision.code === "invalid_image"),
		).toBe(true);
		const healthy: Context = { messages: [{ role: "user", content: [valid], timestamp: 2 }] };
		expect((await prepareImageContext(healthy, model, {})).context).toBe(healthy);
	});

	it("does not cache a transient codec resource failure as a permanently bad image", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: [valid], timestamp: 42 },
				{ role: "user", content: "next", timestamp: 43 },
			],
		};
		const process = vi.spyOn(imageProcess, "processImage").mockResolvedValueOnce({
			ok: false,
			code: "input_limit",
			message: "Image processing queue is full.",
		});
		try {
			const first = await prepareImageContext(context, model, {});
			expect(first.decisions[0]).toMatchObject({ stage: "omitted", code: "input_limit" });
			const retry = await prepareImageContext(context, model, {});
			expect(retry.context).toBe(context);
			expect(process).toHaveBeenCalledTimes(2);
		} finally {
			process.mockRestore();
		}
	});

	it("rejects a valid current original that cannot fit a tighter request policy instead of sending without it", async () => {
		const context: Context = { messages: [{ role: "user", content: [valid], timestamp: 44 }] };
		await expect(
			prepareImageContext(context, model, { autoResizeImages: false, limits: { maxEncodedBytes: 10 } }),
		).rejects.toMatchObject({ code: "image_budget" });
		expect(context.messages[0].content[0]).toBe(valid);
	});

	it("can resume a legacy history whose image fields are missing", async () => {
		const context = {
			messages: [{ role: "user", content: [{ type: "image" }], timestamp: 0 }],
		} as unknown as Context;
		const repaired = await prepareImageContext(context, model, {});
		expect(repaired.context.messages[0].content[0]).toMatchObject({ type: "text" });
		expect(context.messages[0].content[0]).toEqual({ type: "image" });
	});

	it("strips only application source metadata from the request copy, including pi-messages", async () => {
		const attachment = { ...valid, imageSource: { version: 1, asset: { sha256: "private-source-identity" } } };
		const context: Context = { messages: [{ role: "user", content: [attachment], timestamp: 45 }] };
		const prepared = await prepareImageContext(context, { ...model, api: "pi-messages" }, {});
		expect(JSON.stringify(prepared.context)).not.toContain("imageSource");
		expect(JSON.stringify(context)).toContain("private-source-identity");
		expect(prepared.context.messages[0].content[0]).toEqual(valid);
	});

	it("keeps resize geometry in reports without appending processing prose or changing user text and image IDs", async () => {
		const wide = { ...valid, data: createImagePng(800, 4).toString("base64") };
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 46,
					content: [wide, { type: "text", text: "Earlier original 1600x8, displayed at 800x4" }, valid],
				},
			],
		};
		const snapshot = JSON.stringify(context);
		const initial = await prepareImageContext(context, model, {});
		const resized = await prepareImageContext(context, model, { limits: { maxWidth: 400 } });
		expect(JSON.stringify(context)).toBe(snapshot);
		expect(resized.decisions.map((decision) => decision.imageId)).toEqual(
			initial.decisions.map((decision) => decision.imageId),
		);
		expect(resized.context.messages[0].content).toHaveLength(3);
		expect(resized.context.messages[0].content[1]).toBe(context.messages[0].content[1]);
		expect(JSON.stringify(resized.context)).not.toContain("Request-only image preparation");
		expect(JSON.stringify(resized.context)).not.toContain("Multiply coordinates");
		expect(resized.decisions[0]).toMatchObject({ width: 400, height: 2 });
	});

	it("blockImages suppresses undecodable images without invoking decode", async () => {
		const context: Context = {
			messages: [{ role: "user", content: [{ ...invalid, data: "not even base64" }], timestamp: 0 }],
		};
		const result = await prepareImageContext(context, model, { blockImages: true });
		expect(result.context.messages[0].content[0]).toMatchObject({ type: "text" });
		expect(result.decisions[0].reason).toContain("disabled");
	});

	it("accepts validated unchanged images on wire but rejects a hook's malformed replacement", async () => {
		const payload = {
			messages: [
				{
					role: "user",
					content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${valid.data}` } }],
				},
			],
		};
		const snapshot = JSON.stringify(payload);
		expect((await guardImagePayload(payload, model, {})).decisions[0].stage).toBe("serialized");
		expect(JSON.stringify(payload)).toBe(snapshot);
		payload.messages[0].content[0].image_url.url = `data:image/png;base64,${invalid.data}`;
		await expect(guardImagePayload(payload, model, {})).rejects.toMatchObject({ code: "invalid_image" });
	});

	it("does not let payload hooks reintroduce images for blocked or text-only requests", async () => {
		const payload = {
			messages: [{ content: [{ type: "image_url", image_url: { url: "https://example.invalid/private" } }] }],
		};
		await expect(guardImagePayload(payload, model, { blockImages: true })).rejects.toMatchObject({
			code: "image_budget",
		});
		await expect(guardImagePayload(payload, { ...model, input: ["text"] }, {})).rejects.toMatchObject({
			code: "image_budget",
		});
	});

	it("checks post-hook count and encoded bytes without echoing private payloads", async () => {
		const part = { type: "input_image", image_url: `data:image/png;base64,${valid.data}` };
		await expect(
			guardImagePayload(
				{ input: [{ role: "user", content: [part, part] }] },
				{ ...model, api: "openai-responses" },
				{ limits: { maxImages: 1 } },
			),
		).rejects.toMatchObject({ code: "image_budget" });
		await expect(
			guardImagePayload(
				{ input: [part] },
				{ ...model, api: "openai-responses" },
				{ limits: { maxEncodedBytes: 4 } },
			),
		).rejects.toMatchObject({ code: "image_budget" });
	});

	it("bounds and validates Base64 before decoder allocation", () => {
		expect(() => decodeImageData({ ...valid, data: "====" })).toThrow("canonical Base64");
		expect(() => decodeImageData({ ...valid, data: "AB==" })).toThrow("canonical Base64");
		expect(() => decodeImageData(valid, 1)).toThrow("source byte limit");
		expect(() => decodeImageData({ ...valid, data: undefined } as unknown as typeof valid)).toThrow("MIME type");
	});
});
