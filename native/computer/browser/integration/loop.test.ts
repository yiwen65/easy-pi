import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type * as CuaSdk from "@trycua/cua-driver";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerHost } from "../../../../packages/coding-agent/src/core/computer/host.ts";
import { ModelRuntime } from "../../../../packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../../../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../../packages/coding-agent/src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../../../packages/coding-agent/test/utilities.ts";
import type { NativeOperation, NativeResult } from "../../controlled/adapter.ts";
import type { ExecuteRequest } from "../../controlled/contracts.ts";
import { type BrowserNativeHost, createControlledBrowserRuntime } from "../adapter.ts";
import { createControlledBrowserBinding } from "../binding.ts";
import { loadBrowserSdk } from "../loader.ts";

// Genuine generated values are loaded, but the desktop host below is fake. No real native host/TCC/lease.
const optedIn = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
if (optedIn && (process.env.ALLOW_GUI_TESTS !== "false" || process.env.ALLOW_REAL_APIS !== "false"))
	throw new Error("No-GUI/native-load opt-in required");
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(mode: "enabled" | "ordinary" | "noTools" = "enabled") {
	const sdk = loadBrowserSdk(process.env.CUA_DRIVER_TYPESCRIPT_DIR!);
	const cwd = mkdtempSync(join(tmpdir(), "pi-native-computer-loop-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const values = new Map(["Name", "City", "Team", "Note"].map((label) => [label, ""]));
	let version = 0;
	const plans: CuaSdk.ComputerPlan[] = [];
	const native: BrowserNativeHost = {
		openSession() {
			throw new Error("No dummy native-window target");
		},
		openBrowserSession: () => ({
			revoke() {},
			async close() {},
			newOperation(): NativeOperation {
				let resolve!: (result: NativeResult) => void;
				const result = new Promise<NativeResult>((done) => {
					resolve = done;
				});
				let finish!: (proof: CuaSdk.ComputerTerminal) => void;
				const terminal = new Promise<CuaSdk.ComputerTerminal>((done) => {
					finish = done;
				});
				const proof = (inputCommitted: boolean) =>
					finish({ operationId: `fake-${version}`, cancelled: false, inputCommitted });
				return {
					startPrepare() {
						resolve(new sdk.ComputerResult.BrowserPrepared({ pid: 42, windowId: 7n }));
						proof(true);
					},
					startNavigate() {
						resolve(
							new sdk.ComputerResult.Action({
								value: {
									effect: sdk.ActionEffect.Unverifiable,
									route: sdk.ActionRoute.Dom,
									delivery: { mode: sdk.ActionDeliveryMode.Background },
								},
							}),
						);
						proof(true);
					},
					startObserve() {
						version++;
						resolve(
							new sdk.ComputerResult.Observation({
								value: {
									pid: 42,
									windowId: 7n,
									snapshotId: `snapshot-${version}`,
									images: [],
									elementsComplete: true,
									truncated: false,
									degraded: false,
									elements: [...values].map(([label, value], index) => ({
										elementIndex: BigInt(index),
										depth: 0,
										role: "textbox",
										label,
										value,
										enabled: true,
										inWebContent: true,
										elementToken: `token-${version}-${index}`,
									})),
								},
							}),
						);
						proof(false);
					},
					startPlan(plan) {
						plans.push(plan);
						const steps = plan.steps.map((step, index): CuaSdk.ComputerStepResult => {
							if (sdk.ComputerStep.Fill.instanceOf(step)) {
								expect(sdk.ComputerAddress.Selector.instanceOf(step.inner.target)).toBe(true);
								if (!sdk.ComputerAddress.Selector.instanceOf(step.inner.target))
									throw new Error("fake supports only selectors");
								values.set(step.inner.target.inner.selector.label, step.inner.text);
								return {
									index,
									dispatch: sdk.ComputerDispatch.Dispatched,
									condition: sdk.ComputerCondition.Satisfied,
									elapsedMs: 1n,
									action: {
										effect: sdk.ActionEffect.Confirmed,
										route: sdk.ActionRoute.Dom,
										evidence: [{ kind: sdk.ActionEvidenceKind.ValueReadback }],
									},
								};
							}
							if (!sdk.ComputerStep.AssertValue.instanceOf(step)) throw new Error("unsupported fake action");
							expect(values.get(step.inner.selector.label)).toBe(step.inner.value);
							return {
								index,
								dispatch: sdk.ComputerDispatch.NotDispatched,
								condition: sdk.ComputerCondition.Satisfied,
								elapsedMs: 1n,
							};
						});
						resolve(
							new sdk.ComputerResult.Plan({
								value: {
									status: sdk.ComputerPlanStatus.Completed,
									completedSteps: steps.length,
									steps,
									elapsedMs: BigInt(steps.length),
								},
							}),
						);
						proof(true);
					},
					startClick() {
						throw new Error("No JS decomposition");
					},
					cancel() {},
					result: () => result,
					terminal: () => terminal,
				};
			},
		}),
		revoke() {},
		async close() {},
	};
	const createRuntime = vi.fn(() =>
		createControlledBrowserRuntime(
			{ host: native, destroy() {} },
			{ qualifiedBundle: "/qualified/CfT.app", privateParent: "/private/owned" },
		),
	);
	const host = new ComputerHost({ desktopId: "faux-browser-form", createRuntime });
	cleanups.push(() => host.close());
	const getApi = vi.fn(() => sdk);
	const binding = createControlledBrowserBinding(host.openSession(), getApi);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "computer-plan-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime,
		model: faux.getModel(),
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		resourceLoader: createTestResourceLoader(),
		...(mode !== "ordinary" ? { computer: binding } : {}),
		...(mode === "noTools" ? { noTools: "all" as const } : {}),
	});
	cleanups.push(async () => {
		await session.shutdown();
	});
	await session.bindExtensions({});
	return { session, faux, host, binding, createRuntime, getApi, plans, values };
}

