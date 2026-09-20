import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createComputerSessionBinding } from "../../../../packages/coding-agent/src/core/computer/binding.ts";
import { ComputerHost } from "../../../../packages/coding-agent/src/core/computer/host.ts";
import { ModelRuntime } from "../../../../packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../../../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../../packages/coding-agent/src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../../../packages/coding-agent/test/utilities.ts";
import { DesktopView } from "../view.ts";

// Exercises the real AgentSession/provider-context hook, not native delivery.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.each(["visible", "blockImages", "transformOmission"] as const)(
	"canonical context controls ephemeral image authority: %s",
	async (mode) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-desktop-context-"));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const host = new ComputerHost({
			desktopId: "context-test",
			createRuntime() {
				throw new Error("No native runtime in context test");
			},
		});
		cleanups.push(() => host.close());
		const view = new DesktopView<string>();
		const observations: boolean[] = [];
		const binding = createComputerSessionBinding(host.openSession(), () => [
			{
				name: "computer",
				label: "Computer",
				description: "Test image view",
				parameters: Type.Object({}),
				executionResource: { key: "desktop:context-test", mode: "exclusive" },
				async execute(id) {
					const content: ToolResultMessage["content"] = [
						{ type: "text", text: "Image ref: current" },
						{ type: "image", data: "cG5n", mimeType: "image/png" },
					];
					view.publish(id, content, "current");
					return { content, details: {} };
				},
			},
		]);
		binding.observeContext = (imagesEnabled, messages) => {
			view.observeContext(imagesEnabled, messages);
			observations.push(imagesEnabled);
		};
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ provider: "desktop-context-faux", tokensPerSecond: 0 });
		runtime.registerNativeProvider(faux.provider);
		const model = { ...faux.getModel(), input: ["text", "image"] as ("text" | "image")[] };
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRuntime: runtime,
			model,
			computer: binding,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({
				images: { blockImages: mode === "blockImages" },
				compaction: { enabled: false },
				retry: { enabled: false },
			}),
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(async () => {
			await session.shutdown();
		});
		await session.bindExtensions({});
		if (mode === "transformOmission") {
			const original = session.agent.transformContext;
			session.agent.transformContext = async (messages, signal) => {
				const transformed = original ? await original(messages, signal) : messages;
				return transformed.map((message) =>
					message.role === "toolResult"
						? { ...message, content: message.content.filter((part) => part.type !== "image") }
						: message,
				);
			};
		}
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("computer", {}), { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				expect(result?.content.some((part) => part.type === "image")).toBe(mode === "visible");
				expect(view.consume()).toBe(mode === "visible" ? "current" : undefined);
				return fauxAssistantMessage("done");
			},
		]);
		await session.prompt("Inspect the test image.");
		expect(faux.state.callCount).toBe(2);
		expect(observations).toHaveLength(2);
		expect(observations.every((enabled) => enabled === (mode !== "blockImages"))).toBe(true);
		expect(session.agent.executionScheduler).toBe(host.scheduler);
		if (mode === "visible") {
			let renewedObservations = 0;
			const renewed = createComputerSessionBinding(host.openSession(), () => []);
			renewed.observeContext = () => {
				renewedObservations++;
			};
			binding.renew = () => renewed;
			await session.reload();
			expect(session.computer).toBe(renewed);
			faux.setResponses([fauxAssistantMessage("after reload")]);
			await session.prompt("Continue without the retired view.");
			expect(renewedObservations).toBe(1);
			expect(observations).toHaveLength(2);
		}
	},
);
