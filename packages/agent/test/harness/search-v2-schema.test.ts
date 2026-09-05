import { validateToolArguments } from "@earendil-works/pi-ai/compat";
import { type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { makeStrictJsonSchema } from "../../../ai/src/api/constrained-sampling.ts";
import type { SearchCapabilities } from "../../src/harness/tools/search-provider.ts";
import { searchV2SchemaForCapabilities } from "../../src/harness/tools/search-v2.ts";

function expandEnums(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(expandEnums);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (record.type === "string" && Array.isArray(record.enum)) {
		const { type: _type, enum: values, ...rest } = record;
		return { anyOf: (values as string[]).map((entry) => Type.Literal(entry)), ...rest };
	}
	return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, expandEnums(nested)]));
}

const empty: SearchCapabilities = {
	textLiteral: false,
	textRegex: false,
	context: false,
	fuzzyFiles: false,
	glob: false,
	stableCursor: false,
	globalRanking: false,
};
const capabilities: SearchCapabilities[] = [
	empty,
	{ ...empty, glob: true },
	{ ...empty, fuzzyFiles: true, glob: true },
	{ ...empty, textLiteral: true },
	{ ...empty, textLiteral: true, textRegex: true, fuzzyFiles: true, glob: true, context: true, wordBoundary: true },
	{ ...empty, structuredModes: ["semantic_candidate"], taskRanking: true, scopeFilters: true },
	{
		...empty,
		textLiteral: true,
		textRegex: true,
		fuzzyFiles: true,
		glob: true,
		context: true,
		stableCursor: true,
		globalRanking: true,
		taskRanking: true,
		scopeFilters: true,
		wordBoundary: true,
		structuredModes: [
			"symbol_definition",
			"symbol_reference",
			"implementation",
			"assignment",
			"call",
			"string_literal",
			"comment",
			"semantic_candidate",
		],
	},
];

describe("compact Search finite domains", () => {
	it("retains strict-sampling conversion and nullable optional selectors", () => {
		const schema = searchV2SchemaForCapabilities(capabilities[capabilities.length - 1]);
		const strict = makeStrictJsonSchema(schema);
		const previous = makeStrictJsonSchema(expandEnums(schema) as TSchema);
		expect(strict.required).toEqual(previous.required);
		expect(strict.additionalProperties).toBe(false);
		const currentValidator = Compile(strict as TSchema);
		const previousValidator = Compile(previous as TSchema);
		const optionalNulls = Object.fromEntries(
			Object.keys(schema.properties).map((key) => [key, key === "query" ? "test" : null]),
		);
		for (const kind of [null, "text", "files", "glob", "invalid", 1, true, {}]) {
			const input = { ...optionalNulls, kind };
			expect(currentValidator.Check(input)).toBe(previousValidator.Check(input));
		}
		expect(currentValidator.Check(optionalNulls)).toBe(true);
	});
	for (const [index, available] of capabilities.entries())
		it(`preserves capability set ${index} and argument normalization while removing repeated schema syntax`, () => {
			const schema = searchV2SchemaForCapabilities(available);
			const previousRepresentation = expandEnums(schema) as TSchema;
			const current = Compile(schema);
			const previous = Compile(previousRepresentation);
			const keys = ["kind", "mode", "targetKind", "queryTemplate", "ranking"] as const;
			let compacted = 0;
			for (const key of keys) {
				const property = schema.properties[key] as { enum?: unknown[]; const?: unknown } | undefined;
				if (!property) continue;
				const values = Array.isArray(property.enum)
					? property.enum
					: property.const === undefined
						? []
						: [property.const];
				if (Array.isArray(property.enum)) compacted += 1;
				for (const value of [...values, undefined, null, true, 1, "invalid", "", [], {}]) {
					const args = {
						query: "test",
						kind:
							available.textLiteral || available.textRegex || available.structuredModes?.length
								? "text"
								: available.fuzzyFiles
									? "files"
									: "glob",
						[key]: value,
					};
					expect(current.Check(args), `${key}=${JSON.stringify(value)}`).toBe(previous.Check(args));
					const normalize = (parameters: TSchema) => {
						try {
							return {
								accepted: true,
								value: validateToolArguments(
									{ name: "search", description: "search", parameters },
									{ type: "toolCall", id: "test", name: "search", arguments: args },
								) as unknown,
							};
						} catch {
							return { accepted: false };
						}
					};
					expect(normalize(schema)).toEqual(normalize(previousRepresentation));
				}
			}
			const bytes = Buffer.byteLength(JSON.stringify(schema));
			const previousBytes = Buffer.byteLength(JSON.stringify(previousRepresentation));
			if (compacted) expect(bytes).toBeLessThan(previousBytes);
			else expect(bytes).toBe(previousBytes);
		});
});
