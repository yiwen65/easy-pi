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

function fixture(
	options: {
		web?: boolean;
		rejectNavigation?: boolean;
		navigationFailure?: string;
		navigationCommitted?: boolean;
		prepareFailure?: string;
		prepareTerminal?: Promise<void>;
		clickEffect?: CuaSdk.ActionEffect;
		scrollable?: boolean;
		scrollFailure?: string;
		scrollCommitted?: boolean;
		option?: boolean;
		noise?: number;
		blankStructure?: boolean;
		presentationNoise?: boolean;
		selectionState?: boolean;
		tabLinks?: boolean;
		presentationTextValue?: string;
		duplicate?: boolean;
		observeFailureAfter?: number;
		clickTerminal?: Promise<void>;
		followupTerminal?: Promise<void>;
	} = {},
) {
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
					const terminal = { operationId: `op-${calls.length}`, cancelled: false, inputCommitted: committed };
					if (name === "prepare" && options.prepareTerminal)
						void options.prepareTerminal.then(() => receipt.resolve(terminal));
					else if ((name === "click" || name === "scroll") && options.clickTerminal)
						void options.clickTerminal.then(() => receipt.resolve(terminal));
					else if (name === "observe" && snapshots > 1 && options.followupTerminal)
						void options.followupTerminal.then(() => receipt.resolve(terminal));
					else receipt.resolve(terminal);
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
						if (options.rejectNavigation || options.navigationFailure) {
							calls.push("navigate-refused");
							result.reject(
								new api.ComputerError.Refused({ reason: options.navigationFailure ?? "permission_denied" }),
							);
							receipt.resolve({
								operationId: "refused",
								cancelled: false,
								inputCommitted: options.navigationCommitted ?? false,
							});
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
						if (options.observeFailureAfter !== undefined && snapshots > options.observeFailureAfter) {
							calls.push("observe-refused");
							result.reject(new api.ComputerError.Refused({ reason: "browser_frame_changed" }));
							receipt.resolve({ operationId: "read-refused", cancelled: false, inputCommitted: false });
							return;
						}
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
										...(options.tabLinks
											? [
													{ label: "Activate First", parentIndex: 300n },
													{ label: "Activate Second", parentIndex: 301n },
													{ label: "Missing parent", parentIndex: 999n },
													{ label: "Non-tab parent", parentIndex: 0n },
												].map((row, index) => ({
													...row,
													role: "link",
													elementIndex: BigInt(400 + index),
													depth: 2,
													inWebContent: true,
													actions: ["press"],
													elementToken: `${snapshotId}:link-${index}`,
												}))
											: []),
										...(options.selectionState
											? [
													{ role: "tab", label: "First", selected: snapshots === 1, actions: ["press"] },
													{ role: "tab", label: "Second", selected: snapshots !== 1, actions: ["press"] },
													{ role: "none", label: "", selected: false, enabled: false },
													{ role: "StaticText", label: "Selection" },
													{ role: "InlineTextBox", label: "Selection", selected: true },
												].map((row, index) => ({
													...row,
													elementIndex: BigInt(300 + index),
													depth: 1,
													inWebContent: true,
													elementToken: `${snapshotId}:selection-${index}`,
												}))
											: []),
										...Array.from({ length: options.noise ?? 0 }, (_, index) => ({
											elementIndex: BigInt(index + 2),
											depth: 0,
											role: options.blankStructure ? "generic" : "none",
											actions: options.blankStructure ? ["scroll_into_view"] : [],
											label: options.blankStructure ? " " : "structure".repeat(20),
											inWebContent: true,
											enabled: false,
											elementToken: `${snapshotId}:noise-${index}`,
										})),
										{
											elementIndex: 0n,
											depth: 0,
											role: "textbox",
											actions: options.scrollable ? ["fill", "scroll_into_view"] : ["fill"],
											label: "Name",
											value: "",
											enabled: true,
											inWebContent: options.web ?? true,
											elementToken: `${snapshotId}:0`,
										},
										...(options.blankStructure
											? [
													{
														elementIndex: 100n,
														depth: 1,
														role: "StaticText",
														label: "Task body at end",
														inWebContent: true,
														elementToken: `${snapshotId}:body`,
													},
												]
											: []),
										...(options.duplicate
											? [
													{
														elementIndex: 101n,
														depth: 1,
														role: "textbox",
														label: "Name",
														value: "unique-value",
														actions: ["fill"],
														inWebContent: true,
														elementToken: `${snapshotId}:duplicate`,
													},
												]
											: []),
										...(options.option
											? [
													{
														elementIndex: 1n,
														depth: 1,
														role: "option",
														label: "Pro",
														valueDescription: "Plan",
														enabled: true,
														inWebContent: true,
														elementToken: `${snapshotId}:1`,
														actions: ["select_option"],
													},
												]
											: []),
										...(options.presentationNoise
											? [
													{
														role: "StaticText",
														label: "Repeated text",
														suffix: "text",
														...(options.presentationTextValue !== undefined
															? { value: options.presentationTextValue }
															: {}),
													},
													{ role: "InlineTextBox", label: "Repeated text", suffix: "duplicate" },
													{ role: "InlineTextBox", label: "Unique fragment", suffix: "unique" },
													{
														role: "InlineTextBox",
														label: "Repeated text",
														suffix: "value",
														value: "state",
													},
													{
														role: "InlineTextBox",
														label: "Repeated text",
														suffix: "action",
														actions: ["press"],
													},
													{ role: "none", label: "", suffix: "empty", enabled: false },
													{ role: "none", label: "Structural text", suffix: "labelled", enabled: false },
												].map(({ suffix, ...row }, index) => ({
													...row,
													elementIndex: BigInt(200 + index),
													depth: 1,
													inWebContent: true,
													elementToken: `${snapshotId}:${suffix}`,
												}))
											: []),
									],
								},
							}),
							false,
						);
					},
					startClick() {
						complete(
							"click",
							new api.ComputerResult.Action({
								value: {
									effect: options.clickEffect ?? api.ActionEffect.Unverifiable,
									route: api.ActionRoute.Dom,
									delivery: { mode: api.ActionDeliveryMode.Background, deliveredCount: 1 },
								},
							}),
							true,
						);
					},
					startScrollIntoView(token) {
						assert.equal(token, `b-snapshot-${snapshots}:0`);
						if (options.scrollFailure) {
							calls.push("scroll-refused");
							result.reject(new api.ComputerError.Refused({ reason: options.scrollFailure }));
							receipt.resolve({
								operationId: "refused",
								cancelled: false,
								inputCommitted: options.scrollCommitted ?? false,
							});
							return;
						}
						complete(
							"scroll",
							new api.ComputerResult.Action({
								value: {
									effect: options.clickEffect ?? api.ActionEffect.Unverifiable,
									route: api.ActionRoute.Dom,
								},
							}),
							true,
						);
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
	"prepare with URL waits for terminal, navigates once and returns usable observation",
	{ skip: !sdk },
	async (t) => {
		const terminal = deferred<void>();
		const f = fixture({ prepareTerminal: terminal.promise });
		t.after(() => f.host.close());
		const pending = f.tool.execute("open", { request: { op: "prepare", url: "about:blank" }, observeAfter: true });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(f.calls, ["prepare"]);
		terminal.resolve();
		const result = await pending;
		assert.equal(result.details.status, "navigation_submitted");
		assert.equal(result.details.observationRef, "b-snapshot-1");
		await f.tool.execute("fill", execute(result.details.observationRef!));
		assert.deepEqual(f.calls, ["prepare", "navigate", "observe", "plan"]);
	},
);

