import type { ImageContent } from "@earendil-works/pi-ai";
import { normalizeImageMimeType } from "../../utils/image-validation.ts";
import type { FileEntry } from "../session-manager.ts";
import type { ImageAssetRef } from "./source-store.ts";
import { IMAGE_LIMITS, ImageInputError } from "./types.ts";

export interface ImageSourceDimensions {
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
}

/** App-only provenance. Provider serialization and portable exports must strip this property. */
export interface ImageSourceMetadata {
	version: 1;
	asset: ImageAssetRef;
	dimensions?: ImageSourceDimensions;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAsset(value: unknown): value is ImageAssetRef {
	return (
		object(value) &&
		value.version === 1 &&
		typeof value.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.sha256) &&
		Number.isSafeInteger(value.byteLength) &&
		(value.byteLength as number) > 0 &&
		(value.byteLength as number) <= IMAGE_LIMITS.maxInputBytes &&
		["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"].includes(value.mimeType as string) &&
		Object.keys(value).every((key) => ["version", "sha256", "byteLength", "mimeType"].includes(key))
	);
}

export function getImageSourceMetadata(image: unknown): ImageSourceMetadata | undefined {
	if (!object(image) || image.type !== "image" || !object(image.imageSource)) return undefined;
	const source = image.imageSource;
	if (source.version !== 1 || !isAsset(source.asset)) return undefined;
	const dimensions = source.dimensions;
	if (
		dimensions !== undefined &&
		(!object(dimensions) ||
			!["originalWidth", "originalHeight", "width", "height"].every(
				(key) => Number.isSafeInteger(dimensions[key]) && (dimensions[key] as number) > 0,
			))
	)
		return undefined;
	return {
		version: 1,
		asset: { ...source.asset },
		...(dimensions === undefined
			? {}
			: {
					dimensions: {
						originalWidth: dimensions.originalWidth as number,
						originalHeight: dimensions.originalHeight as number,
						width: dimensions.width as number,
						height: dimensions.height as number,
					},
				}),
	};
}

/** Storage validates canonical Base64, not raster semantics (admission owns decoding). */
export function imageStorageBytes(image: ImageContent): Buffer {
	if (
		typeof image.data !== "string" ||
		!image.data.length ||
		image.data.length > Math.ceil(IMAGE_LIMITS.maxInputBytes / 3) * 4 ||
		image.data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
	)
		throw new ImageInputError("storage_invalid", "Invalid inline image storage data.");
	const bytes = Buffer.from(image.data, "base64");
	if (bytes.toString("base64") !== image.data) {
		throw new ImageInputError("storage_invalid", "Invalid inline image storage data.");
	}
	return bytes;
}

type Transform = (image: Record<string, unknown>) => unknown;

function content(value: unknown, transform: Transform): unknown {
	if (!Array.isArray(value)) return value;
	return value.flatMap((block) => {
		if (!object(block) || block.type !== "image") return [block];
		const transformed = transform(block);
		return Array.isArray(transformed) ? transformed : [transformed];
	});
}

function message(value: unknown, transform: Transform): unknown {
	if (!object(value) || !["user", "assistant", "toolResult", "custom"].includes(value.role as string)) return value;
	return { ...value, content: content(value.content, transform) };
}

function messages(value: unknown, transform: Transform): unknown {
	return Array.isArray(value) ? value.map((item) => message(item, transform)) : value;
}

/** Schema-directed only: tool arguments/details, signatures and arbitrary extension data stay opaque. */
function task(value: unknown, transform: Transform, suspended = true): unknown {
	if (!object(value)) return value;
	const copy = { ...value };
	if ("prompt" in copy) copy.prompt = messages(copy.prompt, transform);
	if (Array.isArray(copy.queued))
		copy.queued = copy.queued.map((group) =>
			object(group) ? { ...group, messages: messages(group.messages, transform) } : group,
		);
	if (object(copy.step)) {
		const step = { ...copy.step };
		if ("message" in step) step.message = message(step.message, transform);
		if (Array.isArray(step.items))
			step.items = step.items.flatMap((item) => {
				if (!object(item) || !object(item.block) || item.block.type !== "image") return [item];
				const transformed = transform(item.block);
				return (Array.isArray(transformed) ? transformed : [transformed]).map((block) => ({ ...item, block }));
			});
		copy.step = step;
	}
	if (Array.isArray(copy.tools))
		copy.tools = copy.tools.map((tool) =>
			object(tool) && "result" in tool ? { ...tool, result: message(tool.result, transform) } : tool,
		);
	if (suspended && Array.isArray(copy.suspendedTasks))
		copy.suspendedTasks = copy.suspendedTasks.map((item) =>
			object(item) ? { ...item, state: task(item.state, transform, false) } : item,
		);
	return copy;
}

function transformEntry(entry: FileEntry, transform: Transform): FileEntry {
	if (entry.type === "message") return { ...entry, message: message(entry.message, transform) } as FileEntry;
	if (entry.type === "custom_message") return { ...entry, content: content(entry.content, transform) } as FileEntry;
	if (entry.type === "compaction" && entry.replacementHistory) {
		return { ...entry, replacementHistory: messages(entry.replacementHistory, transform) } as FileEntry;
	}
	if (entry.type === "custom" && entry.customType === "pi-task-recovery") {
		return { ...entry, data: task(entry.data, transform) };
	}
	if (entry.type === "custom" && entry.customType === "pi-tool-interruption" && object(entry.data)) {
		return { ...entry, data: { ...entry.data, message: message(entry.data.message, transform) } };
	}
	return entry;
}

