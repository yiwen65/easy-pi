import { createHash } from "node:crypto";
import type { Api, Context, ImageContent, Model } from "@earendil-works/pi-ai";
import {
	IMAGE_LIMITS,
	type ImageDecision,
	ImageInputError,
	type ImageLimits,
	type ImagePolicy,
	type ImageSelection,
} from "./types.ts";

/** Explicit constraints for one actual route; never inferred from model/provider names. */
export interface ImagePolicyOverride {
	api: Api;
	baseUrl: string;
	limits: Partial<ImageLimits>;
	/** The caller is responsible for verifying any provider-contract declaration. */
	source: "operator" | "provider-contract";
}

export interface ImagePolicyOptions {
	autoResizeImages?: boolean;
	blockImages?: boolean;
	/** Positive safe integers. Overrides can tighten, but never relax, engineering caps. */
	limits?: Partial<ImageLimits>;
	providerOverrides?: readonly ImagePolicyOverride[];
}

export interface ImagePolicyEvidence {
	source: "engineering" | "model-input" | "settings" | ImagePolicyOverride["source"];
	fields: readonly (keyof ImageLimits | "vision")[];
}

export interface ResolvedImagePolicy extends ImagePolicy {
	/** No built-in provider hard caps are assumed. Unknown routes retain engineering protection. */
	provenance: readonly ImagePolicyEvidence[];
}

/** Validate configuration without including untrusted values in diagnostics. */
export function validateImageLimits(value: unknown): Partial<ImageLimits> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Invalid images.limits: expected an object of positive safe integers");
	}
	const limits: Partial<ImageLimits> = {};
	for (const [key, limit] of Object.entries(value)) {
		if (!Object.hasOwn(IMAGE_LIMITS, key)) throw new Error("Invalid images.limits: unknown limit");
		if (limit === undefined) continue;
		if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
			throw new Error(`Invalid images.limits.${key}: expected a positive safe integer`);
		}
		limits[key as keyof ImageLimits] = limit;
	}
	return limits;
}

function endpointIdentity(baseUrl: string): string | undefined {
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		// Credentials and query/fragment data are neither route overrides nor diagnostic identity.
		return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		return undefined;
	}
}

/** Pass the auth-resolved model, not a catalog model, at the request boundary. */
export function resolveImagePolicy(
	model: Model<Api> | undefined,
	options: ImagePolicyOptions = {},
): ResolvedImagePolicy {
	const mode = options.autoResizeImages === false ? "original" : "balanced";
	const limits: ImageLimits = {
		...IMAGE_LIMITS,
		// A one-pixel-wide original may be as long as the pixel cap; 2000px is a balanced preference.
		maxWidth: mode === "original" ? IMAGE_LIMITS.maxInputPixels : IMAGE_LIMITS.maxWidth,
		maxHeight: mode === "original" ? IMAGE_LIMITS.maxInputPixels : IMAGE_LIMITS.maxHeight,
	};
	const provenance: ImagePolicyEvidence[] = [
		{ source: "engineering", fields: Object.keys(IMAGE_LIMITS) as (keyof ImageLimits)[] },
		{ source: "model-input", fields: ["vision"] },
	];
	const configured = validateImageLimits(options.limits);
	const sources = new Map<ImagePolicyEvidence["source"], Set<keyof ImageLimits>>();
	if (Object.keys(configured).length > 0) sources.set("settings", new Set());
	for (const [key, value] of Object.entries(configured)) {
		const field = key as keyof ImageLimits;
		limits[field] = Math.min(limits[field], value);
		sources.get("settings")!.add(field);
	}
	const endpoint = model ? endpointIdentity(model.baseUrl) : undefined;
	for (const override of options.providerOverrides ?? []) {
		if (override.source !== "operator" && override.source !== "provider-contract") {
			throw new Error("Invalid image policy override source");
		}
		const overrideEndpoint = endpointIdentity(override.baseUrl);
		if (!overrideEndpoint) throw new Error("Invalid image policy override endpoint");
		const overrideLimits = validateImageLimits(override.limits);
		if (!model || override.api !== model.api || overrideEndpoint !== endpoint) continue;
		for (const [key, value] of Object.entries(overrideLimits)) {
			const field = key as keyof ImageLimits;
			limits[field] = Math.min(limits[field], value);
			if (!sources.has(override.source)) sources.set(override.source, new Set());
			sources.get(override.source)!.add(field);
		}
	}
	for (const source of ["settings", "operator", "provider-contract"] as const) {
		const fields = sources.get(source);
		if (fields) provenance.push({ source, fields: [...fields].sort() });
	}
	// The pixel cap also bounds either dimension, including original mode.
	limits.maxWidth = Math.min(limits.maxWidth, limits.maxInputPixels);
	limits.maxHeight = Math.min(limits.maxHeight, limits.maxInputPixels);
	const blocked = options.blockImages === true;
	const vision = model?.input.includes("image") ?? false;
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				version: 1,
				provider: model?.provider,
				model: model?.id,
				api: model?.api,
				// Opaque/non-HTTP transports cannot match endpoint constraints. Hash their identity only.
				endpoint: endpoint ?? (model ? createHash("sha256").update(model.baseUrl).digest("hex") : null),
				mode,
				blocked,
				vision,
				limits,
				provenance,
			}),
		)
		.digest("hex");
	return { ...limits, mode, blocked, vision, fingerprint, provenance };
}