test("prepare with URL does not navigate after cancellation during terminal drain", { skip: !sdk }, async (t) => {
	const terminal = deferred<void>();
	const controller = new AbortController();
	const f = fixture({ prepareTerminal: terminal.promise });
	t.after(() => f.host.close());
	const pending = f.tool.execute(
		"open",
		{ request: { op: "prepare", url: "about:blank" }, observeAfter: true },
		controller.signal,
	);
	const rejected = assert.rejects(pending);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(f.calls, ["prepare"]);
	controller.abort();
	terminal.resolve();
	await rejected;
	assert.deepEqual(f.calls, ["prepare"]);
});

test("combined preparation stops at the first refused or unknown stage", { skip: !sdk }, async (t) => {
	for (const options of [
		{ prepareFailure: "permission_denied" },
		{ navigationFailure: "permission_denied" },
		{ navigationFailure: "unexpected_modal_surface", navigationCommitted: true },
		{ observeFailureAfter: 0 },
	]) {
		const f = fixture(options);
		t.after(() => f.host.close());
		await assert.rejects(
			f.tool.execute("open", { request: { op: "prepare", url: "about:blank" }, observeAfter: true }),
		);
		assert.deepEqual(
			f.calls,
			options.prepareFailure
				? ["prepare-refused"]
				: options.navigationFailure
					? ["prepare", "navigate-refused"]
					: ["prepare", "navigate", "observe-refused"],
		);
	}
});

