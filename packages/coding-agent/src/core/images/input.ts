import type { ImageContent } from "@earendil-works/pi-ai";
import { IMAGE_LIMITS, ImageInputError } from "./types.ts";

/** Strict, bounded Base64 admission. Header inspection alone is not a decode oracle. */
export function decodeImageData(image: ImageContent, maxInputBytes = IMAGE_LIMITS.maxInputBytes): Buffer {
	if (!image || typeof image.data !== "string" || typeof image.mimeType !== "string") {
		throw new ImageInputError("invalid_image", "Image must contain Base64 data and a MIME type.");
	}
	const data = image.data;
	if (data.length > Math.ceil(maxInputBytes / 3) * 4) {
		throw new ImageInputError("input_limit", "Image exceeds the source byte limit.");
	}
	if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
		throw new ImageInputError("invalid_base64", "Image data must be canonical Base64.");
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.byteLength > maxInputBytes)
		throw new ImageInputError("input_limit", "Image exceeds the source byte limit.");
	if (bytes.toString("base64") !== data)
		throw new ImageInputError("invalid_base64", "Image data must be canonical Base64.");
	return bytes;
}
