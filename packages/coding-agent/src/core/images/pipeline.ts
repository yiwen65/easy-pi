import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { processImage } from "../../utils/image-process.ts";
import { normalizeImageMimeType } from "../../utils/image-validation.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { decodeImageData } from "./input.ts";
import { getImageSourceMetadata, type ImageSourceDimensions, type ImageSourceMetadata } from "./storage-codec.ts";
import { type ImageDecision, ImageInputError, type ImagePolicy } from "./types.ts";

export interface PreparedInputImages {
	images: ImageContent[] | undefined;
	decisions: ImageDecision[];
	/** Pending original snapshots, in image order. Empty after a source sink commits. */
	sources: ImageContent[];
	/** Images with their preparation hints immediately adjacent. */
	content: (ImageContent | TextContent)[];
}

export interface PrepareInputImageOptions {
	signal?: AbortSignal;
	/** A source commit belongs to this session, not every later caller holding the same object. */
	sourceOwner?: string;
	/** Publish the original snapshot before its prepared image enters durable history/queues. */
	onPrepared?: (
		prepared: ImageContent,
		source: ImageContent,
		dimensions: ImageSourceDimensions,
	) => ImageContent | Promise<ImageContent>;
}

interface SourceClaim {
	id: number;
	released: boolean;
}

interface PreparedFacts {
	signature: string;
	key: string;
	sourceId: string;
	inputMimeType: string;
	inputWidth: number;
	inputHeight: number;
	committed: boolean;
	sourceOwner?: string;
	claim?: SourceClaim;
	metadata?: ImageSourceMetadata;
	decision: ImageDecision;
}

// Weak keys retain facts only, never original byte payloads. Early CLI/read preparation uses
// the bounded handoff below until a session owns the source. Eviction is explicit, not a license
// to relabel a derivative as its original. Reattaching the original repopulates its digest entry.
const prepared = new WeakMap<ImageContent, PreparedFacts>();
const sourceHandoffs = new Map<string, { bytes: Buffer; mimeType: string; id: number; references: number }>();
let sourceHandoffBytes = 0;
let nextSourceClaimId = 0;
export const IMAGE_SOURCE_HANDOFF_LIMITS = Object.freeze({ maxEntries: 32, maxBytes: 32 * 1024 * 1024 });

/** Payload-only diagnostics; never exposes source bytes or filesystem paths. */
export function getImageSourceHandoffStats(): { entries: number; bytes: number } {
	return { entries: sourceHandoffs.size, bytes: sourceHandoffBytes };
}

function signature(image: ImageContent): string {
	return createHash("sha256").update(image.mimeType).update("\0").update(image.data).digest("hex");
}

function releaseSource(sourceId: string): void {
	const entry = sourceHandoffs.get(sourceId);
	if (!entry) return;
	sourceHandoffBytes -= entry.bytes.byteLength;
	sourceHandoffs.delete(sourceId);
}

function rememberSource(sourceId: string, bytes: Buffer, mimeType: string): void {
	if (sourceHandoffs.has(sourceId)) return;
	while (
		sourceHandoffs.size >= IMAGE_SOURCE_HANDOFF_LIMITS.maxEntries ||
		sourceHandoffBytes + bytes.byteLength > IMAGE_SOURCE_HANDOFF_LIMITS.maxBytes
	) {
		const oldest = sourceHandoffs.keys().next().value;
		if (oldest === undefined) return;
		releaseSource(oldest);
	}
	sourceHandoffs.set(sourceId, { bytes, mimeType, id: ++nextSourceClaimId, references: 0 });
	sourceHandoffBytes += bytes.byteLength;
}

function releaseSourceClaim(sourceId: string, claim: SourceClaim | undefined): void {
	if (!claim || claim.released) return;
	claim.released = true;
	const entry = sourceHandoffs.get(sourceId);
	if (!entry || entry.id !== claim.id) return;
	if (--entry.references === 0) releaseSource(sourceId);
}

/** Keep only standard image fields and locally validated provenance, never caller-forged app fields. */
export function sanitizeInputImage(
	image: ImageContent & { imageSource?: unknown },
	metadata: ImageSourceMetadata | null | undefined = prepared.get(image)?.signature === signature(image)
		? prepared.get(image)?.metadata
		: undefined,
): ImageContent {
	if (!metadata && Object.keys(image).length === 3) return image;
	const dimensions = metadata?.dimensions;
	return {
		type: "image",
		data: image.data,
		mimeType: image.mimeType,
		...(metadata
			? {
					imageSource: {
						version: 1,
						asset: { ...metadata.asset },
						...(dimensions
							? {
									dimensions: {
										originalWidth: dimensions.originalWidth,
										originalHeight: dimensions.originalHeight,
										width: dimensions.width,
										height: dimensions.height,
									},
								}
							: {}),
					},
				}
			: {}),
	};
}

