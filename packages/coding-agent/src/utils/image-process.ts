import { type ImageFailureCode, ImageInputError } from "../core/images/types.ts";
import { formatDimensionNote, type ImageResizeOptions, prepareImage } from "./image-resize.ts";

export interface ProcessImageOptions {
	/** False preserves valid original bytes; output policy still applies. */
	autoResizeImages?: boolean;
	resizeOptions?: ImageResizeOptions;
	signal?: AbortSignal;
	/** Includes time spent in the bounded queue. Default: 10 seconds. */
	timeoutMs?: number;
	maxInputBytes?: number;
	maxInputPixels?: number;
}

export type ProcessImageResult =
	| {
			ok: true;
			data: string;
			mimeType: string;
			hints: string[];
			dimensions: { originalWidth: number; originalHeight: number; width: number; height: number };
	  }
	| { ok: false; message: string; code: ImageFailureCode };

export async function processImage(
	bytes: Uint8Array,
	mimeType: string,
	options?: ProcessImageOptions,
): Promise<ProcessImageResult> {
	try {
		const result = await prepareImage(bytes, mimeType, {
			...options?.resizeOptions,
			autoResizeImages: options?.autoResizeImages ?? true,
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
			...(options?.maxInputBytes !== undefined ? { maxInputBytes: options.maxInputBytes } : {}),
			...(options?.maxInputPixels !== undefined ? { maxInputPixels: options.maxInputPixels } : {}),
		});
		const hints: string[] = [];
		if (result.convertedFrom) hints.push(`[Image converted from ${result.convertedFrom} to ${result.mimeType}.]`);
		const note = formatDimensionNote(result);
		if (note) hints.push(note);
		return {
			ok: true,
			data: result.data,
			mimeType: result.mimeType,
			hints,
			dimensions: {
				originalWidth: result.originalWidth,
				originalHeight: result.originalHeight,
				width: result.width,
				height: result.height,
			},
		};
	} catch (error) {
		if (
			options?.signal?.aborted ||
			options?.resizeOptions?.signal?.aborted ||
			(error instanceof Error && error.name === "AbortError")
		)
			throw error;
		const failure =
			error instanceof ImageInputError
				? error
				: new ImageInputError("decoder_unavailable", "Image processing is unavailable.");
		return { ok: false, message: `[Image omitted: ${failure.message}]`, code: failure.code };
	}
}
