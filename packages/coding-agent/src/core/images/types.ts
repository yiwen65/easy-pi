import type { ImageContent } from "@earendil-works/pi-ai";

/** Local engineering limits, not a claim about an upstream provider's contract. */
export const IMAGE_LIMITS = Object.freeze({
	maxInputBytes: 20 * 1024 * 1024,
	maxBatchInputBytes: 32 * 1024 * 1024,
	maxInputPixels: 32_000_000,
	maxImages: 32,
	maxEncodedBytes: 4.5 * 1024 * 1024,
	maxRequestEncodedBytes: 24 * 1024 * 1024,
	maxWidth: 2000,
	maxHeight: 2000,
	timeoutMs: 10_000,
	batchTimeoutMs: 30_000,
});

export type ImageFailureCode =
	| "invalid_base64"
	| "invalid_image"
	| "mime_mismatch"
	| "input_limit"
	| "pixel_limit"
	| "image_budget"
	| "decoder_unavailable"
	| "timeout"
	| "aborted"
	| "storage_missing"
	| "storage_invalid"
	| "unsupported_api";

export class ImageInputError extends Error {
	readonly code: ImageFailureCode;
	readonly imageIds: readonly string[];

	constructor(code: ImageFailureCode, message: string, imageIds: readonly string[] = []) {
		super(message);
		this.name = "ImageInputError";
		this.code = code;
		this.imageIds = imageIds;
	}
}

export interface ImageLimits {
	maxInputBytes: number;
	maxBatchInputBytes: number;
	maxInputPixels: number;
	maxImages: number;
	maxEncodedBytes: number;
	maxRequestEncodedBytes: number;
	maxWidth: number;
	maxHeight: number;
	timeoutMs: number;
	batchTimeoutMs: number;
}

export interface ImagePolicy extends ImageLimits {
	mode: "balanced" | "original";
	blocked: boolean;
	vision: boolean;
	/** An API/endpoint-bound key, without credentials or URL query parameters. */
	fingerprint: string;
}

export interface ImageDecision {
	imageId: string;
	stage: "accepted" | "prepared" | "serialized" | "omitted";
	/** Current user/latest current-turn tool images cannot be explicitly excluded. */
	protected?: boolean;
	code?: ImageFailureCode;
	reason?: string;
	mimeType?: string;
	inputBytes?: number;
	encodedBytes?: number;
	width?: number;
	height?: number;
}

export interface ImageSelection {
	/** Stable request-view IDs, never filesystem paths or permission grants. */
	omitImageIds?: readonly string[];
}

export interface ImagePreparation {
	images: ImageContent[];
	decisions: ImageDecision[];
}
