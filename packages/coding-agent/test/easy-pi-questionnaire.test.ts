import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { collectUserInput, registerRequestUserInput } from "../src/extensions/questionnaire.ts";

const questions = [
	{
		header: "Scope",
		id: "scope",
		question: "Choose scope",
		options: [
			{ label: "Small", description: "One module" },
			{ label: "Large", description: "Whole repository" },
		],
	},
];

test("non-interactive questionnaire returns input_required", async () => {
	const ctx = { hasUI: false } as unknown as ExtensionContext;
	assert.deepEqual(await collectUserInput(ctx, questions), { status: "input_required", answers: [] });
});

type RegisteredTool = {
	execute: (
		toolCallId: string,
		params: { questions: typeof questions },
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
};

test("non-interactive execute falls back to plain-text questions", async () => {
	let tool: RegisteredTool | undefined;
	registerRequestUserInput({
		registerTool: (definition: RegisteredTool) => {
			tool = definition;
		},
	} as unknown as ExtensionAPI);

	const ctx = { hasUI: false } as unknown as ExtensionContext;
	const result = await tool!.execute("call-1", { questions }, undefined, undefined, ctx);
	const text = result.content[0]!.text;
	assert.ok(text.includes("plain text"));
	assert.ok(text.includes("Choose scope"));
	assert.ok(text.includes("Small — One module"));
	assert.ok(text.includes("(or answer in your own words)"));
	assert.deepEqual(result.details, { status: "input_required", answers: [] });
});

test("questionnaire returns selected and custom answers", async () => {
	const selectedCtx = {
		hasUI: true,
		ui: { select: async () => "Small — One module" },
	} as unknown as ExtensionContext;
	assert.deepEqual(await collectUserInput(selectedCtx, questions), {
		status: "answered",
		answers: [{ id: "scope", answer: "Small", custom: false }],
	});

	const customCtx = {
		hasUI: true,
		ui: { select: async () => "Type a custom answer", input: async () => "Only src" },
	} as unknown as ExtensionContext;
	assert.deepEqual(await collectUserInput(customCtx, questions), {
		status: "answered",
		answers: [{ id: "scope", answer: "Only src", custom: true }],
	});
});
