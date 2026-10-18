import type { Api, ImageContent } from "@earendil-works/pi-ai";
import { ImageInputError } from "./types.ts";

export interface WireImage {
	path: string;
	/** References are counted, but no local decode can prove their remote contents. */
	kind: "inline" | "reference";
	image?: ImageContent;
}

export interface WireImageScan {
	supported: boolean;
	images: WireImage[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Read only schema-defined image positions, never tool arguments or signed reasoning. */
export function collectWireImages(api: Api, payload: unknown): WireImageScan {
	const images: WireImage[] = [];
	const root = record(payload);
	let visits = 0;
	const add = (image: WireImage): void => {
		if (images.length >= 4096) throw new ImageInputError("image_budget", "Too many image blocks in provider payload");
		images.push(image);
	};
	const inline = (data: unknown, mimeType: unknown, path: string): void => {
		if (typeof data !== "string" || typeof mimeType !== "string") {
			throw new ImageInputError("invalid_image", `Invalid image fields at ${path}`);
		}
		add({ path, kind: "inline", image: { type: "image", data, mimeType } });
	};
	const url = (value: unknown, path: string): void => {
		if (typeof value !== "string" || value.length === 0) {
			throw new ImageInputError("invalid_image", `Invalid image URL field at ${path}`);
		}
		if (!/^data:/i.test(value)) {
			add({ path, kind: "reference" });
			return;
		}
		const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(value);
		if (!match) throw new ImageInputError("invalid_base64", `Invalid inline image URI at ${path}`);
		inline(match[2], match[1], path);
	};
	const parts = (value: unknown, path: string, style: string, depth = 0): void => {
		if (!Array.isArray(value)) return;
		if (depth > 16) throw new ImageInputError("invalid_image", "Provider image content nesting is too deep");
		for (let index = 0; index < value.length; index++) {
			if (++visits > 100_000)
				throw new ImageInputError("input_limit", "Provider image scan exceeded its work limit");
			const part = record(value[index]);
			if (!part) continue;
			const here = `${path}[${index}]`;
			if (style === "chat" || style === "mistral") {
				if (part.type === "image_url") {
					const imageUrl = part.image_url ?? part.imageUrl;
					url(record(imageUrl)?.url ?? imageUrl, here);
				}
			} else if (style === "responses") {
				if (part.type === "input_image" || part.type === "computer_screenshot") {
					if (typeof part.file_id === "string" && part.file_id.length > 0) add({ path: here, kind: "reference" });
					else url(part.image_url, here);
				} else {
					if (part.type === "message" || typeof part.role === "string") {
						parts(part.content, `${here}.content`, style, depth + 1);
					}
					if (part.type === "function_call_output" || part.type === "custom_tool_call_output") {
						parts(part.output, `${here}.output`, style, depth + 1);
					} else if (part.type === "computer_call_output") {
						parts([part.output], `${here}.output`, style, depth + 1);
					}
				}
			} else if (style === "anthropic") {
				if (part.type === "image") {
					const source = record(part.source);
					if (source?.type === "base64") inline(source.data, source.media_type, here);
					else if (source?.type === "url") url(source.url, here);
					else if (source?.type === "file" && typeof source.file_id === "string")
						add({ path: here, kind: "reference" });
					else throw new ImageInputError("invalid_image", `Invalid image source at ${here}`);
				} else if (part.type === "tool_result") {
					parts(part.content, `${here}.content`, style, depth + 1);
				}
			} else if (style === "google") {
				const data = record(part.inlineData ?? part.inline_data);
				const file = record(part.fileData ?? part.file_data);
				const mime = data?.mimeType ?? data?.mime_type;
				const fileMime = file?.mimeType ?? file?.mime_type;
				if (typeof mime === "string" && mime.toLowerCase().startsWith("image/")) inline(data?.data, mime, here);
				if (typeof fileMime === "string" && fileMime.toLowerCase().startsWith("image/")) {
					url(file?.fileUri ?? file?.file_uri, here);
				}
				const response = record(part.functionResponse ?? part.function_response);
				if (response) parts(response.parts, `${here}.functionResponse.parts`, style, depth + 1);
			} else if (style === "bedrock") {
				const image = record(part.image);
				if (image) {
					const source = record(image.source);
					if (source?.bytes instanceof Uint8Array && typeof image.format === "string") {
						inline(Buffer.from(source.bytes).toString("base64"), `image/${image.format}`, here);
					} else if (record(source?.s3Location)) add({ path: here, kind: "reference" });
					else throw new ImageInputError("invalid_image", `Invalid image source at ${here}`);
				}
				const tool = record(part.toolResult);
				if (tool) parts(tool.content, `${here}.toolResult.content`, style, depth + 1);
			} else if (style === "pi" && part.type === "image") {
				inline(part.data, part.mimeType, here);
			}
		}
	};
	const messages = (value: unknown, path: string, style: string): void => {
		if (!Array.isArray(value)) return;
		for (let index = 0; index < value.length; index++) {
			if (++visits > 100_000)
				throw new ImageInputError("input_limit", "Provider image scan exceeded its work limit");
			const message = record(value[index]);
			if (!message || (style === "pi" && message.role === "assistant")) continue;
			parts(message.content, `${path}[${index}].content`, style);
		}
	};
	switch (api) {
		case "openai-completions":
		case "mistral-conversations":
			messages(root?.messages, "messages", api === "openai-completions" ? "chat" : "mistral");
			break;
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
			parts(root?.input, "input", "responses");
			break;
		case "anthropic-messages":
			messages(root?.messages, "messages", "anthropic");
			break;
		case "google-generative-ai":
		case "google-vertex": {
			const contents = root?.contents;
			if (Array.isArray(contents)) {
				for (let index = 0; index < contents.length; index++) {
					if (++visits > 100_000)
						throw new ImageInputError("input_limit", "Provider image scan exceeded its work limit");
					parts(record(contents[index])?.parts, `contents[${index}].parts`, "google");
				}
			}
			break;
		}
		case "bedrock-converse-stream":
			messages(root?.messages, "messages", "bedrock");
			break;
		case "pi-messages":
			messages(record(root?.context)?.messages, "context.messages", "pi");
			break;
		default:
			return { supported: false, images };
	}
	return { supported: true, images };
}
