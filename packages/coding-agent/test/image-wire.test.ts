import type { Api } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { collectWireImages } from "../src/core/images/wire.ts";
import { createImagePng } from "./helpers/image-fixtures.ts";

const bytes = createImagePng();
const data = bytes.toString("base64");
const uri = `data:image/png;base64,${data}`;

const cases: { api: Api; payload: unknown }[] = [
	{
		api: "openai-completions",
		payload: { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: uri } }] }] },
	},
	{
		api: "mistral-conversations",
		payload: { messages: [{ role: "tool", content: [{ type: "image_url", imageUrl: uri }] }] },
	},
	{
		api: "openai-responses",
		payload: { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: uri }] }] },
	},
	{
		api: "openai-codex-responses",
		payload: { input: [{ type: "function_call_output", output: [{ type: "input_image", image_url: uri }] }] },
	},
	{
		api: "azure-openai-responses",
		payload: { input: [{ type: "computer_call_output", output: { type: "computer_screenshot", image_url: uri } }] },
	},
	{
		api: "anthropic-messages",
		payload: {
			messages: [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
						},
					],
				},
			],
		},
	},
	{
		api: "google-generative-ai",
		payload: { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data } }] }] },
	},
	{
		api: "google-vertex",
		payload: { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data } }] }] },
	},
	{
		api: "bedrock-converse-stream",
		payload: {
			messages: [
				{ role: "user", content: [{ toolResult: { content: [{ image: { format: "png", source: { bytes } } }] } }] },
			],
		},
	},
	{
		api: "pi-messages",
		payload: {
			context: { messages: [{ role: "toolResult", content: [{ type: "image", mimeType: "image/png", data }] }] },
		},
	},
];

describe("schema-bound provider image inspection", () => {
	it.each(cases)("finds the actual inline image for $api without rewriting the payload", ({ api, payload }) => {
		const original = JSON.stringify(payload);
		const result = collectWireImages(api, payload);
		expect(result.supported).toBe(true);
		expect(result.images).toHaveLength(1);
		expect(result.images[0]).toMatchObject({ kind: "inline", image: { type: "image", mimeType: "image/png", data } });
		expect(JSON.stringify(payload)).toBe(original);
	});

	it.each(["google-generative-ai", "google-vertex"] as const)(
		"finds multimodal tool-response images for %s without scanning response JSON",
		(api) => {
			const payload = {
				contents: [
					{
						role: "user",
						parts: [
							{
								functionResponse: {
									name: "capture",
									response: { output: { inlineData: { mimeType: "image/png", data: "opaque tool JSON" } } },
									parts: [{ inlineData: { mimeType: "image/png", data } }],
								},
							},
						],
					},
				],
			};
			expect(collectWireImages(api, payload).images).toEqual([
				{
					kind: "inline",
					path: "contents[0].parts[0].functionResponse.parts[0]",
					image: { type: "image", mimeType: "image/png", data },
				},
			]);
		},
	);

	it("does not treat signed reasoning or tool JSON arguments as image inputs", () => {
		const payload = {
			input: [
				{ type: "reasoning", encrypted_content: uri },
				{ type: "function_call", arguments: JSON.stringify({ image_url: uri }) },
				{ type: "message", role: "user", content: [{ type: "input_text", text: uri }] },
			],
		};
		expect(collectWireImages("openai-responses", payload).images).toEqual([]);
	});

	it("counts URL and file references without exposing them as local inline bytes", () => {
		const result = collectWireImages("openai-responses", {
			input: [
				{
					role: "user",
					content: [
						{ type: "input_image", image_url: "https://example.invalid/private?token=secret" },
						{ type: "input_image", file_id: "file-private" },
					],
				},
			],
		});
		expect(result.images.map((image) => image.kind)).toEqual(["reference", "reference"]);
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(JSON.stringify(result)).not.toContain("file-private");
	});

	it("rejects malformed data URIs and image sources before dispatch", () => {
		expect(() =>
			collectWireImages("openai-completions", {
				messages: [{ content: [{ type: "image_url", image_url: { url: "data:image/png,broken" } }] }],
			}),
		).toThrow("Invalid inline image URI");
		expect(() =>
			collectWireImages("anthropic-messages", { messages: [{ content: [{ type: "image", source: {} }] }] }),
		).toThrow("Invalid image source");
	});

	it("bounds nested tool-result image traversal", () => {
		const content: unknown[] = [];
		content.push({ type: "tool_result", content });
		expect(() => collectWireImages("anthropic-messages", { messages: [{ content }] })).toThrow("nesting is too deep");
	});

	it("makes unknown custom API coverage explicit", () => {
		expect(collectWireImages("custom-wire", { images: [uri] })).toEqual({ supported: false, images: [] });
	});

	it("does not replay pi-messages assistant output images as input", () => {
		expect(
			collectWireImages("pi-messages", {
				context: { messages: [{ role: "assistant", content: [{ type: "image", data, mimeType: "image/png" }] }] },
			}).images,
		).toEqual([]);
	});
});
