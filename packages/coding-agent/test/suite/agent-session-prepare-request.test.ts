import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
	};
}

describe("AgentSession request preparation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("refreshes model, tools and thinking after first and queued input persistence", async () => {
		const harness = await createHarness({
			models: [
				{ id: "initial", reasoning: true },
				{ id: "selected", reasoning: true },
			],
			tools: [tool("old"), tool("selected")],
			initialActiveToolNames: ["old"],
			settings: { compaction: { enabled: false } },
			prepareRequest: ({ context, model, thinkingLevel }) => {
				expect(model.id).toBe("selected");
				expect(context.tools?.map((entry) => entry.name)).toEqual(["selected"]);
				const lastUser = context.messages.filter((entry) => entry.role === "user").at(-1);
				expect(thinkingLevel).toBe(getMessageText(lastUser) === "first" ? "high" : "off");
			},
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event, ctx) => {
						if (event.message.role !== "user") return;
						const selected = ctx.modelRegistry.find(ctx.model!.provider, "selected");
						if (!selected) throw new Error("Missing selected faux model");
						await pi.setModel(selected);
						pi.setActiveTools(["selected"]);
						pi.setThinkingLevel(getMessageText(event.message) === "first" ? "high" : "off");
					});
				},
			],
		});
		harnesses.push(harness);
		const requests: string[] = [];
		harness.setResponses([
			(context, options, _state, model) => {
				requests.push(model.id);
				expect(context.tools?.map((entry) => entry.name)).toEqual(["selected"]);
				expect(options?.reasoning).toBe("high");
				expect(context.messages.filter((entry) => entry.role === "user").map(getMessageText)).toEqual(["first"]);
				expect(
					harness.sessionManager
						.buildSessionContext()
						.messages.filter((entry) => entry.role === "user")
						.map(getMessageText),
				).toEqual(["first"]);
				return fauxAssistantMessage("first response");
			},
			(context, options, _state, model) => {
				requests.push(model.id);
				expect(context.tools?.map((entry) => entry.name)).toEqual(["selected"]);
				expect(options?.reasoning).toBeUndefined();
				expect(context.messages.filter((entry) => entry.role === "user").map(getMessageText)).toEqual([
					"first",
					"queued",
				]);
				return fauxAssistantMessage("queued response");
			},
		]);
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				getMessageText(event.message) === "first response"
			) {
				void harness.session.followUp("queued");
			}
		});
		await harness.session.prompt("first");
		expect(requests).toEqual(["selected", "selected"]);
		expect(harness.session.messages.filter((entry) => entry.role === "user").map(getMessageText)).toEqual([
			"first",
			"queued",
		]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("uses live persisted messages added by an awaited input listener before step binding", async () => {
		const harness = await createHarness({ tools: [], settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		harness.session.agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "user") {
				await harness.session.sendCustomMessage(
					{ customType: "input-receipt", content: "persisted receipt", display: false },
					{ triggerTurn: false },
				);
			}
		});
		let observed = "";
		harness.setResponses([
			(context) => {
				observed = JSON.stringify(context.messages);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("first");
		expect(observed).toContain("persisted receipt");
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "input-receipt"),
		).toHaveLength(1);
	});

	it("drops inherited cache routing with an input-boundary model switch while retaining native identity", async () => {
		const harness = await createHarness({
			models: [{ id: "initial" }, { id: "selected" }],
			tools: [],
			settings: { compaction: { enabled: false }, transport: "websocket" },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event, ctx) => {
						if (event.message.role !== "user") return;
						const selected = ctx.modelRegistry.find(ctx.model!.provider, "selected");
						if (!selected) throw new Error("Missing selected faux model");
						await pi.setModel(selected);
					});
				},
			],
		});
		harnesses.push(harness);
		const nativeIdentity = harness.session.sessionId;
		harness.session.agent.sessionId = nativeIdentity;
		harness.session.agent.promptCacheKey = "inherited-logical-prefix";
		harness.session.agent.cacheAffinityId = "inherited-ancestor";
		harness.session.agent.transport = "sse";
		const requests: Array<{ modelId: string; options?: SimpleStreamOptions }> = [];
		harness.setResponses([
			(context, options, _state, model) => {
				requests.push({ modelId: model.id, options });
				expect(context.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
					"switch",
				]);
				return fauxAssistantMessage("switched");
			},
		]);
		await harness.session.prompt("switch");
		expect(harness.session.agent.cacheAffinityId).toBeUndefined();
		expect(harness.session.agent.promptCacheKey).toBeUndefined();
		expect(requests).toHaveLength(1);
		expect(requests[0].modelId).toBe("selected");
		expect(requests[0].options?.cacheAffinityId).toBeUndefined();
		expect(requests[0].options?.promptCacheKey).toBeUndefined();
		expect(requests[0].options?.transport).toBe("websocket");
		expect(requests[0].options?.sessionId).toBe(nativeIdentity);
		expect(harness.session.sessionId).toBe(nativeIdentity);
	});

	it("adds late durable receipts to owned next-turn context without resurrecting omitted entries or leaking markers", async () => {
		let preparedTurns = 0;
		const marker = "owned request-only marker";
		const receipt = "same receipt payload";
		const harness = await createHarness({
			tools: [tool("echo")],
			settings: { compaction: { enabled: false } },
			prepareNextTurnWithContext: ({ context }) => {
				if (++preparedTurns !== 1) return { context };
				return {
					context: {
						...context,
						messages: [
							...context.messages.filter(
								(message) =>
									!(message.role === "user" && getMessageText(message) === "omitted older input") &&
									!(message.role === "custom" && message.customType === "input-receipt"),
							),
							{ role: "user", content: marker, timestamp: Date.now() },
						],
					},
				};
			},
		});
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{ customType: "input-receipt", content: receipt, display: false },
			{ triggerTurn: false },
		);
		harness.session.agent.subscribe(async (event) => {
			if (event.type !== "message_end") return;
			if (event.message.role === "assistant" && getMessageText(event.message) === "queue trigger") {
				await harness.session.followUp("queued input");
				await harness.session.sendCustomMessage(
					{ customType: "queued-context", content: "selected custom input", display: false },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			}
			if (event.message.role === "user" && getMessageText(event.message) === "queued input") {
				await harness.session.sendCustomMessage(
					{ customType: "input-receipt", content: receipt, display: false },
					{ triggerTurn: false },
				);
			}
		});
		const transform = harness.session.agent.transformContext;
		let noticeInjected = false;
		harness.session.agent.transformContext = async (messages, signal) => {
			const transformed = transform ? await transform(messages, signal) : messages;
			if (!noticeInjected && transformed.some((message) => getMessageText(message) === marker)) {
				noticeInjected = true;
				await harness.session.sendCustomMessage(
					{ customType: "request-notice", content: "late transform notice", display: false },
					{ triggerTurn: false },
				);
				const notice = harness.session.agent.state.messages.at(-1);
				if (!notice) throw new Error("Missing persisted transform notice");
				return [...transformed, notice];
			}
			return transformed;
		};
		let queuedRequest: Context | undefined;
		let customRequest: Context | undefined;
		let separateRequest: Context | undefined;
		harness.setResponses([
			fauxAssistantMessage("seed response"),
			fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("queue trigger"),
			(context) => {
				queuedRequest = context;
				return fauxAssistantMessage("queued response");
			},
			(context) => {
				customRequest = context;
				return fauxAssistantMessage("custom response");
			},
			(context) => {
				separateRequest = context;
				return fauxAssistantMessage("fresh response");
			},
		]);
		await harness.session.prompt("omitted older input");
		await harness.session.prompt("start tool turn");
		const queuedTexts = queuedRequest?.messages.map(getMessageText) ?? [];
		expect(queuedTexts).toContain(marker);
		expect(queuedTexts).toContain("queued input");
		expect(queuedTexts).not.toContain("omitted older input");
		expect(queuedTexts.filter((text) => text === receipt || text.includes(receipt))).toHaveLength(1);
		expect(queuedTexts.filter((text) => text === "queued input")).toHaveLength(1);
		expect(queuedTexts.filter((text) => text === marker)).toHaveLength(1);
		const noticeIndex = queuedTexts.findIndex((text) => text.includes("late transform notice"));
		expect(noticeIndex).toBeGreaterThan(queuedTexts.indexOf(marker));
		expect(noticeIndex).toBeLessThan(queuedTexts.indexOf("queue trigger"));
		const customTexts = customRequest?.messages.map(getMessageText) ?? [];
		expect(customTexts.filter((text) => text.includes("selected custom input"))).toHaveLength(1);
		expect(customTexts.filter((text) => text.includes(receipt))).toHaveLength(1);
		expect(customTexts.filter((text) => text.includes("late transform notice"))).toHaveLength(1);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "input-receipt"),
		).toHaveLength(2);
		await harness.session.prompt("separate run");
		expect(JSON.stringify(separateRequest?.messages)).not.toContain(marker);
		expect(JSON.stringify(separateRequest?.messages)).toContain("omitted older input");
		expect(harness.faux.state.callCount).toBe(6);
	});

	it("lets a later branch checkpoint replace owned context without restoring its old messages", async () => {
		let preparedTurns = 0;
		const marker = "obsolete owned marker";
		const harness = await createHarness({
			tools: [tool("echo")],
			settings: { compaction: { enabled: false } },
			prepareNextTurnWithContext: ({ context }) =>
				++preparedTurns === 1
					? {
							context: {
								...context,
								messages: [...context.messages, { role: "user", content: marker, timestamp: Date.now() }],
							},
						}
					: { context },
		});
		harnesses.push(harness);
		harness.session.agent.subscribe(async (event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				getMessageText(event.message) === "checkpoint trigger"
			) {
				harness.sessionManager.appendCompactionCheckpoint(
					[{ role: "user", content: "authoritative checkpoint", timestamp: Date.now() }],
					1000,
				);
				await harness.session.followUp("after checkpoint");
			}
		});
		let resumedRequest: Context | undefined;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("checkpoint trigger"),
			(context) => {
				resumedRequest = context;
				return fauxAssistantMessage("resumed");
			},
		]);
		await harness.session.prompt("old request");
		const texts = resumedRequest?.messages.map(getMessageText) ?? [];
		expect(texts).toEqual(["authoritative checkpoint", "after checkpoint"]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("prepares each bounded retry without resurrecting failure artifacts or consuming input twice", async () => {
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const prepareRequest = harness.session.agent.prepareRequest;
		expect(prepareRequest).toBeTypeOf("function");
		let preparations = 0;
		harness.session.agent.prepareRequest = async (request, signal) => {
			preparations++;
			return (await prepareRequest?.(request, signal)) ?? undefined;
		};
		harness.setResponses([
			fauxAssistantMessage("failure artifact", {
				stopReason: "error",
				errorMessage: "terminated (UND_ERR_SOCKET: other side closed)",
			}),
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain("failure artifact");
				expect(context.messages.filter((entry) => entry.role === "user").map(getMessageText)).toEqual(["first"]);
				return fauxAssistantMessage("recovered");
			},
		]);
		await harness.session.prompt("first");
		expect(preparations).toBe(2);
		expect(harness.faux.state.callCount).toBe(2);
		expect(
			harness.sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error",
				),
		).toHaveLength(1);
	});

	it("prepares post-tool requests once and keeps transforms and provider observation downstream", async () => {
		const harness = await createHarness({
			tools: [tool("echo")],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		const order: string[] = [];
		const prepareRequest = harness.session.agent.prepareRequest;
		expect(prepareRequest).toBeTypeOf("function");
		harness.session.agent.prepareRequest = async (request, signal) => {
			order.push("prepare");
			return (await prepareRequest?.(request, signal)) ?? undefined;
		};
		const transform = harness.session.agent.transformContext;
		harness.session.agent.transformContext = async (messages, signal) => {
			order.push("transform");
			return transform ? await transform(messages, signal) : messages;
		};
		harness.session.agent.onProviderContext = (_model, context) => {
			order.push("observe");
			expect(context.tools?.map((entry) => entry.name)).toEqual(["echo"]);
		};
		harness.setResponses([
			() => {
				order.push("provider");
				return fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" });
			},
			() => {
				order.push("provider");
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("first");
		expect(order).toEqual([
			"prepare",
			"transform",
			"observe",
			"provider",
			"prepare",
			"transform",
			"observe",
			"provider",
		]);
	});
});
