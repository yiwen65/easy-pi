import { createHash } from "node:crypto";
import { parse, resolve } from "node:path";
import type { PermissionMode } from "@easy-pi/permissions";
import type { ChildModelSelection, SubagentRole } from "./types.ts";

export const SUBAGENT_PROMPT_CACHE_KEY_ENV = "WJ_SUBAGENT_PROMPT_CACHE_KEY";
const CACHE_PROFILE_VERSION = 1;
const CACHE_KEY_HASH_CHARS = 40;
const CACHE_KEY_PREFIX = `wj-subagent-v${CACHE_PROFILE_VERSION}-`;
const CACHE_KEY_PATTERN = new RegExp(`^wj-subagent-v${CACHE_PROFILE_VERSION}-[a-f0-9]{${CACHE_KEY_HASH_CHARS}}$`);

export interface SubagentPromptCacheProfile {
	workspaceRoot: string;
	role: SubagentRole;
	permissionMode: PermissionMode;
	childModel?: ChildModelSelection;
}

/**
 * Group only Child requests whose stable provider prefix is expected to match.
 * Task, attempt, snapshot, and session identities are intentionally excluded.
 */
export function createSubagentPromptCacheKey(profile: SubagentPromptCacheProfile): string {
	const workspaceRoot = resolve(profile.workspaceRoot).replaceAll("\\", "/");
	const identity = JSON.stringify({
		version: CACHE_PROFILE_VERSION,
		workspaceRoot,
		role: profile.role,
		permissionMode: profile.permissionMode,
		provider: profile.childModel?.provider ?? "inherited",
		model: profile.childModel?.model ?? "inherited",
	});
	const hash = createHash("sha256").update(identity).digest("hex").slice(0, CACHE_KEY_HASH_CHARS);
	return `${CACHE_KEY_PREFIX}${hash}`;
}

export function readSubagentPromptCacheKey(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	const key = environment[SUBAGENT_PROMPT_CACHE_KEY_ENV];
	if (key === undefined) return undefined;
	if (!CACHE_KEY_PATTERN.test(key)) throw new Error(`Invalid ${SUBAGENT_PROMPT_CACHE_KEY_ENV}`);
	return key;
}

/**
 * Replace only an already-enabled provider cache key. Empty/missing fields mean
 * the provider or caller disabled cache retention and must remain untouched.
 */
export function applySubagentPromptCacheKey(payload: unknown, key: string): unknown | undefined {
	if (!CACHE_KEY_PATTERN.test(key)) throw new Error(`Invalid ${SUBAGENT_PROMPT_CACHE_KEY_ENV}`);
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const record = payload as Record<string, unknown>;
	const next = { ...record };
	let changed = false;
	for (const field of ["prompt_cache_key", "promptCacheKey"] as const) {
		if (typeof record[field] !== "string" || record[field].length === 0) continue;
		next[field] = key;
		changed = true;
	}
	return changed ? next : undefined;
}

/**
 * Pi executes tools in the real isolated CWD. Hiding that ephemeral absolute
 * prefix from the Child system prompt preserves the same semantics via `.` and
 * keeps equivalent snapshots/worktrees cache-compatible.
 */
export function normalizeSubagentSystemPrompt(systemPrompt: string, cwd: string): string {
	const resolvedCwd = resolve(cwd);
	const promptCwd = resolvedCwd.replaceAll("\\", "/");
	const root = parse(resolvedCwd).root.replaceAll("\\", "/");
	if (promptCwd === root) return systemPrompt;
	return systemPrompt.split(promptCwd).join(".");
}
