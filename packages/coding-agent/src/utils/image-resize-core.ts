import { IMAGE_LIMITS, ImageInputError } from "../core/images/types.ts";
import { applyExifOrientation } from "./exif-orientation.ts";
import { inspectImage } from "./image-validation.ts";
import { loadPhoton } from "./photon.ts";

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 2000
	maxHeight?: number; // Default: 2000
	maxBytes?: number; // Base64 bytes, default: 4.5 MiB
	jpegQuality?: number; // Default: 80
	maxInputBytes?: number; // May tighten the 20 MiB source limit
	maxInputPixels?: number; // May tighten the 32 MP decoded limit
	signal?: AbortSignal;
	timeoutMs?: number; // Per caller, including queue time; default: 10 seconds
}

export interface ImagePreparationOptions extends ImageResizeOptions {
	autoResizeImages?: boolean;
	forcePng?: boolean;
}

export interface ImageCodecOptions {
	maxWidth: number;
	maxHeight: number;
	maxBytes: number;
	jpegQuality: number;
	maxInputBytes: number;
	maxInputPixels: number;
	autoResizeImages: boolean;
	forcePng: boolean;
}

export interface ResizedImage {
	data: string;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
	convertedFrom?: string;
}

export function imageCodecOptions(options?: ImagePreparationOptions): ImageCodecOptions {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const opts: ImageCodecOptions = {
		// Original mode has no artificial resize preference. Explicit dimensions
		// still express a caller/provider hard limit; the source pixel cap remains.
		maxWidth: options?.maxWidth ?? (autoResizeImages ? IMAGE_LIMITS.maxWidth : IMAGE_LIMITS.maxInputPixels),
		maxHeight: options?.maxHeight ?? (autoResizeImages ? IMAGE_LIMITS.maxHeight : IMAGE_LIMITS.maxInputPixels),
		maxBytes: options?.maxBytes ?? IMAGE_LIMITS.maxEncodedBytes,
		jpegQuality: options?.jpegQuality ?? 80,
		maxInputBytes: Math.min(options?.maxInputBytes ?? IMAGE_LIMITS.maxInputBytes, IMAGE_LIMITS.maxInputBytes),
		maxInputPixels: Math.min(options?.maxInputPixels ?? IMAGE_LIMITS.maxInputPixels, IMAGE_LIMITS.maxInputPixels),
		autoResizeImages,
		forcePng: options?.forcePng ?? false,
	};
	for (const value of [
		opts.maxWidth,
		opts.maxHeight,
		opts.maxBytes,
		opts.jpegQuality,
		opts.maxInputBytes,
		opts.maxInputPixels,
	]) {
		if (!Number.isFinite(value) || value < 1)
			throw new ImageInputError("input_limit", "Invalid image processing limit.");
	}
	opts.maxWidth = Math.floor(opts.maxWidth);
	opts.maxHeight = Math.floor(opts.maxHeight);
	opts.jpegQuality = Math.min(100, Math.floor(opts.jpegQuality));
	return opts;
}

/** Worker-only codec. A successful decode, not just a matching header, is required. */
export async function prepareImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	opts: ImageCodecOptions,
): Promise<ResizedImage> {
	if (inputBytes.byteLength > opts.maxInputBytes)
		throw new ImageInputError("input_limit", "Image exceeds the source byte limit.");
	const actualMime = inspectImage(inputBytes, mimeType, opts.maxInputPixels);
	const photon = await loadPhoton();
	if (!photon) throw new ImageInputError("decoder_unavailable", "Image decoder is unavailable.");

	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		image = photon.PhotonImage.new_from_byteslice(inputBytes);
		const oriented = applyExifOrientation(photon, image, inputBytes);
		if (oriented !== image) {
			image.free();
			image = oriented;
		}
		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		if (!originalWidth || !originalHeight)
			throw new ImageInputError("invalid_image", "Image dimensions must be positive.");
		if (originalWidth * originalHeight > opts.maxInputPixels)
			throw new ImageInputError("pixel_limit", "Image exceeds the decoded pixel limit.");
		const convertedFrom =
			actualMime === "image/bmp" || (opts.forcePng && actualMime !== "image/png") ? actualMime : undefined;
		const result = (bytes: Uint8Array, outputMime: string, width: number, height: number): ResizedImage => ({
			data: Buffer.from(bytes).toString("base64"),
			mimeType: outputMime,
			originalWidth,
			originalHeight,
			width,
			height,
			wasResized: width !== originalWidth || height !== originalHeight,
			...(convertedFrom ? { convertedFrom } : {}),
		});
		const fits = (bytes: Uint8Array): boolean => Math.ceil(bytes.byteLength / 3) * 4 <= opts.maxBytes;
		const dimensionsFit = originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight;
		if (dimensionsFit && fits(inputBytes) && !convertedFrom)
			return result(inputBytes, actualMime, originalWidth, originalHeight);

		if (!opts.autoResizeImages) {
			if (dimensionsFit && convertedFrom) {
				const png = image.get_bytes();
				if (fits(png)) return result(png, "image/png", originalWidth, originalHeight);
			}
			throw new ImageInputError(
				"image_budget",
				"Original image does not fit the output policy; resizing is disabled.",
			);
		}

		let hasAlpha: boolean | undefined;
		const scale = Math.min(1, opts.maxWidth / originalWidth, opts.maxHeight / originalHeight);
		let width = Math.max(1, Math.round(originalWidth * scale));
		let height = Math.max(1, Math.round(originalHeight * scale));
		const qualities = [...new Set([opts.jpegQuality, 85, 70, 55, 40])]
			.filter((quality) => quality <= opts.jpegQuality)
			.sort((a, b) => b - a);
		while (true) {
			const resized = photon.resize(image, width, height, photon.SamplingFilter.Lanczos3);
			try {
				const png = resized.get_bytes();
				if (fits(png)) return result(png, "image/png", width, height);
				if (!opts.forcePng) {
					if (hasAlpha === undefined) {
						// Only pay for the full RGBA copy if JPEG is actually needed.
						// Inspect the source once, so resizing away a small translucent
						// feature never authorizes an opaque JPEG conversion.
						const pixels = image.get_raw_pixels();
						hasAlpha = false;
						for (let offset = 3; offset < pixels.length; offset += 4) {
							if (pixels[offset] !== 255) {
								hasAlpha = true;
								break;
							}
						}
					}
					if (!hasAlpha) {
						for (const quality of qualities) {
							const jpeg = resized.get_bytes_jpeg(quality);
							if (fits(jpeg)) return result(jpeg, "image/jpeg", width, height);
						}
					}
				}
			} finally {
				resized.free();
			}
			if (width === 1 && height === 1) break;
			width = Math.max(1, Math.floor(width * 0.75));
			height = Math.max(1, Math.floor(height * 0.75));
		}
		throw new ImageInputError("image_budget", "Image could not fit the output byte limit.");
	} catch (error) {
		if (error instanceof ImageInputError) throw error;
		throw new ImageInputError("invalid_image", "Image raster could not be decoded or encoded.");
	} finally {
		image?.free();
	}
}

/** Legacy codec entry for callers already running outside the UI thread. */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	try {
		return await prepareImageInProcess(inputBytes, mimeType, imageCodecOptions(options));
	} catch {
		return null;
	}
}
