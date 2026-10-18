import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
					codemode: "Run JavaScript that calls other tools",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
			expect(prompt).toContain("- codemode: Run JavaScript that calls other tools");
			expect(prompt).toContain("(via bash/write/codemode)");
		});

		test("omits codemode when it is not selected", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "bash", "edit", "write"],
				toolSnippets: { codemode: "Run JavaScript that calls other tools" },
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("codemode");
			expect(prompt).toContain("(via bash/write)");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- Resolve docs/... and examples/... against the directories above, not the current working directory.",
			);
			expect(prompt).toContain("environment variables (docs/environment-variables.md)");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("workflow efficiency", () => {
		test("guides direct actions and evidence reuse without weakening validation", () => {
			const prompt = buildSystemPrompt({ selectedTools: ["read"], cwd: "/workspace" });

			expect(prompt).toContain("Once the next routine action is clear, execute it directly");
			expect(prompt).toContain("batch independent read-only inspections");
			expect(prompt).toContain("keeping dependent actions and writes ordered");
			expect(prompt).toContain("use scoped searches and relevant excerpts unless full reads are required");
			expect(prompt).toContain("Reuse recorded evidence and terminal results; inspect missing output as needed");
			expect(prompt).toContain("re-check when external state may have changed or a concrete evidence gap remains");
			expect(prompt).toContain(
				"Once a required interaction capability is confirmed unavailable, stop repeated discovery",
			);
			expect(prompt).toContain("use a verified equivalent or report the remaining validation gap");
			expect(prompt).toContain("verify changes with the smallest check that can catch a meaningful failure");
			expect(prompt).toContain("Optimize for correctness first, then efficiency");
		});

		test.each([
			{ tools: [], waitTools: undefined },
			{ tools: ["wait_for"], waitTools: "wait_for" },
			{ tools: ["wait_agent"], waitTools: "wait_agent" },
			{ tools: ["wait_for", "wait_agent"], waitTools: "wait_for or wait_agent" },
		])("limits blocking-wait guidance to available tools: $tools", ({ tools, waitTools }) => {
			const prompt = buildSystemPrompt({ selectedTools: tools, cwd: "/workspace" });

			if (waitTools === undefined) {
				expect(prompt).not.toContain("When waiting is the only remaining dependency");
			} else {
				expect(prompt).toContain(`use ${waitTools} instead of polling status`);
				expect(prompt).toContain("not to repeatedly check completion");
			}
			for (const name of ["wait_for", "wait_agent"]) {
				if (!tools.some((tool) => tool === name)) expect(prompt).not.toContain(name);
			}
		});

		test("preserves custom system-prompt replacement without default workflow guidance", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "Custom instructions only.",
				selectedTools: ["read", "wait_for", "wait_agent"],
				cwd: "/workspace",
			});

			expect(prompt).toBe("Custom instructions only.\nCurrent working directory: /workspace\n");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
