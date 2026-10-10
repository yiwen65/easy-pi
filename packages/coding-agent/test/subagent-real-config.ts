import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Explicit test overrides only; runtime/user-session defaults do not select the test model. */
export function realSubagentConfig(env: Record<string, string | undefined> = process.env) {
	const effort = env.PI_REAL_SUBAGENT_EFFORT ?? "medium";
	const supported: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	if (!supported.includes(effort as ThinkingLevel)) throw new Error("Invalid PI_REAL_SUBAGENT_EFFORT");
	return {
		provider: env.PI_REAL_SUBAGENT_PROVIDER ?? "openai-codex",
		modelId: env.PI_REAL_SUBAGENT_MODEL ?? "gpt-6.1-sol",
		thinkingLevel: effort as ThinkingLevel,
	};
}
