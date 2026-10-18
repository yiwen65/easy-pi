import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { planImageBudget, resolveImagePolicy, validateImageLimits } from "../src/core/images/policy.ts";
import { IMAGE_LIMITS, ImageInputError } from "../src/core/images/types.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "vision-test",
		name: "Vision test",
		api: "openai-responses",
		provider: "test",
		baseUrl: "https://provider.test/v1",
		input: ["text", "image"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1000,
		...overrides,
	};
}

// Budget planning intentionally does not decode or validate these synthetic Base64-sized payloads.
function image(bytes = 4): ImageContent {
	return { type: "image", data: "A".repeat(bytes), mimeType: "image/png" };
}

function user(timestamp: number, ...images: ImageContent[]): UserMessage {
	return { role: "user", timestamp, content: [{ type: "text", text: `user ${timestamp}` }, ...images] };
}

function tool(timestamp: number, ...images: ImageContent[]): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		timestamp,
		toolCallId: `call-${timestamp}`,
		toolName: "screenshot",
		content: [{ type: "text", text: "Tool execution facts" }, ...images],
		isError: false,
		details: { capture: timestamp },
	};
}

function assistant(timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		timestamp,
		content: [{ type: "thinking", thinking: "", thinkingSignature: "opaque-signed-fact", redacted: true }],
		api: "openai-responses",
		provider: "test",
		model: "vision-test",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function budgetError(run: () => unknown): ImageInputError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ImageInputError);
		expect((error as ImageInputError).code).toBe("image_budget");
		return error as ImageInputError;
	}
	throw new Error("Expected an image budget failure");
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

describe("resolveImagePolicy", () => {
	it("uses explicit model capability and documented engineering defaults without guessing names", () => {
		const policy = resolveImagePolicy(model());
		expect(policy).toMatchObject({ ...IMAGE_LIMITS, mode: "balanced", blocked: false, vision: true });
		expect(policy.provenance.map((entry) => entry.source)).toEqual(["engineering", "model-input"]);
		expect(resolveImagePolicy(model({ id: "gpt-vision-latest", input: ["text"] })).vision).toBe(false);
		expect(resolveImagePolicy(undefined).vision).toBe(false);
	});

	it("original mode removes the balanced 2000px preference, not resource or byte protection", () => {
		const policy = resolveImagePolicy(model(), { autoResizeImages: false });
		expect(policy.mode).toBe("original");
		expect(policy.maxWidth).toBe(IMAGE_LIMITS.maxInputPixels);
		expect(policy.maxHeight).toBe(IMAGE_LIMITS.maxInputPixels);
		expect(policy.maxEncodedBytes).toBe(IMAGE_LIMITS.maxEncodedBytes);
		expect(policy.maxInputBytes).toBe(IMAGE_LIMITS.maxInputBytes);
		expect(resolveImagePolicy(model(), { autoResizeImages: false, limits: { maxInputPixels: 3000 } }).maxWidth).toBe(
			3000,
		);
	});

	it("only tightens engineering caps, including explicit false and per-route constraints", () => {
		const policy = resolveImagePolicy(model(), {
			blockImages: false,
			limits: { maxImages: 12, maxInputBytes: Number.MAX_SAFE_INTEGER },
			providerOverrides: [
				{
					api: "openai-responses",
					baseUrl: "https://provider.test/v1/",
					limits: { maxImages: 8 },
					source: "operator",
				},
				{
					api: "openai-responses",
					baseUrl: "https://provider.test/v1",
					limits: { maxEncodedBytes: 1024 },
					source: "provider-contract",
				},
			],
		});
		expect(policy).toMatchObject({
			blocked: false,
			maxImages: 8,
			maxEncodedBytes: 1024,
			maxInputBytes: IMAGE_LIMITS.maxInputBytes,
		});
		expect(policy.provenance).toContainEqual({ source: "settings", fields: ["maxImages", "maxInputBytes"] });
		expect(policy.provenance).toContainEqual({ source: "provider-contract", fields: ["maxEncodedBytes"] });
	});

	it("does not apply provider constraints after endpoint or API rerouting", () => {
		const options = {
			providerOverrides: [
				{
					api: "openai-responses",
					baseUrl: "https://provider.test/v1",
					limits: { maxImages: 2 },
					source: "operator" as const,
				},
			],
		};
		const direct = resolveImagePolicy(model(), options);
		const gateway = resolveImagePolicy(model({ baseUrl: "https://gateway.test/v1" }), options);
		const otherApi = resolveImagePolicy(model({ api: "openai-completions" }), options);
		expect(direct.maxImages).toBe(2);
		expect(gateway.maxImages).toBe(IMAGE_LIMITS.maxImages);
		expect(otherApi.maxImages).toBe(IMAGE_LIMITS.maxImages);
		expect(gateway.fingerprint).not.toBe(direct.fingerprint);
		expect(otherApi.fingerprint).not.toBe(direct.fingerprint);
	});

	it("fingerprints complete effective policy and sanitized endpoint without leaking credential material", () => {
		const first = resolveImagePolicy(
			model({ baseUrl: "https://name:password@provider.test/v1/?api_key=secret#fragment" }),
		);
		const second = resolveImagePolicy(model({ baseUrl: "https://other:new@provider.test/v1?api_key=changed" }));
		expect(first.fingerprint).toBe(second.fingerprint);
		expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(first)).not.toMatch(/password|secret|api_key|fragment|provider\.test/);
		for (const changed of [
			resolveImagePolicy(model({ baseUrl: "https://provider.test/v2" })),
			resolveImagePolicy(model({ id: "other" })),
			resolveImagePolicy(model({ input: ["text"] })),
			resolveImagePolicy(model(), { autoResizeImages: false }),
			resolveImagePolicy(model(), { blockImages: true }),
			resolveImagePolicy(model(), { limits: { maxImages: 1 } }),
		]) {
			expect(changed.fingerprint).not.toBe(first.fingerprint);
		}
		expect(resolveImagePolicy(model({ baseUrl: "opaque-a" })).fingerprint).not.toBe(
			resolveImagePolicy(model({ baseUrl: "opaque-b" })).fingerprint,
		);
	});

	it("is deterministic when equivalent override and settings key order changes", () => {
		const a = {
			api: "openai-responses",
			baseUrl: "https://provider.test/v1",
			limits: { maxImages: 2 },
			source: "operator" as const,
		};
		const b = { ...a, limits: { maxEncodedBytes: 1024 } };
		expect(
			resolveImagePolicy(model(), { limits: { maxImages: 10, maxWidth: 1000 }, providerOverrides: [a, b] }),
		).toEqual(resolveImagePolicy(model(), { limits: { maxWidth: 1000, maxImages: 10 }, providerOverrides: [b, a] }));
	});

	it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "32", null])(
		"rejects invalid numeric limits: %s",
		(value) => {
			expect(() => validateImageLimits({ maxImages: value })).toThrow("positive safe integer");
		},
	);

	it("rejects invalid shapes and unknown limit keys without echoing input values", () => {
		for (const limits of [null, [], "secret-value", { "private-path-secret": 12 }]) {
			expect(() => validateImageLimits(limits)).toThrow("Invalid images.limits");
		}
		expect(() => resolveImagePolicy(model(), { limits: { maxImages: 0 } })).toThrow();
		expect(validateImageLimits({ maxImages: undefined, maxInputBytes: 10 })).toEqual({ maxInputBytes: 10 });
	});
});

