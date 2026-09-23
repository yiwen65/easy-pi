import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDesktopInput } from "../contracts.ts";
import { DesktopIntents } from "../intent.ts";
import { projectObservation } from "../projection.ts";
import { parseComputerSegmentInput } from "../segment-contracts.ts";
import { projectSegment } from "../segment-projection.ts";
import { candidateSdk } from "./sdk.ts";

const enabled = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
const request = () =>
	parseComputerSegmentInput({
		request: {
			op: "segment",
			ref: "snapshot",
			actions: [{ op: "type_text", text: "literal" }],
			expected: { kind: "visual", description: "saved" },
		},
	}).request;

test("one Computer parser accepts segments but rejects model intent IDs, budgets and false resolution", () => {
	assert.deepEqual(parseDesktopInput({ request: request() }), { request: request() });
	for (const extra of [
		{ intentRef: "new-id" },
		{ maxDurationMs: 1 },
		{ recoveryAttempts: 0 },
		{ remainingDurationMs: 30_000 },
		{ previousEffect: "native_confirmed" },
	])
		assert.throws(() => parseDesktopInput({ request: { ...request(), ...extra } }));
	assert.doesNotThrow(() => parseDesktopInput({ request: { ...request(), previousEffect: "observed" } }));
});

test("trusted intent ledger keeps identity across evidence changes and requires a newer visible resolution boundary", () => {
	const ledger = new DesktopIntents();
	const owner = {};
	const first = ledger.begin(request(), 1, owner);
	assert.throws(() => ledger.begin({ ...request(), previousEffect: "observed" }, 1, owner), /new_visible/);
	ledger.finish("paused", false);
	assert.equal(
		ledger.begin({ ...request(), ref: "new-snapshot", expected: { kind: "window_focused" } }, 2, owner),
		first,
	);
	ledger.finish("outcome_unknown", false);
	assert.throws(() => ledger.begin(request(), 3, owner), /unresolved/);
	assert.throws(() => ledger.begin({ ...request(), previousEffect: "observed" }, 3, {}), /new_visible/);
	const next = ledger.begin({ ...request(), previousEffect: "observed" }, 3, owner);
	assert.notEqual(next, first);
	ledger.finish("needs_observation", false);
	assert.throws(() => ledger.begin(request(), 4, {}), /target_changed/);
});

test("native intent tombstone capacity is not reset by repeatedly resolved identical actions", () => {
	const ledger = new DesktopIntents();
	const owner = {};
	for (let i = 1; i <= 256; i++) {
		ledger.begin(request(), i, owner);
		ledger.finish("confirmed", false);
	}
	assert.throws(() => ledger.begin(request(), 257, owner), /capacity/);
});

test("partial projection grants only displayed retained references and preserves identifier separately", () => {
	const result = projectObservation({
		pid: 1,
		windowId: 1n,
		snapshotId: "s",
		images: [],
		elementsComplete: false,
		truncated: true,
		elements: [
			{
				elementIndex: 0n,
				depth: 0,
				role: "AXTextField",
				label: "Visible",
				identifier: "stable-id",
				elementToken: "one",
			},
			{ elementIndex: 1n, depth: 0, role: "AXTextField", value: "x".repeat(9000), elementToken: "hidden" },
		],
	});
	assert.equal(result.details.nativeComplete, false);
	assert.equal(result.details.viewTruncated, true);
	assert.deepEqual([...result.grant.refs], ["one"]);
	assert.equal(result.grant.legacyRefs.size, 0);
	assert.match(result.content[0]!.text, /"label":"Visible","identifier":"stable-id"/);
	assert.doesNotMatch(result.content[0]!.text, /hidden/);
});

test(
	"genuine result projection preserves partial/unknown prefix, actual routing, recovery and safe codes",
	{ skip: !enabled },
	() => {
		const sdk = candidateSdk();
		const value = sdk.ComputerSegmentResult.create({
			status: sdk.ComputerSegmentStatus.OutcomeUnknown,
			actions: [
				{
					index: 0,
					dispatch: sdk.ComputerDispatch.Dispatched,
					action: {
						effect: sdk.ActionEffect.Partial,
						route: sdk.ActionRoute.SyntheticEvents,
						delivery: { mode: sdk.ActionDeliveryMode.Foreground, deliveredCount: 2 },
					},
					code: "PRIVATE arbitrary error",
				},
			],
			firstUnfinishedAction: 0,
			condition: sdk.ComputerCondition.Unknown,
			recoveryAttempts: 2,
			remainingDurationMs: 19_000,
			elapsedMs: 11n,
		});
		const result = projectSegment(sdk, value, 3, false);
		assert.equal(result.attemptedActions, 1);
		assert.equal(result.firstUnfinishedAction, 0);
		assert.equal(result.recoveryAttempts, 2);
		assert.equal(result.remainingDurationMs, 19_000);
		assert.equal(result.elapsedMs, "11");
		assert.equal(result.actions[0]!.action?.effect, "partial");
		assert.equal(result.actions[0]!.action?.delivery?.mode, "foreground");
		assert.equal(result.actions[0]!.code, "native_fault");
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
		for (const invalid of [
			{ ...value, status: 999 },
			{ ...value, condition: 999 },
			{ ...value, actions: [{ ...value.actions[0]!, dispatch: 999 }] },
			{ ...value, recoveryAttempts: 3 },
			{ ...value, remainingDurationMs: -1 },
			{ ...value, remainingDurationMs: 30_001 },
			{ ...value, remainingDurationMs: NaN },
			{ ...value, firstUnfinishedAction: 1 },
			{ ...value, actions: [value.actions[0]!, { ...value.actions[0]!, index: 1 }] },
		])
			assert.throws(() => projectSegment(sdk, invalid, 3, false));
	},
);

test(
	"native confirmed condition may avoid unnecessary actions, but visual description is never native proof",
	{ skip: !enabled },
	() => {
		const sdk = candidateSdk();
		const value = sdk.ComputerSegmentResult.create({
			status: sdk.ComputerSegmentStatus.Confirmed,
			condition: sdk.ComputerCondition.Satisfied,
			actions: [],
			firstUnfinishedAction: 0,
			recoveryAttempts: 0,
			remainingDurationMs: 29_999,
			elapsedMs: 1n,
		});
		assert.equal(projectSegment(sdk, value, 1, false).status, "confirmed");
		assert.throws(() => projectSegment(sdk, value, 1, true));
	},
);
