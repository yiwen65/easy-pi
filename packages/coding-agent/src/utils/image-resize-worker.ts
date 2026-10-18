import { parentPort } from "node:worker_threads";
import { type ImageFailureCode, ImageInputError } from "../core/images/types.ts";
import { type ImageCodecOptions, prepareImageInProcess, type ResizedImage } from "./image-resize-core.ts";

export interface ImageWorkerResponse {
	result?: ResizedImage;
	error?: { code: ImageFailureCode; message: string };
}

const port = parentPort;
if (!port) throw new Error("image resize worker requires parentPort");

port.once("message", (message: { inputBytes: Uint8Array; mimeType: string; options: ImageCodecOptions }) => {
	void (async () => {
		try {
			const result = await prepareImageInProcess(message.inputBytes, message.mimeType, message.options);
			port.postMessage({ result } satisfies ImageWorkerResponse);
		} catch (error) {
			const failure =
				error instanceof ImageInputError ? error : new ImageInputError("invalid_image", "Image processing failed.");
			port.postMessage({ error: { code: failure.code, message: failure.message } } satisfies ImageWorkerResponse);
		} finally {
			port.close();
		}
	})();
});
