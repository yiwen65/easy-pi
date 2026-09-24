import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { DesktopView } from "../../../../native/computer/desktop/view.ts";
import { createComputerSessionBinding } from "../../src/core/computer/binding.ts";
import { recentComputerImages } from "../../src/core/computer/context.ts";
import { ComputerHost } from "../../src/core/computer/host.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";

function screenshot(id: string, count = 1, toolName = "computer"): ToolResultMessage {
	return {
		role: "toolResult",
		toolName,
		toolCallId: id,
		timestamp: 1,
		isError: false,
		content: [
			{ type: "text", text: `Evidence ${id}` },
			...Array.from({ length: count }, (_, index) => ({
				type: "image" as const,
				mimeType: "image/png",
				data: `image-${id}-${index}`,
			})),
		],
	};
}

describe("Computer request image history", () => {
	it("keeps latest two complete groups byte-identical without mutating the archive", () => {
		const messages = [screenshot("old"), screenshot("previous", 2), screenshot("current", 2)];
		const original = structuredClone(messages);
		const result = recentComputerImages(messages);
		expect(result[0].content).toEqual([
			messages[0].content[0],
			{ type: "text", text: expect.stringContaining("Historical Computer screenshot omitted") },
		]);
		expect(result[1]).toBe(messages[1]);
		expect(result[2]).toBe(messages[2]);
		expect(messages).toEqual(original);
		expect(recentComputerImages(result)).toEqual(result);
	});

	it("does not touch user images, other tools or text-only results", () => {
		const user: Message = {
			role: "user",
			timestamp: 1,
			content: [{ type: "image", mimeType: "image/png", data: "user-image" }],
		};
		const read = screenshot("read", 1, "read");
		const text = screenshot("text", 0);
		const messages = [user, read, text, screenshot("one"), screenshot("two"), screenshot("three")];
		const result = recentComputerImages(messages);
		expect(result.slice(0, 3)).toEqual([user, read, text]);
		expect(result[0]).toBe(user);
		expect(result[1]).toBe(read);
		expect(result[2]).toBe(text);
	});

	it("does no projection below the limit and does not revive retired capabilities", () => {
		const messages = [screenshot("old"), screenshot("previous"), screenshot("current", 2)];
		const small = messages.slice(1);
		expect(recentComputerImages(small)).toBe(small);
		const view = new DesktopView<{ ref: string }>();
		view.publish("current", messages[2].content, { ref: "current-pair" });
		view.observeContext(true, recentComputerImages(messages));
		expect(view.consume()).toEqual({ ref: "current-pair" });
		view.observeContext(true, messages);
		expect(view.consume()).toBeUndefined();
		view.publish("old", messages[0].content, { ref: "old" });
		view.observeContext(true, recentComputerImages(messages));
		expect(view.consume()).toBeUndefined();
	});

	it("settings default to all and only explicit recent opts in", () => {
		expect(SettingsManager.inMemory().getComputerImageHistory()).toBe("all");
		expect(SettingsManager.inMemory({ images: { computerHistory: "recent" } }).getComputerImageHistory()).toBe(
			"recent",
		);
	});

	it.each([
		{ mode: "all" as const, blocked: false, expected: 3 },
		{ mode: "recent" as const, blocked: false, expected: 2 },
		{ mode: "recent" as const, blocked: true, expected: 0 },
	])("SDK projects $mode / blockImages=$blocked before the binding observer", async ({ mode, blocked, expected }) => {
		const faux = fauxProvider();
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });
		const host = new ComputerHost({
			desktopId: "image-history-test",
			createRuntime() {
				throw new Error("Must remain lazy");
			},
		});
		const binding = createComputerSessionBinding(host.openSession(), () => []);
		let observed: readonly Message[] = [];
		binding.observeContext = (_enabled, messages) => {
			observed = messages;
		};
		const { session } = await createAgentSession({
			model: faux.getModel(),
			modelRuntime: runtime,
			computer: binding,
			resourceLoader: createTestResourceLoader(),
			tools: [],
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
				images: { computerHistory: mode, blockImages: blocked },
			}),
		});
		const images = [screenshot("a"), screenshot("b"), screenshot("c")];
		session.agent.state.messages = images.flatMap((message) => [
			fauxAssistantMessage(
				[
					{
						type: "toolCall",
						id: message.toolCallId,
						name: "computer",
						arguments: { request: { op: "capture", maxDimension: 512 } },
					},
				],
				{ stopReason: "toolUse" },
			),
			message,
		]);
		const countImages = (messages: readonly Message[]) =>
			messages.reduce(
				(count, message) =>
					count +
					(Array.isArray(message.content) ? message.content.filter((part) => part.type === "image").length : 0),
				0,
			);
		try {
			faux.setResponses([
				(context) => {
					expect(countImages(context.messages)).toBe(expected);
					expect(countImages(observed)).toBe(expected);
					return fauxAssistantMessage("done");
				},
			]);
			await session.prompt("Continue without executing any tools.");
			expect(
				session.messages
					.filter((message) => message.role === "toolResult")
					.flatMap((message) => message.content)
					.filter((part) => part.type === "image"),
			).toHaveLength(3);
		} finally {
			await session.abort();
			session.dispose();
			await host.close();
		}
	});
});
