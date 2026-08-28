import { shortHash } from "../utils/hash.ts";

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined || key.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;

	const prefixChars: string[] = [];
	for (const char of key) {
		if (prefixChars.length === OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) {
			const hash = shortHash(key);
			const prefixLength = OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH - hash.length - 1;
			return `${prefixChars.slice(0, prefixLength).join("")}~${hash}`;
		}
		prefixChars.push(char);
	}
	return key;
}
