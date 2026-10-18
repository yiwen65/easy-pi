import { createHash } from "node:crypto";
import type { Api, Context, ImageContent, Model } from "@earendil-works/pi-ai";
import { processImage } from "../../utils/image-process.ts";
import { decodeImageData } from "./input.ts";
import { type ImagePolicyOptions, planImageBudget, resolveImagePolicy } from "./policy.ts";
import { type ImageDecision, ImageInputError, type ImagePolicy, type ImageSelection } from "./types.ts";
import { collectWireImages } from "./wire.ts";

const invalidImages = new Map<string, { code: ImageInputError["code"]; message: string }>();

function imageKey(image: ImageContent, policy: ImagePolicy): string {
	return createHash("sha256")
		.update(JSON.stringify([image.mimeType, policy.fingerprint]))
		.update(image.data)
		.digest("hex");
}

async function prepareBlock(image: ImageContent, policy: ImagePolicy, signal?: AbortSignal) {
	signal?.throwIfAborted();
	if (typeof image?.data !== "string" || typeof image.mimeType !== "string") {
		throw new ImageInputError("invalid_image", "Image must contain Base64 data and a MIME type.");
	}
	if (image.data.length > Math.ceil(policy.maxInputBytes / 3) * 4) {
		throw new ImageInputError("input_limit", "Image exceeds the source byte limit.");
	}
	const key = imageKey(image, policy);
	const invalid = invalidImages.get(key);
	if (invalid) throw new ImageInputError(invalid.code, invalid.message);
	try {
		const bytes = decodeImageData(image, policy.maxInputBytes);
		const result = await processImage(bytes, image.mimeType, {
			autoResizeImages: policy.mode === "balanced",
			resizeOptions: { maxWidth: policy.maxWidth, maxHeight: policy.maxHeight, maxBytes: policy.maxEncodedBytes },
			maxInputBytes: policy.maxInputBytes,
			maxInputPixels: policy.maxInputPixels,
			timeoutMs: policy.timeoutMs,
			signal,
		});
		if (!result.ok) throw new ImageInputError(result.code, result.message);
		return {
			image:
				result.data === image.data && result.mimeType === image.mimeType
					? image
					: { ...image, data: result.data, mimeType: result.mimeType },
			dimensions: result.dimensions,
		};
	} catch (error) {
		if (error instanceof ImageInputError && ["invalid_base64", "mime_mismatch", "pixel_limit"].includes(error.code)) {
			if (invalidImages.size >= 512) invalidImages.delete(invalidImages.keys().next().value!);
			invalidImages.set(key, { code: error.code, message: error.message });
		}
		throw error;
	}
}

