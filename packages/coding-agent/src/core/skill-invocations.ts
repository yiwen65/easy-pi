import { readFileSync } from "node:fs";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { createSkillPromptMessage, type SkillPromptMessage } from "./messages.ts";
import type { Skill } from "./skills.ts";

const SKILL_TOKEN_PREFIX = "/skill:";
const SKILL_NAME_BOUNDARY_PATTERN = /[A-Za-z0-9_-]/;

interface SkillInvocation {
	skill: Skill;
	start: number;
	end: number;
}

export interface SkillPromptExpansion {
	text: string;
	messages: SkillPromptMessage[];
}

function isTokenStartBoundary(char: string | undefined): boolean {
	return char === undefined || /\s/.test(char);
}

function isTokenEndBoundary(char: string | undefined): boolean {
	return char === undefined || !SKILL_NAME_BOUNDARY_PATTERN.test(char);
}

/** Find registered skill tokens without interpreting arbitrary `/skill:` text. */
function collectSkillInvocations(text: string, skills: readonly Skill[]): SkillInvocation[] {
	const candidates = skills
		.map((skill) => ({ skill, token: `${SKILL_TOKEN_PREFIX}${skill.name}` }))
		.sort((left, right) => right.token.length - left.token.length);
	const invocations: SkillInvocation[] = [];
	let searchStart = 0;

	while (searchStart < text.length) {
		const start = text.indexOf(SKILL_TOKEN_PREFIX, searchStart);
		if (start === -1) break;
		searchStart = start + SKILL_TOKEN_PREFIX.length;
		if (!isTokenStartBoundary(text[start - 1])) continue;

		const candidate = candidates.find(({ token }) => {
			const end = start + token.length;
			return text.startsWith(token, start) && isTokenEndBoundary(text[end]);
		});
		if (!candidate) continue;

		const end = start + candidate.token.length;
		invocations.push({ skill: candidate.skill, start, end });
		searchStart = end;
	}

	return invocations;
}

function removeLoadedSkillTokens(
	text: string,
	invocations: readonly SkillInvocation[],
	loadedPaths: Set<string>,
): string {
	let cursor = 0;
	let result = "";
	for (const invocation of invocations) {
		if (!loadedPaths.has(invocation.skill.filePath)) continue;
		result += text.slice(cursor, invocation.start);
		cursor = invocation.end;
	}
	result += text.slice(cursor);
	return result
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
}

/**
 * Resolve every registered skill token into a separate model-context message.
 * Repeated references to the same skill are deduplicated. Tokens are removed
 * only after their skill file loads successfully.
 */
export function buildSkillPromptExpansion(
	text: string,
	skills: readonly Skill[],
	onLoadError: (skill: Skill, error: unknown) => void,
): SkillPromptExpansion {
	const invocations = collectSkillInvocations(text, skills);
	if (invocations.length === 0) return { text, messages: [] };

	const messages: SkillPromptMessage[] = [];
	const attemptedPaths = new Set<string>();
	const loadedPaths = new Set<string>();
	for (const { skill } of invocations) {
		if (attemptedPaths.has(skill.filePath)) continue;
		attemptedPaths.add(skill.filePath);
		try {
			const contents = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
			messages.push(createSkillPromptMessage(skill.name, skill.filePath, skill.baseDir, contents));
			loadedPaths.add(skill.filePath);
		} catch (error) {
			onLoadError(skill, error);
		}
	}

	return {
		text: removeLoadedSkillTokens(text, invocations, loadedPaths),
		messages,
	};
}
