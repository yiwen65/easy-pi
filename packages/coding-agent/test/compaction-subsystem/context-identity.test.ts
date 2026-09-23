import type { Message, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	firstProviderContextDifference,
	identifyProviderContext,
	type ProviderContextIdentityInput,
	preservesProviderContextPrefix,
} from "../../src/core/compaction/subsystem/context-identity.ts";
import * as hashing from "../../src/core/compaction/subsystem/hashing.ts";

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

// Frozen pre-optimization logical view: runtime fields are intentionally absent.
function originalView(input: ProviderContextIdentityInput, count = input.messages.length) {
	return {
		model: input.model,
		systemPrompt: input.systemPrompt,
		messages: input.messages.slice(0, count).map((message) => {
			if (message.role === "user") return { role: message.role, content: message.content };
			if (message.role === "assistant") {
				return {
					role: message.role,
					content: message.content,
					responseId: message.responseId,
					deferred: message.deferred,
				};
			}
			return {
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content,
				addedToolNames: message.addedToolNames,
				isError: message.isError,
			};
		}),
		tools: (input.tools ?? []).map(({ name, description, parameters, constrainedSampling }) => ({
			name,
			description,
			parameters,
			constrainedSampling,
		})),
	};
}

function imageContext(): ProviderContextIdentityInput {
	return {
		model: { provider: "fixture", model: "vision", api: "openai-responses" },
		systemPrompt: "Unicode — 中文🦀",
		messages: [
			user("look"),
			{
				role: "assistant",
				api: "openai-responses",
				provider: "fixture",
				model: "vision",
				responseId: "response-1",
				deferred: { provider: "fixture", modelId: "vision", api: "openai-responses", id: "opaque-1" },
				content: [{ type: "thinking", thinking: "", thinkingSignature: "opaque-signature", redacted: true }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "capture",
				toolName: "computer",
				content: [{ type: "image", mimeType: "image/png", data: "abcd".repeat(20_000) }],
				addedToolNames: ["computer"],
				isError: false,
				timestamp: 2,
			},
		],
		tools: [tool("computer"), tool("read")],
	};
}

describe("image-history identity allocation", () => {
	afterEach(() => vi.restoreAllMocks());

	it("hashes a full historical prefix only once", () => {
		const input = imageContext();
		const serialize = vi.spyOn(hashing, "canonicalJson");
		for (const historicalMessageCount of [undefined, input.messages.length, Infinity]) {
			serialize.mockClear();
			const identity = identifyProviderContext({ ...input, historicalMessageCount });
			expect(identity.historicalPrefixHash).toBe(identity.fullHash);
			expect(serialize).toHaveBeenCalledTimes(1);
		}
	});

	it("compares one message at a time instead of serializing two complete histories", () => {
		const previous = imageContext();
		const next = structuredClone(previous);
		next.messages = [...next.messages, user("continue")];
		const serialize = vi.spyOn(hashing, "canonicalJson");
		expect(preservesProviderContextPrefix(previous, next)).toBe(true);
		for (const [value] of serialize.mock.calls) {
			if (Array.isArray(value)) expect(value.length).toBeLessThanOrEqual(1);
			else expect((value as { messages: unknown[] }).messages).toHaveLength(0);
		}
	});

	it("keeps the original hash bytes and historical-boundary semantics", () => {
		const input = imageContext();
		for (const historicalMessageCount of [undefined, -1, 0, 0.5, 1, 1.5, 3, 99, Infinity, NaN]) {
			const count = Math.max(0, Math.min(input.messages.length, historicalMessageCount ?? input.messages.length));
			expect(identifyProviderContext({ ...input, historicalMessageCount })).toEqual({
				fullHash: hashing.sha256Hex(hashing.canonicalJson(originalView(input))),
				historicalPrefixHash: hashing.sha256Hex(hashing.canonicalJson(originalView(input, count))),
				messageCount: input.messages.length,
				historicalMessageCount: count,
			});
		}
	});

	it("preserves prefix decisions for images, opaque signatures, model and tool changes", () => {
		const previous = imageContext();
		const serialized = hashing.canonicalJson(previous);
		const changed = [
			structuredClone(previous),
			{ ...previous, messages: [...previous.messages, user("appended")] },
			{ ...previous, messages: previous.messages.slice(1) },
			{ ...previous, tools: previous.tools?.slice().reverse() },
			...[
				["image/png", "image/jpeg"],
				["abcdabcd", "changed!"],
				["opaque-signature", "different-signature"],
				["opaque-1", "opaque-2"],
				["response-1", "response-2"],
				["Unicode", "Changed"],
				["vision", "another-model"],
				['"isError":false', '"isError":true'],
				['"addedToolNames":["computer"]', '"addedToolNames":[]'],
			].map(([from, to]) => JSON.parse(serialized.replace(from!, to!)) as ProviderContextIdentityInput),
		];
		for (const next of changed) {
			const expected =
				next.messages.length >= previous.messages.length &&
				hashing.canonicalJson(originalView(previous)) ===
					hashing.canonicalJson(originalView(next, previous.messages.length));
			expect(preservesProviderContextPrefix(previous, next)).toBe(expected);
		}
	});

	it("does not skip a sparse historical slot that has acquired a message", () => {
		const messages = new Array<Message>(2);
		messages[1] = user("same");
		const previous = { messages };
		expect(preservesProviderContextPrefix(previous, { messages: messages.slice() })).toBe(true);
		expect(preservesProviderContextPrefix(previous, { messages: [user("inserted"), user("same")] })).toBe(false);
	});

	it("keeps empty-prefix metadata comparisons and undefined-field normalization", () => {
		expect(preservesProviderContextPrefix({ messages: [] }, { messages: [user("new")] })).toBe(true);
		expect(preservesProviderContextPrefix({ messages: [] }, { messages: [], systemPrompt: "new" })).toBe(false);
		expect(preservesProviderContextPrefix({ messages: [] }, { messages: [], tools: [] })).toBe(true);
		expect(identifyProviderContext({ messages: [] })).toEqual(
			identifyProviderContext({ messages: [], systemPrompt: undefined, tools: [] }),
		);
	});
});
