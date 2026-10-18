import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { processImage } from "../src/utils/image-process.ts";
import { imagePngChunk } from "./helpers/image-fixtures.ts";

/** Anonymous 7px text/1px rules: a byte-preservation oracle, not an OCR-quality score. */
function textScreenshot(width: number): Buffer {
	const height = 80;
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	const raw = Buffer.alloc((width + 1) * height, 255);
	for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
	const glyphs = [
		["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
		["111", "010", "010", "010", "010", "010", "111"],
		["010", "110", "010", "010", "010", "010", "111"],
		["111", "001", "001", "111", "100", "100", "111"],
	];
	let x = 8;
	for (const glyph of glyphs) {
		for (let y = 0; y < glyph.length; y++) {
			for (let column = 0; column < glyph[y].length; column++) {
				if (glyph[y][column] === "1") raw[(y + 8) * (width + 1) + x + column + 1] = 0;
			}
		}
		x += glyph[0].length + 3;
	}
	for (let column = 8; column < width - 8; column++) raw[24 * (width + 1) + column + 1] = 0;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		imagePngChunk("IHDR", header),
		imagePngChunk("IDAT", deflateSync(raw)),
		imagePngChunk("IEND", Buffer.alloc(0)),
	]);
}

describe("screenshot small-text byte fidelity", () => {
	it("preserves fitting small text and one-pixel rules without lossy re-encoding", async () => {
		const input = textScreenshot(400);
		const result = await processImage(input, "image/png");
		expect(result).toMatchObject({ ok: true, mimeType: "image/png", data: input.toString("base64") });
	});

	it("original mode retains wide text bytes while balanced mode reports the changed geometry", async () => {
		const input = textScreenshot(2400);
		const original = await processImage(input, "image/png", { autoResizeImages: false });
		expect(original).toMatchObject({
			ok: true,
			data: input.toString("base64"),
			dimensions: { width: 2400, height: 80 },
		});
		const balanced = await processImage(input, "image/png");
		expect(balanced).toMatchObject({ ok: true, dimensions: { originalWidth: 2400, width: 2000 } });
		if (!balanced.ok) throw new Error("Expected prepared screenshot");
		expect(balanced.hints.join("\n")).toContain("original 2400x80");
	});
});
