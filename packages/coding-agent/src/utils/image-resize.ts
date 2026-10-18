import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { IMAGE_LIMITS, ImageInputError } from "../core/images/types.ts";
import {
	type ImageCodecOptions,
	type ImagePreparationOptions,
	type ImageResizeOptions,
	imageCodecOptions,
	type ResizedImage,
} from "./image-resize-core.ts";
import type { ImageWorkerResponse } from "./image-resize-worker.ts";
import { normalizeImageMimeType } from "./image-validation.ts";

export type { ImagePreparationOptions, ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";

const MAX_QUEUE = 8;
const MAX_CACHE_ENTRIES = 32;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, { result: ResizedImage; bytes: number }>();
let cacheBytes = 0;
const jobs = new Map<string, ImageJob>();
const queue: ImageJob[] = [];
let active = false;

interface ImageWaiter {
	resolve: (result: ResizedImage) => void;
	reject: (error: unknown) => void;
	cleanup: () => void;
}
interface ImageJob {
	key: string;
	input: Uint8Array;
	mimeType: string;
	options: ImageCodecOptions;
	controller: AbortController;
	waiters: Set<ImageWaiter>;
	started: boolean;
	done: Promise<void>;
	finish: () => void;
}

function abortError(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("Image processing aborted.", "AbortError");
}

function isLoadFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return (
		code !== undefined &&
		["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_UNKNOWN_FILE_EXTENSION", "ERR_WORKER_PATH", "ENOENT"].includes(
			code,
		)
	);
}

async function runWorker(specifier: string | URL, job: ImageJob): Promise<ResizedImage> {
	job.controller.signal.throwIfAborted();
	const worker = new Worker(specifier);
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<ResizedImage>((resolve, reject) => {
			onAbort = () => reject(abortError(job.controller.signal));
			job.controller.signal.addEventListener("abort", onAbort, { once: true });
			worker.once("message", (message: ImageWorkerResponse) => {
				if (message?.error) reject(new ImageInputError(message.error.code, message.error.message));
				else if (message?.result && typeof message.result.data === "string") resolve(message.result);
				else reject(new ImageInputError("decoder_unavailable", "Invalid image worker response."));
			});
			worker.once("error", reject);
			worker.once("exit", (code) =>
				reject(
					new ImageInputError("decoder_unavailable", `Image worker exited before returning a result (${code}).`),
				),
			);
			// Only our private snapshot is detached. No input or shared cache bytes
			// belong to the caller by this point.
			const input = new Uint8Array(job.input);
			worker.postMessage({ inputBytes: input, mimeType: job.mimeType, options: job.options }, [input.buffer]);
		});
	} finally {
		if (onAbort) job.controller.signal.removeEventListener("abort", onAbort);
		// Capacity is not released, and last-waiter cancellation does not finish,
		// until the thread has actually stopped.
		await worker.terminate();
	}
}

async function runJob(job: ImageJob): Promise<ResizedImage> {
	const workerUrl = new URL(
		import.meta.url.endsWith(".ts") ? "./image-resize-worker.ts" : "./image-resize-worker.js",
		import.meta.url,
	);
	try {
		if (typeof process.versions.bun === "string") {
			try {
				return await runWorker("./src/utils/image-resize-worker.ts", job);
			} catch (error) {
				// Bun's embedded entrypoint can be absent in a non-compiled layout.
				// Only a proven loader failure permits trying the URL entrypoint.
				if (!isLoadFailure(error)) throw error;
				job.controller.signal.throwIfAborted();
			}
		}
		return await runWorker(workerUrl, job);
	} catch (error) {
		if (job.controller.signal.aborted) throw abortError(job.controller.signal);
		if (error instanceof ImageInputError) throw error;
		if ((error as NodeJS.ErrnoException)?.code === "ERR_WORKER_OUT_OF_MEMORY") {
			throw new ImageInputError("input_limit", "Image worker exhausted its resources.");
		}
		throw new ImageInputError("decoder_unavailable", "Image worker could not be loaded or completed.");
	}
}

