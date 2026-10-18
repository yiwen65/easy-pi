import { crc32, deflateSync } from "node:zlib";

export function imagePngChunk(type: string, data: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(data.length);
	header.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
	return Buffer.concat([header, data, crc]);
}

/** A deterministic grayscale image; no personal screenshots or external encoders. */
export function createImagePng(width = 4, height = 4): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	const raw = Buffer.alloc((width + 1) * height);
	for (let row = 0; row < height; row++) {
		raw.fill(row % 256, row * (width + 1) + 1, (row + 1) * (width + 1));
	}
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		imagePngChunk("IHDR", header),
		imagePngChunk("IDAT", deflateSync(raw)),
		imagePngChunk("IEND", Buffer.alloc(0)),
	]);
}
