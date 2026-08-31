import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML skill block rendering", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("parses structured skill context messages and legacy inline skill blocks", () => {
		expect(templateJs).toContain("const structuredMatch = text.match(/^<skill>\\n<name>");
		expect(templateJs).toMatch(/legacyMatch/);
		expect(templateJs).toMatch(/skillBlock\.userMessage/);
	});

	it("renders built-in skill context entries separately from user messages", () => {
		expect(templateJs).toMatch(/entry\.customType === 'skill-prompt'/);
		expect(templateJs).toMatch(/renderSkillInvocation\(skillBlock\)/);

		// Legacy inline messages remain readable after switching new invocations to separate entries.
		expect(templateJs).toMatch(/skill-invocation/);

		// When a skill block has a userMessage, the user-message div must be emitted
		// as a separate block after the skill-invocation div, containing the user-authored text.
		// Verify the code checks hasUserContent so the user-message div is only omitted
		// when the skill block has no user prompt and no images.
		expect(templateJs).toMatch(/hasUserContent/);
	});

	it("renders skill content as markdown, not raw text", () => {
		// The skill block body is markdown (from the SKILL.md file).
		// It should be rendered through safeMarkedParse, not escaped as raw text.
		expect(templateJs).toMatch(/safeMarkedParse\(skillBlock\.content\)/);
	});

	it("shows skill name and user message in the sidebar tree", () => {
		// The sidebar tree should display both the skill name and the user prompt,
		// not just one or the other.
		expect(templateJs).toMatch(/tree-role-skill/);
	});
});
