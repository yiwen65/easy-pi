import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Native requires a canonical private parent, including on macOS /var -> /private/var. */
export function createBrowserDirectory(parent = tmpdir()): string {
	return realpathSync(mkdtempSync(join(parent, "epi-computer-browser-")));
}
