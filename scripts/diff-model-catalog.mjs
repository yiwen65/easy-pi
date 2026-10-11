#!/usr/bin/env node

import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readModelCatalog } from "./model-catalog.mjs";

function printUsage() {
	console.log(`Usage: node scripts/diff-model-catalog.mjs [--thinking] [--before <dir> --after <dir>] [provider ...]

By default, generates catalogs at HEAD and in the current worktree (uses network).
To compare pre-generated catalogs entirely offline, supply both --before and
--after. No worktree or model generation occurs in that mode.
If providers are omitted, all providers and chat/image operations are compared.
Legacy-only catalogs without models.all.json are treated as chat-only.

--thinking compares only chat models' effective thinking levels. With generated
catalogs it uses each worktree's getSupportedThinkingLevels(); with --before and
--after it uses the current implementation for both catalogs.

Examples:
  node scripts/diff-model-catalog.mjs --before /tmp/before --after /tmp/after openrouter
  npm run diff:model-catalog -- --thinking moonshotai kimi-coding
`);
}

function parseArgs(args) {
	const options = { thinkingOnly: false, before: undefined, after: undefined, providers: [], help: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help") options.help = true;
		else if (arg === "--thinking") options.thinkingOnly = true;
		else if (arg === "--before" || arg === "--after") {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a directory`);
			const key = arg.slice(2);
			if (options[key]) throw new Error(`${arg} may only be supplied once`);
			options[key] = resolve(value);
		} else if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`);
		else options.providers.push(arg);
	}
	if (Boolean(options.before) !== Boolean(options.after)) throw new Error("--before and --after must be supplied together");
	return options;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(`Command failed: ${[command, ...args].join(" ")}\n${details}`);
	}
	return result.stdout ?? "";
}

function generateCatalog(cwd, outputDir) {
	run(process.execPath, ["packages/ai/scripts/generate-models.ts", "--strict", "--json-only", "--json-output", outputDir], { cwd, capture: true });
}

function generateThinkingCatalog(cwd, catalogPath, outputDir) {
	run(process.execPath, [join(cwd, "scripts", "generate-thinking-capabilities.mjs"), catalogPath, outputDir], {
		cwd,
		capture: true,
	});
}

function readThinkingCatalog(outputDir, providerIds) {
	return new Map(providerIds.map((provider) => {
		const entries = JSON.parse(readFileSync(join(outputDir, "providers", `${provider}.json`), "utf8"));
		return [provider, new Map(Object.entries(entries).map(([id, value]) => [JSON.stringify(["chat", id]), value]))];
	}));
}

const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVEL_RANKS = new Map(THINKING_LEVEL_ORDER.map((key, index) => [key, index]));

function sortJsonKeys(keys, parentKey) {
	if (parentKey !== "thinkingLevelMap" && parentKey !== "values") return keys.sort();
	return keys.sort((left, right) => {
		const leftRank = THINKING_LEVEL_RANKS.get(left) ?? Number.POSITIVE_INFINITY;
		const rightRank = THINKING_LEVEL_RANKS.get(right) ?? Number.POSITIVE_INFINITY;
		return leftRank - rightRank || left.localeCompare(right);
	});
}

function canonicalizeJson(value, parentKey) {
	if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry));
	if (value === null || typeof value !== "object") return value;

	return Object.fromEntries(sortJsonKeys(Object.keys(value), parentKey).map((key) => [key, canonicalizeJson(value[key], key)]));
}

function formatJsonForDiff(value, indent = "") {
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const childIndent = `${indent}  `;
		return `[\n${value.map((entry) => `${childIndent}${formatJsonForDiff(entry, childIndent)},`).join("\n")}\n${indent}]`;
	}
	if (value === null || typeof value !== "object") return JSON.stringify(value);

	const entries = Object.entries(value);
	if (entries.length === 0) return "{}";
	const childIndent = `${indent}  `;
	return `{\n${entries
		.map(([key, entry]) => `${childIndent}${JSON.stringify(key)}: ${formatJsonForDiff(entry, childIndent)},`)
		.join("\n")}\n${indent}}`;
}

function writeModelSnapshot(path, model) {
	writeFileSync(path, model === undefined ? "" : `${formatJsonForDiff(canonicalizeJson(model))}\n`);
}