/** Sniff regular local files without blocking on a pipe/device, including during open. */
export async function detectImageInputMimeType(path: string): Promise<string | null> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		if (!(await file.stat()).isFile())
			throw new ImageInputError("invalid_image", "Image input must be a regular file.");
		const buffer = Buffer.alloc(4100);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
	} finally {
		await file.close();
	}
}

/** Read one local image snapshot without allocating or reading an unbounded file. */
export async function readImageInputFile(path: string, maxBytes: number): Promise<Buffer> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stats = await file.stat();
		if (!stats.isFile()) throw new ImageInputError("invalid_image", "Image input must be a regular file.");
		const size = stats.size;
		if (size > maxBytes) throw new ImageInputError("input_limit", "Image file exceeds the source byte limit.");
		const buffer = Buffer.alloc(Math.min(maxBytes, size) + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) return buffer.subarray(0, length);
			length += bytesRead;
		}
		throw new ImageInputError("input_limit", "Image file grew while being read; retry the attachment.");
	} finally {
		await file.close();
	}
}

/** Admit a whole attachment group before doing any expensive image work. */
export async function prepareInputImages(
	images: ImageContent[] | undefined,
	policy: ImagePolicy,
	options: PrepareInputImageOptions = {},
): Promise<PreparedInputImages> {
	if (options.signal?.aborted) throw new ImageInputError("aborted", "Image preparation was cancelled.");
	if (images === undefined) return { images: undefined, decisions: [], content: [], sources: [] };
	if (!Array.isArray(images)) throw new ImageInputError("invalid_image", "Images must be an array.");
	if (images.length > policy.maxImages) throw new ImageInputError("input_limit", "Too many image attachments.");
	let batchBytes = 0;
	for (const image of images) {
		if (!image || image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") {
			throw new ImageInputError("invalid_image", "Each image must contain Base64 data and a MIME type.");
		}
		if (!image.mimeType || image.mimeType.length > 128) {
			throw new ImageInputError("invalid_image", "Image MIME type must be a short non-empty media type.");
		}
		if (image.data.length > Math.ceil(policy.maxInputBytes / 3) * 4) {
			throw new ImageInputError("input_limit", "Image exceeds the source byte limit.");
		}
		const entry = prepared.get(image);
		const known = entry?.signature === signature(image) ? entry : undefined;
		const metadata = known?.metadata;
		const inputBytes = metadata?.asset.byteLength ?? known?.decision.inputBytes;
		const dimensions = metadata?.dimensions;
		const inputWidth = dimensions?.originalWidth ?? known?.inputWidth;
		const inputHeight = dimensions?.originalHeight ?? known?.inputHeight;
		if (inputBytes !== undefined && inputBytes > policy.maxInputBytes) {
			throw new ImageInputError("input_limit", "Original image exceeds the source byte limit.");
		}
		if (inputWidth !== undefined && inputHeight !== undefined && inputWidth * inputHeight > policy.maxInputPixels) {
			throw new ImageInputError("pixel_limit", "Original image exceeds the source pixel limit.");
		}
		batchBytes +=
			inputBytes ??
			Math.floor(image.data.length / 4) * 3 - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0);
		if (batchBytes > policy.maxBatchInputBytes) {
			throw new ImageInputError("input_limit", "Images exceed the combined source byte limit.");
		}
	}
	const owners = [...images];
	// Snapshot before the first await; path mutation/deletion and caller object mutation cannot change it.
	const snapshots = owners.map((image) => {
		const entry = prepared.get(image);
		const metadata = entry?.signature === signature(image) ? entry.metadata : undefined;
		return sanitizeInputImage({ ...image }, metadata ?? null);
	});
	const key = JSON.stringify([
		policy.mode,
		policy.maxInputBytes,
		policy.maxInputPixels,
		policy.maxWidth,
		policy.maxHeight,
		policy.maxEncodedBytes,
	]);
	const controller = new AbortController();
	let timedOut = false;
	const cancel = () => controller.abort();
	options.signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, policy.batchTimeoutMs);
	timer.unref?.();
	const result: PreparedInputImages = { images: [], decisions: [], content: [], sources: [] };
	const publications: Array<{ index: number; contentIndex: number; source: ImageContent; facts: PreparedFacts }> = [];
	const claimsCreated: Array<{ sourceId: string; claim: SourceClaim }> = [];
	try {
		for (const [index, image] of snapshots.entries()) {
			if (controller.signal.aborted) throw new ImageInputError("aborted", "Image preparation was cancelled.");
			const owner = owners[index];
			const entry = prepared.get(owner);
			const known = entry?.signature === signature(image) ? entry : undefined;
			const committed =
				known?.committed === true && (!options.onPrepared || known.sourceOwner === options.sourceOwner);
			const metadata = committed ? known?.metadata : undefined;
			let source: ImageContent | undefined;
			let bytes: Buffer | undefined;
			let claim: SourceClaim | undefined;
			let sourceId = known?.sourceId;
			if (!committed) {
				const retained = sourceId ? sourceHandoffs.get(sourceId) : undefined;
				if (retained) {
					bytes = retained.bytes;
					source = Object.freeze({ type: "image", data: bytes.toString("base64"), mimeType: retained.mimeType });
				} else {
					bytes = decodeImageData(image, policy.maxInputBytes);
					const digest = createHash("sha256").update(bytes).digest("hex");
					if (sourceId && digest !== sourceId) {
						throw new ImageInputError(
							"storage_missing",
							"Original image snapshot expired before session attachment. Reattach the original image and retry.",
							known ? [known.decision.imageId] : [],
						);
					}
					sourceId = digest;
					source = Object.freeze({ type: "image", data: image.data, mimeType: image.mimeType });
					rememberSource(sourceId, bytes, source.mimeType);
				}
				const handoff = sourceHandoffs.get(sourceId!);
				if (handoff) {
					if (known?.claim && !known.claim.released && known.claim.id === handoff.id) claim = known.claim;
					else {
						handoff.references++;
						claim = { id: handoff.id, released: false };
						claimsCreated.push({ sourceId: sourceId!, claim });
					}
				}
			}
			let output: ImageContent;
			let facts: PreparedFacts;
			let hints: string[] = [];
			if (known?.key === key) {
				output = sanitizeInputImage(signature(owner) === known.signature ? owner : image, metadata ?? null);
				facts = { ...known, committed, metadata, claim, sourceOwner: committed ? known.sourceOwner : undefined };
				result.decisions.push({ ...known.decision });
			} else {
				// A policy change can still use the pending original; committed provenance never requires
				// re-reading or re-publishing the source merely to validate a hydrated derivative.
				bytes ??= decodeImageData(image, policy.maxInputBytes);
				const imageId = metadata
					? `image_${metadata.asset.sha256}`
					: (known?.decision.imageId ?? `image_${sourceId ?? createHash("sha256").update(bytes).digest("hex")}`);
				const processed = await processImage(bytes, source?.mimeType ?? image.mimeType, {
					autoResizeImages: policy.mode === "balanced",
					resizeOptions: {
						maxWidth: policy.maxWidth,
						maxHeight: policy.maxHeight,
						maxBytes: policy.maxEncodedBytes,
					},
					signal: controller.signal,
					timeoutMs: policy.timeoutMs,
					maxInputBytes: policy.maxInputBytes,
					maxInputPixels: policy.maxInputPixels,
				});
				if (controller.signal.aborted) throw new ImageInputError("aborted", "Image preparation was cancelled.");
				if (!processed.ok) throw new ImageInputError(processed.code, processed.message, [imageId]);
				output = sanitizeInputImage(
					processed.data === owner.data && processed.mimeType === owner.mimeType
						? owner
						: { ...image, data: processed.data, mimeType: processed.mimeType },
					metadata ?? null,
				);
				const original = metadata?.dimensions;
				const decision: ImageDecision = {
					imageId,
					stage: "prepared",
					mimeType: output.mimeType,
					inputBytes: metadata?.asset.byteLength ?? known?.decision.inputBytes ?? bytes.byteLength,
					encodedBytes: output.data.length,
					width: processed.dimensions.width,
					height: processed.dimensions.height,
				};
				facts = {
					signature: signature(output),
					key,
					sourceId: sourceId ?? createHash("sha256").update(bytes).digest("hex"),
					inputMimeType:
						metadata?.asset.mimeType ?? known?.inputMimeType ?? normalizeImageMimeType(image.mimeType),
					inputWidth: original?.originalWidth ?? known?.inputWidth ?? processed.dimensions.originalWidth,
					inputHeight: original?.originalHeight ?? known?.inputHeight ?? processed.dimensions.originalHeight,
					committed,
					sourceOwner: committed ? known?.sourceOwner : undefined,
					claim,
					metadata,
					decision,
				};
				if (metadata) {
					facts.metadata = {
						...metadata,
						dimensions: {
							originalWidth: facts.inputWidth,
							originalHeight: facts.inputHeight,
							width: decision.width!,
							height: decision.height!,
						},
					};
					output = sanitizeInputImage(output, facts.metadata);
				}
				result.decisions.push(
					{
						...decision,
						stage: "accepted",
						mimeType: facts.inputMimeType,
						encodedBytes: Math.ceil(decision.inputBytes! / 3) * 4,
						width: facts.inputWidth,
						height: facts.inputHeight,
					},
					decision,
				);
				hints = processed.hints;
			}
			prepared.set(output, facts);
			const contentIndex = result.content.length;
			result.content.push(output);
			if (hints.length) result.content.push({ type: "text", text: hints.join("\n") });
			result.images!.push(output);
			if (source) {
				if (options.onPrepared) publications.push({ index, contentIndex, source, facts });
				else result.sources.push(source);
			}
		}
		if (
			!policy.blocked &&
			policy.vision &&
			result.images!.reduce((bytes, image) => bytes + image.data.length, 0) > policy.maxRequestEncodedBytes
		) {
			throw new ImageInputError(
				"image_budget",
				"Current image attachments exceed the request Base64 byte budget. Remove or crop attachments before retrying.",
				result.decisions.filter((decision) => decision.stage === "prepared").map((decision) => decision.imageId),
			);
		}
		for (const publication of publications) {
			if (controller.signal.aborted) throw new ImageInputError("aborted", "Image preparation was cancelled.");
			const output = result.images![publication.index];
			const { facts, source } = publication;
			let attached: ImageContent;
			try {
				const published = await options.onPrepared!(output, source, {
					originalWidth: facts.inputWidth,
					originalHeight: facts.inputHeight,
					width: facts.decision.width!,
					height: facts.decision.height!,
				});
				attached = sanitizeInputImage(published, getImageSourceMetadata(published) ?? null);
				if (attached.type !== "image" || signature(attached) !== facts.signature) {
					throw new ImageInputError("storage_invalid", "Image source attachment changed the prepared image.");
				}
			} catch (error) {
				if (error instanceof ImageInputError) throw error;
				throw new ImageInputError(
					"storage_invalid",
					"Original image snapshot could not be attached to this session.",
				);
			}
			// Publication may leave an orphan on cancellation, but must never revive a cancelled prompt.
			releaseSourceClaim(facts.sourceId, facts.claim);
			const committed = {
				...facts,
				committed: true,
				sourceOwner: options.sourceOwner,
				metadata: getImageSourceMetadata(attached),
			};
			prepared.set(output, committed);
			prepared.set(attached, committed);
			result.images![publication.index] = attached;
			result.content[publication.contentIndex] = attached;
			if (controller.signal.aborted) throw new ImageInputError("aborted", "Image preparation was cancelled.");
		}
		return result;
	} catch (error) {
		// A failed call does not return its newly created outputs. Keep only pre-existing caller
		// claims (for example a CLI derivative retry), rather than stranding inaccessible claims.
		for (const { sourceId, claim } of claimsCreated) releaseSourceClaim(sourceId, claim);
		if (timedOut) throw new ImageInputError("timeout", "Image attachment preparation exceeded its deadline.");
		if (options.signal?.aborted || controller.signal.aborted) {
			throw new ImageInputError("aborted", "Image preparation was cancelled.");
		}
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
	}
}

/** Preserve text/image order for extension/custom messages as well as tool output. */
export async function prepareInputContent(
	content: (TextContent | ImageContent)[],
	policy: ImagePolicy,
	options: PrepareInputImageOptions = {},
): Promise<{ content: (TextContent | ImageContent)[]; decisions: ImageDecision[] }> {
	const images: ImageContent[] = [];
	for (const part of content) {
		if (part?.type === "image") images.push(part);
		if (images.length > policy.maxImages) throw new ImageInputError("input_limit", "Too many image attachments.");
	}
	if (!images.length) return { content, decisions: [] };
	const result = await prepareInputImages(images, policy, options);
	const output: (TextContent | ImageContent)[] = [];
	let index = 0;
	for (const part of content) {
		if (part.type !== "image") output.push(part);
		else {
			output.push(result.content[index++]);
			if (result.content[index]?.type === "text") output.push(result.content[index++]);
		}
	}
	return {
		content: output.every((part, i) => part === content[i]) && output.length === content.length ? content : output,
		decisions: result.decisions,
	};
}