test("prepare URL is validated before native creation and observation remains optional", { skip: !sdk }, async (t) => {
	const f = fixture();
	t.after(() => f.host.close());
	await assert.rejects(
		f.tool.execute("invalid", { request: { op: "prepare", url: "file:///private" }, observeAfter: true }),
		/Invalid/,
	);
	assert.equal(f.creates, 0);
	const result = await f.tool.execute("open", { request: { op: "prepare", url: "about:blank" } });
	assert.equal(result.details.status, "navigation_submitted");
	assert.equal(result.details.observationRef, undefined);
	assert.deepEqual(f.calls, ["prepare", "navigate"]);
});

test(
	"browser selected state preserves false, absence and fresh state through compaction",
	{ skip: !sdk },
	async (t) => {
		const f = fixture({ selectionState: true });
		t.after(() => f.host.close());
		const first = await f.tool.execute("o", { request: { op: "observe" } });
		const parseRows = (result: typeof first) =>
			result.content.flatMap((part) =>
				part.type === "text"
					? part.text
							.split("\n")
							.filter((line) => line.startsWith("{"))
							.map((line) => JSON.parse(line))
					: [],
			);
		const before = parseRows(first);
		assert.equal(before.find((row) => row.label === "First").selected, true);
		assert.equal(before.find((row) => row.label === "Second").selected, false);
		assert.equal(before.find((row) => row.label === "Name").selected, undefined);
		assert.equal(before.find((row) => row.role === "none")?.selected, false);
		assert.equal(before.find((row) => row.role === "InlineTextBox")?.selected, true);
		const next = await f.tool.execute("c", {
			request: { op: "click", ref: first.details.observationRef!, target: "b-snapshot-1:selection-1" },
			observeAfter: true,
		});
		assert.equal(parseRows(next).find((row) => row.label === "Second").selected, true);
		assert.equal(parseRows(next).find((row) => row.label === "First").selected, false);
		assert.deepEqual(f.calls, ["observe", "click", "observe"]);
	},
);

test(
	"tab link relationships come from native hierarchy without granting filtered parents",
	{ skip: !sdk },
	async (t) => {
		const f = fixture({ selectionState: true, tabLinks: true });
		t.after(() => f.host.close());
		const first = await f.tool.execute("o", { request: { op: "observe", text: "Activate" } });
		const parseRows = (result: typeof first) =>
			result.content.flatMap((part) =>
				part.type === "text"
					? part.text
							.split("\n")
							.filter((line) => line.startsWith("{"))
							.map((line) => JSON.parse(line))
					: [],
			);
		const before = parseRows(first);
		assert.deepEqual(before.find((row) => row.label === "Activate First").tab, { label: "First", selected: true });
		assert.deepEqual(before.find((row) => row.label === "Activate Second").tab, { label: "Second", selected: false });
		await assert.rejects(
			f.tool.execute("hidden", {
				request: { op: "click", ref: first.details.observationRef!, target: "b-snapshot-1:selection-0" },
			}),
			/stale_observation/,
		);
		const next = await f.tool.execute("all", { request: { op: "observe" } });
		const after = parseRows(next);
		assert.equal(after.find((row) => row.label === "Missing parent").tab, undefined);
		assert.equal(after.find((row) => row.label === "Non-tab parent").tab, undefined);
		assert.equal(after.find((row) => row.label === "Activate Second").tab.selected, true);
		await f.tool.execute("click", {
			request: { op: "click", ref: next.details.observationRef!, target: "b-snapshot-2:link-1" },
		});
		assert.deepEqual(f.calls, ["observe", "observe", "click"]);
	},
);

