import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const resolver = new URL("source-resolver.mjs", import.meta.url).href;
const entries = {
	"@easy-pi/permissions": "permissions/src/index.ts",
	"@easy-pi/permissions/journal": "permissions/src/external-mutation-journal.ts",
	"@easy-pi/subagent": "subagent/src/index.ts",
	...Object.fromEntries(["collaboration-contract", "collaboration-controller", "collaboration-mailbox", "collaboration-store", "context-fork", "session-host"].map((name) => [`@easy-pi/subagent/${name}`, `subagent/src/${name}.ts`])),
	"@easy-pi/web-search": "pi-web-search/src/index.ts",
	"@easy-pi/grok-tui": "grok-tui/src/index.ts",
	"@earendil-works/pi-grok-tui": "grok-tui-compat/src/index.ts",
	"@earendil-works/pi-ai": "ai/src/index.ts",
	"@earendil-works/pi-ai/compat": "ai/src/compat.ts",
	"@earendil-works/pi-ai/oauth": "ai/src/oauth.ts",
	"@earendil-works/pi-ai/bedrock-provider": "ai/src/bedrock-provider.ts",
	"@earendil-works/pi-ai/bun-oauth": "ai/src/bun-oauth.ts",
	"@earendil-works/pi-ai/providers/faux": "ai/src/providers/faux.ts",
	"@earendil-works/pi-ai/api/simple-options": "ai/src/api/simple-options.ts",
	"@earendil-works/pi-codemode": "codemode/src/index.ts",
	"@earendil-works/pi-codemode/declarations": "codemode/src/declarations.ts",
	"@earendil-works/pi-codemode/source": "codemode/src/source.ts",
	"@earendil-works/pi-codemode/portable": "codemode/src/portable.ts",
	"@earendil-works/pi-codemode/cloudflare": "codemode/src/cloudflare.ts",
	"@earendil-works/pi-codemode/worker": "codemode/src/runtime/worker.ts",
	"@earendil-works/pi-mcp": "mcp/src/index.ts",
	"@earendil-works/pi-mcp/oauth": "mcp/src/oauth/index.ts",
	"@earendil-works/pi-mcp/testing": "mcp/src/testing/index.ts",
	"@earendil-works/pi-agent-core": "agent/src/index.ts",
	"@earendil-works/pi-agent-core/node": "agent/src/node.ts",
	"@earendil-works/pi-agent-core/session/testing": "agent/src/harness/session/testing/index.ts",
	"@earendil-works/pi-telemetry": "telemetry/src/index.ts",
	"@earendil-works/pi-telemetry/testing": "telemetry/src/testing/index.ts",
	"@earendil-works/pi-coding-agent": "coding-agent/src/index.ts",
	"@earendil-works/pi-coding-agent/client": "coding-agent/src/client/index.ts",
	"@earendil-works/pi-coding-agent/rpc-entry": "coding-agent/src/rpc-entry.ts",
	"@earendil-works/pi-client": "client/src/index.ts",
	"@earendil-works/pi-client/unix": "client/src/unix.ts",
	"@earendil-works/pi-server": "server/src/index.ts",
	"@earendil-works/pi-server/testing": "server/src/testing/index.ts",
	"@earendil-works/pi-server/unix": "server/src/transports/unix/index.ts",
	"@earendil-works/pi-protocol": "protocol/src/index.ts",
	"@earendil-works/pi-tui": "tui/src/index.ts",
	"@earendil-works/pi-session-backend-sqlite-node": "session-backends/sqlite-node/src/index.ts",
};

function run(code, options = {}) {
	const result = spawnSync(process.execPath, ["--import", resolver, "--input-type=module", "--eval", code], { cwd: root, encoding: "utf8", ...options });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

test("maps all actual workspace exports to canonical source URLs, including nested and wildcard exports", () => {
	const actual = JSON.parse(run(`console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(entries))}.map(s => [s, import.meta.resolve(s)]))));`));
	for (const [name, path] of Object.entries(entries)) {
		assert.equal(actual[name], pathToFileURL(realpathSync(join(root, "packages", path))).href, name);
		assert.ok(!actual[name].includes("/dist/"), name);
	}
});

test("package entry and direct source imports share the same module singleton", () => {
	const direct = pathToFileURL(realpathSync(join(root, "packages/ai/src/index.ts"))).href;
	assert.equal(run(`import * as a from "@earendil-works/pi-ai"; import * as b from ${JSON.stringify(direct)}; console.log(a === b);`), "true");
});

test("does not manufacture old, private, missing, or traversal aliases", () => {
	const names = ["@earendil-works/pi-agent-old", "@earendil-works/pi-coding-agent/hooks", "@easy-pi/subagent/tool", "@earendil-works/pi-ai/nonexistent", "@earendil-works/pi-ai/providers/../index"];
	const actual = JSON.parse(run(`console.log(JSON.stringify(${JSON.stringify(names)}.map(s => { try { return import.meta.resolve(s); } catch (e) { return e.code; } })));`));
	assert.deepEqual(actual, names.map(() => "ERR_PACKAGE_PATH_NOT_EXPORTED").map((code, i) => i === 0 ? "ERR_MODULE_NOT_FOUND" : i === 4 ? "ERR_INVALID_MODULE_SPECIFIER" : code));
});

test("unmapped legacy-main subpaths are delegated to Node, not turned into source aliases", () => {
	const code = 'console.log(import.meta.resolve("@earendil-works/pi-tui/dist/index.js"));';
	const native = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { cwd: root, encoding: "utf8" });
	assert.equal(native.status, 0, native.stderr);
	assert.equal(run(code), native.stdout.trim());
	assert.ok(run(code).includes("/dist/index.js"));
});

test("outside callers keep external packages and relative .js imports; workspace imports still use source", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-source-external-"));
	try {
		for (const name of ["typebox", "unrelated"]) {
			const pkg = join(directory, "node_modules", name);
			mkdirSync(pkg, { recursive: true });
			writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
			writeFileSync(join(pkg, "index.js"), `export const marker = ${JSON.stringify(name)};`);
		}
		writeFileSync(join(directory, "legacy.js"), 'export const marker = "js";');
		writeFileSync(join(directory, "legacy.ts"), 'export const marker = "wrong-ts";');
		const entry = join(directory, "entry.mjs");
		writeFileSync(entry, 'import {marker as a} from "typebox"; import {marker as b} from "unrelated"; import {marker as c} from "./legacy.js"; console.log(JSON.stringify([a,b,c,import.meta.resolve("@earendil-works/pi-server/unix")]));');
		const result = spawnSync(process.execPath, ["--import", resolver, entry], { cwd: directory, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), ["typebox", "unrelated", "js", pathToFileURL(realpathSync(join(root, "packages/server/src/transports/unix/index.ts"))).href]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("file-URL preload works through paths containing spaces, #, ?, and %", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi source #?%-"));
	try {
		const link = join(directory, "workspace #?%");
		symlinkSync(root, link, "dir");
		const preload = pathToFileURL(join(link, "scripts/source-resolver.mjs")).href;
		const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "--eval", 'console.log(import.meta.resolve("@earendil-works/pi-ai"));'], { cwd: directory, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), pathToFileURL(realpathSync(join(root, "packages/ai/src/index.ts"))).href);
		if (process.platform !== "win32") {
			const launcher = spawnSync("bash", [join(link, "pi-test.sh"), "--version"], { cwd: directory, encoding: "utf8" });
			assert.equal(launcher.status, 0, launcher.stderr);
			assert.equal(launcher.stdout.trim(), JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8")).version);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
