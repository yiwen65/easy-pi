import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { InMemoryCredentialStore, type ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createComputerSessionBinding } from "../../../../packages/coding-agent/src/core/computer/binding.ts";
import { ComputerHost } from "../../../../packages/coding-agent/src/core/computer/host.ts";
import type { ToolDefinition } from "../../../../packages/coding-agent/src/core/extensions/types.ts";
import { ModelRuntime } from "../../../../packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../../../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../../packages/coding-agent/src/core/settings-manager.ts";
import {
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../../../../packages/coding-agent/test/utilities.ts";
import type { DesktopGrant } from "../projection.ts";
import { validateSegmentEvidence } from "../segment-evidence.ts";
import { DesktopView } from "../view.ts";

function oversizedPng(): string {
	const chunk = (type: string, body: Buffer) => {
		const header = Buffer.alloc(8);
		header.writeUInt32BE(body.length);
		header.write(type, 4);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])));
		return Buffer.concat([header, body, checksum]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(2048);
	ihdr.writeUInt32BE(1284, 4);
	ihdr[8] = 8;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(Buffer.alloc(2049 * 1284))),
		chunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

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

it.each(["binding", "extensionPixels", "extensionText", "unboundComputer", "screenshot"] as const)(
	"2048px image evidence through real session normalization: %s",
	async (mode) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-desktop-image-"));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const host = new ComputerHost({
			desktopId: "image-test",
			createRuntime() {
				throw new Error("No native runtime in image test");
			},
		});
		cleanups.push(() => host.close());
		const view = new DesktopView<DesktopGrant>();
		const data = oversizedPng();
		const bound = mode !== "unboundComputer" && mode !== "screenshot";
		const name = mode === "screenshot" ? "screenshot" : "computer";
		const parameters = Type.Object({ op: Type.Union([Type.Literal("capture"), Type.Literal("segment")]) });
		const tool: ToolDefinition<typeof parameters> = {
			name,
			label: name,
			description: "Test exact image evidence",
			parameters,
			executionResource: { key: "desktop:image-test", mode: "exclusive" },
			async execute(id, args) {
				if (args.op === "segment") {
					validateSegmentEvidence(
						{
							op: "segment",
							ref: "current",
							actions: [{ op: "key", key: "Tab" }],
							expected: { kind: "visual", description: "focus changed" },
						},
						view.consume(),
					);
					return { content: [{ type: "text", text: "accepted" }], details: {} };
				}
				const content: ToolResultMessage["content"] = [
					{ type: "text", text: "Image ref: current; width=2048; height=1284" },
					{ type: "image", data, mimeType: "image/png" },
				];
				view.publish(id, content, { kind: "image", ref: "current", width: 2048, height: 1284, targetKey: "test" });
				return { content, details: {} };
			},
		};
		const binding = createComputerSessionBinding(host.openSession(), () => (bound ? [tool] : []));
		binding.observeContext = (enabled, messages) => view.observeContext(enabled, messages);
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("tool_result", (event) => {
						if (event.toolName !== name || !event.content.some((part) => part.type === "image")) return;
						if (mode === "extensionPixels")
							return { content: event.content.filter((part) => part.type !== "image") };
						if (mode === "extensionText")
							return { content: [...event.content, { type: "text", text: "changed" }] };
					});
				},
			],
			cwd,
		);
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ provider: "desktop-image-faux", tokensPerSecond: 0 });
		runtime.registerNativeProvider(faux.provider);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRuntime: runtime,
			model: { ...faux.getModel(), input: ["text", "image"] },
			computer: binding,
			customTools: bound ? [] : [tool],
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({
				images: { autoResize: true },
				compaction: { enabled: false },
				retry: { enabled: false },
			}),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		cleanups.push(() => session.shutdown().then(() => undefined));
		await session.bindExtensions({});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall(name, { op: "capture" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall(name, { op: "segment" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("Capture then use the returned image reference.");
		const results = session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		const action = results[1]!;
		expect(action.isError, JSON.stringify(action.content)).toBe(mode !== "binding");
		if (mode !== "binding")
			expect(action.content).toEqual(
				expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("stale_observation") })]),
			);
		const image = results[0]!.content.find((part) => part.type === "image");
		if (mode === "extensionPixels") expect(image).toBeUndefined();
		else {
			expect(image?.type).toBe("image");
			if (image?.type !== "image") throw new Error("Missing image");
			expect(Buffer.from(image.data, "base64").readUInt32BE(16)).toBe(bound ? 2048 : 2000);
			if (bound) expect(image.data).toBe(data);
		}
	},
);