test("press rejects selected-only postconditions before dispatching the entire batch", { skip: !sdk }, async (t) => {
	for (const label of ["First", "Second"]) {
		const f = fixture({ selectionState: true });
		t.after(() => f.host.close());
		const seen = await f.tool.execute("o", { request: { op: "observe" } });
		await assert.rejects(
			f.tool.execute("p", {
				request: {
					op: "execute",
					ref: seen.details.observationRef!,
					steps: [
						{ op: "fill", target: { selector: { role: "textbox", label: "Name" } }, text: "must not run" },
						{
							op: "press",
							target: { selector: { role: "tab", label } },
							expect: { role: "tab", label },
							value: "true",
						},
					],
				},
			}),
			/postcondition_not_observed/,
		);
		assert.deepEqual(f.calls, ["observe"]);
		assert.equal(f.plans.length, 0);
	}
});

test("press retains explicitly observed empty-string value postconditions", { skip: !sdk }, async (t) => {
	const f = fixture();
	t.after(() => f.host.close());
	const seen = await f.tool.execute("o", { request: { op: "observe" } });
	const selector = { role: "textbox", label: "Name" };
	const result = await f.tool.execute("p", {
		request: {
			op: "execute",
			ref: seen.details.observationRef!,
			steps: [{ op: "press", target: { selector }, expect: selector, value: "changed" }],
		},
	});
	assert.equal(result.details.status, "completed");
	assert.deepEqual(f.calls, ["observe", "plan"]);
});

test(
	"scroll requires a displayed capability and consumes its observation without clicking",
	{ skip: !sdk },
	async (t) => {
		for (const scrollable of [false, true]) {
			const f = fixture({ scrollable });
			t.after(() => f.host.close());
			const seen = await f.tool.execute("o", { request: { op: "observe" } });
			const ref = seen.details.observationRef!;
			const input = { request: { op: "scroll_into_view" as const, ref, target: `${ref}:0` } };
			if (scrollable) {
				assert.match(JSON.stringify(seen.content), /scroll_into_view/);
				const result = await f.tool.execute("s", input);
				assert.equal(result.details.status, "action_submitted");
				assert.equal(result.details.effect, "unverifiable");
				assert.equal(result.details.completedSteps, 0);
			} else await assert.rejects(f.tool.execute("s", input), /action_unavailable/);
			await assert.rejects(f.tool.execute("retry", input), /stale_observation/);
			assert.deepEqual(f.calls, scrollable ? ["observe", "scroll"] : ["observe"]);
		}
	},
);

test("scroll follow-up waits for terminal and cancellation suppresses the read", { skip: !sdk }, async (t) => {
	for (const cancel of [false, true]) {
		const terminal = deferred<void>();
		const controller = new AbortController();
		const f = fixture({ scrollable: true, clickTerminal: terminal.promise });
		t.after(() => f.host.close());
		const seen = await f.tool.execute("o", { request: { op: "observe" } });
		const ref = seen.details.observationRef!;
		const pending = f.tool.execute(
			"s",
			{ request: { op: "scroll_into_view", ref, target: `${ref}:0` }, observeAfter: true },
			controller.signal,
		);
		const outcome = pending.then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(f.calls, ["observe", "scroll"]);
		if (cancel) controller.abort();
		terminal.resolve();
		const result = await outcome;
		if (cancel) assert.ok("error" in result);
		else {
			assert.ok("value" in result);
			assert.equal(result.value.details.observationRef, "b-snapshot-2");
		}
		assert.deepEqual(f.calls, cancel ? ["observe", "scroll"] : ["observe", "scroll", "observe"]);
	}
});

test("refused or unknown scrolling never starts a follow-up or replays", { skip: !sdk }, async (t) => {
	assert.ok(sdk);
	for (const effect of [sdk.ActionEffect.Refused, sdk.ActionEffect.Partial, sdk.ActionEffect.SuspectedNoop]) {
		const f = fixture({ scrollable: true, clickEffect: effect });
		t.after(() => f.host.close());
		const seen = await f.tool.execute("o", { request: { op: "observe" } });
		const ref = seen.details.observationRef!;
		const input = {
			request: { op: "scroll_into_view" as const, ref, target: `${ref}:0` },
			observeAfter: true as const,
		};
		await assert.rejects(
			f.tool.execute("s", input),
			effect === sdk.ActionEffect.Refused ? /paused/ : /outcome_unknown/,
		);
		await assert.rejects(f.tool.execute("retry", input), /stale_observation/);
		assert.deepEqual(f.calls, ["observe", "scroll"]);
	}
});

