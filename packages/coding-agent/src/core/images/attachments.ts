import type { SessionManager } from "../session-manager.ts";
import { getImageSourceMetadata, type ImageSourceDimensions } from "./storage-codec.ts";
import { IMAGE_LIMITS, ImageInputError } from "./types.ts";

/** Local source identity, not a provider image ID or a filesystem capability. */
export interface ImageSourceSummary {
	sourceId: string;
	mimeType: string;
	byteLength: number;
	dimensions?: ImageSourceDimensions;
}

export interface ImageSourceData extends ImageSourceSummary {
	/** Explicit reads only; at most maxInputBytes decoded bytes. */
	data: string;
}

/** Inspect only known image-bearing message fields on the active branch, never opaque details. */
export function listBranchImageSources(manager: SessionManager): ImageSourceSummary[] {
	const sources = new Map<string, ImageSourceSummary>();
	for (const entry of manager.getBranch()) {
		const contents: unknown[] = entry.type === "custom_message" ? [entry.content] : [];
		const messages =
			entry.type === "message"
				? [entry.message]
				: entry.type === "compaction"
					? (entry.replacementHistory ?? [])
					: [];
		for (const message of messages) {
			if (["user", "assistant", "toolResult", "custom"].includes(message.role) && "content" in message) {
				contents.push(message.content);
			}
		}
		for (const content of contents) {
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				const source = getImageSourceMetadata(block);
				if (!source || sources.has(source.asset.sha256)) continue;
				sources.set(source.asset.sha256, {
					sourceId: source.asset.sha256,
					mimeType: source.asset.mimeType,
					byteLength: source.asset.byteLength,
					...(source.dimensions
						? {
								dimensions: {
									originalWidth: source.dimensions.originalWidth,
									originalHeight: source.dimensions.originalHeight,
									width: source.dimensions.width,
									height: source.dimensions.height,
								},
							}
						: {}),
				});
			}
		}
	}
	return [...sources.values()];
}

/** Branch membership is checked afresh before the store enforces session ownership/integrity. */
export function readBranchImageSource(manager: SessionManager, sourceId: string, allowPrefix = false): ImageSourceData {
	if (typeof sourceId !== "string" || !(allowPrefix ? /^[a-f0-9]{8,64}$/ : /^[a-f0-9]{64}$/).test(sourceId)) {
		throw new ImageInputError("invalid_image", "Use a source ID from this branch's image source inventory.");
	}
	const matches = listBranchImageSources(manager).filter((source) => source.sourceId.startsWith(sourceId));
	if (matches.length === 0) {
		throw new ImageInputError("storage_missing", "Image source is not attached on the active branch.");
	}
	if (matches.length !== 1) {
		throw new ImageInputError("invalid_image", "Image source prefix is ambiguous; use a longer source ID.");
	}
	const source = matches[0];
	const bytes = manager.readImageSource({
		version: 1,
		sha256: source.sourceId,
		byteLength: source.byteLength,
		mimeType: source.mimeType,
	});
	if (bytes.byteLength !== source.byteLength || bytes.byteLength > IMAGE_LIMITS.maxInputBytes) {
		throw new ImageInputError("storage_invalid", "Image source length does not match its bounded reference.");
	}
	return { ...source, data: bytes.toString("base64") };
}
