import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { mapAgentSessionEvent, type PiSessionUiEvent } from "../src/modes/interactive-grok/pi-session-events.ts";
import { PiSessionPort, type PiSessionRuntimeHost } from "../src/modes/interactive-grok/pi-session-port.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createRuntimeHost(getSession: () => AgentSession): PiSessionRuntimeHost {
	return {
		get session() {
			return getSession();
		},
		switchSession: async () => ({ cancelled: false }),
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
	};
}

describe("PiSessionPort", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("maps streaming and tool events in source order while preserving toolCallId", async () => {
		const echoParameters = Type.Object({ text: Type.String() });
		const echoTool: AgentTool<typeof echoParameters, { stage: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo input",
			parameters: echoParameters,
			execute: async (_toolCallId, params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { stage: "partial" } });
				return { content: [{ type: "text", text: params.text }], details: { stage: "done" } };
			},
		};
		const harness = await createHarness({ tools: [echoTool], initialActiveToolNames: ["echo"] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("finished"),
		]);

		const port = new PiSessionPort(createRuntimeHost(() => harness.session));
		const events: PiSessionUiEvent[] = [];
		const sourceEventTypes: string[] = [];
		port.subscribe((event, sourceEvent) => {
			events.push(event);
			sourceEventTypes.push(sourceEvent.type);
		});

		await port.prompt("run echo");

		expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
		expect(events.some((event) => event.kind === "message" && event.phase === "update")).toBe(true);
		expect(
			events.filter((event) => event.kind === "tool").map((event) => `${event.phase}:${event.toolCallId}`),
		).toEqual(["start:call-1", "update:call-1", "end:call-1"]);
		expect(sourceEventTypes.filter((type) => type.startsWith("tool_execution_"))).toEqual([
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		]);
		port.dispose();
	});

	it("maps queue changes and cancellation-relevant lifecycle without owning either behavior", async () => {
		const waitParameters = Type.Object({});
		const waitTool: AgentTool<typeof waitParameters, Record<string, never>> = {
			name: "wait",
			label: "Wait",
			description: "Wait until cancellation",
			parameters: waitParameters,
			execute: async (_toolCallId, _params, signal) => {
				await new Promise<void>((_resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
				return { content: [{ type: "text", text: "unreachable" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool], initialActiveToolNames: ["wait"] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {}, { id: "wait-1" })], { stopReason: "toolUse" }),
		]);

		const port = new PiSessionPort(createRuntimeHost(() => harness.session));
		const events: PiSessionUiEvent[] = [];
		port.subscribe((event) => events.push(event));
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = port.subscribe((event) => {
				if (event.kind === "tool" && event.phase === "start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const prompt = port.prompt("wait");
		await toolStarted;
		await port.steer("steer later");
		await port.followUp("follow up later");
		expect(port.clearQueue()).toEqual({ steering: ["steer later"], followUp: ["follow up later"] });
		await port.abort();
		await prompt;

		const queueEvents = events.filter((event): event is Extract<PiSessionUiEvent, { kind: "queue" }> => {
			return event.kind === "queue";
		});
		expect(queueEvents.map((event) => [event.steering, event.followUp])).toEqual([
			[["steer later"], []],
			[["steer later"], ["follow up later"]],
			[[], []],
		]);
		expect(events.some((event) => event.kind === "agent" && event.phase === "settled")).toBe(true);
		port.dispose();
	});

	it("maps retry and compaction state without collapsing source details", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		const port = new PiSessionPort(createRuntimeHost(() => harness.session));
		const events: PiSessionUiEvent[] = [];
		port.subscribe((event) => events.push(event));
		await port.prompt("retry");

		expect(
			events
				.filter((event) => event.kind === "retry")
				.map((event) =>
					event.phase === "start" ? `start:${event.attempt}/${event.maxAttempts}` : `end:${event.success}`,
				),
		).toEqual(["start:1/2", "end:true"]);

		expect(mapAgentSessionEvent({ type: "compaction_start", reason: "overflow" }, 40)).toEqual({
			sequence: 40,
			kind: "compaction",
			phase: "start",
			reason: "overflow",
		});
		expect(
			mapAgentSessionEvent(
				{
					type: "compaction_end",
					reason: "manual",
					result: undefined,
					aborted: true,
					willRetry: false,
				},
				41,
			),
		).toEqual({
			sequence: 41,
			kind: "compaction",
			phase: "end",
			reason: "manual",
			result: undefined,
			aborted: true,
			willRetry: false,
			errorMessage: undefined,
		});
		port.dispose();
	});

	it("hydrates the active context without mutating session persistence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer")]);
		const port = new PiSessionPort(createRuntimeHost(() => harness.session));
		await port.prompt("question");
		const before = structuredClone(harness.sessionManager.getEntries());

		const hydration = port.hydrate();

		expect(hydration.sessionId).toBe(harness.session.sessionId);
		expect(hydration.cwd).toBe(harness.sessionManager.getCwd());
		expect(hydration.contextEntries).toEqual(harness.sessionManager.buildContextEntries());
		expect(hydration.contextEntries.length).toBeGreaterThan(0);
		expect(hydration.isRetrying).toBe(false);
		expect(harness.sessionManager.getEntries()).toEqual(before);
	});

	it("rebinds event delivery to the replacement session and keeps sequence monotonic", async () => {
		const first = await createHarness();
		const second = await createHarness();
		harnesses.push(first, second);
		let current = first.session;
		const port = new PiSessionPort(createRuntimeHost(() => current));
		const events: PiSessionUiEvent[] = [];
		port.subscribe((event) => events.push(event));

		await first.session.sendCustomMessage({ customType: "source", content: "first", display: true });
		current = second.session;
		port.rebind();
		await first.session.sendCustomMessage({ customType: "source", content: "stale", display: true });
		await second.session.sendCustomMessage({ customType: "source", content: "second", display: true });

		const messageEvents = events.filter((event): event is Extract<PiSessionUiEvent, { kind: "message" }> => {
			return event.kind === "message";
		});
		expect(
			messageEvents.flatMap((event) =>
				event.phase === "start" && event.message.role === "custom" ? [event.message.content] : [],
			),
		).toEqual(["first", "second"]);
		expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
		port.dispose();
	});
});
