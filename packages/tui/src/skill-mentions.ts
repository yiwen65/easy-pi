const SKILL_MENTION_PREFIX = "\u2063\u2063";
const SKILL_MENTION_SUFFIX = "\u2063";
const SKILL_MENTION_PATTERN = `${SKILL_MENTION_PREFIX}([^${SKILL_MENTION_SUFFIX}\r\n]+)${SKILL_MENTION_SUFFIX}`;

export interface SkillMentionSpan {
	start: number;
	end: number;
	nameStart: number;
	nameEnd: number;
	name: string;
}

/** Encode a selected skill as width-preserving editor metadata around its visible name. */
export function encodeSkillMention(name: string): string {
	if (!name || name.includes(SKILL_MENTION_SUFFIX) || /[\r\n]/.test(name)) {
		throw new Error("Skill mention names must be non-empty single-line text");
	}
	return `${SKILL_MENTION_PREFIX}${name}${SKILL_MENTION_SUFFIX}`;
}

export function findSkillMentions(text: string): SkillMentionSpan[] {
	const mentions: SkillMentionSpan[] = [];
	for (const match of text.matchAll(new RegExp(SKILL_MENTION_PATTERN, "gu"))) {
		const name = match[1]!;
		const start = match.index;
		const nameStart = start + SKILL_MENTION_PREFIX.length;
		mentions.push({
			start,
			end: start + match[0].length,
			nameStart,
			nameEnd: nameStart + name.length,
			name,
		});
	}
	return mentions;
}

export function isSkillMention(text: string): boolean {
	const mentions = findSkillMentions(text);
	return mentions.length === 1 && mentions[0]!.start === 0 && mentions[0]!.end === text.length;
}

/** Restore backend skill syntax when text re-enters the built-in editor. */
export function encodeSkillInvocations(text: string): string {
	return text.replace(/(^|\s)\/skill:([^\s]+)/gu, (_match, boundary: string, name: string) => {
		return `${boundary}${encodeSkillMention(name)}`;
	});
}

/** Return the text shown to editor consumers without private marker metadata. */
export function stripSkillMentions(text: string): string {
	return text.replace(new RegExp(SKILL_MENTION_PATTERN, "gu"), (_match, name: string) => name);
}

/** Convert selected mentions back to the syntax understood by the coding-agent parser. */
export function expandSkillMentions(text: string): string {
	return text.replace(new RegExp(SKILL_MENTION_PATTERN, "gu"), (_match, name: string) => `/skill:${name}`);
}
