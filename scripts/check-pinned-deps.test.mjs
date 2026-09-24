import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

for (const [script, filename, invalid, valid, diagnostic] of [
	[
		"check-pinned-deps.mjs",
		"package.json",
		JSON.stringify({ dependencies: { external: "^1.2.3" } }),
		JSON.stringify({ dependencies: { external: "1.2.3" } }),
		"must be pinned",
	],
	[
		"check-ts-relative-imports.mjs",
		"source.ts",
		'import value from "./value.js";',
		'import value from "./value.ts";',
		"Relative .js imports are not allowed",
	],
]) {
	test(`${script} ignores generated roots but still checks authored computer directories`, () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-source-check-"));
		const put = (relative, content) => {
			const path = join(cwd, relative);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		};
		const run = () =>
			spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
				cwd,
				encoding: "utf8",
			});
		try {
			put(join("packages", "authored", filename), valid);
			for (const root of [
				".artifacts/copied-workspace",
				"packages/coding-agent/computer/sdk",
				"packages/coding-agent/computer/materials/sources/vendor",
			]) {
				put(join(root, filename), invalid);
			}
			const generatedOnly = run();
			assert.equal(generatedOnly.status, 0, generatedOnly.stderr);

			const authored = join("packages", "authored", "computer", filename);
			put(authored, invalid);
			const rejected = run();
			assert.equal(rejected.status, 1, rejected.stderr);
			assert.ok(rejected.stderr.includes(diagnostic), rejected.stderr);
			assert.ok(rejected.stderr.includes(authored), rejected.stderr);
			assert.ok(!rejected.stderr.includes(".artifacts"), rejected.stderr);
			assert.ok(!rejected.stderr.includes(join("packages", "coding-agent", "computer")), rejected.stderr);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}
