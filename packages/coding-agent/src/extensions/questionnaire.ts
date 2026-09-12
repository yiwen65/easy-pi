import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";

const OptionSchema = Type.Object({
	label: Type.String({ minLength: 1, description: "Short user-facing option label" }),
	description: Type.String({ minLength: 1, description: "One sentence explaining the impact or tradeoff" }),
});

const QuestionSchema = Type.Object({
	header: Type.String({ minLength: 1, maxLength: 24, description: "Short context label" }),
	id: Type.String({ minLength: 1, description: "Stable identifier for the answer" }),
	question: Type.String({ minLength: 1, description: "Question shown to the user" }),
	options: Type.Array(OptionSchema, { minItems: 2, maxItems: 4 }),
});

const RequestUserInputSchema = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1 }),
});

interface QuestionOption {
	label: string;
	description: string;
}

interface Question {
	header: string;
	id: string;
	question: string;
	options: QuestionOption[];
}

export interface UserInputAnswer {
	id: string;
	answer: string;
	custom: boolean;
}

export interface UserInputResult {
	status: "answered" | "cancelled" | "input_required";
	answers: UserInputAnswer[];
}

const CUSTOM_OPTION = "Type a custom answer";

/** Render questions as plain text for the non-interactive fallback. */
function formatQuestionsAsText(questions: Question[]): string {
	return questions
		.map((question, index) => {
			const lines = [`${index + 1}. [${question.header}] ${question.question}`];
			for (const option of question.options) {
				lines.push(`   - ${option.label} — ${option.description}`);
			}
			lines.push("   - (or answer in your own words)");
			return lines.join("\n");
		})
		.join("\n\n");
}

export async function collectUserInput(ctx: ExtensionContext, questions: Question[]): Promise<UserInputResult> {
	if (!ctx.hasUI) return { status: "input_required", answers: [] };
	const answers: UserInputAnswer[] = [];
	for (const question of questions) {
		const labels = question.options.map((option) => `${option.label} — ${option.description}`);
		const selected = await ctx.ui.select(`${question.header}\n${question.question}`, [...labels, CUSTOM_OPTION]);
		if (selected === undefined) return { status: "cancelled", answers };
		if (selected === CUSTOM_OPTION) {
			const custom = await ctx.ui.input(question.header, "Type your answer");
			if (custom === undefined) return { status: "cancelled", answers };
			answers.push({ id: question.id, answer: custom, custom: true });
			continue;
		}
		const index = labels.indexOf(selected);
		const option = question.options[index];
		if (!option) return { status: "cancelled", answers };
		answers.push({ id: question.id, answer: option.label, custom: false });
	}
	return { status: "answered", answers };
}

export function registerRequestUserInput(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "request_user_input",
		label: "Request User Input",
		description:
			'Ask structured questions with selectable options. Use only for material user decisions, and ask exactly as many questions as those decisions require — no padding. A custom free-text answer path is appended automatically — do not add an "Other" option. When no interactive UI is available, the questions are returned as text — present them in plain text and end the turn; the caller (user or parent agent) answers in a follow-up. If the user cancels, the result says so — respect it instead of retrying. Returns answers as "id: answer" lines.',
		promptSnippet: "Ask structured clarification questions",
		parameters: RequestUserInputSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await collectUserInput(ctx, params.questions);
			if (result.status === "input_required") {
				return {
					content: [
						{
							type: "text",
							text: `No interactive UI is available. Ask these questions in plain text and wait for the user's reply:\n\n${formatQuestionsAsText(params.questions)}`,
						},
					],
					details: result,
				};
			}
			if (result.status === "cancelled") {
				return {
					content: [{ type: "text", text: "User cancelled structured input" }],
					details: result,
				};
			}
			return {
				content: [
					{ type: "text", text: result.answers.map((answer) => `${answer.id}: ${answer.answer}`).join("\n") },
				],
				details: result,
			};
		},
	});
}
