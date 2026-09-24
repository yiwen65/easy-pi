import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, release } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarios as generalScenarios } from "../general/scenarios.mjs";
import { summarize } from "./metrics.mjs";

const [fixture, bridge, output, count = "20", suite = "save-panel"] = process.argv.slice(2);
assert.ok(["save-panel", "general"].includes(suite));
assert.equal(process.env.ALLOW_GUI_TESTS, "true");
assert.ok([fixture, bridge, output].every((value) => value && isAbsolute(value)));
const pairs = Number(count);
assert.ok(Number.isInteger(pairs) && pairs > 0 && pairs <= 100);
mkdirSync(output); // Never overwrite another run.
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const probe = fileURLToPath(new URL(suite === "general" ? "../general/probe.mjs" : "./probe.mjs", import.meta.url));
writeFileSync(
	join(output, "contract.json"),
	JSON.stringify(
		{
			version: 1,
			suite,
			scenarios: suite === "general" ? generalScenarios : ["save", "working-synthetic", "broken-synthetic"],
			pairs,
			node: process.versions.node,
			os: release(),
			arch: arch(),
			fixtureSha256: sha(fixture),
			probeSha256: sha(probe),
			bridgeSha256: sha(bridge),
			nativeSha256: sha(
				join(dirname(bridge), "sdk/node_modules/@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib"),
			),
			timing:
				"cold bridge require plus feature creation through final independent verification; preopened fixture setup and awaited close separately reported",
			model: "none; deterministic tool/UI E2E",
			order:
				suite === "general"
					? "one combined attempt per scenario per round, fresh process"
					: "alternating AB/BA by pair",
			failurePolicy:
				"retain every attempt; stop batch on missing native close proof or non-clean lease; never retry an attempt",
		},
		null,
		2,
	),
);
const samples = [];
let stop = false;
for (let pair = 0; pair < pairs && !stop; pair++) {
	for (const scenario of suite === "general" ? generalScenarios : ["save", "working-synthetic", "broken-synthetic"]) {
		for (const strategy of suite === "general"
			? ["combined"]
			: pair % 2
				? ["combined", "split"]
				: ["split", "combined"]) {
			const name = `${pair}-${scenario}-${strategy}`;
			const result = await new Promise((resolve, reject) => {
				const child = spawn(process.execPath, [probe, fixture, bridge, scenario, strategy], {
					env: { ...process.env, ALLOW_GUI_TESTS: "true", COMPUTER_BENCHMARK: "true" },
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				const watchdog = setTimeout(() => {
					writeFileSync(
						join(output, `${name}.pending-drain.json`),
						JSON.stringify({ pid: child.pid, status: "deadline_exceeded", closed: false }),
					);
					console.error(
						name,
						"deadline exceeded; abort requested, awaiting native drain; no next task or forced kill",
					);
					child.kill("SIGTERM");
				}, 90_000);
				child.stdout.on("data", (chunk) => {
					stdout += chunk;
				});
				child.stderr.on("data", (chunk) => {
					stderr += chunk;
				});
				child.on("error", (error) => {
					clearTimeout(watchdog);
					reject(error);
				});
				child.on("close", (exitCode, signal) => {
					clearTimeout(watchdog);
					resolve({ stdout, stderr, exitCode, signal });
				});
			});
			writeFileSync(join(output, `${name}.log`), result.stdout + result.stderr);
			const line = result.stdout.split("\n").find((value) => value.startsWith("E2E_SAMPLE "));
			const sample = {
				...(line ? JSON.parse(line.slice(11)) : { passed: false, closed: false, calls: [] }),
				scenario,
				strategy,
				pair,
				exitCode: result.exitCode,
				signal: result.signal,
			};
			samples.push(sample);
			appendFileSync(join(output, "samples.jsonl"), `${JSON.stringify(sample)}\n`);
			writeFileSync(join(output, "summary.json"), JSON.stringify(summarize(samples), null, 2));
			console.log(name, sample.passed ? "PASS" : "FAIL", sample.taskMs ?? "no result");
			if (
				!sample.closed ||
				sample.fixtureExit?.code !== 0 ||
				!/^pi-computer-desktop-v1 C /.test(sample.lease ?? "")
			) {
				stop = true;
				break;
			}
		}
		if (stop) break;
	}
}
const summary = summarize(samples);
console.log(JSON.stringify(summary, null, 2));
if (stop || !summary.allPassed) process.exitCode = 1;
