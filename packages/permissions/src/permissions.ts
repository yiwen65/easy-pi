import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	type ExternalMutationJournalPolicy,
	validateExternalMutationJournalPolicy,
} from "./external-mutation-journal.ts";

export type PermissionMode = "full-access";
export type PermissionDecision = "allow" | "deny";

export const CHILD_HARNESS_CONTEXT_VERSION = 2 as const;
export const CHILD_HARNESS_CONTEXT_ENV = "WJ_CHILD_CONTEXT_FILE";

/** WJ-owned permission snapshot passed across the Child process boundary. */
export interface ChildHarnessContext {
	schemaVersion: typeof CHILD_HARNESS_CONTEXT_VERSION;
	cwd: string;
	permissionMode: PermissionMode;
	sessionGrants: string[];
	protectedRoots: string[];
	inheritedWriteRoots: string[];
	mutationJournal?: ExternalMutationJournalPolicy;
}

export interface CreateChildHarnessContextOptions {
	cwd: string;
	permissionMode: PermissionMode;
	sessionGrants?: readonly string[];
	protectedRoots: readonly string[];
	inheritedWriteRoots?: readonly string[];
	mutationJournal?: ExternalMutationJournalPolicy;
}

export type ChildHarnessContextProvider = (
	options: Omit<CreateChildHarnessContextOptions, "permissionMode" | "sessionGrants">,
) => ChildHarnessContext;

export interface BashAssessment {
	hardDenyReason?: string;
}

export interface PermissionRequest {
	mode: PermissionMode;
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	sessionGrants: ReadonlySet<string>;
	/** Additional WJ hard-breaker roots inherited from an enclosing Agent. */
	protectedRoots?: readonly string[];
	/** Parent-approved write roots inherited by a headless Child permission snapshot. */
	inheritedWriteRoots?: readonly string[];
}

export interface PermissionOutcome {
	decision: PermissionDecision;
	reason: string;
}

function expandKnownPathVariables(token: string, cwd: string, variables?: ReadonlyMap<string, string>): string {
	const knownVariables = variables ?? new Map<string, string>();
	return token
		.replace(/^~(?=\/|$)/, homedir())
		.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string, plain: string) => {
			const name = braced || plain;
			if (name === "PWD") return cwd;
			if (name === "HOME") return homedir();
			return knownVariables.get(name) ?? match;
		});
}

