import { describe, expect, it } from "vitest";
import { getJsonSchemaToolParameters, makeStrictJsonSchema } from "../src/api/constrained-sampling.ts";
import { stream } from "../src/api/openai-completions.ts";
import { convertResponsesTools } from "../src/api/openai-responses-shared.ts";
import type { Model, Tool } from "../src/types.ts";

// cua-driver 0.34.0 parse_visual_regions: valid JSON Schema, but Moonshot requires
// an explicit items type even when the enum already restricts it to strings.
const parameters = {
	type: "object",
	properties: {
		capture_id: { type: "string" },
		options: {
			type: "object",
			additionalProperties: false,
			default: {},
			properties: {
				kinds: {
					anyOf: [
						{ type: "array", items: { enum: ["text", "icon"] }, minItems: 1, maxItems: 2, uniqueItems: true },
						{ type: "null" },
					],
				},
			},
			required: [],
		},
	},
	required: ["capture_id"],
};
const tool: Tool = { name: "mcp__cua_driver__parse_visual_regions", description: "Parse a capture", parameters };
const model: Model<"openai-completions"> = {
	id: "qd/kmodel_latest",
	name: "Offline router fixture",
	api: "openai-completions",
	provider: "custom",
	baseUrl: "https://offline.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1024,
};

describe("provider tool enum schemas", () => {
	it("sends the CUA enum items type through the real Chat Completions payload builder", async () => {
		let payload: unknown;
		let fetchCalls = 0;
		await stream(
			model,
			{ messages: [{ role: "user", content: "inspect", timestamp: 0 }], tools: [tool] },
			{
				apiKey: "offline-placeholder",
				maxRetries: 0,
				fetch: async () => {
					fetchCalls++;
					throw new Error("Network forbidden in schema regression");
				},
				onPayload(value) {
					payload = value;
					throw new Error("Captured before network");
				},
			},
		).result();
		expect(fetchCalls).toBe(0);
		expect(payload).toMatchObject({
			tools: [
				{
					function: {
						parameters: {
							properties: {
								options: {
									properties: {
										kinds: {
											anyOf: [
												{
													type: "array",
													items: { enum: ["text", "icon"], type: "string" },
													minItems: 1,
													maxItems: 2,
													uniqueItems: true,
												},
												{ type: "null" },
											],
										},
									},
								},
							},
						},
					},
				},
			],
		});
		expect(convertResponsesTools([tool])[0]).toMatchObject({ parameters: getJsonSchemaToolParameters(tool, false) });
		expect(parameters.properties.options.properties.kinds.anyOf[0].items).not.toHaveProperty("type");
	});

	it.each([
		{ values: ["text", "icon"], type: "string" },
		{ values: [1, 2.5], type: "number" },
		{ values: [true, false], type: "boolean" },
		{ values: [null], type: "null" },
	])("adds the redundant $type type for a homogeneous enum without mutating it", ({ values, type }) => {
		const schema = { type: "object", properties: { choice: { enum: values } } };
		const converted = getJsonSchemaToolParameters({ ...tool, parameters: schema }, false);
		expect(converted).toMatchObject({ properties: { choice: { enum: values, type } } });
		expect(schema.properties.choice).not.toHaveProperty("type");
		expect(makeStrictJsonSchema(schema)).toMatchObject({
			properties: {
				choice: type === "null" ? { enum: values, type } : { anyOf: [{ enum: values, type }, { type: "null" }] },
			},
		});
	});

	it("preserves explicit types, mixed/empty/structured enums, and instance data", () => {
		const instance = { enum: ["literal"], properties: { choice: { enum: ["literal"] } } };
		const schema = {
			type: "object",
			properties: {
				explicit: { type: "integer", enum: [1, 2] },
				mixed: { enum: ["text", null] },
				empty: { enum: [] },
				structured: { enum: [instance] },
				array: { enum: [["text"]] },
			},
			default: instance,
			examples: [instance],
		} as Tool["parameters"];
		expect(getJsonSchemaToolParameters({ ...tool, parameters: schema }, undefined)).toBe(schema);
	});

	it("normalizes schema branches and definitions without rewriting references or data", () => {
		const literal = { enum: ["data"] };
		const schema = {
			anyOf: [{ type: "object", properties: { value: { enum: ["a"] } } }],
			$defs: { item: { enum: ["b"] } },
			definitions: { oldItem: { enum: ["c"] } },
			properties: { reference: { $ref: "#/$defs/item" } },
			additionalProperties: { enum: ["d"] },
			default: literal,
		} as Tool["parameters"];
		const converted = getJsonSchemaToolParameters({ ...tool, parameters: schema }, false);
		expect(converted).toMatchObject({
			type: "object",
			anyOf: [{ properties: { value: { enum: ["a"], type: "string" } } }],
			$defs: { item: { enum: ["b"], type: "string" } },
			definitions: { oldItem: { enum: ["c"], type: "string" } },
			properties: { reference: { $ref: "#/$defs/item" } },
			additionalProperties: { enum: ["d"], type: "string" },
			default: literal,
		});
		expect((converted as Record<string, unknown>).default).toBe(literal);
		expect(getJsonSchemaToolParameters({ ...tool, parameters: converted }, false)).toBe(converted);
	});
});