describe.skipIf(!optedIn)(
	"isolated browser bridge through real SDK/AgentSession with faux model and fake desktop",
	() => {
		it("reduces the same eight-step form from 11 model requests to 5 including fixed bootstrap without an inner loop or scheduler", async () => {
			const counts: number[] = [];
			for (const batched of [false, true]) {
				const f = await fixture();
				expect(f.session.agent.executionScheduler).toBe(f.host.scheduler);
				const acquire = vi.spyOn(f.host.scheduler, "acquire");
				const steps: ExecuteRequest["steps"] = [...f.values.keys()].flatMap((label) => [
					{ op: "fill" as const, target: { selector: { role: "textbox", label } }, text: `value-${label}` },
					{ op: "assert_value" as const, selector: { role: "textbox", label }, value: `value-${label}` },
				]);
				const batches = batched
					? [steps]
					: [steps.slice(0, 2), steps.slice(2, 4), steps.slice(4, 6), steps.slice(6, 8)];
				const responses: FauxResponseStep[] = [
					fauxAssistantMessage(fauxToolCall("computer", { request: { op: "prepare" } }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage(
						fauxToolCall("computer", { request: { op: "navigate", url: "http://127.0.0.1/form" } }),
						{ stopReason: "toolUse" },
					),
				];
				for (const batch of batches) {
					responses.push(
						fauxAssistantMessage(fauxToolCall("computer", { request: { op: "observe" } }), {
							stopReason: "toolUse",
						}),
					);
					responses.push((context) => {
						const last = context.messages.filter((message) => message.role === "toolResult").at(-1);
						const text =
							last?.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n") ?? "";
						const ref = /Observation ref: ([^;]+)/.exec(text)?.[1];
						expect(ref).toBeTruthy();
						return fauxAssistantMessage(
							fauxToolCall("computer", { request: { op: "execute", ref, steps: batch } }),
							{ stopReason: "toolUse" },
						);
					});
				}
				responses.push(fauxAssistantMessage("All four fields verified."));
				f.faux.setResponses(responses);
				await f.session.prompt("Complete the four known form fields and verify each value.");
				counts.push(f.faux.state.callCount);
				expect(f.createRuntime).toHaveBeenCalledTimes(1);
				expect(f.plans).toHaveLength(batched ? 1 : 4);
				expect(acquire).toHaveBeenCalledTimes(batched ? 4 : 10);
				expect(f.host.scheduler.runningCount).toBe(0);
				for (const [label, value] of f.values) expect(value).toBe(`value-${label}`);
				const results = f.session.messages.filter((message) => message.role === "toolResult");
				expect(results.every((result) => !result.isError)).toBe(true);
				expect(results.at(-1)?.details).toMatchObject({ status: "completed", completedSteps: batched ? 8 : 2 });
				expect(
					f.session.messages.filter(
						(message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall"),
					),
				).toHaveLength(results.length);
				await f.session.shutdown();
				await f.host.close();
			}
			expect(counts).toEqual([11, 5]);
		});

		it.each(["ordinary", "noTools"] as const)(
			"%s mode does not construct a native runtime or expose the schema",
			async (mode) => {
				const f = await fixture(mode);
				f.faux.setResponses([
					(context) => {
						expect(context.tools?.some((tool) => tool.name === "computer")).not.toBe(true);
						return fauxAssistantMessage("Coding only.");
					},
				]);
				await f.session.prompt("Do not use the desktop.");
				expect(f.createRuntime).not.toHaveBeenCalled();
				expect(f.getApi).not.toHaveBeenCalled();
			},
		);

		it("forked/renewed bindings get independent schemas and no grants from a previous observation", async () => {
			const f = await fixture();
			const tool = f.session.agent.state.tools.find((tool) => tool.name === "computer")!;
			await tool.execute("o", { request: { op: "observe" } });
			for (const binding of [f.binding.fork(), f.binding.renew()]) {
				expect(binding.tools[0]).not.toBe(f.binding.tools[0]);
				expect(binding.scheduler).toBe(f.host.scheduler);
				await expect(
					binding.tools[0].execute(
						"p",
						{
							request: {
								op: "execute",
								ref: "snapshot-1",
								steps: [{ op: "fill", target: { selector: { role: "textbox", label: "Name" } }, text: "x" }],
							},
						},
						undefined,
						undefined,
						{} as never,
					),
				).rejects.toThrow("stale_observation");
				await binding.close();
			}
			expect(f.plans).toHaveLength(0);
		});
	},
);
