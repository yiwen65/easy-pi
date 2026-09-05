import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeEnvironment } from "../unified-tools-real-eval.ts";
import { stableHash } from "../v2-bounded-real-eval.ts";
import type { Variant } from "./metrics.ts";

export const DEV_IDS = ["D-11", "D-12"] as const;
export const VALIDATION_IDS = ["Q-11", "Q-12", "Q-21", "Q-22", "Q-31", "Q-32"] as const;
export const PROBE_IDS = [
	"base",
	"system-A",
	"system-B",
	"tools-A",
	"tools-B",
	"full-A",
	"full-B",
	"full-C",
	"system-C",
	"tools-C",
	"system-C-tools-B",
	"system-B-tools-C",
] as const;
export const VALIDATION_ORDER = VALIDATION_IDS.flatMap((caseId, index) =>
	(
		[
			["A", "B", "C"],
			["C", "A", "B"],
			["B", "C", "A"],
		] as const
	)[index % 3].map((variant) => ({ caseId, variant })),
);

export interface Fixture {
	id: string;
	family: "small" | "large" | "concurrent";
	knownPath: boolean;
	target: string;
	marker: string;
	initial: Record<string, string>;
	desired: string;
	external: string;
	prompt: string;
	commands: string[];
	json: boolean;
}

export function fixture(id: string): Fixture {
	const spec: Record<string, [Fixture["family"], number]> = {
		"D-11": ["large", 517],
		"D-12": ["concurrent", 823],
		"Q-11": ["small", 1307],
		"Q-12": ["small", 1409],
		"Q-21": ["large", 1511],
		"Q-22": ["large", 1607],
		"Q-31": ["concurrent", 1709],
		"Q-32": ["concurrent", 1811],
	};
	if (!spec[id]) throw new Error("unknown_fixture");
	const [family, seed] = spec[id];
	const oldValue = 4 + (seed % 19);
	const newValue = oldValue + 7;
	let target: string;
	let original: string;
	let desired: string;
	let marker: string;
	let external = "";
	let prompt: string;
	let predicate: string;
	const initial: Record<string, string> = {};
	const commands = ["find . -type f", "node check.cjs"];
	if (family === "small") {
		target = "settings/buffer.json";
		original = `${JSON.stringify({ bufferWindow: oldValue, flushEvery: (seed % 11) + 2, label: "steady" }, null, 2)}\n`;
		desired = original.replace(`"bufferWindow": ${oldValue}`, `"bufferWindow": ${newValue}`);
		marker = "bufferWindow";
		prompt = `In settings/buffer.json change only bufferWindow to ${newValue}. Preserve the other values and examples. Verify using node check.cjs.`;
		predicate = `JSON.parse(text).bufferWindow === ${newValue}`;
		initial["examples/buffer.json"] = original;
	} else if (family === "large") {
		target = "src/dispatcher/leases.mjs";
		const lines = Array.from(
			{ length: 180 + (seed % 3) * 320 },
			(_, i) => `// Dispatch schedule reference ${seed}-${i + 1}; preserve this note.`,
		).join("\n");
		marker = "leaseWindowTicks";
		original = `${lines}\nexport const leaseWindowTicks = ${oldValue};\nexport const idleDrainTicks = 3;\n`;
		desired = original.replace(`leaseWindowTicks = ${oldValue}`, `leaseWindowTicks = ${newValue}`);
		prompt = `Locate the live dispatcher leaseWindowTicks declaration and set its numeric literal to ${newValue}. Preserve every other line, including idleDrainTicks, preview settings, examples and notes. Verify using node check.cjs.`;
		predicate = `text.includes("export const leaseWindowTicks = ${newValue};")`;
		commands.push("grep -R -n leaseWindowTicks src");
		initial["src/preview/leases.mjs"] = `export const leaseWindowTicks = ${oldValue};\n`;
		for (let i = 0; i < 12; i += 1)
			initial[`examples/schedule-${i}.mjs`] = `export const leaseWindowTicks = ${oldValue};\n`;
	} else {
		target = "src/queue-policy.mjs";
		marker = "batchQuota";
		original = `// Queue policy ${seed}; another actor may advance its epoch.\nexport const configEpoch = 1;\n\n// Change the quota only while the epoch remains 1.\nexport const batchQuota = ${oldValue};\nexport const backoffTicks = 3;\n`;
		desired = original.replace(`batchQuota = ${oldValue}`, `batchQuota = ${newValue}`);
		external = original.replace("configEpoch = 1", "configEpoch = 2");
		prompt = `Inspect src/queue-policy.mjs. Only if configEpoch is still 1, set batchQuota to ${newValue}. Another actor may advance configEpoch while you work: if it is no longer 1, leave batchQuota unchanged and report that the condition no longer holds. Never change configEpoch or other lines. Verify the resulting policy with node check.cjs.`;
		predicate = `(text.includes("configEpoch = 1;") && text.includes("batchQuota = ${newValue};")) || (text.includes("configEpoch = 2;") && text.includes("batchQuota = ${oldValue};"))`;
		initial["examples/queue-policy.mjs"] = original;
	}
	initial[target] = original;
	initial["check.cjs"] =
		`const fs = require("node:fs");\ntry {\n  const text = fs.readFileSync(${JSON.stringify(target)}, "utf8");\n  if (!(${predicate})) { console.log("FAIL: requested values or current epoch condition are not satisfied"); process.exit(1); }\n  console.log("PASS");\n} catch { console.log("FAIL: missing or invalid fixture"); process.exit(1); }\n`;
	return {
		id,
		family,
		knownPath: family !== "large",
		target,
		marker,
		initial,
		desired,
		external,
		prompt,
		commands,
		json: family === "small",
	};
}

