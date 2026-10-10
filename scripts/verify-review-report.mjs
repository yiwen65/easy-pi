#!/usr/bin/env node

/**
 * Mechanical verification of a delegated review report.
 *
 * Review subagents can confabulate findings: symbols, paths and line numbers
 * that look plausible but never existed (observed 2026-09-23: 16/16 findings
 * across three reports referenced nonexistent code). This script grounds every
 * verifiable claim in the report against the repository before a coordinator
 * trusts or acts on it:
 *
 *   - `path/to/file.ts:line` references: the file must exist and the line must
 *     be in range; the actual line content is printed for eyeball comparison.
 *   - `backtickSymbols` (identifier-shaped, length >= 4): the symbol must
 *     occur in a file referenced by the same finding block (or anywhere in the
 *     repo when the block names no file). Symbols absent from the worktree are
 *     checked against full git history (`git log -S`) to distinguish "moved or
 *     renamed" from "never existed".
 *   - prose camelCase identifiers (e.g. removeSensitiveKeys written without
 *     backticks) must occur in a file referenced by the same block; misses are
 *     reported as PROSE_NOT_FOUND (advisory, still counted as suspects).
 *
 * Usage: node scripts/verify-review-report.mjs <report-file> [--root <repo>] [--strict]
 * Exit code: 1 when --strict and any claim is NOT_IN_FILE / NEVER_EXISTED / FILE_MISSING.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const reportPath = args.find((arg) => !arg.startsWith("--"));
const root = args.includes("--root") ? args[args.indexOf("--root") + 1] : fileURLToPath(new URL("..", import.meta.url));
const strict = args.includes("--strict");

if (!reportPath || !existsSync(reportPath)) {
	console.error("Usage: node scripts/verify-review-report.mjs <report-file> [--root <repo>] [--strict]");
	process.exit(2);
}

const PATH_LINE_RE = /[\w./-]+\.(?:ts|mts|mjs|cts|cjs|js|tsx|jsx|swift|py|sh|css|html|json|md):\d+/g;
const SYMBOL_RE = /`([A-Za-z_$][\w$]{3,})`/g;
const PROSE_SYMBOL_RE = /\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]{3,}\b|\b[A-Z][a-z]+[A-Z][A-Za-z0-9]{2,}\b/g;
const STOP_SYMBOLS = new Set(["true", "false", "null", "undefined", "string", "number", "boolean", "void"]);
// Language builtins and report vocabulary that legitimately never appear in source files.
const PROSE_STOP = new Set([
	"TypeError",
	"SyntaxError",
	"RangeError",
	"ReferenceError",
	"RegExp",
	"Json",
	"JavaScript",
	"TypeScript",
	"NodeList",
	"AbortSignal",
	"AbortController",
	"Promise.allSettled",
]);

const text = readFileSync(reportPath, "utf8");
// Findings conventionally start with a `###` heading; text before the first
// heading (preamble) is checked as one block too.
const blocks = [];
let current = { title: "(preamble)", lines: [] };
for (const line of text.split("\n")) {
	const heading = line.match(/^###\s+(.*)$/);
	if (heading) {
		blocks.push(current);
		// Keep the heading in the body: single-line findings put path:line and
		// symbols in the heading itself.
		current = { title: heading[1].trim(), lines: [line] };
	} else {
		current.lines.push(line);
	}
}
blocks.push(current);

const fileCache = new Map();
function readRepoFile(relativePath) {
	if (!fileCache.has(relativePath)) {
		const absolute = isAbsolute(relativePath) ? relativePath : join(root, relativePath);
		fileCache.set(relativePath, existsSync(absolute) ? readFileSync(absolute, "utf8") : null);
	}
	return fileCache.get(relativePath);
}

const gitCache = new Map();
function symbolInGitHistory(symbol) {
	if (!gitCache.has(symbol)) {
		const result = spawnSync("git", ["log", "--all", "--oneline", "-1", `-S${symbol}`], {
			cwd: root,
			encoding: "utf8",
			timeout: 60_000,
		});
		gitCache.set(symbol, result.status === 0 && result.stdout.trim().length > 0);
	}
	return gitCache.get(symbol);
}

function resolveReportPath(raw) {
	// Reports may prefix repo-relative paths with the absolute root or ./.
	let path = raw;
	if (isAbsolute(path)) {
		path = path.startsWith(root) ? path.slice(root.length).replace(/^\//, "") : path;
	}
	return path.replace(/^\.\//, "");
}

let suspects = 0;
let verified = 0;
const summary = [];

for (const block of blocks) {
	const body = block.lines.join("\n");
	const refs = [...body.matchAll(PATH_LINE_RE)].map((match) => {
		const [rawPath, rawLine] = match[0].split(/:(?=\d+$)/);
		return { raw: match[0], path: resolveReportPath(rawPath), line: Number(rawLine) };
	});
	const symbols = [
		...new Set(
			[...body.matchAll(SYMBOL_RE)].map((match) => match[1]).filter((symbol) => !STOP_SYMBOLS.has(symbol)),
		),
	];
	const symbolSet = new Set(symbols);
	const proseSymbols = [
		...new Set(
			[...body.matchAll(PROSE_SYMBOL_RE)]
				.map((match) => match[0])
				.filter((symbol) => !PROSE_STOP.has(symbol) && !symbolSet.has(symbol))
				// path:line fragments ("background-task-manager.ts") are not identifiers
				.filter((symbol) => !/\.(?:ts|js|mjs|swift|py)$/.test(symbol)),
		),
	];
	if (refs.length === 0 && symbols.length === 0 && proseSymbols.length === 0) continue;

	const findings = [];
	const readableFiles = [...new Set(refs.map((ref) => ref.path))].filter((path) => readRepoFile(path) !== null);

	for (const ref of refs) {
		const content = readRepoFile(ref.path);
		if (content === null) {
			suspects++;
			findings.push(`FILE_MISSING  ${ref.raw}`);
			continue;
		}
		const lines = content.split("\n");
		if (ref.line < 1 || ref.line > lines.length) {
			suspects++;
			findings.push(`LINE_RANGE    ${ref.raw}  (file has ${lines.length} lines)`);
			continue;
		}
		verified++;
		findings.push(`LINE_OK       ${ref.raw}  | ${lines[ref.line - 1].trim().slice(0, 100)}`);
	}

	const checkSymbol = (symbol, repoWide) => {
		if (!repoWide && readableFiles.length > 0) {
			return readableFiles.some((path) => readRepoFile(path).includes(symbol));
		}
		const result = spawnSync("rg", ["-l", "-F", "-q", symbol], { cwd: root, encoding: "utf8", timeout: 60_000 });
		return result.status === 0;
	};

	for (const symbol of symbols) {
		if (checkSymbol(symbol, readableFiles.length === 0)) {
			verified++;
			findings.push(`SYMBOL_OK     \`${symbol}\``);
			continue;
		}
		suspects++;
		const scopeNote = readableFiles.length > 0 ? "the finding's files" : "worktree";
		const inHistory = symbolInGitHistory(symbol);
		findings.push(
			inHistory
				? `RENAMED       \`${symbol}\` (absent from ${scopeNote}, present in git history)`
				: `NEVER_EXISTED \`${symbol}\` (absent from ${scopeNote} AND git history)`,
		);
	}

	for (const symbol of proseSymbols) {
		// Prose identifiers only make sense relative to the block's own files.
		if (readableFiles.length === 0) continue;
		if (checkSymbol(symbol, false)) {
			verified++;
			findings.push(`PROSE_OK      ${symbol}`);
		} else {
			suspects++;
			findings.push(`PROSE_NOT_FOUND ${symbol} (not in any file this finding references)`);
		}
	}

	if (findings.length > 0) {
		summary.push(`\n### ${block.title}`);
		summary.push(...findings.map((line) => `  ${line}`));
	}
}

console.log(`verify-review-report: ${verified} verified, ${suspects} suspect in ${reportPath}`);
console.log(summary.join("\n"));
if (strict && suspects > 0) process.exit(1);