test("native stale scroll diagnostics preserve uncertainty and never refresh or replay", { skip: !sdk }, async (t) => {
	for (const committed of [false, true]) {
		for (const reason of ["stale_browser_observation", "private detail /secret"]) {
			const f = fixture({ scrollable: true, scrollFailure: reason, scrollCommitted: committed });
			t.after(() => f.host.close());
			const seen = await f.tool.execute("o", { request: { op: "observe" } });
			const ref = seen.details.observationRef!;
			const input = {
				request: { op: "scroll_into_view" as const, ref, target: `${ref}:0` },
				observeAfter: true as const,
			};
			const safeReason = reason.startsWith("private") ? "native_fault" : reason;
			await assert.rejects(f.tool.execute("s", input), (error: unknown) => {
				assert.ok(error instanceof Error && "details" in error);
				assert.deepEqual(error.details, {
					status: committed ? "outcome_unknown" : "paused",
					completedSteps: 0,
					code: committed ? "outcome_unknown" : safeReason,
					...(committed ? { cause: safeReason } : {}),
				});
				assert.doesNotMatch(error.message, /private detail|secret/);
				if (committed) assert.match(error.message, /Do not replay/);
				else if (reason === "stale_browser_observation") assert.match(error.message, /Observe again/);
				return true;
			});
			await assert.rejects(f.tool.execute("retry", input), /stale_observation/);
			assert.deepEqual(f.calls, ["observe", "scroll-refused"]);
		}
	}
});

test("filtered observations read fresh UI and grant only literal matches", { skip: !sdk }, async (t) => {
	const f = fixture({ noise: 60, blankStructure: true });
	t.after(() => f.host.close());
	await f.tool.execute("first", { request: { op: "observe" } });
	const seen = await f.tool.execute("search", { request: { op: "observe", text: "BODY AT END" } });
	assert.equal(seen.details.observationRef, "b-snapshot-2");
	assert.equal(seen.details.viewTruncated, false);
	assert.match(JSON.stringify(seen.content), /Task body at end/);
	assert.doesNotMatch(JSON.stringify(seen.content), /Name/);
	await assert.rejects(f.tool.execute("hidden", execute(seen.details.observationRef!)), /stale_observation/);
	const literal = await f.tool.execute("literal", { request: { op: "observe", text: ".*" } });
	assert.doesNotMatch(JSON.stringify(literal.content), /Task body at end|Name/);
	assert.deepEqual(f.calls, ["observe", "observe", "observe"]);
});

test("filtering does not turn duplicate selectors into unique targets", { skip: !sdk }, async (t) => {
	const f = fixture({ duplicate: true });
	t.after(() => f.host.close());
	const seen = await f.tool.execute("o", { request: { op: "observe", text: "unique-value" } });
	assert.match(JSON.stringify(seen.content), /duplicate/);
	assert.doesNotMatch(JSON.stringify(seen.content), /selector/);
	await assert.rejects(f.tool.execute("p", execute(seen.details.observationRef!)), /stale_observation/);
	assert.equal(f.plans.length, 0);
});

test(
	"browser observation retains meaningful text ahead of empty structure within the byte budget",
	{ skip: !sdk },
	async (t) => {
		const f = fixture({ noise: 60, blankStructure: true });
		t.after(() => f.host.close());
		const seen = await f.tool.execute("o", { request: { op: "observe" } });
		const text = seen.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		assert.match(text, /Task body at end/);
		assert.match(text, /Name/);
		assert.equal(seen.details.viewTruncated, true);
		assert.ok(Buffer.byteLength(text.split("Untrusted UI rows:\n")[1]!) <= 4096);
		await assert.rejects(
			f.tool.execute("hidden", {
				request: {
					op: "click",
					ref: seen.details.observationRef!,
					target: `${seen.details.observationRef}:noise-59`,
				},
			}),
			/stale_observation/,
		);
		assert.deepEqual(f.calls, ["observe"]);
	},
);

