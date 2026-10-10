import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { getJsonSchemaToolParameters } from "../src/api/constrained-sampling.ts";
import { streamSimple } from "../src/api/openai-completions.ts";
import { convertResponsesTools } from "../src/api/openai-responses-shared.ts";
import type { Model, Tool } from "../src/types.ts";

vi.mock("openai", () => ({
	default: class {
		chat = {
			completions: {
				create: () => {
					const data = {
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: {}, finish_reason: "stop" }] };
						},
					};
					return { withResponse: async () => ({ data, response: { status: 200, headers: new Headers() } }) };
				},
			},
		};
	},
}));

const model: Model<"openai-completions"> = {
	id: "qd/kmodel_latest",
	name: "Router fixture",
	api: "openai-completions",
	provider: "custom",
	baseUrl: "http://localhost:20128/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

// Same top-level union shape as the built-in wait_agent tool.
const parameters = Type.Union([
	Type.Object({ timeout_ms: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
	Type.Object(
		{ target: Type.String(), turn_id: Type.Optional(Type.String()), timeout_ms: Type.Optional(Type.Integer()) },
		{ additionalProperties: false },
	),
]);
const tool: Tool = { name: "wait_agent", description: "Wait for mail or a child", parameters };

describe("OpenAI object-union tool parameters", () => {
	it("sends an explicit root object type through Chat Completions", async () => {
		let payload: unknown;
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }], tools: [tool] },
			{
				apiKey: "test",
				onPayload: (value) => {
					payload = value;
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(payload).toMatchObject({
			tools: [{ function: { parameters: { type: "object", anyOf: parameters.anyOf } } }],
		});
	});

	it("preserves union constraints and leaves the original schema unchanged", () => {
		const converted = getJsonSchemaToolParameters(tool, false);
		expect(converted).toMatchObject({ type: "object", anyOf: parameters.anyOf });
		expect(parameters).not.toHaveProperty("type");
		for (const input of [{}, { target: "worker", turn_id: "turn" }, { turn_id: "turn" }, { unexpected: true }, []]) {
			expect(Value.Check(converted, input)).toBe(Value.Check(parameters, input));
		}
		expect(convertResponsesTools([tool])[0]).toMatchObject({ parameters: converted, strict: false });
	});

	it("does not constrain mixed or empty unions or change existing object schemas", () => {
		for (const schema of [
			Type.Union([Type.Object({}), Type.String()]),
			Type.Union([Type.Object({}), Type.Null()]),
			{ anyOf: [] } as Tool["parameters"],
			Type.Object({ value: Type.String() }),
		]) {
			expect(getJsonSchemaToolParameters({ ...tool, parameters: schema }, undefined)).toBe(schema);
		}
	});

	it("keeps strict union rejection and normalizes the non-strict fallback", () => {
		expect(() => getJsonSchemaToolParameters(tool, true)).toThrow("object and array unions are unsupported");
		expect(
			convertResponsesTools([{ ...tool, constrainedSampling: { type: "json_schema", strict: "prefer" } }])[0],
		).toMatchObject({ strict: false, parameters: { type: "object", anyOf: parameters.anyOf } });
	});
});
