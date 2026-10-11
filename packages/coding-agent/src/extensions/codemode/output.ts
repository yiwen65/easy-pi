import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, Text } from "@earendil-works/pi-tui";

/** Remote/script output is private to the user, not a world-readable temporary file. */
export async function writeCodemodeOutputFile(data: string | Uint8Array, extension: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-codemode-"));
	const path = join(directory, `output${extension}`);
	await writeFile(path, data, { mode: 0o600 });
	return path;
}

/** Count wrapped visual rows, not logical lines, for compact code and JSON previews. */
export class CodemodeOutputPreview implements Component {
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
