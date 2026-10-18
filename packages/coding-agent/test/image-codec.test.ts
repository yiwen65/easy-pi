import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { convertImageBytesToPng, convertToPng } from "../src/utils/image-convert.ts";
import { processImage } from "../src/utils/image-process.ts";
import { loadPhoton } from "../src/utils/photon.ts";
import { createImagePng, imagePngChunk } from "./helpers/image-fixtures.ts";

function alphaPng(width: number, height: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const raster = Buffer.alloc((width * 4 + 1) * height);
	let random = 42;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = y * (width * 4 + 1) + 1 + x * 4;
			for (let channel = 0; channel < 3; channel++) {
				random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
				raster[offset + channel] = random >>> 24;
			}
			raster[offset + 3] = 128;
		}
	}
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		imagePngChunk("IHDR", header),
		imagePngChunk("IDAT", deflateSync(raster)),
		imagePngChunk("IEND", Buffer.alloc(0)),
	]);
}

describe("bounded image codec", () => {
	it("classifies invalid bytes, MIME disagreement and truncated raster even in original mode", async () => {
		for (const [bytes, mimeType, code] of [
			[Buffer.from("not an image"), "image/png", "invalid_image"],
			[createImagePng(), "image/jpeg", "mime_mismatch"],
			[createImagePng().subarray(0, 33), "image/png", "invalid_image"],
		] as const) {
			expect(await processImage(bytes, mimeType, { autoResizeImages: false })).toMatchObject({ ok: false, code });
		}
	});

	it("preserves valid original bytes and reports dimensions", async () => {
		const input = createImagePng(12, 7);
		const result = await processImage(input, "IMAGE/PNG; charset=binary", { autoResizeImages: false });
		expect(result).toMatchObject({
			ok: true,
			data: input.toString("base64"),
			mimeType: "image/png",
			dimensions: { originalWidth: 12, originalHeight: 7, width: 12, height: 7 },
		});
	});

	it("does not impose the balanced 2000px preference on original mode", async () => {
		const input = createImagePng(2300, 5);
		expect(await processImage(input, "image/png", { autoResizeImages: false })).toMatchObject({
			ok: true,
			data: input.toString("base64"),
			dimensions: { originalWidth: 2300, originalHeight: 5, width: 2300, height: 5 },
		});
	});

	it("format-only terminal conversion preserves capture geometry above 2000px", async () => {
		const photon = await loadPhoton();
		expect(photon).not.toBeNull();
		const image = photon!.PhotonImage.new_from_byteslice(createImagePng(2300, 5));
		let jpeg: Uint8Array;
		try {
			jpeg = image.get_bytes_jpeg(90);
		} finally {
			image.free();
		}
		const png = await convertImageBytesToPng(jpeg);
		expect(png).not.toBeNull();
		expect(Buffer.from(png!).readUInt32BE(16)).toBe(2300);
		expect(Buffer.from(png!).readUInt32BE(20)).toBe(5);
		const terminal = await convertToPng(Buffer.from(jpeg).toString("base64"), "image/jpeg");
		expect(terminal).not.toBeNull();
		expect(Buffer.from(terminal!.data, "base64").readUInt32BE(16)).toBe(2300);
		expect(Buffer.from(terminal!.data, "base64").readUInt32BE(20)).toBe(5);
	});

	it("validates WebP and GIF containers and preserves valid original bytes", async () => {
		const photon = await loadPhoton();
		expect(photon).not.toBeNull();
		const image = photon!.PhotonImage.new_from_byteslice(createImagePng(7, 3));
		let webp: Uint8Array;
		try {
			webp = image.get_bytes_webp();
		} finally {
			image.free();
		}
		const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
		for (const [bytes, mimeType] of [
			[webp, "image/webp"],
			[gif, "image/gif"],
		] as const) {
			expect(await processImage(bytes, mimeType, { autoResizeImages: false })).toMatchObject({
				ok: true,
				data: Buffer.from(bytes).toString("base64"),
				mimeType,
			});
		}
		expect(await processImage(webp, "image/webp", { maxInputPixels: 20 })).toMatchObject({
			ok: false,
			code: "pixel_limit",
		});
		const oversizedFrame = Buffer.from(gif);
		const descriptor = oversizedFrame.indexOf(0x2c);
		oversizedFrame.writeUInt16LE(65535, descriptor + 5);
		oversizedFrame.writeUInt16LE(65535, descriptor + 7);
		expect(await processImage(oversizedFrame, "image/gif", { autoResizeImages: false })).toMatchObject({
			ok: false,
			code: "pixel_limit",
		});
	});

	it("does not trust a small WebP canvas to hide an oversized animation frame", async () => {
		const header = Buffer.alloc(12);
		header.write("RIFF");
		header.write("WEBP", 8);
		const canvas = Buffer.alloc(18);
		canvas.write("VP8X");
		canvas.writeUInt32LE(10, 4);
		canvas[8] = 2;
		const frame = Buffer.alloc(24);
		frame.write("ANMF");
		frame.writeUInt32LE(16, 4);
		frame.writeUIntLE(9999, 14, 3);
		frame.writeUIntLE(9999, 17, 3);
		header.writeUInt32LE(header.length + canvas.length + frame.length - 8, 4);
		expect(
			await processImage(Buffer.concat([header, canvas, frame]), "image/webp", { autoResizeImages: false }),
		).toMatchObject({ ok: false, code: "pixel_limit" });
	});

	it("does not reuse a permissive verdict for a tighter input policy", async () => {
		const input = createImagePng();
		expect((await processImage(input, "image/png")).ok).toBe(true);
		expect(await processImage(input, "image/png", { maxInputPixels: 15 })).toMatchObject({
			ok: false,
			code: "pixel_limit",
		});
		expect(await processImage(input, "image/png", { maxInputBytes: input.length - 1 })).toMatchObject({
			ok: false,
			code: "input_limit",
		});
	});

	it("fails rather than silently downsamples original mode outside the output policy", async () => {
		expect(
			await processImage(createImagePng(100, 20), "image/png", {
				autoResizeImages: false,
				resizeOptions: { maxWidth: 50 },
			}),
		).toMatchObject({ ok: false, code: "image_budget" });
	});

	it.each([
		[1, 10_000],
		[10_000, 1],
	])("keeps a nonzero minor dimension for %ix%i strips", async (width, height) => {
		const result = await processImage(createImagePng(width, height), "image/png", {
			resizeOptions: { maxWidth: 100, maxHeight: 100 },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dimensions.width).toBeGreaterThanOrEqual(1);
		expect(result.dimensions.height).toBeGreaterThanOrEqual(1);
		expect(Math.max(result.dimensions.width, result.dimensions.height)).toBe(100);
	});

	it("never trades translucent alpha for JPEG to reach the byte budget", async () => {
		const result = await processImage(alphaPng(64, 64), "image/png", { resizeOptions: { maxBytes: 800 } });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mimeType).toBe("image/png");
		expect(result.data.length).toBeLessThanOrEqual(800);
		const photon = await loadPhoton();
		expect(photon).not.toBeNull();
		const image = photon!.PhotonImage.new_from_byteslice(Buffer.from(result.data, "base64"));
		try {
			expect(image.get_raw_pixels()[3]).toBeLessThan(255);
		} finally {
			image.free();
		}
	});

	it("honors JPEG EXIF orientation without changing valid original bytes", async () => {
		const photon = await loadPhoton();
		expect(photon).not.toBeNull();
		const image = new photon!.PhotonImage(new Uint8Array(6 * 2 * 4).fill(255), 6, 2);
		let jpeg: Uint8Array;
		try {
			jpeg = image.get_bytes_jpeg(90);
		} finally {
			image.free();
		}
		const exif = Buffer.alloc(36);
		exif.set([0xff, 0xe1]);
		exif.writeUInt16BE(34, 2);
		exif.write("Exif\0\0II", 4, "binary");
		exif.writeUInt16LE(42, 12);
		exif.writeUInt32LE(8, 14);
		exif.writeUInt16LE(1, 18);
		exif.writeUInt16LE(0x0112, 20);
		exif.writeUInt16LE(3, 22);
		exif.writeUInt32LE(1, 24);
		exif.writeUInt16LE(6, 28);
		const input = Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
		expect(await processImage(input, "image/jpeg", { autoResizeImages: false })).toMatchObject({
			ok: true,
			data: input.toString("base64"),
			dimensions: { originalWidth: 2, originalHeight: 6, width: 2, height: 6 },
		});
		const resized = await processImage(input, "image/jpeg", { resizeOptions: { maxWidth: 1, maxHeight: 3 } });
		expect(resized).toMatchObject({
			ok: true,
			mimeType: "image/png",
			dimensions: { originalWidth: 2, originalHeight: 6, width: 1, height: 3 },
		});
	});

	it("keeps abort rejection and classifies a worker deadline", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			processImage(createImagePng(9, 9), "image/png", { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(await processImage(createImagePng(15, 15), "image/png", { timeoutMs: 1 })).toMatchObject({
			ok: false,
			code: "timeout",
		});
	});
});