describe("SettingsManager image policy options", () => {
	it("preserves existing booleans and returns detached, validated limits", () => {
		const manager = SettingsManager.inMemory({
			images: { autoResize: false, blockImages: true, limits: { maxImages: 3 } },
		});
		const options = manager.getImagePolicyOptions();
		expect(options).toEqual({ autoResizeImages: false, blockImages: true, limits: { maxImages: 3 } });
		options.limits.maxImages = 1;
		expect(manager.getImagePolicyOptions().limits.maxImages).toBe(3);
		expect(manager.getImageAutoResize()).toBe(false);
		expect(manager.getBlockImages()).toBe(true);
		expect(SettingsManager.inMemory().getImagePolicyOptions()).toEqual({
			autoResizeImages: true,
			blockImages: false,
			limits: {},
		});
	});

	it("validates JSON-loaded values and merges limits using existing project precedence", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ images: { autoResize: false, limits: { maxImages: 5, maxWidth: 500 } } }),
		);
		storage.withLock("project", () => JSON.stringify({ images: { limits: { maxImages: 2 } } }));
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getImagePolicyOptions()).toEqual({
			autoResizeImages: false,
			blockImages: false,
			limits: { maxImages: 2, maxWidth: 500 },
		});
		manager.applyOverrides({ images: { limits: { maxImages: -1 } } });
		expect(() => manager.getImagePolicyOptions()).toThrow("images.limits.maxImages");
	});
});