export interface ImageBudgetPlan {
	context: Context;
	/** Includes every input image, even retained ones, so clients can make an explicit historical selection. */
	decisions: ImageDecision[];
}

interface RequestImage {
	imageId: string;
	messageIndex: number;
	contentIndex: number;
	image: ImageContent;
	user: boolean;
	currentUser: boolean;
	toolGroup: number;
}

/**
 * Pure request projection, not admission or image decoding. encodedBytes is Base64 ASCII length,
 * not decoded bytes or the complete HTTP body. Assistant output is deliberately not input.
 *
 * IDs use message role/timestamp/toolCallId, a duplicate-identity ordinal, and content position;
 * they survive preparation/model changes and unrelated history trimming. Removing a duplicate
 * timestamp identity can change its later duplicate's ordinal; durable asset IDs are a separate layer.
 */
export function planImageBudget(
	context: Context,
	policy: ImagePolicy,
	selection: ImageSelection = {},
): ImageBudgetPlan {
	const images: RequestImage[] = [];
	const identities = new Map<string, number>();
	let currentUserIndex = -1;
	let toolGroup = 0;
	let latestToolGroup = -1;
	let latestToolIndex = -1;
	for (let messageIndex = 0; messageIndex < context.messages.length; messageIndex++) {
		const message = context.messages[messageIndex];
		if (message.role === "user") currentUserIndex = messageIndex;
		if (message.role !== "toolResult") toolGroup++;
		if (message.role === "assistant" || typeof message.content === "string") continue;
		const identity = JSON.stringify([
			message.role,
			message.timestamp,
			message.role === "toolResult" ? message.toolCallId : null,
		]);
		const occurrence = identities.get(identity) ?? 0;
		identities.set(identity, occurrence + 1);
		for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
			const image = message.content[contentIndex];
			if (image.type !== "image") continue;
			const imageId = `image_${createHash("sha256")
				.update(JSON.stringify([identity, occurrence, contentIndex]))
				.digest("hex")
				.slice(0, 24)}`;
			images.push({
				imageId,
				messageIndex,
				contentIndex,
				image,
				user: message.role === "user",
				currentUser: false,
				toolGroup,
			});
			if (message.role === "toolResult") {
				latestToolGroup = toolGroup;
				latestToolIndex = messageIndex;
			}
		}
	}
	// A new user turn makes even the most recent previous-turn screenshot historical.
	if (latestToolIndex < currentUserIndex) latestToolGroup = -1;
	for (const image of images) image.currentUser = image.user && image.messageIndex === currentUserIndex;
	const omissions = new Map<string, string>();
	const budgetOmissions = new Set<string>();
	const selected = new Set(selection.omitImageIds ?? []);
	if (policy.blocked || !policy.vision) {
		for (const image of images) {
			omissions.set(
				image.imageId,
				policy.blocked ? "image sending is disabled" : "selected model does not support image input",
			);
		}
	} else {
		const explicitlyProtected = images.filter(
			(image) =>
				selected.has(image.imageId) && (image.currentUser || (!image.user && image.toolGroup === latestToolGroup)),
		);
		if (explicitlyProtected.length > 0) {
			throw new ImageInputError(
				"image_budget",
				"Current user and latest tool images cannot be omitted. Remove current attachments before submitting, or select historical images instead.",
				explicitlyProtected.map((image) => image.imageId),
			);
		}
		for (const image of images) {
			if (selected.has(image.imageId)) omissions.set(image.imageId, "explicitly excluded from this request");
		}
		let count = 0;
		let bytes = 0;
		let oversized = 0;
		for (const image of images) {
			if (omissions.has(image.imageId)) continue;
			count++;
			bytes += image.image.data.length;
			if (image.image.data.length > policy.maxEncodedBytes) oversized++;
		}
		const overBudget = () => count > policy.maxImages || bytes > policy.maxRequestEncodedBytes || oversized > 0;
		// A tool-result group is atomic for automatic eviction (e.g. parallel screenshot comparisons).
		const evictableGroups = new Map<number, RequestImage[]>();
		for (const image of images) {
			if (image.user || image.toolGroup === latestToolGroup || omissions.has(image.imageId)) continue;
			if (!evictableGroups.has(image.toolGroup)) evictableGroups.set(image.toolGroup, []);
			evictableGroups.get(image.toolGroup)!.push(image);
		}
		for (const group of evictableGroups.values()) {
			if (!overBudget()) break;
			for (const image of group) {
				omissions.set(image.imageId, "older tool image group omitted to fit the request image budget");
				budgetOmissions.add(image.imageId);
				count--;
				bytes -= image.image.data.length;
				if (image.image.data.length > policy.maxEncodedBytes) oversized--;
			}
		}
		if (overBudget()) {
			const protectedIds = images.filter((image) => !omissions.has(image.imageId)).map((image) => image.imageId);
			throw new ImageInputError(
				"image_budget",
				"Protected images exceed the request image count or Base64 byte budget. Select historical image IDs to omit, remove or crop current attachments, or reduce the latest tool image group.",
				protectedIds,
			);
		}
	}
	const decisions: ImageDecision[] = images.map((image) => ({
		imageId: image.imageId,
		stage: omissions.has(image.imageId) ? "omitted" : "accepted",
		protected: image.currentUser || (!image.user && image.toolGroup === latestToolGroup),
		code: budgetOmissions.has(image.imageId) ? "image_budget" : undefined,
		reason: omissions.get(image.imageId),
		mimeType: image.image.mimeType,
		encodedBytes: image.image.data.length,
	}));
	if (omissions.size === 0) return { context, decisions };
	const replacements = new Map<number, Map<number, string>>();
	for (const image of images) {
		const reason = omissions.get(image.imageId);
		if (!reason) continue;
		if (!replacements.has(image.messageIndex)) replacements.set(image.messageIndex, new Map());
		replacements.get(image.messageIndex)!.set(image.contentIndex, `[Image ${image.imageId} omitted: ${reason}.]`);
	}
	const messages = context.messages.map((message, index) => {
		const contentReplacements = replacements.get(index);
		if (!contentReplacements || message.role === "assistant" || typeof message.content === "string") return message;
		return {
			...message,
			content: message.content.map((content, contentIndex) => {
				const text = contentReplacements.get(contentIndex);
				return text ? { type: "text" as const, text } : content;
			}),
		};
	});
	return { context: { ...context, messages }, decisions };
}