test(
	"browser presentation compaction preserves unique text, values, actions and reference boundaries",
	{ skip: !sdk },
	async (t) => {
		const f = fixture({ presentationNoise: true });
		t.after(() => f.host.close());
		const seen = await f.tool.execute("o", { request: { op: "observe" } });
		const text = seen.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
		for (const suffix of ["text", "unique", "value", "action", "labelled"])
			assert.ok(text.includes(`b-snapshot-1:${suffix}`));
		for (const suffix of ["duplicate", "empty"])
			assert.ok(!text.includes(`b-snapshot-1:${suffix}`), `presentation-only ${suffix} should be omitted`);
		assert.match(text, /Unique fragment/);
		assert.match(text, /Structural text/);
		assert.match(text, /"value":"state"/);
		assert.match(text, /"actions":\["press"\]/);
		assert.ok(!text.includes('"selector":{"role":"InlineTextBox","label":"Repeated text"}'));
		assert.equal(seen.details.presentationOmitted, 2);
		assert.equal(seen.details.viewTruncated, false);
		await assert.rejects(
			f.tool.execute("hidden", { request: { op: "click", ref: "b-snapshot-1", target: "b-snapshot-1:duplicate" } }),
			/stale_observation/,
		);
		assert.deepEqual(f.calls, ["observe"]);
	},
);

test("budget-dropped static text cannot suppress its visible inline copy", { skip: !sdk }, async (t) => {
	const f = fixture({ presentationNoise: true, presentationTextValue: "large".repeat(1000) });
	t.after(() => f.host.close());
	const seen = await f.tool.execute("o", { request: { op: "observe" } });
	const text = JSON.stringify(seen.content);
	assert.ok(!text.includes("b-snapshot-1:text"));
	assert.ok(text.includes("b-snapshot-1:duplicate"));
	assert.equal(seen.details.viewTruncated, true);
	assert.equal(seen.details.presentationOmitted, 1);
});

test("combined observations retain presentation counts and fresh actionable refs", { skip: !sdk }, async (t) => {
	const f = fixture({ presentationNoise: true });
	t.after(() => f.host.close());
	const first = await f.tool.execute("o", { request: { op: "observe" } });
	const next = await f.tool.execute("p", { ...execute(first.details.observationRef!), observeAfter: true });
	assert.equal(next.details.presentationOmitted, 2);
	assert.equal(next.details.observationRef, "b-snapshot-2");
	const clicked = await f.tool.execute("c", {
		request: { op: "click", ref: "b-snapshot-2", target: "b-snapshot-2:action" },
	});
	assert.equal(clicked.details.status, "action_submitted");
	assert.deepEqual(f.calls, ["observe", "plan", "observe", "click"]);
});

test("post-action observe waits for terminal and preserves submission facts", { skip: !sdk }, async (t) => {
	const terminal = deferred<void>();
	const f = fixture({ clickTerminal: terminal.promise });
	t.after(() => f.host.close());
	const seen = await f.tool.execute("o", { request: { op: "observe" } });
	const ref = seen.details.observationRef!;
	const pending = f.tool.execute("c", { request: { op: "click", ref, target: `${ref}:0` }, observeAfter: true });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(f.calls, ["observe", "click"]);
	terminal.resolve();
	const combined = await pending;
	assert.equal(combined.details.status, "action_submitted");
	assert.equal(combined.details.observationRef, "b-snapshot-2");
	assert.equal(combined.content.length, 2);
	assert.deepEqual(f.calls, ["observe", "click", "observe"]);
});

test("post-action read failure retains the completed action and never replays", { skip: !sdk }, async (t) => {
	const f = fixture({ observeFailureAfter: 1 });
	t.after(() => f.host.close());
	const seen = await f.tool.execute("o", { request: { op: "observe" } });
	await assert.rejects(
		f.tool.execute("p", { ...execute(seen.details.observationRef!), observeAfter: true }),
		(error: unknown) => {
			assert.ok(error instanceof Error && "details" in error);
			const details = error.details as {
				status: string;
				completedSteps: number;
				observationError: string;
				observationRef?: string;
			};
			assert.equal(details.status, "completed");
			assert.equal(details.completedSteps, 1);
			assert.equal(details.observationError, "browser_frame_changed");
			assert.equal(details.observationRef, undefined);
			assert.match(error.message, /Do not replay/);
			return true;
		},
	);
	assert.deepEqual(f.calls, ["observe", "plan", "observe-refused"]);
});

