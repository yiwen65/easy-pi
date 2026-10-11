import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateGeneratedModelData } from "../scripts/model-data.ts";
import type { AnyModel, ImageModel, Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
const generatedAt = "2026-01-02T03:04:05.678Z";
const chat: Model<"custom-chat"> = {
	type: "chat",
	id: "same",
	name: "Chat",
	api: "custom-chat",
	provider: "fixture",
	baseUrl: "https://fixture.test",
	reasoning: false,
	input: ["text"],
	cost: {
		input: 3,
		output: 4,
		cacheRead: 0.3,
		cacheWrite: 3,
		tiers: [{ inputTokensAbove: 100, input: 6, output: 8, cacheRead: 0.6, cacheWrite: 6 }],
	},
	contextWindow: 1000,
	maxTokens: 100,
};
const image: ImageModel<"custom-image"> = {
	type: "image",
	id: "same",
	name: "Image",
	api: "custom-image",
	provider: "fixture",
	baseUrl: "https://fixture.test",
	input: ["text", "image"],
	output: ["image", "text"],
	cost: { input: 0.10000000000000002, output: -1, cacheRead: 0, cacheWrite: 0 },
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-normalized-generation-"));
	roots.push(root);
	const isolatedPackageRoot = join(root, "package");
	mkdirSync(isolatedPackageRoot);
	for (const entry of ["package.json", "scripts", "src"])
		cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
	const snapshotPath = join(root, "snapshot.json");
	writeFileSync(snapshotPath, JSON.stringify({ generatedAt, models: [chat, image] }));
	const fetchLog = join(root, "fetches.json");
	writeFileSync(fetchLog, "[]");
	const preloadPath = join(root, "no-network.mjs");
	writeFileSync(
		preloadPath,
		`import { readFileSync, writeFileSync } from 'node:fs';\nglobalThis.fetch = async input => { const urls = JSON.parse(readFileSync(${JSON.stringify(fetchLog)}, 'utf8')); const url = input instanceof Request ? input.url : String(input); urls.push(url); writeFileSync(${JSON.stringify(fetchLog)}, JSON.stringify(urls)); throw new Error('Forbidden network: ' + url); };\n`,
	);
	const outputDir = join(root, "catalog");
	const run = (args: string[] = [], preload = preloadPath) => {
		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preload).href, "scripts/generate-models.ts", "--strict", ...args],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 },
		);
		expect(JSON.parse(readFileSync(fetchLog, "utf8"))).toEqual([]);
		return result;
	};
	return { root, isolatedPackageRoot, snapshotPath, outputDir, preloadPath, run };
}

function contents(root: string): Record<string, string> {
	return Object.fromEntries(
		readdirSync(root, { recursive: true })
			.filter((entry) => String(entry).endsWith(".ts") || String(entry).endsWith(".json"))
			.map((entry) => [String(entry), readFileSync(join(root, String(entry)), "utf8")]),
	);
}

