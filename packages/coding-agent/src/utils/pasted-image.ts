import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getImageDimensions } from "@earendil-works/pi-tui";

/** Only a standalone explicit PNG/JPEG path is treated as an attachment request. */
export function pastedImagePath(text: string): string | undefined {
	let path = text.trim();
	if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")))
		path = path.slice(1, -1);
	if (/[\x00-\x1f\x7f]/.test(path) || !/\.(png|jpe?g)$/i.test(path)) return undefined;
	if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	return isAbsolute(path) ? path : undefined;
}

/** Read asynchronously, without opening a FIFO or allocating an unbounded attachment. */
export async function readPastedImage(path: string): Promise<ImageContent | undefined> {
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024) return undefined;
			const bytes = Buffer.alloc(stat.size);
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
				if (bytesRead === 0) return undefined;
				offset += bytesRead;
			}
			const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
				? "image/png"
				: bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
					? "image/jpeg"
					: undefined;
			if (!mimeType) return undefined;
			const data = bytes.toString("base64");
			if (!getImageDimensions(data, mimeType)) return undefined;
			return { type: "image", mimeType, data };
		} finally {
			await file.close();
		}
	} catch {
		return undefined;
	}
}
