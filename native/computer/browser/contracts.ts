import { Buffer } from "node:buffer";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ControlledComputerInputSchema, parseControlledComputerInput } from "../controlled/contracts.ts";

export const ControlledBrowserInputSchema = Type.Object(
	{
		request: Type.Union([
			ControlledComputerInputSchema.properties.request,
			Type.Object({ op: StringEnum(["prepare"] as const) }, { additionalProperties: false }),
			Type.Object(
				{ op: StringEnum(["navigate"] as const), url: Type.String({ minLength: 1, maxLength: 2048 }) },
				{ additionalProperties: false },
			),
		]),
	},
	{ additionalProperties: false },
);
export type ControlledBrowserInput = Static<typeof ControlledBrowserInputSchema>;

export function parseControlledBrowserInput(input: unknown): ControlledBrowserInput {
	if (!Value.Check(ControlledBrowserInputSchema, input)) throw new Error("Invalid browser computer request");
	if (input.request.op === "observe" || input.request.op === "execute" || input.request.op === "click") {
		return parseControlledComputerInput(input);
	}
	if (input.request.op === "navigate") {
		if (Buffer.byteLength(input.request.url, "utf8") > 2048) throw new Error("Invalid browser URL");
		let url: URL;
		try {
			url = new URL(input.request.url);
		} catch {
			throw new Error("Invalid browser URL");
		}
		if (
			!(url.protocol === "http:" || url.protocol === "https:" || input.request.url === "about:blank") ||
			url.username ||
			url.password
		) {
			throw new Error("Invalid browser URL");
		}
	}
	return structuredClone(input);
}
