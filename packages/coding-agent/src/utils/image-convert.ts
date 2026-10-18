import { IMAGE_LIMITS } from "../core/images/types.ts";
import { type ImagePreparationOptions, prepareImage } from "./image-resize.ts";

// Display conversion must not change capture geometry. Refuse an oversized
// conversion instead of silently applying the provider's 2000px resize policy.
const CONVERSION_OPTIONS: ImagePreparationOptions = {
	forcePng: true,
	autoResizeImages: false,
	maxWidth: IMAGE_LIMITS.maxInputPixels,
	maxHeight: IMAGE_LIMITS.maxInputPixels,
	maxBytes: Math.ceil(IMAGE_LIMITS.maxInputBytes / 3) * 4,
};

/** Decode/conversion shares the bounded worker path, never the UI thread. */
export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	try {
		const result = await prepareImage(bytes, "", CONVERSION_OPTIONS);
		return new Uint8Array(Buffer.from(result.data, "base64"));
	} catch {
		return null;
	}
}

/** Convert images for terminal display (Kitty f=100 requires PNG). */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	if (mimeType === "image/png") return { data: base64Data, mimeType };
	try {
		const result = await prepareImage(
			new Uint8Array(Buffer.from(base64Data, "base64")),
			mimeType,
			CONVERSION_OPTIONS,
		);
		return { data: result.data, mimeType: result.mimeType };
	} catch {
		return null;
	}
}
