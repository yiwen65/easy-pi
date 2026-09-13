import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const ECHO_PARAMETERS = Type.Object({ value: Type.String() });

function echoTool(executed: string[]): AgentTool<typeof ECHO_PARAMETERS, Record<string, never>> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo a value",
		parameters: ECHO_PARAMETERS,
		execute: async (_toolCallId, params) => {
			executed.push(params.value);
			return {
				content: [{ type: "text", text: params.value }],
				details: {},
			};
		},
	};
}

describe("runtime tool cancellation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("does not start a prepared tool after the real AgentSession loop is cancelled", async () => {
		const executed: string[] = [];
		let releaseSecondPreflight: (() => void) | undefined;
		const secondPreflightReleased = new Promise<void>((resolve) => {
			releaseSecondPreflight = resolve;
		});
		let secondPreflightStarted: () => void = () => {};
		const secondPreflightStartedPromise = new Promise<void>((resolve) => {
			secondPreflightStarted = resolve;
		});
		const harness = await createHarness({
			tools: [echoTool(executed)],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event) => {
						if (event.toolCallId === "tool-2") {
							secondPreflightStarted();
							await secondPreflightReleased;
						}
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { value: "first" }, { id: "tool-1" }),
					fauxToolCall("echo", { value: "second" }, { id: "tool-2" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		const promptPromise = harness.session.prompt("run both");
		await secondPreflightStartedPromise;
		harness.session.agent.abort();
		releaseSecondPreflight?.();
		await promptPromise;

		expect(executed).toEqual([]);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("does not start a provider request after AgentSession preflight cancellation", async () => {
		let releaseTransform: (() => void) | undefined;
		const transformReleased = new Promise<void>((resolve) => {
			releaseTransform = resolve;
		});
		let transformStarted: () => void = () => {};
		const transformStartedPromise = new Promise<void>((resolve) => {
			transformStarted = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("provider should not run")]);
		const previousTransform = harness.session.agent.transformContext;
		harness.session.agent.transformContext = async (messages, signal) => {
			transformStarted();
			await transformReleased;
			return previousTransform ? previousTransform(messages, signal) : messages;
		};

		const promptPromise = harness.session.prompt("cancel during provider preparation");
		await transformStartedPromise;
		harness.session.agent.abort();
		releaseTransform?.();
		await promptPromise;

		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
	});
});
