import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("check-ts-relative-imports.mjs", import.meta.url));

function check(files) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ts-imports-"));
	try {
		for (const [name, content] of Object.entries(files)) {
			const path = join(cwd, name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		return spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("rejects static imports, exports, dynamic templates, and import types with query/hash suffixes", () => {
	const result = check({ "bad.ts": [
		'import x from "./static.js";',
		'export { x } from "../export.js?raw";',
		'const x = import(`./dynamic.js#fragment`);',
		'type X = import("../type.js?raw#fragment").X;',
	].join("\n") });
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /bad\.ts:1:15: \.\/static\.js/);
	assert.match(result.stderr, /bad\.ts:2:19: \.\.\/export\.js\?raw/);
	assert.match(result.stderr, /bad\.ts:3:18: \.\/dynamic\.js#fragment/);
	assert.match(result.stderr, /bad\.ts:4:17: \.\.\/type\.js\?raw#fragment/);
});

test("positions count UTF-16 code units rather than UTF-8 bytes or codepoints", () => {
	const prefix = 'const emoji = "😀é"; ';
	const result = check({ "unicode.ts": `${prefix}import("./bad.js");` });
	assert.equal(result.status, 1, result.stderr);
	assert.ok(result.stderr.includes(`unicode.ts:1:${prefix.length + 8}: ./bad.js`), result.stderr);
});

test("ignores ordinary strings, comments, computed imports, external packages, and .ts/.mjs specifiers", () => {
	const result = check({ "ok.ts": [
		'// import "./comment.js";',
		'const literal = "./not-an-import.js";',
		'import x from "external.js";',
		'import "./source.ts"; export * from "../source.mjs";',
		'const x = import(`./${literal}.js`);',
		'const y = require("./legacy.js");',
	].join("\n") });
	assert.equal(result.status, 0, result.stderr);
});

test("preserves declaration, dist, dependency, evidence, and packaged-computer exclusions", () => {
	const result = check(Object.fromEntries([
		"types.d.ts", "dist/bad.ts", "node_modules/dep/bad.ts", ".artifacts/bad.ts",
		"packages/coding-agent/computer/bad.ts", "coverage/bad.ts", ".git/bad.ts",
	].map((name) => [name, 'import "./bad.js";'])));
	assert.equal(result.status, 0, result.stderr);
});
