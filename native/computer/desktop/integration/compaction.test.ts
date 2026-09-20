import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { estimateContextTokens } from "../../../../packages/coding-agent/src/core/compaction/compaction.ts";
import { createComputerSessionBinding } from "../../../../packages/coding-agent/src/core/computer/binding.ts";
import { ComputerHost } from "../../../../packages/coding-agent/src/core/computer/host.ts";
import { convertToLlm } from "../../../../packages/coding-agent/src/core/messages.ts";
import { ModelRuntime } from "../../../../packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../../../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../../packages/coding-agent/src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../../../packages/coding-agent/test/utilities.ts";
import { DesktopView } from "../view.ts";

it("real compaction retires image authority and shares its replacement view with estimation and the provider", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "computer-compaction-"));
	const host = new ComputerHost({
		desktopId: "compaction-view",
		createRuntime() {
			throw new Error("No native runtime in the compaction test");
		},
	});
	const view = new DesktopView<string>();
	const control = new DesktopView<string>();
	const binding = createComputerSessionBinding(host.openSession(), () => [
		{
			name: "computer",
			label: "Computer",
			description: "Synthetic image projection; no GUI",
			parameters: Type.Object({}),
			executionResource: { key: "desktop:compaction-view", mode: "exclusive" },
			async execute(id) {
				const content: ToolResultMessage["content"] = [
					{ type: "text", text: "Image ref: old-image" },
					{ type: "image", data: "cG5n", mimeType: "image/png" },
				];
				view.publish(id, content, "old-image");
				control.publish(id, content, "old-image");
				return { content, details: {} };
			},
		},
	]);
	binding.observeContext = (imagesEnabled, messages) => {
		view.observeContext(imagesEnabled, messages);
		control.observeContext(imagesEnabled, messages);
	};
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "computer-compaction-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const manager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime,
		model: { ...faux.getModel(), input: ["text", "image"], contextWindow: 100_000 },
		computer: binding,
		tools: ["computer"],
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
			retry: { enabled: false },
		}),
		resourceLoader: createTestResourceLoader(),
	});
	try {
		await session.bindExtensions({});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("computer", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(`Fixture inspected. ${"Historical explanation. ".repeat(500)}`),
		]);
		await session.prompt("Inspect the synthetic fixture image.");
		expect(control.consume()).toBe("old-image"); // The independent view remains granted until compaction.
		faux.setResponses([
			fauxAssistantMessage(
				"## Conversation timeline\nThe dedicated fixture image was inspected; no input was sent.\n" +
					"## Current continuation point\nThe prior image is obsolete. Capture a new image before any future input.",
			),
		]);
		await session.compact();
		expect(manager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		const active = session.hfCompactionHost?.buildActiveMessages(manager.getBranch());
		expect(active).toEqual(session.messages);
		expect(estimateContextTokens(active!)).toEqual(estimateContextTokens(session.messages));
		expect(JSON.stringify(convertToLlm(session.messages))).not.toContain('"type":"image"');
		faux.setResponses([
			(context) => {
				expect(context.messages).toEqual(convertToLlm(session.messages));
				expect(view.consume()).toBeUndefined();
				expect(context.messages.some((message) => message.role === "toolResult")).toBe(false);
				return fauxAssistantMessage("Fresh observation is required.");
			},
		]);
		await session.prompt("Continue after compaction.");
	} finally {
		try {
			await session.shutdown();
		} finally {
			await host.close();
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});
