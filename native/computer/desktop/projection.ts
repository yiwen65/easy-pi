import { Buffer } from "node:buffer";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ComputerDiscoveredWindow, ComputerImage } from "@trycua/cua-driver";

export type DesktopGrant =
	| { kind: "windows"; refs: ReadonlySet<string> }
	| { kind: "image"; ref: string; width: number; height: number }
	| { kind: "semantic" };

export function projectWindows(windows: readonly ComputerDiscoveredWindow[], omittedWindows: number) {
	if (windows.length > 256 || !Number.isSafeInteger(omittedWindows) || omittedWindows < 0)
		throw new Error("Invalid native window catalog");
	const refs = new Set<string>();
	const lines: string[] = [];
	let bytes = 0;
	let omitted = omittedWindows;
	for (const window of windows) {
		if (!window.reference || Buffer.byteLength(window.reference) > 128 || refs.has(window.reference))
			throw new Error("Invalid native window reference");
		const line = JSON.stringify({
			ref: window.reference,
			app: window.appName,
			title: window.title,
			bounds: window.bounds,
			onScreen: window.isOnScreen,
		});
		const size = Buffer.byteLength(line) + 1;
		if (bytes + size > 8192) {
			omitted++;
			continue;
		}
		bytes += size;
		lines.push(line);
		refs.add(window.reference);
	}
	const content: TextContent[] = [
		{
			type: "text",
			text: `Untrusted window metadata; omitted=${omitted}. Not a complete catalog.\n${lines.join("\n")}`,
		},
	];
	return {
		content,
		grant: { kind: "windows", refs } satisfies DesktopGrant,
		details: { status: "discovered", omittedWindows: omitted },
	};
}

/** Validates the bounded native carrier, not PNG provenance or all decoded pixels. */
export function projectImage(image: ComputerImage) {
	const { imageId: ref, geometry, png } = image;
	const { outputWidth: width, outputHeight: height } = geometry;
	if (
		!ref ||
		Buffer.byteLength(ref) > 128 ||
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 1 ||
		height < 1 ||
		width > 2048 ||
		height > 2048 ||
		width * height > 4 * 1024 * 1024 ||
		!(png instanceof ArrayBuffer) ||
		png.byteLength < 33 ||
		png.byteLength > 8 * 1024 * 1024
	)
		throw new Error("Invalid native image");
	const bytes = Buffer.from(png);
	if (
		!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
		bytes.readUInt32BE(8) !== 13 ||
		bytes.toString("ascii", 12, 16) !== "IHDR" ||
		bytes.readUInt32BE(16) !== width ||
		bytes.readUInt32BE(20) !== height
	)
		throw new Error("Invalid native PNG header");
	const content: (TextContent | ImageContent)[] = [
		{
			type: "text",
			text: `Untrusted window image. Image ref: ${ref}; width=${width}; height=${height}. Coordinates are output-image pixels, not desktop points. Use this ref once, then capture again.`,
		},
		{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
	];
	return {
		content,
		grant: { kind: "image", ref, width, height } satisfies DesktopGrant,
		details: { status: "captured", imageRef: ref, width, height },
	};
}
