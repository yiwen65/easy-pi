import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue } from "../src/agent-loop.ts";
import { fingerprintToolResult } from "../src/no-progress.ts";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

const prompt: AgentMessage = { role: "user", content: "observe", timestamp: 0 };
const call = () => fauxAssistantMessage([fauxToolCall("observe", {})], { stopReason: "toolUse" });
const done = () => fauxAssistantMessage([fauxText("done")]);

function setup() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const config: AgentLoopConfig = {
		model: faux.getModel(),
		convertToLlm: (messages) => messages as Message[],
	};
	const execute = vi.fn<AgentTool["execute"]>(async () => ({
		content: [{ type: "text", text: "same" }],
		details: {},
	}));
	const tool: AgentTool = {
		name: "observe",
		label: "observe",
		description: "observation",
		parameters: Type.Object({}),
		execute,
	};
	return {
		faux,
		config,
		execute,
		context: { systemPrompt: "", messages: [], tools: [tool] },
		streamFn: models.streamSimple.bind(models),
	};
}

async function observeSettlement(promise: Promise<unknown>) {
	return Promise.race([
		promise.then(
			(value) => ({ state: "fulfilled", value }),
			(error: unknown) => ({ state: "rejected", error }),
		),
		new Promise<{ state: "pending" }>((resolve) => setImmediate(() => resolve({ state: "pending" }))),
	]);
}

describe("runtime progress boundaries (F10/F11)", () => {
	it("does not combine independent follow-ups into a stuck loop", async () => {
		const h = setup();
		h.faux.setResponses([call(), done(), call(), done(), call(), done(), call(), done()]);
		let followUps = 3;
		h.config.getFollowUpMessages = async () => (followUps-- > 0 ? [prompt] : []);
		const messages = await agentLoop([prompt], h.context, h.config, undefined, h.streamFn).result();
		expect(h.execute).toHaveBeenCalledTimes(4);
		expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("resets repetition when steering adds explicit input during tool continuation", async () => {
		const h = setup();
		h.faux.setResponses([call(), call(), call(), call(), done()]);
		let steered = false;
		h.config.getSteeringMessages = async () => {
			if (!steered && h.execute.mock.calls.length === 2) {
				steered = true;
				return [prompt];
			}
			return [];
		};
		const messages = await agentLoop([prompt], h.context, h.config, undefined, h.streamFn).result();
		expect(h.execute).toHaveBeenCalledTimes(4);
		expect(messages.at(-1)).toMatchObject({ stopReason: "stop" });
	});

	it.each([true, false])("distinguishes changing image data (changing=%s)", async (changing) => {
		const h = setup();
		h.faux.setResponses([call(), call(), call(), call(), done()]);
		h.execute.mockImplementation(async () => ({
			content: [
				{
					type: "image",
					mimeType: "image/png",
					data: changing ? `image-${h.execute.mock.calls.length}` : "same-image",
				},
			],
			details: {},
		}));
		const messages = await agentLoop([prompt], h.context, h.config, undefined, h.streamFn).result();
		expect(h.execute).toHaveBeenCalledTimes(changing ? 4 : 3);
		expect(messages.at(-1)).toMatchObject({ stopReason: changing ? "stop" : "error" });
	});

	it("ignores result ids and timestamps but includes the full image identity", () => {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "first",
			toolName: "observe",
			isError: false,
			timestamp: 1,
			content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
		};
		expect(fingerprintToolResult(result)).toBe(
			fingerprintToolResult({ ...result, toolCallId: "second", timestamp: 2 }),
		);
		expect(fingerprintToolResult(result)).not.toBe(
			fingerprintToolResult({ ...result, content: [{ type: "image", mimeType: "image/png", data: "AAAB" }] }),
		);
	});
});

describe("raw loop producer rejection (F19)", () => {
	it.each([
		["prompt", "prepare"],
		["prompt", "persistence"],
		["continue", "prepare"],
		["continue", "persistence"],
	] as const)("terminates %s stream when %s rejects", async (entry, failure) => {
		const h = setup();
		const error = new Error(`${failure} failed`);
		h.faux.setResponses([call()]);
		if (failure === "prepare")
			h.config.prepareRequest = async () => {
				throw error;
			};
		else
			h.config.onToolResult = async () => {
				throw error;
			};
		const stream =
			entry === "prompt"
				? agentLoop([prompt], h.context, h.config, undefined, h.streamFn)
				: agentLoopContinue({ ...h.context, messages: [prompt] }, h.config, undefined, h.streamFn);
		const events: AgentEvent[] = [];
		const iteration = (async () => {
			for await (const event of stream) events.push(event);
		})();
		const [result, iterator] = await Promise.all([observeSettlement(stream.result()), observeSettlement(iteration)]);
		expect(result).toEqual({ state: "rejected", error });
		expect(iterator).toEqual({ state: "rejected", error });
		expect(events[0]?.type).toBe("agent_start");
		expect(events.some((event) => event.type === "agent_end")).toBe(false);
		expect(h.faux.state.callCount).toBe(failure === "prepare" ? 0 : 1);
	});
});