test("cancel during action terminal wait suppresses the optional read", { skip: !sdk }, async (t) => {
	const terminal = deferred<void>();
	const controller = new AbortController();
	const f = fixture({ clickTerminal: terminal.promise });
	t.after(() => f.host.close());
	const seen = await f.tool.execute("o", { request: { op: "observe" } });
	const ref = seen.details.observationRef!;
	const pending = f.tool.execute(
		"c",
		{ request: { op: "click", ref, target: `${ref}:0` }, observeAfter: true },
		controller.signal,
	);
	const rejected = assert.rejects(pending);
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	terminal.resolve();
	await rejected;
	assert.deepEqual(f.calls, ["observe", "click"]);
});

test(
	"follow-up observation waits for its own terminal and cancellation publishes no new ref",
	{ skip: !sdk },
	async (t) => {
		for (const cancel of [false, true]) {
			const terminal = deferred<void>();
			const controller = new AbortController();
			const f = fixture({ followupTerminal: terminal.promise });
			t.after(() => f.host.close());
			const seen = await f.tool.execute("o", { request: { op: "observe" } });
			let settled = false;
			const pending = f.tool
				.execute("p", { ...execute(seen.details.observationRef!), observeAfter: true }, controller.signal)
				.then(
					(value) => {
						settled = true;
						return { value };
					},
					(error: unknown) => {
						settled = true;
						return { error };
					},
				);
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(f.calls, ["observe", "plan", "observe"]);
			assert.equal(settled, false);
			if (cancel) controller.abort();
			terminal.resolve();
			const outcome = await pending;
			if (cancel) {
				assert.ok("error" in outcome);
				assert.ok(outcome.error instanceof Error && "details" in outcome.error);
				const details = outcome.error.details as {
					status: string;
					completedSteps: number;
					observationRef?: string;
				};
				assert.equal(details.status, "completed");
				assert.equal(details.completedSteps, 1);
				assert.equal(details.observationRef, undefined);
			} else {
				assert.ok("value" in outcome);
				assert.equal(outcome.value.details.observationRef, "b-snapshot-2");
			}
		}
	},
);

test("unknown navigation and refused clicks never start post-action reads", { skip: !sdk }, async (t) => {
	assert.ok(sdk);
	const navigation = fixture({ navigationFailure: "unexpected_modal_surface", navigationCommitted: true });
	t.after(() => navigation.host.close());
	await assert.rejects(
		navigation.tool.execute("n", { request: { op: "navigate", url: "about:blank" }, observeAfter: true }),
		/outcome_unknown/,
	);
	assert.deepEqual(navigation.calls, ["navigate-refused"]);
	const click = fixture({ clickEffect: sdk.ActionEffect.Refused });
	t.after(() => click.host.close());
	const seen = await click.tool.execute("o", { request: { op: "observe" } });
	const ref = seen.details.observationRef!;
	await assert.rejects(
		click.tool.execute("c", { request: { op: "click", ref, target: `${ref}:0` }, observeAfter: true }),
		/paused/,
	);
	assert.deepEqual(click.calls, ["observe", "click"]);
});

