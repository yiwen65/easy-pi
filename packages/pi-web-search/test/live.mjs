import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [url, expectedText] = process.argv.slice(2);
if (!url) throw new Error("Explicit live check: node test/live.mjs <public-url> [expected-visible-text]");
const root = mkdtempSync("/tmp/pi-web-fetch-live-");
try {
	const home = join(root, "home");
	const agent = join(home, ".epi", "agent");
	const cwd = join(root, "work");
	const temp = join(root, "tmp");
	for (const path of [agent, cwd, temp]) mkdirSync(path, { recursive: true });
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("./live-child.mjs", import.meta.url)), url, ...(expectedText ? [expectedText] : [])], {
		cwd, stdio: "inherit", timeout: 110_000,
		env: {
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: temp,
			EASY_PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
			PI_WEB_FETCH_LIVE: "1", JITI_FS_CACHE: "0", NO_COLOR: "1",
			PI_EXTENSION_LOADER: resolve(process.env.PI_EXTENSION_LOADER || fileURLToPath(new URL("../../coding-agent/dist/core/extensions/loader.js", import.meta.url))),
			PI_WEB_SEARCH_EXTENSION: resolve(process.env.PI_WEB_SEARCH_EXTENSION || fileURLToPath(new URL("../src/index.ts", import.meta.url))),
			...(process.env.PI_WEB_FETCH_BROWSER ? { PI_WEB_FETCH_BROWSER: process.env.PI_WEB_FETCH_BROWSER } : {}),
		},
	});
	if (result.error || result.signal) console.error("Live-check child did not finish normally.");
	process.exitCode = result.status ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
