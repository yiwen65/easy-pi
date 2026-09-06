import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Best-effort `.gitignore` subset for non-Git directory enumeration.
 *
 * Supported: blank lines and `#` comments, `!` negation, trailing-`/` directory-only
 * patterns, leading-`/` (or any slash-containing) anchored patterns, `*`, `?`,
 * character classes, and `**` (including leading `**\/`, trailing `/**`, and
 * `a/**\/b`). Per-directory `.gitignore` files apply below their own directory and
 * deeper files take precedence over shallower ones; within one file, later lines
 * win. A directory excluded by a parent rule is never descended into, so its
 * children cannot be re-included (matching Git).
 *
 * Deliberately unsupported (documented best-effort edges): global excludes,
 * `.git/info/exclude`, backslash-escaped leading `!`/`#`/trailing spaces, and
 * locale-dependent case folding.
 */

export interface DirectoryInventoryLimits {
	maxFiles: number;
}

export interface DirectoryInventoryOptions extends DirectoryInventoryLimits {
	signal?: AbortSignal;
}

interface IgnoreRule {
	negated: boolean;
	directoryOnly: boolean;
	/** Path (POSIX, relative to the repository root) of the directory owning the rule. */
	basePath: string;
	regex: RegExp;
	/** Match only the final path segment (unanchored patterns without a slash). */
	basenameOnly: boolean;
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

function globSegmentToRegex(segment: string): string {
	let output = "";
	for (let index = 0; index < segment.length; index++) {
		const char = segment[index]!;
		if (char === "*") output += "[^/]*";
		else if (char === "?") output += "[^/]";
		else if (char === "[") {
			const end = segment.indexOf("]", index + 1);
			if (end === -1) {
				output += "\\[";
			} else {
				const body = segment.slice(index + 1, end);
				const negatedBody = body.startsWith("!") ? `^${body.slice(1)}` : body;
				output += `[${negatedBody.replaceAll("\\", "\\\\")}]`;
				index = end;
			}
		} else {
			output += char.replace(REGEX_SPECIALS, "\\$&");
		}
	}
	return output;
}

/** Compile one gitignore pattern body (without `!` prefix or trailing `/`). */
function compilePattern(pattern: string): { regex: RegExp; basenameOnly: boolean } | undefined {
	if (!pattern) return undefined;
	let anchored = false;
	let body = pattern;
	if (body.startsWith("/")) {
		anchored = true;
		body = body.slice(1);
	}
	if (!anchored && body.includes("/")) anchored = true;
	// A trailing `/**` means "everything below"; a leading `**/` means "any depth".
	if (body === "**") return { regex: /^[^/]+(?:\/[^/]+)*$/, basenameOnly: false };
	let underOnly = false;
	if (body.endsWith("/**")) {
		body = body.slice(0, -3);
		underOnly = true;
	}
	if (body.startsWith("**/")) {
		body = body.slice(3);
		anchored = false;
	}
	const segments = body.split("/").filter((segment) => segment.length > 0);
	if (segments.length === 0) return undefined;
	const parts: string[] = [];
	for (const segment of segments) {
		if (segment === "**") parts.push("(?:[^/]+/)*");
		else parts.push(`${globSegmentToRegex(segment)}/`);
	}
	const joined = parts.join("").replace(/\/$/, "");
	const suffix = underOnly ? "(?:/.+)" : "(?:/.*)?";
	if (!anchored && segments.length === 1) {
		return { regex: new RegExp(`^${joined}$`), basenameOnly: true };
	}
	const prefix = anchored ? "^" : "^(?:[^/]+/)*";
	return { regex: new RegExp(`${prefix}${joined}${suffix}$`), basenameOnly: false };
}

function parseGitignore(content: string, basePath: string): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (const rawLine of content.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line || line.startsWith("#")) continue;
		let body = line;
		let negated = false;
		if (body.startsWith("!")) {
			negated = true;
			body = body.slice(1);
		}
		let directoryOnly = false;
		if (body.endsWith("/")) {
			directoryOnly = true;
			body = body.slice(0, -1);
		}
		body = body.trimEnd();
		if (!body) continue;
		const compiled = compilePattern(body);
		if (!compiled) continue;
		rules.push({ negated, directoryOnly, basePath, ...compiled });
	}
	return rules;
}

function ruleApplies(rule: IgnoreRule, relPath: string, isDirectory: boolean): boolean {
	if (rule.directoryOnly && !isDirectory) return false;
	if (rule.basePath) {
		if (relPath !== rule.basePath && !relPath.startsWith(`${rule.basePath}/`)) return false;
	}
	const candidate = rule.basePath ? relPath.slice(rule.basePath.length + 1) : relPath;
	if (!candidate) return false;
	if (rule.basenameOnly) {
		const basename = candidate.includes("/") ? candidate.slice(candidate.lastIndexOf("/") + 1) : candidate;
		return rule.regex.test(basename);
	}
	return rule.regex.test(candidate);
}

/** Decide whether `relPath` is ignored; later rules (deeper files, later lines) win. */
export function isIgnoredByRules(rules: readonly IgnoreRule[], relPath: string, isDirectory: boolean): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (ruleApplies(rule, relPath, isDirectory)) ignored = !rule.negated;
	}
	return ignored;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Directory enumeration aborted");
}

/**
 * Enumerate regular files and symlinks below `root` (POSIX relative paths, sorted),
 * skipping every `.git` entry and anything excluded by best-effort `.gitignore`
 * rules. Symlinks are listed but never descended into.
 */
export async function enumerateDirectoryFiles(root: string, options: DirectoryInventoryOptions): Promise<string[]> {
	if (!Number.isSafeInteger(options.maxFiles) || options.maxFiles < 0) {
		throw new Error("maxFiles must be a non-negative safe integer");
	}
	const collected: string[] = [];

	async function walk(directory: string, relBase: string, inheritedRules: IgnoreRule[]): Promise<void> {
		throwIfAborted(options.signal);
		let rules = inheritedRules;
		const dirEntries = await readdir(directory, { withFileTypes: true });
		if (dirEntries.some((entry) => entry.isFile() && entry.name === ".gitignore")) {
			try {
				const content = await readFile(join(directory, ".gitignore"), "utf8");
				rules = [...inheritedRules, ...parseGitignore(content, relBase)];
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code !== "ENOENT" &&
					(error as NodeJS.ErrnoException).code !== "EISDIR"
				)
					throw error;
			}
		}
		for (const entry of dirEntries) {
			throwIfAborted(options.signal);
			if (entry.name === ".git") continue;
			const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
			const isDirectory = entry.isDirectory();
			if (isIgnoredByRules(rules, relPath, isDirectory)) continue;
			if (isDirectory) {
				await walk(join(directory, entry.name), relPath, rules);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				if (collected.length + 1 > options.maxFiles) {
					throw new Error(`Directory enumeration exceeds maxFiles (${options.maxFiles})`);
				}
				collected.push(relPath);
			}
			// Sockets, FIFOs, and device nodes are not snapshot content.
		}
	}

	await walk(root, "", []);
	collected.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	return collected;
}
