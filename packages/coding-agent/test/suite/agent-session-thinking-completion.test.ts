import { join } from "node:path";
import type { ResponseReasoningItem, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { beforeAll, describe, expect, it } from "vitest";
import { processResponsesStream } from "../../../ai/src/api/openai-responses-shared.ts";
import { fauxAssistantMessage } from "../../../ai/src/providers/faux.ts";
import { AssistantMessageEventStream } from "../../../ai/src/utils/event-stream.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getMarkdownTheme, initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { GrokThinkingTurnGroupComponent } from "../../src/modes/interactive-grok/components/grok-thinking-turn-group.ts";
import { createHarness } from "./harness.ts";

beforeAll(() => initTheme("dark"));

describe("AgentSession reasoning completion", () => {
	it.each(["summary_text", "summary_part", "reasoning_text", "terminal"])(
		"persists and displays thinking received only in %s completion",
		async (kind) => {
			const harness = await createHarness({ tools: [], hfCompaction: { mode: "off" } });
			const group = new GrokThinkingTurnGroupComponent(getMarkdownTheme(), "Thinking", 0, false);
			const owner = {};
			try {
				harness.session.subscribe((event) => {
					if (event.type !== "message_update" || event.message.role !== "assistant") return;
					const thinking = event.message.content
						.filter((block) => block.type === "thinking")
						.map((block) => block.thinking)
						.join("\n\n");
					group.updateThinking(owner, thinking);
				});
				harness.session.agent.streamFunction = async (model) => {
					const output = fauxAssistantMessage([]);
					const stream = new AssistantMessageEventStream();
					stream.push({ type: "start", partial: output });
					const item: ResponseReasoningItem = { type: "reasoning", id: "rs_test", summary: [] };
					async function* events(): AsyncIterable<ResponseStreamEvent> {
						yield { type: "response.output_item.added", output_index: 0, item, sequence_number: 0 };
						if (kind !== "terminal")
							yield {
								type:
									kind === "summary_part"
										? "response.reasoning_summary_part.done"
										: kind === "summary_text"
											? "response.reasoning_summary_text.done"
											: "response.reasoning_text.done",
								output_index: 0,
								item_id: item.id,
								sequence_number: 1,
								summary_index: 0,
								content_index: 0,
								text: "Recovered thinking",
								part: { type: "summary_text", text: "Recovered thinking" },
							} as ResponseStreamEvent;
						yield {
							type: "response.completed",
							response: {
								status: "completed",
								output: [
									{
										...item,
										summary:
											kind === "terminal" ? [{ type: "summary_text", text: "Recovered thinking" }] : [],
									},
								],
							},
						} as ResponseStreamEvent;
					}
					await processResponsesStream(events(), output, stream, model);
					stream.push({ type: "done", reason: "stop", message: output });
					return stream;
				};
				await harness.session.prompt("test");
				const entries = harness.sessionManager.getEntries().filter((entry) => entry.type === "message");
				expect(entries.at(-1)).toMatchObject({
					message: { role: "assistant", content: [{ type: "thinking", thinking: "Recovered thinking" }] },
				});
				const disk = SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"));
				for (const entry of entries) {
					if (entry.message.role === "user" || entry.message.role === "assistant")
						disk.appendMessage(entry.message);
				}
				const file = disk.getSessionFile();
				expect(file).toBeDefined();
				if (!file) throw new Error("Session file not created");
				expect(SessionManager.open(file).getEntries().at(-1)).toMatchObject({
					message: { content: [{ thinking: "Recovered thinking" }] },
				});
				group.completeTurn();
				group.setExpanded(true);
				expect(group.entryCount).toBe(1);
				expect(group.render(80).join("\n")).toContain("Recovered thinking");
			} finally {
				group.dispose();
				harness.cleanup();
			}
		},
	);
});