export function materialize(cwd: string, data: Fixture): void {
	for (const [path, value] of Object.entries(data.initial)) {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), value, { mode: 0o644 });
	}
}
export function applyExternalChange(cwd: string, data: Fixture): void {
	if (!data.external) throw new Error("no_external_change");
	writeFileSync(join(cwd, data.target), data.external);
}
function paths(cwd: string, prefix = ""): string[] {
	return readdirSync(join(cwd, prefix), { withFileTypes: true })
		.flatMap((entry) => {
			const path = join(prefix, entry.name);
			return entry.isDirectory() ? paths(cwd, path) : [path];
		})
		.sort();
}
export function collateralUnchanged(cwd: string, data: Fixture): boolean {
	try {
		return (
			stableHash(paths(cwd)) === stableHash(Object.keys(data.initial).sort()) &&
			Object.entries(data.initial).every(([path, value]) => {
				const stat = lstatSync(join(cwd, path));
				return (
					stat.isFile() &&
					(stat.mode & 0o777) === 0o644 &&
					(path === data.target || readFileSync(join(cwd, path), "utf8") === value)
				);
			})
		);
	} catch {
		return false;
	}
}
export function targetCorrect(cwd: string, data: Fixture, faultApplied: boolean): boolean {
	try {
		const actual = readFileSync(join(cwd, data.target), "utf8");
		if (data.family === "concurrent") return faultApplied && actual === data.external;
		return data.json
			? stableHash(JSON.parse(actual)) === stableHash(JSON.parse(data.desired))
			: actual === data.desired;
	} catch {
		return false;
	}
}
export function verify(cwd: string, data: Fixture): boolean {
	try {
		if (readFileSync(join(cwd, "check.cjs"), "utf8") !== data.initial["check.cjs"]) return false;
		execFileSync(process.execPath, ["check.cjs"], {
			cwd,
			env: safeEnvironment(cwd),
			stdio: "ignore",
			timeout: 10_000,
		});
		return true;
	} catch {
		return false;
	}
}
export function attemptId(
	stage: "development" | "validation",
	id: string,
	variant: Variant,
	iteration: number,
): string {
	return `${stage}-${id}-${variant}-${iteration}`;
}
export function validAttempt(stage: string, id: string, variant: string, iteration: number): boolean {
	if (!["A", "B", "C"].includes(variant)) return false;
	if (stage === "validation") return (VALIDATION_IDS as readonly string[]).includes(id) && iteration === 0;
	return (
		stage === "development" &&
		(DEV_IDS as readonly string[]).includes(id) &&
		(variant === "C" ? [1, 2].includes(iteration) : iteration === 0)
	);
}
