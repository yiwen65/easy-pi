import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applySubagentPromptCacheKey,
	createSubagentPromptCacheKey,
	normalizeSubagentSystemPrompt,
	readSubagentPromptCacheKey,
	SUBAGENT_PROMPT_CACHE_KEY_ENV,
} from "../src/cache-affinity.ts";
import { createSubmitHandoffSchema } from "../src/handoff.ts";

const baseProfile = {
	workspaceRoot: "/workspace/project",
	role: "scout" as const,
	permissionMode: "auto" as const,
	childModel: { provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "high" as const },
};

describe("Subagent prompt-cache affinity", () => {
	it("derives one bounded private key for a compatible project/model/role profile", () => {
		const key = createSubagentPromptCacheKey(baseProfile);
		const samePrefixAtDifferentEffort = createSubagentPromptCacheKey({
			...baseProfile,
			childModel: { ...baseProfile.childModel, thinkingLevel: "low" },
		});

		expect(key).toMatch(/^wj-subagent-v1-[a-f0-9]{40}$/);
		expect(key.length).toBeLessThanOrEqual(64);
		expect(key).not.toContain("workspace");
		expect(samePrefixAtDifferentEffort).toBe(key);
	});

	it("separates profiles that can change the stable provider prefix", () => {
		const base = createSubagentPromptCacheKey(baseProfile);
		const variants = [
			{ ...baseProfile, workspaceRoot: "/workspace/other" },
			{ ...baseProfile, role: "reviewer" as const },
			{ ...baseProfile, permissionMode: "full-access" as const },
			{ ...baseProfile, childModel: { provider: "openai", model: "gpt-5.6" } },
		];

		expect(new Set(variants.map(createSubagentPromptCacheKey)).size).toBe(variants.length);
		expect(variants.map(createSubagentPromptCacheKey)).not.toContain(base);
	});

	it("reads only controller-shaped cache keys", () => {
		const key = createSubagentPromptCacheKey(baseProfile);
		expect(readSubagentPromptCacheKey({ [SUBAGENT_PROMPT_CACHE_KEY_ENV]: key })).toBe(key);
		expect(readSubagentPromptCacheKey({})).toBeUndefined();
		expect(() => readSubagentPromptCacheKey({ [SUBAGENT_PROMPT_CACHE_KEY_ENV]: "caller-controlled" })).toThrow(
			SUBAGENT_PROMPT_CACHE_KEY_ENV,
		);
	});

	it("replaces only enabled provider cache fields and preserves transport identity", () => {
		const key = createSubagentPromptCacheKey(baseProfile);
		const snake = applySubagentPromptCacheKey(
			{ prompt_cache_key: "unique-session", session_id: "transport-session", input: [] },
			key,
		);
		const camel = applySubagentPromptCacheKey({ promptCacheKey: "unique-session", conversationId: "transport" }, key);

		expect(snake).toMatchObject({ prompt_cache_key: key, session_id: "transport-session" });
		expect(camel).toMatchObject({ promptCacheKey: key, conversationId: "transport" });
		expect(
			applySubagentPromptCacheKey({ prompt_cache_key: undefined, session_id: "transport" }, key),
		).toBeUndefined();
		expect(applySubagentPromptCacheKey({ prompt_cache_key: "", session_id: "transport" }, key)).toBeUndefined();
		expect(applySubagentPromptCacheKey({ session_id: "transport" }, key)).toBeUndefined();
	});

	it("normalizes only the Child's ephemeral CWD to a relative root", () => {
		const cwd = resolve("/private/tmp/subagent-snapshot").replaceAll("\\", "/");
		const prompt = [
			`<project_instructions path="${cwd}/AGENTS.md">`,
			`Current working directory: ${cwd}`,
			"External root: /srv/live-data",
		].join("\n");
		const normalized = normalizeSubagentSystemPrompt(prompt, cwd);

		expect(normalized).toContain('<project_instructions path="./AGENTS.md">');
		expect(normalized).toContain("Current working directory: .");
		expect(normalized).toContain("External root: /srv/live-data");
		expect(normalized).not.toContain(cwd);
	});

	it("keeps one provider-facing handoff schema across tasks and roles", () => {
		const first = createSubmitHandoffSchema();
		const second = createSubmitHandoffSchema();

		expect(second).toEqual(first);
		expect(JSON.stringify(first)).not.toContain("taskId");
		expect(JSON.stringify(first)).not.toContain("role");
	});
});
