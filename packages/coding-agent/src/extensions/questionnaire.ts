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
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 3 }),
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
			"Ask one to three structured questions with clickable choices and a custom-answer path. Use only when a material user decision is required.",
		promptSnippet: "Ask structured clarification questions",
		parameters: RequestUserInputSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await collectUserInput(ctx, params.questions);
			if (result.status === "input_required") {
				throw new Error("input_required: interactive UI is unavailable");
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
