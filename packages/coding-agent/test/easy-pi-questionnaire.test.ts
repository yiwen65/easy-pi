import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { collectUserInput } from "../src/extensions/questionnaire.ts";

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
