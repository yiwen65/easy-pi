import { ImageInputError } from "../core/images/types.ts";
import { detectSupportedImageMimeType } from "./mime.ts";

export function normalizeImageMimeType(mimeType: string): string {
	const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (mime === "image/jpg") return "image/jpeg";
	if (mime === "image/x-ms-bmp" || mime === "image/x-bmp") return "image/bmp";
	return mime;
}

/** Header preflight is a resource guard, not proof that the raster is decodable. */
export function inspectImage(bytes: Uint8Array, declaredMime: string, maxPixels: number): string {
	const mime = detectSupportedImageMimeType(bytes);
	if (!mime) throw new ImageInputError("invalid_image", "Unrecognized or unsupported image container.");
	if (declaredMime && normalizeImageMimeType(declaredMime) !== mime) {
		throw new ImageInputError("mime_mismatch", "Declared image MIME does not match its bytes.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const check = (width: number, height: number): void => {
		if (!width || !height) throw new ImageInputError("invalid_image", "Image dimensions must be positive.");
		if (width * height > maxPixels) {
			throw new ImageInputError("pixel_limit", "Image exceeds the decoded pixel limit.");
		}
	};
	try {
		switch (mime) {
			case "image/png":
				check(view.getUint32(16), view.getUint32(20));
				break;
			case "image/bmp":
				if (view.getUint32(14, true) === 12) {
					check(view.getUint16(18, true), view.getUint16(20, true));
				} else {
					check(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
				}
				break;
			case "image/gif": {
				check(view.getUint16(6, true), view.getUint16(8, true));
				let offset = 13 + (bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
				while (offset < bytes.length) {
					if (bytes[offset] === 0x2c) {
						check(view.getUint16(offset + 5, true), view.getUint16(offset + 7, true));
						break;
					}
					if (bytes[offset] !== 0x21) break;
					offset += 2;
					while (offset < bytes.length && bytes[offset]) offset += 1 + bytes[offset];
					offset++;
				}
				break;
			}
			case "image/jpeg": {
				let found = false;
				for (let offset = 2; offset + 3 < bytes.length; ) {
					if (bytes[offset] !== 0xff) break;
					const marker = bytes[offset + 1];
					if (marker === 0xff) {
						offset++;
						continue;
					}
					if (marker === 0xda || marker === 0xd9) break;
					const length = view.getUint16(offset + 2);
					if (length < 2 || offset + 2 + length > bytes.length) break;
					if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
						check(view.getUint16(offset + 7), view.getUint16(offset + 5));
						found = true;
					}
					offset += 2 + length;
				}
				if (!found) throw new ImageInputError("invalid_image", "Missing JPEG dimensions.");
				break;
			}
			case "image/webp": {
				let found = false;
				const inspectChunks = (from: number, end: number, frame: boolean): void => {
					for (let offset = from; offset + 8 <= end; ) {
						const length = view.getUint32(offset + 4, true);
						const start = offset + 8;
						if (start + length > end) throw new ImageInputError("invalid_image", "Truncated WebP chunk.");
						const tag = String.fromCharCode(...bytes.subarray(offset, offset + 4));
						if (tag === "VP8X" && length >= 10) {
							check(
								1 + (view.getUint32(start + 4, true) & 0xffffff),
								1 + (view.getUint32(start + 6, true) >>> 8),
							);
							found = true;
						} else if (tag === "VP8L" && length >= 5) {
							const bits = view.getUint32(start + 1, true);
							check(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
							found = true;
						} else if (tag === "VP8 " && length >= 10) {
							check(view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff);
							found = true;
						} else if (tag === "ANMF") {
							if (frame || length < 16) throw new ImageInputError("invalid_image", "Invalid WebP frame.");
							check(
								1 + (view.getUint32(start + 6, true) & 0xffffff),
								1 + (view.getUint32(start + 9, true) & 0xffffff),
							);
							inspectChunks(start + 16, start + length, true);
						}
						offset = start + length + (length % 2);
					}
				};
				inspectChunks(12, bytes.length, false);
				if (!found) throw new ImageInputError("invalid_image", "Missing WebP dimensions.");
			}
		}
	} catch (error) {
		if (error instanceof ImageInputError) throw error;
		throw new ImageInputError("invalid_image", "Truncated image header.");
	}
	return mime;
}