/** Repair only the request view. The durable history and tool execution facts are never rewritten. */
export async function prepareImageContext(
	context: Context,
	model: Model<Api>,
	options: ImagePolicyOptions,
	selection: ImageSelection = {},
	signal?: AbortSignal,
	onInventory?: (decisions: ImageDecision[]) => void,
): Promise<{ context: Context; decisions: ImageDecision[] }> {
	const policy = resolveImagePolicy(model, options);
	// Hand-edited/legacy histories are not runtime-typed. Keep positions stable so
	// a malformed block can become an omission rather than breaking budget inspection.
	let normalizedMessages: Context["messages"] | undefined;
	for (let index = 0; index < context.messages.length; index++) {
		const message = context.messages[index];
		if (message.role === "assistant" || typeof message.content === "string") continue;
		let changed = false;
		const content = message.content.map((part) => {
			if (part.type !== "image") return part;
			if (typeof part.data !== "string" || typeof part.mimeType !== "string") {
				changed = true;
				return { type: "image" as const, data: "", mimeType: "application/octet-stream" };
			}
			// Application-owned source references must never leak through pi-messages' full Context wire.
			if ("imageSource" in part) {
				changed = true;
				const clean = { ...part } as ImageContent & { imageSource?: unknown };
				delete clean.imageSource;
				return clean;
			}
			return part;
		});
		if (changed) {
			normalizedMessages ??= context.messages.slice();
			normalizedMessages[index] = { ...message, content };
		}
	}
	const inputContext = normalizedMessages ? { ...context, messages: normalizedMessages } : context;
	// Publish IDs before a protected-group budget error, otherwise clients have no
	// historical selection to use for recovering from that error.
	onInventory?.(
		planImageBudget(inputContext, {
			...policy,
			maxImages: Number.MAX_SAFE_INTEGER,
			maxEncodedBytes: Number.MAX_SAFE_INTEGER,
			maxRequestEncodedBytes: Number.MAX_SAFE_INTEGER,
		}).decisions,
	);
	const selected = planImageBudget(
		inputContext,
		{
			...policy,
			// Apply selection/count first; source bytes may still shrink under this model's policy.
			maxEncodedBytes: Number.MAX_SAFE_INTEGER,
			maxRequestEncodedBytes: Number.MAX_SAFE_INTEGER,
		},
		selection,
	);
	if (policy.blocked || !policy.vision) return selected;
	const accepted = selected.decisions.filter((decision) => decision.stage !== "omitted");
	const updates = new Map<string, ImageDecision>();
	let imageIndex = 0;
	let changed = false;
	const deadline = AbortSignal.timeout(policy.batchTimeoutMs);
	const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const messages: Context["messages"] = [];
	for (const message of selected.context.messages) {
		if (message.role === "assistant" || typeof message.content === "string") {
			messages.push(message);
			continue;
		}
		let contentChanged = false;
		const content: typeof message.content = [];
		for (const part of message.content) {
			if (part.type !== "image") {
				content.push(part);
				continue;
			}
			const decision = accepted[imageIndex++];
			try {
				const result = await prepareBlock(part, policy, operationSignal);
				const prepared = result.image;
				operationSignal.throwIfAborted();
				content.push(prepared);
				contentChanged ||= prepared !== part;
				updates.set(decision.imageId, {
					...decision,
					stage: "prepared",
					mimeType: prepared.mimeType,
					encodedBytes: prepared.data.length,
					width: result.dimensions.width,
					height: result.dimensions.height,
				});
			} catch (error) {
				if (signal?.aborted) throw signal.reason;
				if (deadline.aborted) throw new ImageInputError("timeout", "Image request preparation deadline exceeded.");
				const failure =
					error instanceof ImageInputError
						? error
						: new ImageInputError("decoder_unavailable", "Image preparation is unavailable.");
				if (
					(failure.code === "image_budget" && (message.role === "user" || decision.protected)) ||
					(decision.protected &&
						message.role === "user" &&
						["input_limit", "decoder_unavailable", "timeout"].includes(failure.code))
				) {
					throw new ImageInputError(failure.code, failure.message, [decision.imageId]);
				}
				content.push({
					type: "text",
					text: `[Image ${decision.imageId} omitted: ${failure.code}. ${failure.message}]`,
				});
				contentChanged = true;
				updates.set(decision.imageId, {
					...decision,
					stage: "omitted",
					code: failure.code,
					reason: failure.message,
				});
			}
		}
		if (contentChanged) {
			changed = true;
			messages.push({ ...message, content });
		} else messages.push(message);
	}
	const repaired = changed ? { ...selected.context, messages } : selected.context;
	const budgeted = planImageBudget(repaired, policy);
	for (const decision of budgeted.decisions) {
		updates.set(
			decision.imageId,
			decision.stage === "omitted" ? decision : { ...updates.get(decision.imageId), ...decision, stage: "prepared" },
		);
	}
	const decisions = selected.decisions.map((decision) => updates.get(decision.imageId) ?? decision);
	return { context: budgeted.context, decisions };
}

/** Final hook-after-serialization defence. Does not silently rewrite opaque native payloads. */
export async function guardImagePayload(
	payload: unknown,
	model: Model<Api>,
	options: ImagePolicyOptions,
	signal?: AbortSignal,
): Promise<{ supported: boolean; decisions: ImageDecision[] }> {
	const policy = resolveImagePolicy(model, options);
	const scan = collectWireImages(model.api, payload);
	if (!scan.supported) return { supported: false, decisions: [] };
	if (scan.images.length === 0) return { supported: true, decisions: [] };
	if (policy.blocked || !policy.vision)
		throw new ImageInputError(
			"image_budget",
			"Image input is disabled for this request; a payload hook reintroduced an image.",
		);
	if (scan.images.length > policy.maxImages)
		throw new ImageInputError("image_budget", "Provider payload exceeds the image count limit.");
	let encodedBytes = 0;
	const decisions: ImageDecision[] = [];
	const deadline = AbortSignal.timeout(policy.batchTimeoutMs);
	const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	try {
		for (const part of scan.images) {
			operationSignal.throwIfAborted();
			if (part.kind === "reference") {
				decisions.push({
					imageId: `wire:${part.path}`,
					stage: "serialized",
					reason: "reference serialized; remote contents unverified",
				});
				continue;
			}
			const image = part.image!;
			encodedBytes += image.data.length;
			if (image.data.length > policy.maxEncodedBytes || encodedBytes > policy.maxRequestEncodedBytes)
				throw new ImageInputError("image_budget", "Provider payload exceeds the inline image byte limit.");
			// Validation-only: never silently resize a hook's opaque payload. All transforms happened above.
			const prepared = await prepareBlock(image, { ...policy, mode: "original" }, operationSignal);
			if (prepared.image.data !== image.data || prepared.image.mimeType !== image.mimeType) {
				throw new ImageInputError(
					"invalid_image",
					"Provider payload image requires normalization before serialization.",
				);
			}
			decisions.push({
				imageId: `wire:${part.path}`,
				stage: "serialized",
				mimeType: image.mimeType,
				encodedBytes: image.data.length,
				reason: "local wire validation only; remote image receipt unverified",
			});
		}
		return { supported: true, decisions };
	} catch (error) {
		if (signal?.aborted) throw signal.reason;
		if (deadline.aborted) throw new ImageInputError("timeout", "Image payload validation deadline exceeded.");
		throw error;
	}
}
