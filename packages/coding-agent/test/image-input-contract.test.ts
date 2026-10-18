import { describe, expect, it } from "vitest";
import { processImage } from "../src/utils/image-process.ts";
import { createImagePng, imagePngChunk } from "./helpers/image-fixtures.ts";

describe("image admission safety with auto-resize disabled", () => {
	it("rejects non-image bytes instead of admitting a payload that poisons later requests", async () => {
		const result = await processImage(Buffer.from("not-an-image"), "image/png", { autoResizeImages: false });
		expect(result.ok).toBe(false);
	});

	it("rejects a declared MIME that disagrees with the actual image", async () => {
		const result = await processImage(createImagePng(), "image/jpeg", { autoResizeImages: false });
		expect(result.ok).toBe(false);
	});

	it("rejects an oversized pixel header before decoding its raster", async () => {
		const png = createImagePng();
		const header = Buffer.from(png.subarray(16, 29));
		header.writeUInt32BE(100_000);
		header.writeUInt32BE(100_000, 4);
		const oversized = Buffer.concat([png.subarray(0, 8), imagePngChunk("IHDR", header), png.subarray(33)]);
		const result = await processImage(oversized, "image/png", { autoResizeImages: false });
		expect(result.ok).toBe(false);
	});
});
