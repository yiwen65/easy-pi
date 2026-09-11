import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./pack-easy-pi.mjs", import.meta.url));

for (const useLink of [false, true]) {
	test(`refuses existing output ${useLink ? "symlink" : "directory"} without deleting contents`, () => {
		const directory = mkdtempSync(join(tmpdir(), "epi-pack-safety-"));
		try {
			const sentinel = join(directory, "keep.txt");
			writeFileSync(sentinel, "caller-owned");
			const output = useLink ? join(directory, "link") : directory;
			if (useLink) symlinkSync(directory, output, "dir");
			const result = spawnSync(process.execPath, [script, output], { encoding: "utf8" });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /EEXIST/);
			assert.equal(readFileSync(sentinel, "utf8"), "caller-owned");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
