import { expect, test } from "vitest";
import { realSubagentConfig } from "./subagent-real-config.ts";

test("real subagent tests default to gpt-6.1-sol medium and override model and effort independently", () => {
	expect(realSubagentConfig({})).toEqual({
		provider: "openai-codex",
		modelId: "gpt-6.1-sol",
		thinkingLevel: "medium",
	});
	expect(realSubagentConfig({ PI_REAL_SUBAGENT_MODEL: "explicit-model" })).toMatchObject({
		modelId: "explicit-model",
		thinkingLevel: "medium",
	});
	expect(realSubagentConfig({ PI_REAL_SUBAGENT_EFFORT: "high" })).toMatchObject({
		modelId: "gpt-6.1-sol",
		thinkingLevel: "high",
	});
	expect(() => realSubagentConfig({ PI_REAL_SUBAGENT_EFFORT: "unsupported" })).toThrow(
		"Invalid PI_REAL_SUBAGENT_EFFORT",
	);
});