describe("planImageBudget", () => {
	it("retains a fitting context by reference and reports all stable input IDs without decoding", () => {
		const context: Context = {
			systemPrompt: "fixed prefix",
			messages: [user(1, image()), assistant(2), tool(3, image())],
		};
		const result = planImageBudget(context, resolveImagePolicy(model()));
		expect(result.context).toBe(context);
		expect(result.decisions).toHaveLength(2);
		expect(result.decisions.every((decision) => decision.stage === "accepted" && decision.encodedBytes === 4)).toBe(
			true,
		);
		expect(result).toEqual(planImageBudget(context, resolveImagePolicy(model())));
		expect(result.decisions.map((decision) => decision.imageId)).toEqual(
			planImageBudget(
				{
					...context,
					messages: [{ role: "user", content: "older unrelated message", timestamp: 0 }, ...context.messages],
				},
				resolveImagePolicy(model()),
			).decisions.map((decision) => decision.imageId),
		);
	});

	it.each([
		{ blockImages: true, nonVision: false },
		{ blockImages: false, nonVision: true },
	])("projects disabled/nonvision images to stable notes: %s", (options) => {
		const context: Context = deepFreeze({ messages: [user(1, image()), tool(2, image())] });
		const policy = resolveImagePolicy(model({ input: options.nonVision ? ["text"] : ["text", "image"] }), options);
		const result = planImageBudget(context, policy);
		expect(result.decisions.map((decision) => decision.stage)).toEqual(["omitted", "omitted"]);
		expect(
			result.context.messages.every(
				(message) =>
					typeof message.content === "string" || message.content.every((content) => content.type !== "image"),
			),
		).toBe(true);
		expect(result.context.messages[0].content).toEqual([
			{ type: "text", text: "user 1" },
			{ type: "text", text: expect.stringContaining(result.decisions[0].imageId) },
		]);
		expect(result).toEqual(planImageBudget(context, policy));
		expect(context.messages[0].content).toHaveLength(2);
	});

	it("evicts oldest tool groups atomically when image count is exceeded, preserving latest group and user images", () => {
		const context: Context = {
			messages: [user(1, image()), tool(2, image()), tool(3, image()), assistant(4), tool(5, image())],
		};
		const result = planImageBudget(context, resolveImagePolicy(model(), { limits: { maxImages: 3 } }));
		expect(result.decisions.map((decision) => decision.stage)).toEqual([
			"accepted",
			"omitted",
			"omitted",
			"accepted",
		]);
		expect(result.decisions[1].reason).toContain("older tool image group");
		expect(result.decisions[1].code).toBe("image_budget");
		expect(result.context.messages[0]).toBe(context.messages[0]);
		expect(result.context.messages[3]).toBe(context.messages[3]);
		expect(result.context.messages[4]).toBe(context.messages[4]);
	});

	it("evicts old screenshots for Base64 bytes independently of count", () => {
		const context: Context = { messages: [user(1, image(4)), tool(2, image(12)), assistant(3), tool(4, image(8))] };
		const result = planImageBudget(context, resolveImagePolicy(model(), { limits: { maxRequestEncodedBytes: 12 } }));
		expect(result.decisions.map((decision) => decision.stage)).toEqual(["accepted", "omitted", "accepted"]);
	});

	it("retains image order, tool facts and opaque assistant metadata without mutating frozen canonical input", () => {
		const context: Context = deepFreeze({
			messages: [user(1, image()), tool(2, image(), image()), assistant(3), tool(4, image())],
		});
		const snapshot = structuredClone(context);
		const result = planImageBudget(context, resolveImagePolicy(model(), { limits: { maxImages: 2 } }));
		expect(context).toEqual(snapshot);
		expect(result.context.messages[1]).toMatchObject({
			toolCallId: "call-2",
			details: { capture: 2 },
			isError: false,
		});
		expect(result.context.messages[1].content[0]).toEqual({ type: "text", text: "Tool execution facts" });
		expect(result.context.messages[1].content[1]).toMatchObject({
			text: expect.stringContaining(result.decisions[1].imageId),
		});
		expect(result.context.messages[1].content[2]).toMatchObject({
			text: expect.stringContaining(result.decisions[2].imageId),
		});
		expect(result.context.messages[2]).toBe(context.messages[2]);
	});

	it("fails rather than silently omitting any user image or latest tool group", () => {
		const context: Context = { messages: [user(1, image()), user(2, image()), tool(3, image())] };
		const ids = planImageBudget(context, resolveImagePolicy(model())).decisions.map((decision) => decision.imageId);
		const error = budgetError(() =>
			planImageBudget(context, resolveImagePolicy(model(), { limits: { maxImages: 2 } })),
		);
		expect(error.imageIds).toEqual(ids);
		expect(error.message).toContain("Select historical image IDs");
		expect(error.message).not.toContain("provider.test");
	});

	it("protects the full current user and latest tool image groups even when neither group fits alone", () => {
		for (const context of [
			{ messages: [user(1, image(), image())] },
			{ messages: [tool(1, image()), tool(2, image())] },
		]) {
			const error = budgetError(() =>
				planImageBudget(context, resolveImagePolicy(model(), { limits: { maxImages: 1 } })),
			);
			expect(error.imageIds).toHaveLength(2);
		}
	});

	it("enforces per-image Base64 limits and can evict only unprotected oversized tools", () => {
		const policy = resolveImagePolicy(model(), { limits: { maxEncodedBytes: 8 } });
		const context: Context = { messages: [user(1, image()), tool(2, image(12)), assistant(3), tool(4, image())] };
		expect(planImageBudget(context, policy).decisions.map((decision) => decision.stage)).toEqual([
			"accepted",
			"omitted",
			"accepted",
		]);
		budgetError(() => planImageBudget({ messages: [user(1, image(12))] }, policy));
		budgetError(() => planImageBudget({ messages: [tool(1, image(12))] }, policy));
	});

	it("allows explicit historical user omissions to recover a failed budget without changing canonical history", () => {
		const context: Context = deepFreeze({ messages: [user(1, image()), user(2, image())] });
		const policy = resolveImagePolicy(model(), { limits: { maxImages: 1 } });
		const ids = budgetError(() => planImageBudget(context, policy)).imageIds;
		const result = planImageBudget(context, policy, { omitImageIds: [ids[0], "stale-unknown-id"] });
		expect(result.decisions.map((decision) => decision.stage)).toEqual(["omitted", "accepted"]);
		expect(result.decisions[0].reason).toContain("explicitly excluded");
		expect(result.context.messages[1]).toBe(context.messages[1]);
		expect(context.messages[0].content[1]).toMatchObject({ type: "image" });
		expect(
			planImageBudget(context, resolveImagePolicy(model())).decisions.every(
				(decision) => decision.stage === "accepted",
			),
		).toBe(true);
	});

	it("never lets explicit selection omit current user or latest tool images", () => {
		const context: Context = { messages: [user(1, image()), tool(2, image())] };
		const policy = resolveImagePolicy(model());
		for (const decision of planImageBudget(context, policy).decisions) {
			const error = budgetError(() => planImageBudget(context, policy, { omitImageIds: [decision.imageId] }));
			expect(error.imageIds).toEqual([decision.imageId]);
		}
	});

	it("releases prior-turn tool protection after a new user submission", () => {
		const context: Context = { messages: [user(1), tool(2, image(12)), assistant(3), user(4, image())] };
		const policy = resolveImagePolicy(model(), { limits: { maxRequestEncodedBytes: 8 } });
		const result = planImageBudget(context, policy);
		expect(result.decisions.map((decision) => decision.stage)).toEqual(["omitted", "accepted"]);
		const id = planImageBudget(context, resolveImagePolicy(model())).decisions[0].imageId;
		expect(planImageBudget(context, resolveImagePolicy(model()), { omitImageIds: [id] }).decisions[0].stage).toBe(
			"omitted",
		);
	});

	it("considers an earlier user image historical when the latest user message is text-only", () => {
		const context: Context = { messages: [user(1, image()), { role: "user", content: "next turn", timestamp: 2 }] };
		const policy = resolveImagePolicy(model());
		const imageId = planImageBudget(context, policy).decisions[0].imageId;
		expect(planImageBudget(context, policy, { omitImageIds: [imageId] }).decisions[0].stage).toBe("omitted");
	});

	it("does not count or rewrite assistant output images, including unexpected future image content", () => {
		const output = { ...assistant(2), content: [image(100)] as unknown as AssistantMessage["content"] };
		const context: Context = { messages: [user(1, image()), output] };
		const result = planImageBudget(
			context,
			resolveImagePolicy(model(), { limits: { maxImages: 1, maxRequestEncodedBytes: 4 } }),
		);
		expect(result.decisions).toHaveLength(1);
		expect(result.context.messages[1]).toBe(output);
		expect(planImageBudget(context, resolveImagePolicy(model(), { blockImages: true })).context.messages[1]).toBe(
			output,
		);
	});

	it("assigns distinct stable IDs to duplicate timestamps and identical image bytes", () => {
		const context: Context = { messages: [user(1, image(), image()), user(1, image())] };
		const result = planImageBudget(context, resolveImagePolicy(model()));
		expect(new Set(result.decisions.map((decision) => decision.imageId)).size).toBe(3);
		expect(result).toEqual(planImageBudget(structuredClone(context), resolveImagePolicy(model())));
	});
});
