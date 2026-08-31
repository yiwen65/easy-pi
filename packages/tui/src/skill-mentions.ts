const SKILL_MENTION_PREFIX = "\u2063\u2063";
const SKILL_MENTION_SUFFIX = "\u2063";
const SKILL_MENTION_PATTERN = new RegExp(
	`${SKILL_MENTION_PREFIX}([^${SKILL_MENTION_SUFFIX}\r\n]+)${SKILL_MENTION_SUFFIX}`,
	"gu",
);

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
	if (!text.includes(SKILL_MENTION_PREFIX)) return [];

	const mentions: SkillMentionSpan[] = [];
	for (const match of text.matchAll(SKILL_MENTION_PATTERN)) {
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
	if (!text.startsWith(SKILL_MENTION_PREFIX) || !text.endsWith(SKILL_MENTION_SUFFIX)) return false;
	const name = text.slice(SKILL_MENTION_PREFIX.length, -SKILL_MENTION_SUFFIX.length);
	return name.length > 0 && !name.includes(SKILL_MENTION_SUFFIX) && !/[\r\n]/.test(name);
}

/** Restore backend skill syntax when text re-enters the built-in editor. */
export function encodeSkillInvocations(text: string): string {
	return text.replace(/(^|\s)\/skill:([^\s]+)/gu, (_match, boundary: string, name: string) => {
		return `${boundary}${encodeSkillMention(name)}`;
	});
}

/** Return the text shown to editor consumers without private marker metadata. */
export function stripSkillMentions(text: string): string {
	if (!text.includes(SKILL_MENTION_PREFIX)) return text;
	return text.replace(SKILL_MENTION_PATTERN, (_match, name: string) => name);
}

/** Convert selected mentions back to the syntax understood by the coding-agent parser. */
export function expandSkillMentions(text: string): string {
	if (!text.includes(SKILL_MENTION_PREFIX)) return text;
	return text.replace(SKILL_MENTION_PATTERN, (_match, name: string) => `/skill:${name}`);
}
