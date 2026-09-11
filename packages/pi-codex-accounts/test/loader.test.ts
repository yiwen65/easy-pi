import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

test("installed Pi's real Jiti loader loads a persisted account", async () => {
	// Integration test intentionally exercises the host's loader, not just tsx imports.
	const { loadExtensions } = await import(pathToFileURL(join(getPackageDir(), "dist/core/extensions/loader.js")).href);
	const dir = mkdtempSync(join(tmpdir(), "pi-codex-loader-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		mkdirSync(join(dir, "codex-accounts", "work"), { recursive: true });
		const result = await loadExtensions([fileURLToPath(new URL("../index.ts", import.meta.url))], dir);
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		assert.ok(result.extensions[0].commands.has("codex-account"));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
