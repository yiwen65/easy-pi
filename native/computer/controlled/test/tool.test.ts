import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type * as CuaSdk from "@trycua/cua-driver";
import { ComputerHost } from "../../../../packages/coding-agent/src/core/computer/host.ts";
import { ControlledComputerRuntime, type NativeHost, type NativeOperation, type NativeResult } from "../adapter.ts";
import { parseControlledComputerInput } from "../contracts.ts";
import { loadControlledSdk } from "../loader.ts";
import { createControlledComputerTool } from "../tool.ts";

const allowed = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
if (allowed) {
	assert.equal(process.env.ALLOW_GUI_TESTS, "false");
	assert.equal(process.env.ALLOW_REAL_APIS, "false");
	assert.ok(process.env.CUA_DRIVER_TYPESCRIPT_DIR);
}
const sdk = allowed ? loadControlledSdk(process.env.CUA_DRIVER_TYPESCRIPT_DIR!) : undefined;
const selector = { role: "AXTextField", label: "Name" };
const execute = (ref = "snapshot-1") => ({
	request: {
		op: "execute" as const,
		ref,
		steps: [{ op: "fill" as const, target: { selector }, text: "PRIVATE-INPUT" }],
	},
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

function fixture(
	options: {
		observation?: Partial<CuaSdk.WindowStateOutput>;
		plan?: CuaSdk.ComputerPlanResult;
		reject?: unknown;
		committed?: boolean;
		holdTerminal?: boolean;
	} = {},
) {
	assert.ok(sdk);
	const api = sdk;
	let creates = 0;
	let apiGets = 0;
	let starts = 0;
	let cancellations = 0;
	const plans: CuaSdk.ComputerPlan[] = [];
	const terminal = deferred<void>();
	const started = deferred<void>();
	const native: NativeHost = {
		openSession: () => ({
			revoke() {},
			async close() {},
			newOperation(): NativeOperation {
				const result = deferred<NativeResult>();
				const proof = deferred<CuaSdk.ComputerTerminal>();
				const complete = () => {
					starts++;
					started.resolve();
					void (options.holdTerminal ? terminal.promise : Promise.resolve()).then(() =>
						proof.resolve({
							operationId: `op-${starts}`,
							cancelled: false,
							inputCommitted: options.committed ?? false,
						}),
					);
				};
				return {
					startObserve() {
						result.resolve(
							new api.ComputerResult.Observation({
								value: {
									pid: 42,
									windowId: 9007199254740993n,
									snapshotId: "snapshot-1",
									images: [],
									elementsComplete: true,
									truncated: false,
									degraded: false,
									elements: [
										{
											elementIndex: 0n,
											depth: 0,
											...selector,
											value: "",
											enabled: true,
											inWebContent: false,
											elementToken: "token-1",
										},
									],
									...options.observation,
								},
							}),
						);
						complete();
					},
					startClick() {
						throw new Error("tool must not decompose a segment into JS clicks");
					},
					startPlan(plan) {
						plans.push(plan);
						if (options.reject) result.reject(options.reject);
						else
							result.resolve(
								new api.ComputerResult.Plan({
									value: options.plan ?? {
										status: api.ComputerPlanStatus.Completed,
										completedSteps: plan.steps.length,
										elapsedMs: 9n,
										steps: plan.steps.map((_, index) => ({
											index,
											dispatch: api.ComputerDispatch.Dispatched,
											condition: api.ComputerCondition.Satisfied,
											elapsedMs: 3n,
											action: {
												effect: api.ActionEffect.Unverifiable,
												route: api.ActionRoute.Accessibility,
												delivery: { mode: api.ActionDeliveryMode.Background },
												evidence: [],
											},
										})),
									},
								}),
							);
						complete();
					},
					cancel() {
						cancellations++;
					},
					result: () => result.promise,
					terminal: () => proof.promise,
				};
			},
		}),
		revoke() {},
		async close() {},
	};
	const host = new ComputerHost({
		desktopId: "native-tool-fixture",
		createRuntime: () => {
			creates++;
			return new ControlledComputerRuntime({ host: native, destroy() {} }, { pid: 42, windowId: 9007199254740993n });
		},
	});
	const capability = host.openSession();
	const getApi = () => {
		apiGets++;
		return api;
	};
	const tool = createControlledComputerTool(capability, getApi);
	return {
		host,
		capability,
		tool,
		plans,
		terminal,
		started,
		getApi,
		get creates() {
			return creates;
		},
		get apiGets() {
			return apiGets;
		},
		get starts() {
			return starts;
		},
		get cancellations() {
			return cancellations;
		},
	};
}

const observe = { request: { op: "observe" as const } };

test("native form schema rejects private fields, ambiguous addresses, invalid bounds and aggregate UTF-8 overflow without echo", () => {
	for (const value of [
		{ ...execute(), permission: "PRIVATE" },
		{ request: { ...execute().request, script: "PRIVATE" } },
		{ request: { ...execute().request, steps: [] } },
		{ request: { ...execute().request, steps: Array(9).fill(execute().request.steps[0]) } },
		{ request: { ...execute().request, steps: [{ op: "fill", target: { ref: "a", selector }, text: "PRIVATE" }] } },
		{
			request: {
				...execute().request,
				steps: [{ op: "fill", target: { selector: { ...selector, label: "界".repeat(100) } }, text: "PRIVATE" }],
			},
		},
		{ request: { ...execute().request, steps: [{ op: "fill", target: { selector }, text: "界".repeat(6000) }] } },
	])
		assert.throws(
			() => parseControlledComputerInput(value),
			(error: unknown) => error instanceof Error && !error.message.includes("PRIVATE"),
		);
	const input = execute();
	const parsed = parseControlledComputerInput(input);
	input.request.steps[0]!.text = "changed";
	assert.notDeepEqual(input, parsed);
});

test("the optional tool and schema import with no SDK resolution or native load", () => {
	const guard = `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
 if (specifier.includes('@trycua') || specifier.endsWith('.node')) throw new Error('native import');
 return next(specifier, context);
}}); process.dlopen = () => { throw new Error('native load'); };`;
	const child = spawnSync(
		process.execPath,
		[
			"--import",
			`data:text/javascript,${encodeURIComponent(guard)}`,
			"--input-type=module",
			"--eval",
			`import ${JSON.stringify(new URL("../tool.ts", import.meta.url).href)};`,
		],
		{ encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
	);
	assert.equal(child.error, undefined);
	assert.equal(child.status, 0, child.stderr);
});

test(
	"genuine generated plans keep two address types and preserve per-step unconfirmed facts",
	{ skip: !sdk },
	async (t) => {
		const f = fixture();
		t.after(() => f.host.close());
		assert.equal(f.creates, 0);
		assert.equal(f.apiGets, 0);
		const seen = await f.tool.execute("o", observe);
		assert.match(JSON.stringify(seen.content), /selector/);
		assert.equal(seen.details.nativeComplete, true);
		const result = await f.tool.execute("p", {
			request: {
				...execute().request,
				steps: [
					{ op: "fill", target: { ref: "token-1" }, text: "PRIVATE-INPUT" },
					{ op: "press", target: { selector }, expect: selector, value: "PRIVATE-INPUT" },
					{ op: "assert_value", selector, value: "PRIVATE-INPUT" },
				],
			},
		});
		assert.equal(f.plans.length, 1);
		assert.ok(sdk!.ComputerStep.Fill.instanceOf(f.plans[0]!.steps[0]));
		assert.ok(sdk!.ComputerAddress.Ref.instanceOf(f.plans[0]!.steps[0]!.inner.target));
		assert.ok(sdk!.ComputerStep.Press.instanceOf(f.plans[0]!.steps[1]));
		assert.equal(result.details.status, "completed");
		assert.equal(result.details.steps?.[0]?.action?.effect, "unverifiable");
		assert.equal(result.details.steps?.[0]?.condition, "satisfied");
		assert.equal(result.details.elapsedMs, "9");
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE-INPUT|9007199254740993/);
		await assert.rejects(f.tool.execute("again", execute()), /stale_observation/);
		assert.equal(f.plans.length, 1);
	},
);

test("incomplete, degraded, web and ambiguous observations never grant selectors", { skip: !sdk }, async (t) => {
	const row = { elementIndex: 0n, depth: 0, ...selector, enabled: true, inWebContent: false, elementToken: "token-1" };
	for (const observation of [
		{ elementsComplete: false },
		{ truncated: true },
		{ degraded: true },
		{ elements: [{ ...row, inWebContent: true }] },
		{ elements: [row, { ...row, elementIndex: 1n, elementToken: "token-2" }] },
	]) {
		const f = fixture({ observation });
		t.after(() => f.host.close());
		await f.tool.execute("o", observe);
		await assert.rejects(f.tool.execute("p", execute()), /stale_observation/);
		assert.equal(f.plans.length, 0);
	}
});

test(
	"the 4 KiB view never grants dropped rows or copies tree, image or app metadata to details",
	{ skip: !sdk },
	async (t) => {
		const f = fixture({
			observation: {
				appName: "PRIVATE-APP",
				treeMarkdown: "PRIVATE-TREE",
				elements: [
					{
						elementIndex: 0n,
						depth: 0,
						...selector,
						enabled: true,
						inWebContent: false,
						value: "x".repeat(5000),
						elementToken: "token-1",
					},
				],
			},
		});
		t.after(() => f.host.close());
		const result = await f.tool.execute("o", observe);
		assert.equal(result.details.viewTruncated, true);
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE|xxxxx|token-1/);
		await assert.rejects(f.tool.execute("p", execute()), /stale_observation/);
		assert.equal(f.plans.length, 0);
	},
);

test("a lost committed result stays unknown, is drained and never replayed", { skip: !sdk }, async (t) => {
	const f = fixture({ reject: new Error("PRIVATE-NATIVE"), committed: true });
	t.after(() => f.host.close());
	await f.tool.execute("o", observe);
	await assert.rejects(
		f.tool.execute("p", execute()),
		(error: unknown) =>
			error instanceof Error && error.message.includes("outcome_unknown") && !error.message.includes("PRIVATE"),
	);
	assert.equal(f.plans.length, 1);
	await assert.rejects(f.tool.execute("p2", execute()), /stale_observation/);
	assert.equal(f.plans.length, 1);
});

test(
	"partial plan reports its completed prefix and safe code without treating unknown as success",
	{ skip: !sdk },
	async (t) => {
		assert.ok(sdk);
		const f = fixture({
			plan: {
				status: sdk.ComputerPlanStatus.OutcomeUnknown,
				completedSteps: 0,
				firstUnfinishedStep: 0,
				elapsedMs: 4n,
				steps: [
					{
						index: 0,
						dispatch: sdk.ComputerDispatch.Unknown,
						condition: sdk.ComputerCondition.Unknown,
						code: "PRIVATE",
						elapsedMs: 4n,
					},
				],
			},
		});
		t.after(() => f.host.close());
		await f.tool.execute("o", observe);
		await assert.rejects(
			f.tool.execute("p", execute()),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes('"dispatch":"unknown"') &&
				error.message.includes("First unfinished step: 0") &&
				!error.message.includes("PRIVATE"),
		);
	},
);

test(
	"result readiness cannot publish a view before terminal proof; renewed tools have no old grants",
	{ skip: !sdk },
	async (t) => {
		const f = fixture({ holdTerminal: true });
		t.after(() => f.host.close());
		let finished = false;
		const pending = f.tool.execute("o", observe).then((result) => {
			finished = true;
			return result;
		});
		await f.started.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(finished, false);
		f.terminal.resolve();
		await pending;
		const fresh = f.capability.renew();
		const freshTool = createControlledComputerTool(fresh, f.getApi);
		await assert.rejects(freshTool.execute("p", execute()), /stale_observation/);
		assert.equal(f.plans.length, 0);
		await fresh.close();
	},
);