export interface ImageStorageOperations {
	put(bytes: Uint8Array, mimeType: string): ImageAssetRef;
	read(ref: ImageAssetRef): Buffer;
}

/** Physical v4 images have imageAsset and no data. Logical images always have Base64 data. */
export class ImageStorageCodec {
	private readonly store: ImageStorageOperations;
	private readonly readSource: ((ref: ImageAssetRef) => Buffer) | undefined;

	constructor(store: ImageStorageOperations, readSource?: (ref: ImageAssetRef) => Buffer) {
		this.store = store;
		this.readSource = readSource;
	}

	encode(entry: FileEntry): FileEntry {
		return transformEntry(entry, (image) => {
			if ("imageAsset" in image) throw new ImageInputError("storage_invalid", "Expected a logical inline image.");
			const metadata = getImageSourceMetadata(image);
			if ("imageSource" in image && !metadata)
				throw new ImageInputError("storage_invalid", "Invalid image source metadata.");
			if (metadata) {
				const bytes = this.readSource ? this.readSource(metadata.asset) : this.store.read(metadata.asset);
				metadata.asset = this.store.put(bytes, metadata.asset.mimeType);
			}
			let bytes: Buffer;
			try {
				bytes = imageStorageBytes(image as unknown as ImageContent);
			} catch (error) {
				// Failed tool-image admission intentionally retains bounded raw evidence. Do not
				// make the already-executed tool fact (or its recovery receipt) unpersistable.
				if (typeof image.data === "string" && image.data.length <= Math.ceil(IMAGE_LIMITS.maxInputBytes / 3) * 4)
					return { ...image };
				throw error;
			}
			const mime = typeof image.mimeType === "string" ? normalizeImageMimeType(image.mimeType) : "";
			if (!["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"].includes(mime)) return { ...image };
			const asset = this.store.put(bytes, mime);
			const { data: _data, imageSource: _source, ...rest } = image;
			return {
				...rest,
				mimeType: asset.mimeType,
				imageAsset: asset,
				...(metadata ? { imageSource: metadata } : {}),
			};
		});
	}

	decode(entry: FileEntry): FileEntry {
		return transformEntry(entry, (image) => {
			if (!("imageAsset" in image)) return image;
			const metadata = getImageSourceMetadata(image);
			try {
				if (!isAsset(image.imageAsset) || "data" in image || image.mimeType !== image.imageAsset.mimeType) {
					throw new ImageInputError("storage_invalid", "Invalid physical image reference.");
				}
				const data = this.store.read(image.imageAsset).toString("base64");
				const { imageAsset: _asset, imageSource: _source, ...rest } = image;
				if ("imageSource" in image) {
					try {
						if (!metadata) throw new ImageInputError("storage_invalid", "Invalid image source metadata.");
						this.store.read(metadata.asset);
					} catch (error) {
						const code = error instanceof ImageInputError ? error.code : "storage_invalid";
						// Keep the usable derivative and facts. A lost original must not poison every
						// subsequent recovery snapshot, nor be silently replaced by the derivative.
						return [
							{ ...rest, data },
							{ type: "text", text: `[Original image source unavailable locally: ${code}.]` },
						];
					}
				}
				return { ...rest, data, ...(metadata ? { imageSource: metadata } : {}) };
			} catch (error) {
				const code = error instanceof ImageInputError ? error.code : "storage_invalid";
				if (metadata) {
					try {
						// A broken derivative must not make a healthy original undiscoverable or
						// uncopiable. This is explicit local recovery, not remote receipt evidence.
						const data = this.store.read(metadata.asset).toString("base64");
						const dimensions = metadata.dimensions;
						const recovered: ImageSourceMetadata = {
							...metadata,
							...(dimensions
								? {
										dimensions: {
											...dimensions,
											width: dimensions.originalWidth,
											height: dimensions.originalHeight,
										},
									}
								: {}),
						};
						const { imageAsset: _asset, imageSource: _source, ...rest } = image;
						return [
							{ ...rest, type: "image", mimeType: metadata.asset.mimeType, data, imageSource: recovered },
							{
								type: "text",
								text: `[Image derivative unavailable locally: ${code}. Recovered verified original; earlier derivative size notes do not describe this image.]`,
							},
						];
					} catch {
						// Both local representations are unavailable; retain surrounding facts.
					}
				}
				return { type: "text", text: `[Image omitted locally: ${code}.]` };
			}
		});
	}
}

/** Inline derivative only: source bundles are intentionally not part of portable export. */
export function portableImageEntry(entry: FileEntry): FileEntry {
	return transformEntry(entry, (image) => {
		if ("imageAsset" in image)
			throw new ImageInputError("storage_invalid", "Portable export requires hydrated images.");
		const { imageSource: _source, ...rest } = image;
		return rest;
	});
}

export function collectImageAssets(entry: FileEntry): ImageAssetRef[] {
	const refs: ImageAssetRef[] = [];
	transformEntry(entry, (image) => {
		if (isAsset(image.imageAsset)) refs.push(image.imageAsset);
		const source = getImageSourceMetadata(image);
		if (source) refs.push(source.asset);
		return image;
	});
	return refs;
}
