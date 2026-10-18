/** Process @file CLI arguments into text content and image attachments. */
import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { detectImageInputMimeType, prepareInputImages, readImageInputFile } from "../core/images/pipeline.ts";
import { resolveImagePolicy } from "../core/images/policy.ts";
import { ImageInputError } from "../core/images/types.ts";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { stripBom } from "../utils/text.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

/** Invalid user attachments reject the submission, rather than silently submitting text only. */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const policy = resolveImagePolicy(undefined, { autoResizeImages: options?.autoResizeImages });
	const parts: Array<{ text: string } | { path: string; imageIndex: number }> = [];
	const images: ImageContent[] = [];
	let batchBytes = 0;
	for (const fileArg of fileArgs) {
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}
		const stats = await stat(absolutePath);
		if (!stats.isFile()) throw new ImageInputError("invalid_image", "File attachments must be regular files.");
		if (stats.size === 0) continue;
		const mimeType = await detectImageInputMimeType(absolutePath);
		if (mimeType) {
			if (
				images.length >= policy.maxImages ||
				stats.size > policy.maxInputBytes ||
				batchBytes + stats.size > policy.maxBatchInputBytes
			) {
				throw new ImageInputError("input_limit", "File image attachments exceed the source count or byte limit.");
			}
			const content = await readImageInputFile(absolutePath, policy.maxInputBytes);
			batchBytes += content.byteLength;
			if (batchBytes > policy.maxBatchInputBytes)
				throw new ImageInputError("input_limit", "File image attachments exceed the combined source byte limit.");
			parts.push({ path: absolutePath, imageIndex: images.length });
			images.push({ type: "image", mimeType, data: content.toString("base64") });
		} else {
			try {
				const content = stripBom(await readFile(absolutePath, "utf-8"));
				parts.push({ text: `<file name="${absolutePath}">\n${content}\n</file>\n` });
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}
	const prepared = await prepareInputImages(images, policy);
	const hints: string[] = [];
	for (const part of prepared.content) {
		if (part.type === "image") hints.push("");
		else hints[hints.length - 1] = part.text;
	}
	const text = parts
		.map((part) => ("text" in part ? part.text : `<file name="${part.path}">${hints[part.imageIndex]}</file>\n`))
		.join("");
	return { text, images: prepared.images ?? [] };
}