describe("offline normalized model generation", () => {
	it("preserves mixed operation records, float/sentinel prices, timestamp and hashes, with keyed public chat projections", () => {
		const f = fixture();
		const result = f.run(["--normalized-input", f.snapshotPath, "--json-output", f.outputDir]);
		expect(result.status, result.stderr).toBe(0);
		expect(() => validateGeneratedModelData(f.isolatedPackageRoot)).not.toThrow();
		const dataDir = join(f.isolatedPackageRoot, "src/providers/data");
		const values = JSON.parse(readFileSync(join(dataDir, "fixture.json"), "utf8"));
		expect(values).toEqual({ "custom-chat": { "chat:same": chat }, "custom-image": { "image:same": image } });
		const manifest = JSON.parse(readFileSync(join(dataDir, ".manifest.json"), "utf8"));
		expect(manifest.schemaVersion).toBe(4);
		expect(manifest.generatedAt).toBe(generatedAt);
		expect(manifest.files["fixture.json"]).toBe(
			createHash("sha256")
				.update(readFileSync(join(dataDir, "fixture.json")))
				.digest("hex"),
		);
		expect(JSON.parse(readFileSync(join(f.outputDir, "models.json"), "utf8"))).toEqual({ fixture: { same: chat } });
		expect(JSON.parse(readFileSync(join(f.outputDir, "providers/fixture.json"), "utf8"))).toEqual({ same: chat });
		expect(JSON.parse(readFileSync(join(f.outputDir, "models.all.json"), "utf8"))).toEqual([chat, image]);
		expect(JSON.parse(readFileSync(join(f.outputDir, "providers/fixture.all.json"), "utf8"))).toEqual([chat, image]);
		const before = contents(join(f.isolatedPackageRoot, "src"));
		expect(f.run(["--normalized-input", f.snapshotPath, "--data-only"]).status).toBe(0);
		expect(contents(join(f.isolatedPackageRoot, "src"))).toEqual(before);
	});

	it.each(["--json-only", "--data-only"])(
		"requires the explicit snapshot input to exist without fallback (%s)",
		(mode) => {
			const f = fixture();
			const before = contents(join(f.isolatedPackageRoot, "src"));
			const result = f.run([
				"--normalized-input",
				join(f.root, "missing.json"),
				mode,
				...(mode === "--json-only" ? ["--json-output", f.outputDir] : []),
			]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("ENOENT");
			expect(contents(join(f.isolatedPackageRoot, "src"))).toEqual(before);
			expect(existsSync(f.outputDir)).toBe(false);
		},
	);

	it.each([
		["unknown operation", [{ ...chat, type: "classifier" }]],
		["duplicate cross-API operation", [chat, { ...chat, api: "other" }]],
		["invalid image output", [{ ...image, output: ["text"] }]],
		["invalid chat limits", [{ ...chat, contextWindow: 0 }]],
		["provider path traversal", [{ ...chat, provider: "../escape" }]],
	] as const)("validates %s before writing or fetching", (_name, models) => {
		const f = fixture();
		const before = contents(join(f.isolatedPackageRoot, "src"));
		writeFileSync(f.snapshotPath, JSON.stringify({ generatedAt, models }));
		expect(f.run(["--normalized-input", f.snapshotPath, "--json-output", f.outputDir]).status).toBe(1);
		expect(contents(join(f.isolatedPackageRoot, "src"))).toEqual(before);
		expect(existsSync(f.outputDir)).toBe(false);
	});

	it("rolls back all internal data, wrappers and aggregator after a failed swap", () => {
		const f = fixture();
		expect(f.run(["--normalized-input", f.snapshotPath]).status).toBe(0);
		const before = contents(join(f.isolatedPackageRoot, "src"));
		writeFileSync(
			f.snapshotPath,
			JSON.stringify({ generatedAt, models: [{ ...chat, name: "Changed" }, image] satisfies AnyModel[] }),
		);
		const failSwap = join(f.root, "fail-swap.mjs");
		writeFileSync(
			failSwap,
			`import ${JSON.stringify(pathToFileURL(f.preloadPath).href)};\nimport fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nconst rename = fs.renameSync; fs.renameSync = (from, to) => { if (String(from).includes('.model-generation-') && String(from).endsWith('/data')) throw new Error('injected data swap failure'); return rename(from, to); }; syncBuiltinESMExports();\n`,
		);
		const result = f.run(["--normalized-input", f.snapshotPath], failSwap);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("injected data swap failure");
		expect(contents(join(f.isolatedPackageRoot, "src"))).toEqual(before);
		expect(
			readdirSync(join(f.isolatedPackageRoot, "src/providers")).some((entry) =>
				entry.startsWith(".model-generation-"),
			),
		).toBe(false);
	});

	it.each(["staging", "swap"] as const)(
		"rolls back combined internal and public generation after public %s failure",
		(phase) => {
			const f = fixture();
			expect(f.run(["--normalized-input", f.snapshotPath, "--json-output", f.outputDir]).status).toBe(0);
			const sourceBefore = contents(join(f.isolatedPackageRoot, "src"));
			const publicBefore = contents(f.outputDir);
			writeFileSync(
				f.snapshotPath,
				JSON.stringify({
					generatedAt,
					models: [
						{ ...chat, name: "Changed", id: "changed-id" },
						image,
						{ ...chat, provider: "second-fixture", id: "new-shard" },
					] satisfies AnyModel[],
				}),
			);
			const faultPath = join(f.root, "fail-combined-public.mjs");
			writeFileSync(
				faultPath,
				`import ${JSON.stringify(pathToFileURL(f.preloadPath).href)};\nimport fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nconst phase = ${JSON.stringify(phase)}; const rename = fs.renameSync; const write = fs.writeFileSync; fs.renameSync = (from, to) => { if (phase === 'swap' && String(from).includes('.catalog-generation-') && String(from).endsWith('/catalog')) throw new Error('injected combined public failure'); return rename(from, to); }; fs.writeFileSync = (path, ...args) => { if (phase === 'staging' && String(path).includes('.catalog-generation-') && String(path).endsWith('/models.json')) throw new Error('injected combined public failure'); return write(path, ...args); }; syncBuiltinESMExports();\n`,
			);
			const result = f.run(["--normalized-input", f.snapshotPath, "--json-output", f.outputDir], faultPath);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("injected combined public failure");
			expect(contents(join(f.isolatedPackageRoot, "src"))).toEqual(sourceBefore);
			expect(contents(f.outputDir)).toEqual(publicBefore);
			expect(
				readdirSync(join(f.isolatedPackageRoot, "src/providers")).some((entry) =>
					entry.startsWith(".model-generation-"),
				),
			).toBe(false);
			expect(readdirSync(f.root).some((entry) => entry.startsWith(".catalog-generation-"))).toBe(false);
		},
	);

	it("reports post-commit cleanup failure without splitting the committed internal/public versions", () => {
		const f = fixture();
		expect(f.run(["--normalized-input", f.snapshotPath, "--json-output", f.outputDir]).status).toBe(0);
		const changed = {
			generatedAt,
			models: [
				{ ...chat, name: "Changed", id: "changed-id" },
				image,
				{ ...chat, provider: "second-fixture", id: "new-shard" },
			] satisfies AnyModel[],
		};
		writeFileSync(f.snapshotPath, JSON.stringify(changed));
		const control = fixture();
		writeFileSync(control.snapshotPath, JSON.stringify(changed));
		expect(control.run(["--normalized-input", control.snapshotPath, "--json-output", control.outputDir]).status).toBe(
			0,
		);
		const expectedSource = contents(join(control.isolatedPackageRoot, "src"));
		const expectedPublic = contents(control.outputDir);
		const faultPath = join(f.root, "fail-post-commit-cleanup.mjs");
		writeFileSync(
			faultPath,
			`import ${JSON.stringify(pathToFileURL(f.preloadPath).href)};\nimport fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nconst remove = fs.rmSync; fs.rmSync = (path, options) => { if (String(path).includes('.catalog-generation-') && fs.existsSync(${JSON.stringify(join(f.outputDir, "providers/second-fixture.json"))})) { const error = new Error('injected post-commit cleanup EACCES'); error.code = 'EACCES'; throw error; } return remove(path, options); }; syncBuiltinESMExports();\n`,
		);
		const result = f.run(["--normalized-input", f.snapshotPath, "--json-output", f.outputDir], faultPath);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("injected post-commit cleanup EACCES");
		expect(contents(join(f.isolatedPackageRoot, "src"))).toEqual(expectedSource);
		expect(contents(f.outputDir)).toEqual(expectedPublic);
		// Cleanup failure is reported, not swallowed; afterEach owns removal of this remaining backup.
		const remaining = readdirSync(f.root).filter((entry) => entry.startsWith(".catalog-generation-"));
		expect(remaining).toHaveLength(1);
		expect(existsSync(join(f.root, remaining[0], "previous-catalog"))).toBe(true);
		expect(
			readdirSync(join(f.isolatedPackageRoot, "src/providers")).some((entry) =>
				entry.startsWith(".model-generation-"),
			),
		).toBe(false);
	});

	it("rolls back the public JSON catalog after a failed public swap", () => {
		const f = fixture();
		expect(f.run(["--normalized-input", f.snapshotPath, "--json-only", "--json-output", f.outputDir]).status).toBe(0);
		const before = contents(f.outputDir);
		const sourceBefore = contents(join(f.isolatedPackageRoot, "src"));
		const failSwap = join(f.root, "fail-public-swap.mjs");
		writeFileSync(
			failSwap,
			`import ${JSON.stringify(pathToFileURL(f.preloadPath).href)};\nimport fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nconst rename = fs.renameSync; fs.renameSync = (from, to) => { if (String(from).includes('.catalog-generation-') && String(from).endsWith('/catalog')) throw new Error('injected public swap failure'); return rename(from, to); }; syncBuiltinESMExports();\n`,
		);
		const result = f.run(
			["--normalized-input", f.snapshotPath, "--json-only", "--json-output", f.outputDir],
			failSwap,
		);
		expect(result.status).toBe(1);
		expect(contents(f.outputDir)).toEqual(before);
		expect(contents(join(f.isolatedPackageRoot, "src"))).toEqual(sourceBefore);
	});
});