function writeChangedLines(output) {
	const changedLines = output.split("\n").filter((line) => {
		const withoutColor = line.replace(/\u001b\[[0-9;]*m/g, "");
		return (
			(withoutColor.startsWith("+") && !withoutColor.startsWith("+++")) ||
			(withoutColor.startsWith("-") && !withoutColor.startsWith("---"))
		);
	});
	if (changedLines.length > 0) process.stdout.write(`${changedLines.join("\n")}\n`);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printUsage();
		return;
	}
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-model-catalog-diff-"));
	const baselineWorktree = join(temporaryRoot, "baseline-worktree");
	let repoRoot;
	let worktreeAdded = false;
	try {
		let baselineOutput = options.before;
		let currentOutput = options.after;
		if (!baselineOutput) {
			repoRoot = run("git", ["rev-parse", "--show-toplevel"], { capture: true }).trim();
			run("git", ["worktree", "add", "--detach", baselineWorktree, "HEAD"], { cwd: repoRoot });
			worktreeAdded = true;
			copyFileSync(join(repoRoot, "scripts", "generate-thinking-capabilities.mjs"), join(baselineWorktree, "scripts", "generate-thinking-capabilities.mjs"));
			const nodeModules = join(repoRoot, "node_modules");
			if (existsSync(nodeModules)) symlinkSync(nodeModules, join(baselineWorktree, "node_modules"), process.platform === "win32" ? "junction" : "dir");
			baselineOutput = join(temporaryRoot, "before");
			currentOutput = join(temporaryRoot, "after");
			console.log("Generating catalog from HEAD...");
			generateCatalog(baselineWorktree, baselineOutput);
			console.log("Generating catalog from the current worktree...");
			generateCatalog(repoRoot, currentOutput);
		}

		const before = readModelCatalog(baselineOutput, { allowLegacy: true });
		const after = readModelCatalog(currentOutput, { allowLegacy: true });
		const requestedProviders = options.providers;
		const providers = requestedProviders.length > 0 ? requestedProviders : [...new Set([...before.providerIds, ...after.providerIds])].sort();
		let beforeModelsByProvider = before.modelsByProvider;
		let afterModelsByProvider = after.modelsByProvider;
		if (options.thinkingOnly) {
			console.log("Computing effective thinking capabilities (chat only)...");
			const beforeThinking = join(temporaryRoot, "before-thinking");
			const afterThinking = join(temporaryRoot, "after-thinking");
			const currentRoot = fileURLToPath(new URL("..", import.meta.url));
			generateThinkingCatalog(options.before ? currentRoot : baselineWorktree, before.modelsPath, beforeThinking);
			generateThinkingCatalog(options.after ? currentRoot : repoRoot, after.modelsPath, afterThinking);
			beforeModelsByProvider = readThinkingCatalog(beforeThinking, before.providerIds);
			afterModelsByProvider = readThinkingCatalog(afterThinking, after.providerIds);
		}

		const changedModels = [];
		for (const provider of providers) {
			const beforeModels = beforeModelsByProvider.get(provider);
			const afterModels = afterModelsByProvider.get(provider);
			if (beforeModels === undefined && afterModels === undefined) throw new Error(`Unknown provider: ${provider}`);
			const keys = [...new Set([...(beforeModels?.keys() ?? []), ...(afterModels?.keys() ?? [])])].sort();
			for (const key of keys) {
				const beforeModel = beforeModels?.get(key);
				const afterModel = afterModels?.get(key);
				if (JSON.stringify(canonicalizeJson(beforeModel)) === JSON.stringify(canonicalizeJson(afterModel))) continue;
				const beforePath = "before-model.json";
				const afterPath = "after-model.json";
				writeModelSnapshot(join(temporaryRoot, beforePath), beforeModel);
				writeModelSnapshot(join(temporaryRoot, afterPath), afterModel);
				const result = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--color=always", "--unified=0", "--", beforePath, afterPath], {
					cwd: temporaryRoot,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				});
				const [type, id] = JSON.parse(key);
				const label = `${provider}/${type}:${id}`;
				if (result.error) throw result.error;
				if (result.status === 1) {
					console.log(`\n${label}`);
					writeChangedLines(result.stdout);
					changedModels.push(label);
				} else if (result.status !== 0) throw new Error(`Could not compare ${label}: ${result.stderr || result.stdout}`);
			}
		}
		if (changedModels.length === 0) console.log(`No model catalog changes${requestedProviders.length === 1 ? ` for ${requestedProviders[0]}` : ""}.`);
		else {
			console.log(`\n${changedModels.length} model catalog entr${changedModels.length === 1 ? "y" : "ies"} changed.`);
			for (const label of changedModels) console.log(`- ${label}`);
		}
	} finally {
		if (worktreeAdded) {
			try {
				run("git", ["worktree", "remove", "--force", baselineWorktree], { cwd: repoRoot });
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
			}
		}
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