function isWithin(path: string, parent: string): boolean {
	const rel = relative(parent, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function canonicalExistingPath(path: string): string {
	return canonicalizeProspectivePath(path, dirname(path));
}

function recursiveDeleteBase(expanded: string, cwd: string): string | undefined {
	const wildcard = expanded.search(/[*?[{]/);
	const rawBase = wildcard < 0 ? expanded : expanded.slice(0, wildcard);
	const base = rawBase === "" ? "." : rawBase.replace(/\/+$/, "") || "/";
	const normalized = isAbsolute(base) ? resolve(base) : resolve(cwd, base);
	return canonicalizeProspectivePath(normalized, cwd);
}

function protectedDeleteReason(target: string, protectedRoots: string[]): string | undefined {
	return protectedRoots.some((root) => isWithin(root, target))
		? `Refusing deletion that covers protected root: ${target}`
		: undefined;
}

interface ParsedShellWord {
	parts: Array<{ text: string; expandable: boolean }>;
}

interface ParsedShellCommand {
	words: ParsedShellWord[];
	operatorBefore?: string;
}

function shellWordText(word: ParsedShellWord): string {
	return word.parts.map((part) => part.text).join("");
}

function parseShellCommands(source: string): ParsedShellCommand[] {
	const commands: ParsedShellCommand[] = [];
	let words: ParsedShellWord[] = [];
	let parts: ParsedShellWord["parts"] = [];
	let wordStarted = false;
	let quote: "'" | '"' | undefined;
	let operatorBefore: string | undefined;
	let heredocTarget: { stripTabs: boolean } | undefined;
	let heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];

	const append = (text: string, expandable: boolean) => {
		wordStarted = true;
		const previous = parts.at(-1);
		if (previous?.expandable === expandable) previous.text += text;
		else parts.push({ text, expandable });
	};
	const finishWord = () => {
		if (!wordStarted) return;
		const word = { parts };
		if (heredocTarget) {
			heredocs.push({ delimiter: shellWordText(word), stripTabs: heredocTarget.stripTabs });
			heredocTarget = undefined;
		} else {
			words.push(word);
		}
		parts = [];
		wordStarted = false;
	};
	const finishCommand = (nextOperator?: string) => {
		finishWord();
		if (words.length > 0) commands.push({ words, ...(operatorBefore ? { operatorBefore } : {}) });
		words = [];
		operatorBefore = nextOperator;
	};
	const skipHeredocBodies = (start: number): number => {
		let cursor = start;
		for (const heredoc of heredocs) {
			while (cursor < source.length) {
				const lineEnd = source.indexOf("\n", cursor);
				const end = lineEnd < 0 ? source.length : lineEnd;
				const line = source.slice(cursor, end).replace(/\r$/, "");
				const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
				cursor = lineEnd < 0 ? source.length : lineEnd + 1;
				if (candidate === heredoc.delimiter) break;
			}
		}
		heredocs = [];
		return cursor;
	};

	for (let index = 0; index < source.length; index++) {
		const character = source[index];
		if (!character) continue;
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else append(character, false);
			continue;
		}
		if (quote === '"') {
			if (character === '"') {
				quote = undefined;
			} else if (character === "\\" && source[index + 1]) {
				append(source[++index] ?? "", false);
			} else {
				append(character, true);
			}
			continue;
		}
		if (character === "'" || character === '"') {
			wordStarted = true;
			quote = character;
			continue;
		}
		if (character === "\\" && source[index + 1]) {
			if (source[index + 1] === "\n") index++;
			else append(source[++index] ?? "", false);
			continue;
		}
		if (character === "#" && !wordStarted) {
			const newline = source.indexOf("\n", index);
			index = newline < 0 ? source.length : newline - 1;
			continue;
		}
		if (character === "<" && source[index + 1] === "<") {
			finishWord();
			index++;
			const stripTabs = source[index + 1] === "-";
			if (stripTabs) index++;
			heredocTarget = { stripTabs };
			continue;
		}
		if (/\s/.test(character)) {
			finishWord();
			if (character === "\n") {
				finishCommand("\n");
				if (heredocs.length > 0) index = skipHeredocBodies(index + 1) - 1;
			}
			continue;
		}
		if (character === ";" || character === "|" || character === "&" || character === "(" || character === ")") {
			const doubled = source[index + 1] === character && (character === "|" || character === "&");
			const operator = doubled ? character + character : character;
			finishCommand(operator);
			if (doubled) index++;
			continue;
		}
		append(character, true);
	}
	finishCommand();
	return commands;
}

function expandShellWord(
	word: ParsedShellWord,
	cwd: string,
	variables: ReadonlyMap<string, string>,
): string | undefined {
	let expanded = "";
	for (const part of word.parts) {
		if (!part.expandable) {
			expanded += part.text;
			continue;
		}
		const value = expandKnownPathVariables(part.text, cwd, variables);
		if (/[$`]|\$\(|<\(/.test(value)) return undefined;
		expanded += value;
	}
	return expanded;
}

function assignmentFromWord(word: ParsedShellWord): { name: string; value: ParsedShellWord } | undefined {
	const text = shellWordText(word);
	const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(text);
	if (!match?.[1]) return undefined;
	let remaining = match[0].length;
	const parts: ParsedShellWord["parts"] = [];
	for (const part of word.parts) {
		if (remaining >= part.text.length) {
			remaining -= part.text.length;
			continue;
		}
		parts.push({ text: part.text.slice(remaining), expandable: part.expandable });
		remaining = 0;
	}
	return { name: match[1], value: { parts } };
}

function shellRedirectionWidth(token: string): number {
	if (/^\d*(?:<>|>>?|<|>\||<&|>&)$/.test(token)) return 2;
	if (/^\d*(?:<>|>>?|<|>\||<&|>&).+/.test(token)) return 1;
	return 0;
}

function shellInvocation(
	words: ParsedShellWord[],
	cwd: string,
	variables: ReadonlyMap<string, string>,
): { name: string; args: ParsedShellWord[] } | undefined {
	let cursor = 0;
	const prefixes = new Set(["!", "do", "then", "else", "elif", "if", "while", "until", "time", "{"]);
	while (true) {
		const token = shellWordText(words[cursor] ?? { parts: [] });
		if (prefixes.has(token) || (words[cursor] && assignmentFromWord(words[cursor]))) {
			cursor++;
			continue;
		}
		const redirectionWidth = shellRedirectionWidth(token);
		if (redirectionWidth > 0) {
			cursor += redirectionWidth;
			continue;
		}
		break;
	}
	for (let wrappers = 0; wrappers < 4 && words[cursor]; wrappers++) {
		const command = expandShellWord(words[cursor]!, cwd, variables);
		if (!command) return undefined;
		const name = basename(command).toLowerCase();
		if (name === "command") {
			cursor++;
			while (shellWordText(words[cursor] ?? { parts: [] }).startsWith("-")) cursor++;
			continue;
		}
		if (name === "env") {
			cursor++;
			while (words[cursor]) {
				const token = shellWordText(words[cursor]!);
				if (assignmentFromWord(words[cursor]!)) {
					cursor++;
					continue;
				}
				const redirectionWidth = shellRedirectionWidth(token);
				if (redirectionWidth > 0) {
					cursor += redirectionWidth;
					continue;
				}
				if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir") {
					cursor += 2;
					continue;
				}
				if (token.startsWith("-")) {
					cursor++;
					continue;
				}
				break;
			}
			continue;
		}
		if (name === "sudo") {
			cursor++;
			while (words[cursor]) {
				const token = shellWordText(words[cursor]!);
				const redirectionWidth = shellRedirectionWidth(token);
				if (redirectionWidth > 0) {
					cursor += redirectionWidth;
					continue;
				}
				if (["-C", "-D", "-g", "-h", "-p", "-r", "-t", "-u"].includes(token)) {
					cursor += 2;
					continue;
				}
				if (token.startsWith("-")) {
					cursor++;
					continue;
				}
				break;
			}
			continue;
		}
		return { name, args: words.slice(cursor + 1) };
	}
	return undefined;
}

const findPredicatesWithoutArguments = new Set([
	"!",
	"(",
	")",
	",",
	"-a",
	"-and",
	"-daystart",
	"-depth",
	"-empty",
	"-executable",
	"-false",
	"-ignore_readdir_race",
	"-ls",
	"-mount",
	"-noignore_readdir_race",
	"-nogroup",
	"-nouser",
	"-o",
	"-or",
	"-print",
	"-print0",
	"-prune",
	"-quit",
	"-readable",
	"-true",
	"-writable",
	"-xdev",
]);

const findPredicatesWithOneArgument = new Set([
	"-amin",
	"-anewer",
	"-atime",
	"-cmin",
	"-cnewer",
	"-ctime",
	"-fprint",
	"-fprint0",
	"-fls",
	"-fstype",
	"-gid",
	"-group",
	"-ilname",
	"-iname",
	"-inum",
	"-ipath",
	"-iregex",
	"-links",
	"-lname",
	"-maxdepth",
	"-mindepth",
	"-mmin",
	"-mtime",
	"-name",
	"-newer",
	"-newerat",
	"-newerct",
	"-newermt",
	"-path",
	"-perm",
	"-printf",
	"-regex",
	"-regextype",
	"-size",
	"-type",
	"-uid",
	"-user",
	"-wholename",
	"-xtype",
]);

function findExecObviouslyDeletes(
	words: ParsedShellWord[],
	cwd: string,
	variables: ReadonlyMap<string, string>,
	depth: number,
): boolean {
	const invocation = shellInvocation(words, cwd, variables);
	if (!invocation) return false;
	if (["rm", "rmdir", "shred", "unlink"].includes(invocation.name)) return true;
	if (depth >= 2 || !["bash", "dash", "ksh", "sh", "zsh"].includes(invocation.name)) return false;
	const commandIndex = invocation.args.findIndex((word) => shellWordText(word) === "-c");
	const script = commandIndex < 0 ? undefined : invocation.args[commandIndex + 1];
	if (!script) return false;
	return parseShellCommands(shellWordText(script)).some((command) =>
		findExecObviouslyDeletes(command.words, cwd, variables, depth + 1),
	);
}

function destructiveFindRoots(
	args: ParsedShellWord[],
	cwd: string,
	variables: ReadonlyMap<string, string>,
): ParsedShellWord[] | undefined {
	let cursor = 0;
	while (cursor < args.length) {
		const token = shellWordText(args[cursor]!);
		if (token === "--") {
			cursor++;
			break;
		}
		if (["-H", "-L", "-P"].includes(token) || /^-O\d*$/.test(token)) {
			cursor++;
			continue;
		}
		if (token === "-D") {
			cursor += 2;
			continue;
		}
		break;
	}
	const roots: ParsedShellWord[] = [];
	while (cursor < args.length) {
		const token = shellWordText(args[cursor]!);
		if (token.startsWith("-") || token === "!" || token === "(") break;
		roots.push(args[cursor]!);
		cursor++;
	}
	let destructive = false;
	while (cursor < args.length) {
		const token = shellWordText(args[cursor]!);
		if (token === "-delete") {
			destructive = true;
			break;
		}
		if (["-exec", "-execdir", "-ok", "-okdir"].includes(token)) {
			const payload: ParsedShellWord[] = [];
			for (cursor++; cursor < args.length; cursor++) {
				const part = shellWordText(args[cursor]!);
				if (part === ";" || part === "+") break;
				payload.push(args[cursor]!);
			}
			if (findExecObviouslyDeletes(payload, cwd, variables, 0)) {
				destructive = true;
				break;
			}
		} else if (findPredicatesWithOneArgument.has(token) || /^-newer[A-Za-z]{2}$/.test(token)) {
			cursor++;
		} else if (token === "-fprintf") {
			cursor += 2;
		} else if (token.startsWith("-") && !findPredicatesWithoutArguments.has(token)) {
			// Unknown predicates may consume the next token. Do not reinterpret their argument as a destructive action.
			cursor++;
		}
		cursor++;
	}
	if (!destructive) return undefined;
	return roots.length > 0 ? roots : [{ parts: [{ text: ".", expandable: false }] }];
}

function findCatastrophicGitClean(
	args: ParsedShellWord[],
	effectiveCwd: string,
	protectedRoots: string[],
	variables: ReadonlyMap<string, string>,
): string | undefined {
	let cursor = 0;
	let gitCwd = effectiveCwd;
	while (cursor < args.length) {
		const token = shellWordText(args[cursor]!);
		if (token === "-C") {
			const path = args[cursor + 1];
			const expanded = path ? expandShellWord(path, gitCwd, variables) : undefined;
			if (!expanded) return undefined;
			gitCwd = canonicalizeProspectivePath(expanded, gitCwd);
			cursor += 2;
			continue;
		}
		if (token.startsWith("-C") && token.length > 2) {
			gitCwd = canonicalizeProspectivePath(token.slice(2), gitCwd);
			cursor++;
			continue;
		}
		if (["-c", "--config-env", "--git-dir", "--work-tree", "--namespace"].includes(token)) {
			cursor += 2;
			continue;
		}
		if (token.startsWith("-")) {
			cursor++;
			continue;
		}
		break;
	}
	if (shellWordText(args[cursor] ?? { parts: [] }) !== "clean") return undefined;
	const cleanArgs = args.slice(cursor + 1);
	if (
		cleanArgs.some((word) => {
			const arg = shellWordText(word);
			return ["--dry-run", "--interactive"].includes(arg) || /^-[^-]*[ni]/.test(arg);
		})
	)
		return undefined;
	const pathspecs: ParsedShellWord[] = [];
	let sawPathspec = false;
	for (let index = 0; index < cleanArgs.length; index++) {
		const arg = shellWordText(cleanArgs[index]!);
		if (arg === "--") {
			pathspecs.push(...cleanArgs.slice(index + 1));
			sawPathspec = cleanArgs.length > index + 1;
			break;
		}
		if (arg === "-e" || arg === "--exclude") {
			index++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		pathspecs.push(cleanArgs[index]!);
		sawPathspec = true;
	}
	const targets = sawPathspec ? pathspecs : [{ parts: [{ text: ".", expandable: false }] }];
	for (const pathspec of targets) {
		const expanded = expandShellWord(pathspec, gitCwd, variables);
		if (!expanded) continue;
		const candidate = expanded.startsWith(":(top)") || expanded === ":/" ? "." : expanded;
		const target = recursiveDeleteBase(candidate, gitCwd);
		if (!target) continue;
		const reason = protectedDeleteReason(target, protectedRoots);
		if (reason) return reason;
	}
	return undefined;
}

function findCatastrophicDelete(
	command: string,
	cwd: string,
	additionalProtectedRoots: readonly string[] = [],
	depth = 0,
): string | undefined {
	const protectedRoots = [
		...new Set([
			resolve("/"),
			canonicalExistingPath(homedir()),
			canonicalizeProspectivePath(cwd, cwd),
			...additionalProtectedRoots.map((root) => canonicalizeProspectivePath(root, cwd)),
		]),
	];
	const variables = new Map<string, string>([
		["HOME", homedir()],
		["PWD", cwd],
	]);
	let effectiveCwd = cwd;
	for (const parsed of parseShellCommands(command)) {
		const assignments = parsed.words.map(assignmentFromWord);
		if (assignments.every((assignment) => assignment !== undefined)) {
			if (!parsed.operatorBefore || parsed.operatorBefore === ";" || parsed.operatorBefore === "\n") {
				for (const assignment of assignments) {
					if (!assignment) continue;
					const value = expandShellWord(assignment.value, effectiveCwd, variables);
					if (value === undefined) variables.delete(assignment.name);
					else variables.set(assignment.name, value);
				}
			}
			continue;
		}
		const invocation = shellInvocation(parsed.words, effectiveCwd, variables);
		if (!invocation) continue;
		if (invocation.name === "cd") {
			const destination = invocation.args[0];
			const nextCwd = destination ? expandShellWord(destination, effectiveCwd, variables) : homedir();
			if (nextCwd) {
				effectiveCwd = canonicalizeProspectivePath(nextCwd, effectiveCwd);
				variables.set("PWD", effectiveCwd);
			}
			continue;
		}
		if (depth < 2 && ["bash", "dash", "ksh", "sh", "zsh"].includes(invocation.name)) {
			const commandIndex = invocation.args.findIndex((word) => shellWordText(word) === "-c");
			const script = commandIndex < 0 ? undefined : invocation.args[commandIndex + 1];
			if (script) {
				const reason = findCatastrophicDelete(
					shellWordText(script),
					effectiveCwd,
					additionalProtectedRoots,
					depth + 1,
				);
				if (reason) return reason;
			}
		}
		if (invocation.name === "git") {
			const reason = findCatastrophicGitClean(invocation.args, effectiveCwd, protectedRoots, variables);
			if (reason) return reason;
			continue;
		}
		if (invocation.name === "find") {
			const roots = destructiveFindRoots(invocation.args, effectiveCwd, variables);
			if (!roots) continue;
			for (const root of roots) {
				const expanded = expandShellWord(root, effectiveCwd, variables);
				if (!expanded) continue;
				const target = recursiveDeleteBase(expanded, effectiveCwd);
				if (!target) continue;
				const reason = protectedDeleteReason(target, protectedRoots);
				if (reason) return reason;
			}
			continue;
		}
		if (invocation.name !== "rm") continue;
		const recursive = invocation.args.some((word) => {
			const arg = shellWordText(word);
			return /^-[^-]*r/i.test(arg) || arg === "--recursive";
		});
		if (!recursive) continue;
		for (const arg of invocation.args) {
			const raw = shellWordText(arg);
			if (raw === "--" || raw.startsWith("-")) continue;
			const expanded = expandShellWord(arg, effectiveCwd, variables);
			if (!expanded) continue;
			const target = recursiveDeleteBase(expanded, effectiveCwd);
			if (!target) continue;
			const reason = protectedDeleteReason(target, protectedRoots);
			if (reason) return reason;
		}
	}
	return undefined;
}

export function assessBash(
	command: string,
	cwd: string,
	additionalProtectedRoots: readonly string[] = [],
): BashAssessment {
	const hardDenyReason = findCatastrophicDelete(command, cwd, additionalProtectedRoots);
	return hardDenyReason ? { hardDenyReason } : {};
}

export function canonicalizeProspectivePath(path: string, cwd: string): string {
	const absolute = resolve(cwd, path);
	let existing = absolute;
	const suffix: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		suffix.unshift(basename(existing));
		existing = parent;
	}
	const canonicalBase = existsSync(existing) ? realpathSync(existing) : existing;
	return resolve(canonicalBase, ...suffix);
}

function validPermissionMode(value: unknown): value is PermissionMode {
	return value === "full-access";
}

function absolutePathList(value: unknown, field: string, cwd: string): string[] {
	if (
		!Array.isArray(value) ||
		value.length > 128 ||
		!value.every((path) => typeof path === "string" && isAbsolute(path))
	) {
		throw new Error(`Child Harness ${field} must be a bounded array of absolute paths`);
	}
	return [...new Set(value.map((path) => canonicalizeProspectivePath(path, cwd)))];
}

function sessionGrantList(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		value.length > 256 ||
		!value.every(
			(grant) => typeof grant === "string" && grant.length > 0 && grant.length <= 2_000 && !/[\0\r\n]/.test(grant),
		)
	) {
		throw new Error("Child Harness sessionGrants must be a bounded string array");
	}
	return [...new Set(value)];
}

export function validateChildHarnessContext(value: unknown): ChildHarnessContext {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Child Harness context must be an object");
	}
	const context = value as Record<string, unknown>;
	if (context.schemaVersion !== CHILD_HARNESS_CONTEXT_VERSION) {
		throw new Error(`Child Harness context schema ${CHILD_HARNESS_CONTEXT_VERSION} is required`);
	}
	if (typeof context.cwd !== "string" || !isAbsolute(context.cwd)) {
		throw new Error("Child Harness cwd must be absolute");
	}
	if (!validPermissionMode(context.permissionMode)) throw new Error("Child Harness permission mode is invalid");
	const cwd = canonicalizeProspectivePath(context.cwd, context.cwd);
	const protectedRoots = absolutePathList(context.protectedRoots, "protectedRoots", cwd);
	const inheritedWriteRoots = absolutePathList(context.inheritedWriteRoots, "inheritedWriteRoots", cwd);
	const sessionGrants = sessionGrantList(context.sessionGrants);
	const mutationJournal =
		context.mutationJournal === undefined
			? undefined
			: validateExternalMutationJournalPolicy(context.mutationJournal);
	if (
		mutationJournal &&
		inheritedWriteRoots.some((root) => isWithin(mutationJournal.path, root) || isWithin(root, mutationJournal.path))
	) {
		throw new Error("Inherited write roots must not overlap the private mutation journal");
	}
	if (inheritedWriteRoots.length > 0 && !mutationJournal) {
		throw new Error("Inherited external write roots require a private mutation journal");
	}
	if (inheritedWriteRoots.length === 0 && mutationJournal) {
		throw new Error("A Child mutation journal requires inherited external write roots");
	}
	return {
		schemaVersion: CHILD_HARNESS_CONTEXT_VERSION,
		cwd,
		permissionMode: context.permissionMode,
		sessionGrants,
		protectedRoots,
		inheritedWriteRoots,
		...(mutationJournal ? { mutationJournal } : {}),
	};
}

export function createChildHarnessContext(options: CreateChildHarnessContextOptions): ChildHarnessContext {
	return validateChildHarnessContext({
		schemaVersion: CHILD_HARNESS_CONTEXT_VERSION,
		cwd: options.cwd,
		permissionMode: options.permissionMode,
		sessionGrants: [...(options.sessionGrants ?? [])],
		protectedRoots: [...options.protectedRoots],
		inheritedWriteRoots: [...(options.inheritedWriteRoots ?? [])],
		...(options.mutationJournal ? { mutationJournal: options.mutationJournal } : {}),
	});
}

export function decidePermission(request: PermissionRequest): PermissionOutcome {
	const command =
		request.toolName === "bash" && typeof request.input.command === "string" ? request.input.command : "";
	const bash =
		request.toolName === "bash" ? assessBash(command, request.cwd, request.protectedRoots ?? []) : undefined;
	if (bash?.hardDenyReason) return { decision: "deny", reason: bash.hardDenyReason };
	return { decision: "allow", reason: "Full Access mode" };
}
