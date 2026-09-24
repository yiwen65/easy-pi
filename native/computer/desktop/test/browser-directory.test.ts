import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBrowserDirectory } from "../browser-directory.ts";

test("browser parent satisfies native canonical-path and private-mode requirements through a symlink", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "epi-browser-directory-test-")));
	const alias = join(root, "alias");
	symlinkSync(root, alias, "dir");
	let directory: string | undefined;
	try {
		directory = createBrowserDirectory(alias);
		assert.equal(directory, realpathSync(directory));
		assert.equal(statSync(directory).mode & 0o777, 0o700);
		assert.ok(directory.startsWith(`${root}/epi-computer-browser-`));
		assert.ok(!directory.includes("/alias/"));
	} finally {
		if (directory) rmdirSync(directory);
		unlinkSync(alias);
		rmdirSync(root);
	}
});