function drainQueue(): void {
	if (active) return;
	const job = queue.shift();
	if (!job) return;
	active = true;
	job.started = true;
	void (async () => {
		try {
			const result = await runJob(job);
			if (!job.controller.signal.aborted) {
				// The cache owns only Base64 strings, not source/decoded byte arrays.
				// Count two bytes per retained character conservatively for JS strings.
				const bytes = result.data.length * 2;
				if (bytes <= MAX_CACHE_BYTES) {
					while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + bytes > MAX_CACHE_BYTES) {
						const oldest = cache.entries().next().value;
						if (!oldest) break;
						cache.delete(oldest[0]);
						cacheBytes -= oldest[1].bytes;
					}
					cache.set(job.key, { result: { ...result }, bytes });
					cacheBytes += bytes;
				}
				for (const waiter of job.waiters) {
					waiter.cleanup();
					waiter.resolve({ ...result });
				}
			}
		} catch (error) {
			for (const waiter of job.waiters) {
				waiter.cleanup();
				waiter.reject(error);
			}
		} finally {
			job.waiters.clear();
			if (jobs.get(job.key) === job) jobs.delete(job.key);
			active = false;
			job.finish();
			drainQueue();
		}
	})();
}

/** Classified, worker-backed preparation shared by admission and legacy resize. */
export async function prepareImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImagePreparationOptions,
): Promise<ResizedImage> {
	options?.signal?.throwIfAborted();
	const opts = imageCodecOptions(options);
	if (inputBytes.byteLength > opts.maxInputBytes)
		throw new ImageInputError("input_limit", "Image exceeds the source byte limit.");
	const timeoutMs = options?.timeoutMs ?? IMAGE_LIMITS.timeoutMs;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new ImageInputError("timeout", "Image processing deadline exceeded.");
	const input = new Uint8Array(inputBytes);
	const normalizedMime = normalizeImageMimeType(mimeType);
	const key = createHash("sha256")
		.update(input)
		.update(JSON.stringify(["photon-codec-v2", normalizedMime, opts]))
		.digest("hex");
	const hit = cache.get(key);
	if (hit) {
		cache.delete(key);
		cache.set(key, hit);
		return { ...hit.result };
	}
	let job = jobs.get(key);
	if (!job) {
		if (active && queue.length >= MAX_QUEUE)
			throw new ImageInputError("input_limit", "Image processing queue is full; retry after current images finish.");
		let finish = (): void => {};
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		job = {
			key,
			input,
			mimeType: normalizedMime,
			options: opts,
			controller: new AbortController(),
			waiters: new Set(),
			started: false,
			done,
			finish,
		};
		jobs.set(key, job);
		queue.push(job);
	}
	const currentJob = job;
	return new Promise<ResizedImage>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const signal = options?.signal;
		const cancel = (error: unknown): void => {
			waiter.cleanup();
			currentJob.waiters.delete(waiter);
			if (currentJob.waiters.size > 0) {
				reject(error);
				return;
			}
			if (jobs.get(key) === currentJob) jobs.delete(key);
			currentJob.controller.abort(error);
			if (!currentJob.started) {
				const index = queue.indexOf(currentJob);
				if (index >= 0) queue.splice(index, 1);
				currentJob.finish();
			}
			void currentJob.done.then(() => reject(error));
		};
		const onAbort = (): void =>
			cancel(signal ? abortError(signal) : new DOMException("Image processing aborted.", "AbortError"));
		const waiter: ImageWaiter = {
			resolve,
			reject,
			cleanup: () => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			},
		};
		currentJob.waiters.add(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(
			() => cancel(new ImageInputError("timeout", "Image processing deadline exceeded.")),
			Math.min(timeoutMs, 2_147_483_647),
		);
		drainQueue();
	});
}

/** Existing nullable API. Abort still rejects; ordinary processing failure is null. */
export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	try {
		return await prepareImage(inputBytes, mimeType, options);
	} catch (error) {
		if (options?.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
		return null;
	}
}

export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) return undefined;
	const scaleX = result.originalWidth / result.width;
	const scaleY = result.originalHeight / result.height;
	if (Math.abs(scaleX - scaleY) > 0.01) {
		return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply x coordinates by ${scaleX.toFixed(2)} and y coordinates by ${scaleY.toFixed(2)} to map to original image.]`;
	}
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scaleX.toFixed(2)} to map to original image.]`;
}
