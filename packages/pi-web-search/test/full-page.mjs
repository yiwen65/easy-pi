import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Explicit opt-in: real Chrome + loopback fixtures, no public network or keys.
const root = mkdtempSync("/tmp/pi-full-page-test-");
try {
	for (const name of ["home", "tmp", "work"]) mkdirSync(join(root, name));
	const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=110000", "--test-reporter=spec",
		...process.argv.slice(2), fileURLToPath(new URL("./full-page-child.mjs", import.meta.url))], {
		cwd: join(root, "work"), stdio: "inherit", timeout: 300_000,
		env: {
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
			PI_FULL_PAGE_BROWSER_TEST: "1", NO_COLOR: "1",
			PI_WEB_FETCH_BROWSER_MODULE: resolve(process.env.PI_WEB_FETCH_BROWSER_MODULE || fileURLToPath(new URL("../src/browser.ts", import.meta.url))),
			...(process.env.PI_WEB_FETCH_BROWSER ? { PI_WEB_FETCH_BROWSER: process.env.PI_WEB_FETCH_BROWSER } : {}),
		},
	});
	if (result.error || result.signal) console.error("Full-page browser tests did not finish normally.");
	process.exitCode = result.status ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
