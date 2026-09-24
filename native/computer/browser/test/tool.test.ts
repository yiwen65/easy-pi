import assert from "node:assert/strict";
import { test } from "node:test";
import type * as CuaSdk from "@trycua/cua-driver";
import { ComputerHost } from "../../../../packages/coding-agent/src/core/computer/host.ts";
import type { NativeOperation, NativeResult } from "../../controlled/adapter.ts";
import { type BrowserNativeHost, createControlledBrowserRuntime } from "../adapter.ts";
import { loadBrowserSdk } from "../loader.ts";
import { createControlledBrowserTool } from "../tool.ts";

const allowed = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
if (allowed) {
	assert.equal(process.env.ALLOW_GUI_TESTS, "false");
	assert.equal(process.env.ALLOW_REAL_APIS, "false");
	assert.ok(process.env.CUA_DRIVER_TYPESCRIPT_DIR);
}
const sdk = allowed ? loadBrowserSdk(process.env.CUA_DRIVER_TYPESCRIPT_DIR!) : undefined;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

function fixture(options: { web?: boolean; rejectNavigation?: boolean; prepareFailure?: string } = {}) {
	assert.ok(sdk);
	const api = sdk;
	const calls: string[] = [];
	const plans: CuaSdk.ComputerPlan[] = [];
	let creates = 0;
	let snapshots = 0;
	const native: BrowserNativeHost = {
		openSession() {
			throw new Error("No fake native-window target");
		},
		openBrowserSession: () => ({
			revoke() {},
			async close() {},
			newOperation(): NativeOperation {
				const result = deferred<NativeResult>();
				const receipt = deferred<CuaSdk.ComputerTerminal>();
				const complete = (name: string, value: NativeResult, committed: boolean) => {
					calls.push(name);
					result.resolve(value);
					receipt.resolve({ operationId: `op-${calls.length}`, cancelled: false, inputCommitted: committed });
				};
				return {
					startPrepare() {
						if (options.prepareFailure) {
							calls.push("prepare-refused");
							result.reject(new api.ComputerError.Refused({ reason: options.prepareFailure }));
							receipt.resolve({ operationId: "refused", cancelled: false, inputCommitted: false });
							return;
						}
						complete("prepare", new api.ComputerResult.BrowserPrepared({ pid: 42, windowId: 7n }), true);
					},
					startNavigate() {
						if (options.rejectNavigation) {
							calls.push("navigate-refused");
							result.reject(new api.ComputerError.Refused({ reason: "permission_denied" }));
							receipt.resolve({ operationId: "refused", cancelled: false, inputCommitted: false });
						} else
							complete(
								"navigate",
								new api.ComputerResult.Action({
									value: {
										effect: api.ActionEffect.Unverifiable,
										route: api.ActionRoute.Dom,
										delivery: { mode: api.ActionDeliveryMode.Background, deliveredCount: 1 },
									},
								}),
								true,
							);
					},
					startObserve() {
						const snapshotId = `b-snapshot-${++snapshots}`;
						complete(
							"observe",
							new api.ComputerResult.Observation({
								value: {
									pid: 42,
									windowId: 7n,
									snapshotId,
									images: [],
									elementsComplete: true,
									truncated: false,
									degraded: false,
									elements: [
										{
											elementIndex: 0n,
											depth: 0,
											role: "textbox",
											label: "Name",
											value: "",
											enabled: true,
											inWebContent: options.web ?? true,
											elementToken: `${snapshotId}:0`,
										},
									],
								},
							}),
							false,
						);
					},
					startClick() {
						throw new Error("No JavaScript decomposition of native plans");
					},
					startPlan(plan) {
						plans.push(plan);
						complete(
							"plan",
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
					cancel() {},
					result: () => result.promise,
					terminal: () => receipt.promise,
				};
			},
		}),
		revoke() {},
		async close() {},
	};
	const host = new ComputerHost({
		desktopId: "browser-tool-fixture",
		createRuntime: () => {
			creates++;
			return createControlledBrowserRuntime(
				{ host: native, destroy() {} },
				{ qualifiedBundle: "/qualified/CfT.app", privateParent: "/private/owned" },
			);
		},
	});
	const tool = createControlledBrowserTool(host.openSession(), () => api);
	return {
		host,
		tool,
		calls,
		plans,
		get creates() {
			return creates;
		},
	};
}

const execute = (ref: string) => ({
	request: {
		op: "execute" as const,
		ref,
		steps: [{ op: "fill" as const, target: { selector: { role: "textbox", label: "Name" } }, text: "value-Name" }],
	},
});

test(
	"prepare preserves fixed preflight diagnostics without exposing arbitrary native text",
	{ skip: !sdk },
	async () => {
		for (const reason of [
			"image_path_unavailable",
			"image_catalog_unavailable",
			"image_catalog_changed",
			"browser_parent_unqualified",
			"private detail /secret",
		]) {
			const f = fixture({ prepareFailure: reason });
			try {
				await assert.rejects(f.tool.execute("prepare", { request: { op: "prepare" } }), (error: unknown) => {
					assert.ok(error && typeof error === "object" && "details" in error);
					assert.deepEqual(error.details, {
						status: "paused",
						completedSteps: 0,
						code: reason.startsWith("private") ? "native_fault" : reason,
					});
					return true;
				});
				assert.deepEqual(f.calls, ["prepare-refused"]);
			} finally {
				await f.host.close();
			}
		}
	},
);

test(
	"browser bridge is lazy and sends one native segment through the ordinary outer resource",
	{ skip: !sdk },
	async (t) => {
		const f = fixture();
		t.after(() => f.host.close());
		assert.equal(f.creates, 0);
		assert.equal(f.tool.contract?.approval, "never");
		assert.deepEqual(f.tool.executionResource, { key: "desktop:browser-tool-fixture", mode: "exclusive" });
		for (const op of ["prepare", "navigate"] as const) {
			const lease = await f.host.scheduler.acquire(f.tool.executionResource!);
			try {
				const result = await f.tool.execute(op, {
					request: op === "prepare" ? { op } : { op, url: "http://127.0.0.1/form" },
				});
				assert.equal(result.details.status, op === "prepare" ? "prepared" : "navigation_submitted");
			} finally {
				lease?.release();
			}
		}
		const seen = await f.tool.execute("observe", { request: { op: "observe" } });
		assert.equal(seen.details.status, "observed");
		assert.ok("observationRef" in seen.details && seen.details.observationRef);
		const result = await f.tool.execute("plan", execute(seen.details.observationRef));
		assert.equal(result.details.status, "completed");
		assert.equal(f.plans.length, 1);
		assert.deepEqual(f.calls, ["prepare", "navigate", "observe", "plan"]);
	},
);

test("even a refused navigation invalidates model-visible refs and selectors", { skip: !sdk }, async (t) => {
	const f = fixture({ rejectNavigation: true });
	t.after(() => f.host.close());
	const seen = await f.tool.execute("o", { request: { op: "observe" } });
	assert.ok("observationRef" in seen.details && seen.details.observationRef);
	await assert.rejects(f.tool.execute("n", { request: { op: "navigate", url: "http://127.0.0.1/other" } }), /paused/);
	await assert.rejects(f.tool.execute("p", execute(seen.details.observationRef)), /stale_observation/);
	assert.equal(f.plans.length, 0);
});

test("browser profile never turns native-window rows into browser grants", { skip: !sdk }, async (t) => {
	const f = fixture({ web: false });
	t.after(() => f.host.close());
	const seen = await f.tool.execute("o", { request: { op: "observe" } });
	assert.ok("observationRef" in seen.details && seen.details.observationRef);
	await assert.rejects(f.tool.execute("p", execute(seen.details.observationRef)), /stale_observation/);
	assert.equal(f.plans.length, 0);
});
