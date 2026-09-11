import type { Delegation } from "../src/collaboration-contract.ts";

export function delegation(overrides: Partial<Delegation> = {}): Delegation {
	return {
		version: 1,
		task: {
			relationship: "continue",
			objective: "Inspect parser",
			scope: "Parser only",
			material: [],
			deliverables: ["Findings"],
			acceptance: ["Cite source"],
		},
		context: { mode: "isolated" },
		capabilities: { tools: "inherit" },
		...overrides,
	};
}
