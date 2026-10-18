import { beforeEach, describe, expect, it, vi } from "vitest";
import { createImagePng } from "./helpers/image-fixtures.ts";

const codec = vi.hoisted(() => {
	const source = {
		get_width: () => 4,
		get_height: () => 4,
		get_raw_pixels: vi.fn(() => new Uint8Array(64).fill(255)),
		free: vi.fn(),
	};
	const resized = {
		get_bytes: vi.fn(() => new Uint8Array(12)),
		get_bytes_jpeg: vi.fn((_quality: number) => new Uint8Array(6)),
		free: vi.fn(),
	};
	const photon = {
		PhotonImage: { new_from_byteslice: vi.fn(() => source) },
		resize: vi.fn(() => resized),
		SamplingFilter: { Lanczos3: 1 },
	};
	return { source, resized, photon, load: vi.fn(async () => photon) };
});
vi.mock("../src/utils/photon.ts", () => ({ loadPhoton: codec.load }));

import { imageCodecOptions, prepareImageInProcess } from "../src/utils/image-resize-core.ts";

beforeEach(() => {
	vi.clearAllMocks();
	codec.source.get_raw_pixels.mockReturnValue(new Uint8Array(64).fill(255));
	codec.resized.get_bytes.mockReturnValue(new Uint8Array(12));
	codec.resized.get_bytes_jpeg.mockReturnValue(new Uint8Array(6));
});

describe("image encoding candidate selection", () => {
	it("stops after a PNG fits, without generating JPEG alternatives", async () => {
		const prepared = await prepareImageInProcess(createImagePng(), "image/png", imageCodecOptions({ maxWidth: 2 }));
		expect(prepared.mimeType).toBe("image/png");
		expect(codec.resized.get_bytes).toHaveBeenCalledOnce();
		expect(codec.resized.get_bytes_jpeg).not.toHaveBeenCalled();
		expect(codec.source.get_raw_pixels).not.toHaveBeenCalled();
		expect(codec.resized.free).toHaveBeenCalledOnce();
		expect(codec.source.free).toHaveBeenCalledOnce();
	});

	it("tries decreasing JPEG qualities only as needed and stops at the first fit", async () => {
		codec.resized.get_bytes.mockReturnValue(new Uint8Array(100));
		codec.resized.get_bytes_jpeg.mockImplementation((quality) => new Uint8Array(quality > 55 ? 100 : 12));
		const prepared = await prepareImageInProcess(
			createImagePng(),
			"image/png",
			imageCodecOptions({ maxWidth: 2, maxBytes: 20, jpegQuality: 60 }),
		);
		expect(prepared.mimeType).toBe("image/jpeg");
		expect(codec.resized.get_bytes_jpeg.mock.calls.map(([quality]) => quality)).toEqual([60, 55]);
	});

	it("cannot satisfy a byte budget by discarding source alpha", async () => {
		const rgba = new Uint8Array(64).fill(255);
		rgba[3] = 128;
		codec.source.get_raw_pixels.mockReturnValue(rgba);
		codec.resized.get_bytes.mockReturnValue(new Uint8Array(100));
		await expect(
			prepareImageInProcess(createImagePng(), "image/png", imageCodecOptions({ maxBytes: 20 })),
		).rejects.toMatchObject({ code: "image_budget" });
		expect(codec.resized.get_bytes_jpeg).not.toHaveBeenCalled();
		expect(codec.source.get_raw_pixels).toHaveBeenCalledOnce();
	});
});
