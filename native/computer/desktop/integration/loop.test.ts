import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type * as CuaSdk from "@trycua/cua-driver";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerHost } from "../../../../packages/coding-agent/src/core/computer/host.ts";
import { ModelRuntime } from "../../../../packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../../../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../../packages/coding-agent/src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../../../packages/coding-agent/test/utilities.ts";
import { ControlledComputerRuntime, type NativeOperation, type NativeSession } from "../../controlled/adapter.ts";
import { createDesktopBinding } from "../binding.ts";
import { loadDesktopSdk } from "../loader.ts";

const allowed = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
if (allowed && (process.env.ALLOW_GUI_TESTS !== "false" || process.env.ALLOW_REAL_APIS !== "false"))
	throw new Error("Explicit no-GUI load-only opt-in required");
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(!allowed)("desktop binding through actual AgentSession with faux provider", () => {
	it.each([
		{ blocked: false, vision: true },
		{ blocked: true, vision: true },
		{ blocked: false, vision: false },
	])("discovery/select/capture/key honors blockImages=$blocked vision=$vision", async ({ blocked, vision }) => {
		const sdk = loadDesktopSdk(process.env.CUA_DRIVER_TYPESCRIPT_DIR!);
		let inputs = 0;
		let creates = 0;
		let closes = 0;
		function native(): NativeSession {
			return {
				revoke() {},
				async close() {
					closes++;
				},
				newOperation(): NativeOperation {
					let resolve!: (result: CuaSdk.ComputerResult) => void;
					let finish!: (result: CuaSdk.ComputerTerminal) => void;
					const result = new Promise<CuaSdk.ComputerResult>((accept) => {
						resolve = accept;
					});
					const terminal = new Promise<CuaSdk.ComputerTerminal>((accept) => {
						finish = accept;
					});
					const done = (value: CuaSdk.ComputerResult, input = false) => {
						resolve(value);
						finish({ operationId: "fake", inputCommitted: input, cancelled: false });
					};
					const forbidden = () => {
						throw new Error("Unexpected route");
					};
					return {
						result: () => result,
						terminal: () => terminal,
						cancel() {},
						startListWindows() {
							done(
								new sdk.ComputerResult.Windows({
									windows: [
										{
											reference: "w",
											appName: "Fixture",
											title: "Test",
											bounds: { x: 0, y: 0, width: 2, height: 3 },
											isOnScreen: true,
										},
									],
									omittedWindows: 0,
									filteredOut: 0,
								}),
							);
						},
						startSelectWindow(reference) {
							expect(reference).toBe("w");
							done(new sdk.ComputerResult.WindowSelected({ session: native() }));
						},
						startCapture() {
							const png = new ArrayBuffer(33);
							const bytes = Buffer.from(png);
							bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
							bytes.writeUInt32BE(13, 8);
							bytes.write("IHDR", 12);
							bytes.writeUInt32BE(2, 16);
							bytes.writeUInt32BE(3, 20);
							done(
								new sdk.ComputerResult.Image({
									value: {
										imageId: "i",
										png,
										pid: 1,
										windowId: 1n,
										geometry: {
											desktopX: 0,
											desktopY: 0,
											windowWidth: 2,
											windowHeight: 3,
											sourceWidth: 2,
											sourceHeight: 3,
											cropX: 0,
											cropY: 0,
											cropWidth: 2,
											cropHeight: 3,
											outputWidth: 2,
											outputHeight: 3,
										},
									},
								}),
							);
						},
						startImageKey(ref, key) {
							expect(ref).toBe("i");
							expect(key).toBe(sdk.ComputerKey.Tab);
							inputs++;
							done(
								new sdk.ComputerResult.Action({
									value: { effect: sdk.ActionEffect.Unverifiable, route: sdk.ActionRoute.Accessibility },
								}),
								true,
							);
						},
						startClick: forbidden,
						startScrollIntoView: forbidden,
						startImageClick: forbidden,
						startImageScroll: forbidden,
						startNavigate: forbidden,
						startObserve: forbidden,
						startPlan: forbidden,
						startSegment: forbidden,
						startCrossWindowDrag: forbidden,
						startPrepare: forbidden,
					};
				},
			};
		}
		const host = new ComputerHost({
			desktopId: "full-desktop-loop",
			createRuntime() {
				creates++;
				return new ControlledComputerRuntime(
					{ host: { openSession: native, revoke() {}, async close() {} }, destroy() {} },
					native,
				);
			},
		});
		cleanups.push(() => host.close());
		const binding = createDesktopBinding(host.openSession(), () => sdk);
		const cwd = mkdtempSync(join(tmpdir(), "desktop-loop-"));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ provider: "full-desktop-faux", tokensPerSecond: 0 });
		modelRuntime.registerNativeProvider(faux.provider);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRuntime,
			model: { ...faux.getModel(), input: vision ? ["text", "image"] : ["text"] },
			computer: binding,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({
				images: { blockImages: blocked },
				compaction: { enabled: false },
				retry: { enabled: false },
			}),
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(async () => {
			await session.shutdown();
		});
		await session.bindExtensions({});
		const schemas: string[] = [];
		const observeContext = session.agent.onProviderContext;
		session.agent.onProviderContext = (model, context) => {
			observeContext?.(model, context);
			schemas.push(JSON.stringify(context.tools));
		};
		expect(creates).toBe(0);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("computer", { request: { op: "discover" } }), { stopReason: "toolUse" }),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain('\\"ref\\":\\"w\\"');
				return fauxAssistantMessage(fauxToolCall("computer", { request: { op: "select", ref: "w" } }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(fauxToolCall("computer", { request: { op: "capture", maxDimension: 512 } }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const last = context.messages.filter((message) => message.role === "toolResult").at(-1);
				expect(last?.content.some((part) => part.type === "image")).toBe(!blocked);
				return fauxAssistantMessage(fauxToolCall("computer", { request: { op: "key", ref: "i", key: "Tab" } }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("done"),
		]);
		await session.prompt("Use the dedicated synthetic fixture.");
		expect(faux.state.callCount).toBe(5);
		expect(schemas).toHaveLength(5);
		expect(new Set(schemas).size).toBe(1); // Stable schema/cache prefix throughout the GUI phase.
		expect(creates).toBe(1);
		expect(inputs).toBe(blocked || !vision ? 0 : 1);
		const results = session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(4);
		const calls = session.messages.flatMap((message) =>
			message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [],
		);
		expect(results.map((result) => result.toolCallId)).toEqual(calls.map((call) => call.id));
		expect(results.at(-1)?.isError).toBe(blocked || !vision);
		expect(session.agent.executionScheduler).toBe(host.scheduler);
		await session.shutdown();
		await host.close();
		expect(closes).toBe(2);
	});
});
