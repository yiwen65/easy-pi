import { createHash } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type PrepareInputImageOptions, prepareInputContent, sanitizeInputImage } from "../core/images/pipeline.ts";
import { resolveImagePolicy } from "../core/images/policy.ts";
import { type ImageDecision, ImageInputError, type ImagePolicy } from "../core/images/types.ts";

export type ToolResultContent = TextContent | ImageContent;

export interface NormalizeToolResultImagesOptions {
	/** Whether oversized images are resized to inline provider limits. Default: true */
	autoResizeImages?: boolean;
	policy?: ImagePolicy;
	signal?: AbortSignal;
	sourceOwner?: string;
	onPrepared?: PrepareInputImageOptions["onPrepared"];
	onDecisions?: (decisions: readonly ImageDecision[]) => void;
}

/**
 * Prepare after tool_result transformations, without changing the tool's execution outcome.
 * A failed attachment is bounded evidence, not permission to rerun an already executed tool.
 * The outgoing request guard replaces unprepared images only in the provider view.
 */
export async function normalizeToolResultImages(
	content: ToolResultContent[],
	options?: NormalizeToolResultImagesOptions,
): Promise<ToolResultContent[]> {
	if (!content.some((block) => block.type === "image")) return content;
	const policy = options?.policy ?? resolveImagePolicy(undefined, { autoResizeImages: options?.autoResizeImages });
	try {
		const result = await prepareInputContent(content, policy, {
			signal: options?.signal,
			sourceOwner: options?.sourceOwner,
			onPrepared: options?.onPrepared,
		});
		options?.onDecisions?.(result.decisions);
		return result.content;
	} catch (error) {
		const code = error instanceof ImageInputError ? error.code : "decoder_unavailable";
		let bytes = 0;
		let count = 0;
		const bounded: ToolResultContent[] = [];
		for (const block of content) {
			if (block.type !== "image") {
				bounded.push(block);
				continue;
			}
			count++;
			if (count > policy.maxImages) continue;
			options?.onDecisions?.([
				{
					imageId: `image_${createHash("sha256")
						.update(typeof block.data === "string" ? block.data : "")
						.digest("hex")}`,
					stage: "omitted",
					code,
					reason: "Tool image preparation failed; bounded execution evidence retained without replaying the tool.",
				},
			]);
			const length = typeof block.data === "string" ? block.data.length : 0;
			const size =
				typeof block.data === "string"
					? length % 4 === 0
						? Math.max(0, (length / 4) * 3 - (block.data.endsWith("==") ? 2 : block.data.endsWith("=") ? 1 : 0))
						: Math.ceil(length / 4) * 3
					: 0;
			bytes += size;
			if (
				typeof block.data === "string" &&
				typeof block.mimeType === "string" &&
				block.mimeType.length > 0 &&
				block.mimeType.length <= 128 &&
				length <= Math.ceil(policy.maxInputBytes / 3) * 4 &&
				size <= policy.maxInputBytes &&
				bytes <= policy.maxBatchInputBytes
			) {
				// A missing/failed source may belong to another session. Preserve bounded received
				// bytes, but never commit its foreign or unverified provenance to this owner's log.
				bounded.push(
					code === "storage_missing" || code === "storage_invalid"
						? { type: "image", data: block.data, mimeType: block.mimeType }
						: sanitizeInputImage(block),
				);
				continue;
			}
			const digest =
				typeof block.data === "string" ? createHash("sha256").update(block.data).digest("hex") : "unavailable";
			bounded.push({
				type: "text",
				text: `[Tool image evidence omitted: input_limit; Base64 characters=${length}; Base64 SHA-256=${digest}.]`,
			});
		}
		if (count > policy.maxImages)
			bounded.push({
				type: "text",
				text: `[Additional ${count - policy.maxImages} tool images omitted: input_limit.]`,
			});
		// Do not throw on cancellation here: agent-core would replace the complete executed tool
		// result with an error. Preserve the bounded fact, and let the aborted loop stop normally.
		bounded.push({
			type: "text",
			text: `[Tool image preparation failed: ${code}. Original bounded tool evidence retained; unprepared images must not be sent. Do not rerun the tool to recover this image.]`,
		});
		return bounded;
	}
}
