import type { Message, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	firstProviderContextDifference,
	identifyProviderContext,
	preservesProviderContextPrefix,
} from "../../src/core/compaction/subsystem/context-identity.ts";

const user = (text: string, timestamp = 1): Message => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});

const tool = (name: string): Tool => ({
	name,
	description: `${name} tool`,
	parameters: Type.Object({ path: Type.String() }),
});

describe("provider context identity", () => {
	it("ignores runtime-only timestamps while hashing provider-visible content", () => {
		const first = identifyProviderContext({ systemPrompt: "SYSTEM", messages: [user("hello", 1)] });
		const second = identifyProviderContext({ systemPrompt: "SYSTEM", messages: [user("hello", 999)] });

		expect(second.fullHash).toBe(first.fullHash);
		expect(
			firstProviderContextDifference(
				{ systemPrompt: "SYSTEM", messages: [user("hello", 1)] },
				{ systemPrompt: "SYSTEM", messages: [user("hello", 999)] },
			),
		).toBeUndefined();
	});

	it("treats a normal message append as prefix-preserving", () => {
		const previous = { systemPrompt: "SYSTEM", messages: [user("one")] };
		const next = { systemPrompt: "SYSTEM", messages: [user("one", 2), user("two", 3)] };

		expect(preservesProviderContextPrefix(previous, next)).toBe(true);
		expect(identifyProviderContext({ ...next, historicalMessageCount: 1 }).historicalPrefixHash).toBe(
			identifyProviderContext(previous).fullHash,
		);
	});

	it("detects historical rewrites and reports the first logical path", () => {
		const previous = { systemPrompt: "SYSTEM", messages: [user("one"), user("two")] };
		const rewritten = { systemPrompt: "SYSTEM", messages: [user("changed"), user("two")] };

		expect(preservesProviderContextPrefix(previous, rewritten)).toBe(false);
		expect(firstProviderContextDifference(previous, rewritten)).toBe("$.messages[0].content[0].text");
	});

	it("preserves tool order because schema order is cache-visible", () => {
		const first = { systemPrompt: "SYSTEM", messages: [user("go")], tools: [tool("read"), tool("write")] };
		const reordered = { ...first, tools: [tool("write"), tool("read")] };

		expect(identifyProviderContext(first).fullHash).not.toBe(identifyProviderContext(reordered).fullHash);
		expect(firstProviderContextDifference(first, reordered)).toBe("$.tools[0].description");
	});
});