test("committed navigation retains a safe cause without downgrading unknown outcome", { skip: !sdk }, async (t) => {
	for (const reason of ["unexpected_modal_surface", "private detail /secret"]) {
		const f = fixture({ navigationFailure: reason, navigationCommitted: true });
		t.after(() => f.host.close());
		await assert.rejects(
			f.tool.execute("n", { request: { op: "navigate", url: "http://127.0.0.1/" } }),
			(error: unknown) => {
				assert.ok(error instanceof Error && "details" in error);
				assert.deepEqual(error.details, {
					status: "outcome_unknown",
					completedSteps: 0,
					code: "outcome_unknown",
					cause: reason.startsWith("private") ? "native_fault" : reason,
				});
				assert.match(error.message, /Do not replay/);
				assert.doesNotMatch(error.message, /private detail|secret/);
				return true;
			},
		);
		assert.deepEqual(f.calls, ["navigate-refused"]);
	}
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
		assert.match(f.tool.description, /Password\/file input, dragging and tab switching are unsupported/);
		assert.match(f.tool.description, /repeated observation or scrolling cannot enable them/);
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

test(
	"click uses one observed token, reports submission only and consumes the observation",
	{ skip: !sdk },
	async (t) => {
		const f = fixture();
		t.after(() => f.host.close());
		const seen = await f.tool.execute("o", { request: { op: "observe" } });
		assert.ok("observationRef" in seen.details && seen.details.observationRef);
		const input = {
			request: {
				op: "click" as const,
				ref: seen.details.observationRef,
				target: `${seen.details.observationRef}:0`,
			},
		};
		const result = await f.tool.execute("c", input);
		assert.equal(result.details.status, "action_submitted");
		assert.equal(result.details.completedSteps, 0);
		await assert.rejects(f.tool.execute("again", input), /stale_observation/);
		assert.deepEqual(f.calls, ["observe", "click"]);
	},
);

test("unseen postconditions and post-mutation refs fail before any batch input", { skip: !sdk }, async (t) => {
	for (const scenario of ["postcondition", "batch"] as const) {
		const f = fixture();
		t.after(() => f.host.close());
		const seen = await f.tool.execute("o", { request: { op: "observe" } });
		assert.ok("observationRef" in seen.details && seen.details.observationRef);
		const target = { ref: `${seen.details.observationRef}:0` };
		const steps =
			scenario === "postcondition"
				? [{ op: "press" as const, target, expect: { role: "button", label: "Future dialog" }, value: "" }]
				: [
						{ op: "fill" as const, target, text: "first" },
						{ op: "fill" as const, target, text: "second" },
					];
		await assert.rejects(
			f.tool.execute("p", { request: { op: "execute", ref: seen.details.observationRef, steps } }),
			scenario === "postcondition" ? /postcondition_not_observed/ : /batch_ref_after_mutation/,
		);
		assert.equal(f.plans.length, 0);
		assert.deepEqual(f.calls, ["observe"]);
	}
});

test("click does not report refused or partial effects as submitted and never replays", { skip: !sdk }, async (t) => {
	assert.ok(sdk);
	for (const effect of [sdk.ActionEffect.Refused, sdk.ActionEffect.Partial, sdk.ActionEffect.SuspectedNoop]) {
		const f = fixture({ clickEffect: effect });
		t.after(() => f.host.close());
		const seen = await f.tool.execute("o", { request: { op: "observe" } });
		assert.ok("observationRef" in seen.details && seen.details.observationRef);
		const input = {
			request: {
				op: "click" as const,
				ref: seen.details.observationRef,
				target: `${seen.details.observationRef}:0`,
			},
		};
		await assert.rejects(
			f.tool.execute("c", input),
			effect === sdk.ActionEffect.Refused ? /paused/ : /outcome_unknown/,
		);
		await assert.rejects(f.tool.execute("c2", input), /stale_observation/);
		assert.deepEqual(f.calls, ["observe", "click"]);
	}
});

test(
	"select_option requires a displayed native option capability and prioritizes actionable rows",
	{ skip: !sdk },
	async (t) => {
		const f = fixture({ option: true, noise: 40 });
		t.after(() => f.host.close());
		const seen = await f.tool.execute("o", { request: { op: "observe" } });
		assert.ok("observationRef" in seen.details && seen.details.observationRef);
		assert.match(JSON.stringify(seen.content), /select_option/);
		assert.match(JSON.stringify(seen.content), /Pro/);
		const request = {
			op: "select_option" as const,
			ref: seen.details.observationRef,
			target: `${seen.details.observationRef}:1`,
		};
		const selected = await f.tool.execute("s", { request });
		assert.equal(selected.details.status, "action_submitted");
		await assert.rejects(f.tool.execute("again", { request }), /stale_observation/);
		assert.deepEqual(f.calls, ["observe", "click"]);
		const fresh = await f.tool.execute("o2", { request: { op: "observe" } });
		assert.ok("observationRef" in fresh.details && fresh.details.observationRef);
		await assert.rejects(
			f.tool.execute("wrong-kind", {
				request: {
					op: "select_option",
					ref: fresh.details.observationRef,
					target: `${fresh.details.observationRef}:0`,
				},
			}),
			/action_unavailable/,
		);
		assert.deepEqual(f.calls, ["observe", "click", "observe"]);
	},
);
