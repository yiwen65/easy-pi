import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, Text } from "@earendil-works/pi-tui";

/** Byte-bounded, Unicode-safe middle truncation including the marker. */
export function truncateMiddle(
	text: string,
	maxBytes: number,
): {
	content: string;
	truncated: boolean;
	totalBytes: number;
	totalLines: number;
} {
	const totalBytes = Buffer.byteLength(text);
	const totalLines = text.split("\n").length;
	if (totalBytes <= maxBytes) return { content: text, truncated: false, totalBytes, totalLines };
	const points = Array.from(text);
	const markerBudget = Buffer.byteLength(`…${points.length} chars truncated…`);
	const budget = Math.max(0, maxBytes - markerBudget);
	let head = 0;
	let tail = points.length;
	let bytes = 0;
	while (head < tail && bytes + Buffer.byteLength(points[head]) <= Math.floor(budget / 2)) {
		bytes += Buffer.byteLength(points[head++]);
	}
	bytes = 0;
	while (tail > head && bytes + Buffer.byteLength(points[tail - 1]) <= Math.ceil(budget / 2)) {
		bytes += Buffer.byteLength(points[--tail]);
	}
	const marker = `…${tail - head} chars truncated…`;
	return {
		content: `${points.slice(0, head).join("")}${marker}${points.slice(tail).join("")}`,
		truncated: true,
		totalBytes,
		totalLines,
	};
}

/** Private per-result directory avoids collisions and world-readable remote output. */
export async function writeMcpOutputFile(data: string | Uint8Array, extension: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-mcp-"));
	const path = join(dir, `output${extension}`);
	await writeFile(path, data, { mode: 0o600 });
	return path;
}

/** Preview counts wrapped visual rows, not logical lines (often a single JSON line). */
export class McpOutputPreview implements Component {
	private readonly text: Text;
	private readonly maxLines: number;
	private readonly hint: (hidden: number) => string;

	constructor(text: string, maxLines: number, hint: (hidden: number) => string) {
		this.text = new Text(text, 0, 0);
		this.maxLines = maxLines;
		this.hint = hint;
	}

	render(width: number): string[] {
		const rows = this.text.render(width);
		if (rows.length <= this.maxLines) return rows;
		return [...rows.slice(0, this.maxLines), ...new Text(this.hint(rows.length - this.maxLines), 0, 0).render(width)];
	}

	invalidate(): void {
		this.text.invalidate();
	}
}
