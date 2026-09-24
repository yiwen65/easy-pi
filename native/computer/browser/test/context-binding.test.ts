import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCredentialStore, type ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type * as CuaSdk from "@trycua/cua-driver";
import { ComputerHost } from "../../../../packages/coding-agent/src/core/computer/host.ts";
import { ModelRuntime } from "../../../../packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../../../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../../packages/coding-agent/src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../../../packages/coding-agent/test/utilities.ts";
import { ControlledComputerRuntime, type NativeOperation, type NativeSession } from "../../controlled/adapter.ts";
import { loadDesktopSdk } from "../../desktop/loader.ts";
import { createContextBrowserBinding } from "../context-binding.ts";

const allowed = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
if (allowed) {
	assert.equal(process.env.ALLOW_GUI_TESTS, "false");
	assert.equal(process.env.ALLOW_REAL_APIS, "false");
	assert.ok(process.env.CUA_DRIVER_TYPESCRIPT_DIR);
}
const sdk = allowed ? loadDesktopSdk(process.env.CUA_DRIVER_TYPESCRIPT_DIR!) : undefined;

async function fixture(option = false) {
	assert.ok(sdk);
	const api = sdk;
	let plans = 0;
	let observes = 0;
	const forbidden = () => {
		throw new Error("Unexpected native route");
	};
	const nativeSession = (): NativeSession => ({
		revoke() {},
		async close() {},
		newOperation(): NativeOperation {
			let resolve!: (result: CuaSdk.ComputerResult) => void;
			let proof!: (receipt: CuaSdk.ComputerTerminal) => void;
			const result = new Promise<CuaSdk.ComputerResult>((accept) => {
				resolve = accept;
			});
			const terminal = new Promise<CuaSdk.ComputerTerminal>((accept) => {
				proof = accept;
			});
			const finish = (value: CuaSdk.ComputerResult, inputCommitted: boolean) => {
				resolve(value);
				proof({ operationId: "fake", cancelled: false, inputCommitted });
			};
			return {
				startObserve() {
					const snapshotId = `browser-${++observes}`;
					finish(
						new api.ComputerResult.Observation({
							value: {
								pid: 42,
								windowId: 7n,
								snapshotId,
								images: [],
								elementsComplete: true,
								degraded: false,
								truncated: false,
								elements: [
									{
										elementIndex: 0n,
										depth: 0,
										role: option ? "option" : "textbox",
										actions: option ? ["select_option"] : ["fill"],
										label: "Name",
										value: "",
										enabled: true,
										inWebContent: true,
										elementToken: `${snapshotId}:0`,
									},
								],
							},
						}),
						false,
					);
				},
				startPlan(plan) {
					plans++;
					finish(
						new api.ComputerResult.Plan({
							value: {
								status: api.ComputerPlanStatus.Completed,
								completedSteps: plan.steps.length,
								elapsedMs: 1n,
								steps: plan.steps.map((_, index) => ({
									index,
									dispatch: api.ComputerDispatch.Dispatched,
									condition: api.ComputerCondition.Satisfied,
									elapsedMs: 1n,
									action: {
										effect: api.ActionEffect.Confirmed,
										route: api.ActionRoute.Dom,
										evidence: [{ kind: api.ActionEvidenceKind.ValueReadback }],
									},
								})),
							},
						}),
						true,
					);
				},
				startClick() {
					plans++;
					finish(
						new api.ComputerResult.Action({
							value: { effect: api.ActionEffect.Unverifiable, route: api.ActionRoute.Dom },
						}),
						true,
					);
				},
				startSegment: forbidden,
				startCrossWindowDrag: forbidden,
				startPrepare: forbidden,
				startNavigate: forbidden,
				startCapture: forbidden,
				startImageClick: forbidden,
				startImageScroll: forbidden,
				startImageKey: forbidden,
				startListWindows: forbidden,
				startSelectWindow: forbidden,
				cancel() {},
				result: () => result,
				terminal: () => terminal,
			};
		},
	});
	const host = new ComputerHost({
		desktopId: "browser-context",
		createRuntime: () =>
			new ControlledComputerRuntime(
				{
					host: { openSession: nativeSession, revoke() {}, async close() {} },
					destroy() {},
				},
				nativeSession,
			),
	});
	const binding = createContextBrowserBinding(host.openSession(), () => api);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "browser-context-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		modelRuntime,
		model: faux.getModel(),
		computer: binding,
		sessionManager: SessionManager.inMemory(process.cwd()),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		resourceLoader: createTestResourceLoader(),
	});
	const tool = session.agent.state.tools.find((candidate) => candidate.name === "computer");
	assert.ok(tool);
	return {
		host,
		binding,
		tool,
		async close() {
			await session.shutdown();
			await host.close();
		},
		get plans() {
			return plans;
		},
	};
}

const execute = (ref: string) => ({
	request: {
		op: "execute",
		ref,
		steps: [{ op: "fill", target: { selector: { role: "textbox", label: "Name" } }, text: "value-Name" }],
	},
});

for (const visible of [true, false])
	for (const action of ["execute", "click", "select_option"] as const) {
		test(
			`browser ${action} requires the exact canonical observation: visible=${visible}`,
			{ skip: !sdk },
			async (t) => {
				const f = await fixture(action === "select_option");
				t.after(() => f.close());
				const seen = await f.tool.execute("observation", { request: { op: "observe" } });
				assert.ok(typeof seen.details === "object" && seen.details !== null && "observationRef" in seen.details);
				const ref = seen.details.observationRef;
				assert.ok(typeof ref === "string");
				const message: ToolResultMessage = {
					role: "toolResult",
					toolCallId: "observation",
					toolName: "computer",
					content: seen.content,
					isError: false,
					timestamp: 1,
				};
				f.binding.observeContext?.(false, visible ? [message] : []);
				const input = action === "execute" ? execute(ref) : { request: { op: action, ref, target: `${ref}:0` } };
				if (visible) await f.tool.execute("input", input);
				else {
					// Persisted history cannot restore authority after omission.
					f.binding.observeContext?.(false, [message]);
					await assert.rejects(f.tool.execute("input", input), /current model view/);
				}
				assert.equal(f.plans, visible ? 1 : 0);
			},
		);
	}

test(
	"browser cancellation clears a previously published observation before later context delivery",
	{ skip: !sdk },
	async (t) => {
		const f = await fixture();
		t.after(() => f.close());
		const seen = await f.tool.execute("observation", { request: { op: "observe" } });
		assert.ok(typeof seen.details === "object" && seen.details !== null && "observationRef" in seen.details);
		f.binding.cancel();
		f.binding.observeContext?.(true, [
			{
				role: "toolResult",
				toolCallId: "observation",
				toolName: "computer",
				content: seen.content,
				isError: false,
				timestamp: 1,
			},
		]);
		await assert.rejects(f.tool.execute("input", execute(String(seen.details.observationRef))), /current model view/);
		assert.equal(f.plans, 0);
	},
);
