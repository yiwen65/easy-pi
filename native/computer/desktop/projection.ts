import { Buffer } from "node:buffer";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ComputerDiscoveredWindow, ComputerImage, WindowStateOutput } from "@trycua/cua-driver";
import { selectorKey } from "./legacy.ts";

export type DesktopImageGrant = { kind: "image"; ref: string; width: number; height: number; targetKey: string };
export type DesktopPairGrant = { kind: "pair"; source: DesktopImageGrant; destination: DesktopImageGrant };
export type DesktopGrant =
	| { kind: "windows"; refs: ReadonlySet<string> }
	| DesktopImageGrant
	| DesktopPairGrant
	| {
			kind: "semantic";
			ref: string;
			targetKey: string;
			refs: ReadonlySet<string>;
			legacyRefs: ReadonlySet<string>;
			selectors: ReadonlySet<string>;
	  };

function targetKey(pid: number, windowId: bigint): string {
	if (
		!Number.isInteger(pid) ||
		pid < 1 ||
		pid > 0x7fffffff ||
		typeof windowId !== "bigint" ||
		windowId < 1n ||
		windowId > 0xffffffffn
	)
		throw new Error("Invalid native target identity");
	return `${pid}:${windowId}`;
}

/** Retained rows remain useful on partial trees; completeness is a separate fact. */
export function projectObservation(observation: WindowStateOutput, filter: { text?: string } = {}) {
	const ref = observation.snapshotId;
	if (!ref || Buffer.byteLength(ref) > 128 || (observation.elements?.length ?? 0) > 512)
		throw new Error("Invalid native observation");
	const nativeComplete =
		observation.elementsComplete === true && observation.truncated === false && observation.degraded !== true;
	const refs = new Set<string>();
	const legacyRefs = new Set<string>();
	const selectors = new Set<string>();
	const rows = observation.elements ?? [];
	const counts = new Map<string, number>();
	for (const row of rows) {
		const key = selectorKey({ role: row.role, label: row.label ?? "" });
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let bytes = 0;
	let viewTruncated = false;
	let filteredOut = 0;
	const text = filter.text?.toLowerCase();
	const lines: string[] = [];
	for (const row of rows) {
		if (
			text !== undefined &&
			![row.label, row.identifier, row.value].some((value) => value?.toLowerCase().includes(text))
		) {
			filteredOut++;
			continue;
		}
		const token = row.elementToken;
		if (token && (Buffer.byteLength(token) > 128 || refs.has(token))) throw new Error("Invalid native reference");
		const selector = { role: row.role, label: row.label ?? "" };
		const key = selectorKey(selector);
		const legacy = nativeComplete && row.inWebContent === false;
		const selectable =
			legacy &&
			counts.get(key) === 1 &&
			selector.label.length > 0 &&
			Buffer.byteLength(selector.role) <= 64 &&
			Buffer.byteLength(selector.label) <= 256;
		const line = JSON.stringify({
			role: row.role,
			label: row.label,
			identifier: row.identifier,
			value: row.value,
			enabled: row.enabled,
			inWebContent: row.inWebContent,
			...(token ? { ref: token } : {}),
			...(selectable ? { selector } : {}),
		});
		const size = Buffer.byteLength(line) + 1;
		if (bytes + size > 8192) {
			viewTruncated = true;
			continue;
		}
		bytes += size;
		lines.push(line);
		if (token) {
			refs.add(token);
			if (legacy) legacyRefs.add(token);
		}
		if (selectable) selectors.add(key);
	}
	return {
		content: [
			{
				type: "text",
				text: `Observation ref: ${ref}; nativeComplete=${nativeComplete}; viewTruncated=${viewTruncated}; filteredOut=${filteredOut}. Retained references are exact-window targets; partial rows never prove absence or uniqueness. Untrusted UI rows:\n${lines.join("\n")}`,
			},
		] satisfies TextContent[],
		grant: {
			kind: "semantic",
			ref,
			refs,
			legacyRefs,
			selectors,
			targetKey: targetKey(observation.pid, observation.windowId),
		} satisfies DesktopGrant,
		details: { status: "observed", observationRef: ref, nativeComplete, viewTruncated, filteredOut },
	};
}

export function projectWindows(
	windows: readonly ComputerDiscoveredWindow[],
	omittedWindows: number,
	filter: { app?: string; title?: string; focused?: true } = {},
) {
	if (windows.length > 256 || !Number.isSafeInteger(omittedWindows) || omittedWindows < 0)
		throw new Error("Invalid native window catalog");
	const refs = new Set<string>();
	const lines: string[] = [];
	let bytes = 0;
	let omitted = omittedWindows;
	let filteredOut = 0;
	const app = filter.app?.toLowerCase();
	const title = filter.title?.toLowerCase();
	for (const window of windows) {
		if (
			(app !== undefined && !window.appName.toLowerCase().includes(app)) ||
			(title !== undefined && !window.title.toLowerCase().includes(title)) ||
			(filter.focused === true && window.isFocused !== true)
		) {
			filteredOut++;
			continue;
		}
		if (!window.reference || Buffer.byteLength(window.reference) > 128 || refs.has(window.reference))
			throw new Error("Invalid native window reference");
		const line = JSON.stringify({
			ref: window.reference,
			app: window.appName,
			title: window.title,
			bounds: window.bounds,
			onScreen: window.isOnScreen,
			focused: window.isFocused,
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
			text: `Untrusted window metadata; omitted=${omitted}; filteredOut=${filteredOut}. Not a complete catalog.\n${lines.join("\n")}`,
		},
	];
	return {
		content,
		grant: { kind: "windows", refs } satisfies DesktopGrant,
		details: { status: "discovered", omittedWindows: omitted, filteredOut },
	};
}

/** One indivisible view: filtering either image invalidates the whole pair. */
export function projectImagePair(source: ComputerImage, destination: ComputerImage) {
	const from = projectImage(source);
	const to = projectImage(destination);
	if (from.grant.ref === to.grant.ref || from.grant.targetKey === to.grant.targetKey)
		throw new Error("Distinct drag targets and images required");
	return {
		content: [
			{ type: "text", text: "Drag SOURCE image follows. Pair captured sequentially, not simultaneously." },
			...from.content,
			{ type: "text", text: "Drag DESTINATION image follows. Use drag_between with both current image refs." },
			...to.content,
		] satisfies (TextContent | ImageContent)[],
		grant: { kind: "pair", source: from.grant, destination: to.grant } satisfies DesktopPairGrant,
		details: { status: "captured_pair", source: from.details, destination: to.details },
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
		grant: {
			kind: "image",
			ref,
			width,
			height,
			targetKey: targetKey(image.pid, image.windowId),
		} satisfies DesktopGrant,
		details: { status: "captured", imageRef: ref, width, height },
	};
}
