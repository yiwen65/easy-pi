import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Read only these two non-credential overrides. Never copy process.env, NODE_OPTIONS,
// the caller's HOME/agent directory, or any provider/auth configuration to the child.
const loader = resolve(process.env.PI_EXTENSION_LOADER ||
	fileURLToPath(new URL("../../coding-agent/dist/core/extensions/loader.js", import.meta.url)));
const entry = resolve(process.env.PI_WEB_SEARCH_EXTENSION ||
	fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const root = mkdtempSync("/tmp/pi-web-search-offline-");

try {
	const home = join(root, "home");
	const agent = join(home, ".epi", "agent");
	const cwd = join(root, "work");
	const temp = join(root, "tmp");
	for (const dir of [agent, cwd, temp]) mkdirSync(dir, { recursive: true });
	const child = spawnSync(process.execPath, [
		"--test", "--test-concurrency=1", "--test-timeout=15000", "--test-reporter=spec",
		...process.argv.slice(2),
		...readdirSync(dirname(fileURLToPath(import.meta.url))).filter(name => name.endsWith(".test.mjs"))
			.map(name => fileURLToPath(new URL(name, import.meta.url))),
	], {
		cwd,
		stdio: "inherit",
		timeout: 30_000,
		env: {
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
			HOME: home,
			USERPROFILE: home,
			EASY_PI_CODING_AGENT_DIR: agent,
			PI_CODING_AGENT_DIR: agent,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_CACHE_HOME: join(home, ".cache"),
			XDG_DATA_HOME: join(home, ".local", "share"),
			TMPDIR: temp,
			JITI_FS_CACHE: "0",
			NO_COLOR: "1",
			PI_WEB_SEARCH_OFFLINE: "1",
			PI_EXTENSION_LOADER: loader,
			PI_WEB_SEARCH_EXTENSION: entry,
			// No key at startup; the tests create only literal synthetic keys.
		},
	});
	if (child.error) console.error(`Offline test process failed: ${child.error.message}`);
	if (child.signal) console.error(`Offline test process terminated: ${child.signal}`);
	process.exitCode = child.status ?? 1;
} finally {
	rmSync(root, { recursive: true, force: true });
}
