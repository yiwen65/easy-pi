import assert from "node:assert/strict";
import test from "node:test";
import { DesktopIntents } from "../intent.ts";
import { parseComputerSegmentInput } from "../segment-contracts.ts";

const request = (key: string, observed = false) =>
	parseComputerSegmentInput({
		request: {
			op: "segment",
			ref: "view",
			actions: [{ op: "key", key }],
			expected: { kind: "visual", description: "Expected result" },
			...(observed ? { previousEffect: "observed" } : {}),
		},
	}).request;

test("explicit current-target reconciliation permits earlier visual work to become a new intent", () => {
	const intents = new DesktopIntents();
	const owner = {};
	const first = intents.begin(request("a"), 1, owner);
	intents.finish("needs_observation", false);
	intents.begin(request("b"), 2, owner);
	intents.finish("needs_observation", false);
	const repeated = intents.begin(request("a", true), 3, owner);
	assert.notEqual(
		repeated,
		first,
		"must not reuse an older unreconciled native tombstone after explicit reconciliation",
	);
});

test("re-observation without explicit reconciliation retains the old intent", () => {
	const intents = new DesktopIntents();
	const owner = {};
	const first = intents.begin(request("a"), 1, owner);
	intents.finish("needs_observation", false);
	intents.begin(request("b"), 2, owner);
	intents.finish("needs_observation", false);
	assert.equal(intents.begin(request("a"), 3, owner), first);
});

test("target identity separates shortcuts but reselection cannot silently renew unresolved work", () => {
	const intents = new DesktopIntents();
	const owner = {};
	const first = intents.begin(request("a"), 1, owner, "10:20");
	intents.finish("needs_observation", false);
	const second = intents.begin(request("a"), 2, {}, "10:21");
	assert.notEqual(second, first);
	intents.finish("needs_observation", false);
	assert.throws(() => intents.begin(request("a"), 3, {}, "10:20"), /target_changed/);
	assert.notEqual(intents.begin(request("a", true), 4, {}, "10:20"), first);
});

test("unknown effects cannot escape through another target reconciliation", () => {
	const intents = new DesktopIntents();
	const owner = {};
	intents.begin(request("a"), 1, owner, "10:20");
	intents.finish("needs_observation", false);
	intents.begin(request("b"), 2, owner, "10:21");
	intents.finish("outcome_unknown", true);
	assert.throws(() => intents.begin(request("a", true), 3, owner, "10:20"), /new_visible_evidence/);
	assert.throws(() => intents.begin(request("c"), 3, owner, "10:22"), /previous_intent_unresolved/);
});

test("no-input retargeting rekeys one intent without growing aliases or renewing its budget", () => {
	const intents = new DesktopIntents();
	const owner = {};
	const first = intents.begin(request("0"), 1, owner, "10:20");
	for (let index = 1; index <= 300; index++) {
		intents.finish("paused", false, true);
		assert.equal(intents.begin(request(String(index)), index + 1, owner, "10:20"), first);
	}
	intents.finish("needs_observation", false);
	assert.notEqual(intents.begin(request("0"), 302, owner, "10:20"), first, "old aliases were retired");
});

test("a no-input retry cannot replace an older unresolved action tombstone", () => {
	const intents = new DesktopIntents();
	const owner = {};
	const first = intents.begin(request("a"), 1, owner);
	intents.finish("needs_observation", false);
	const second = intents.begin(request("b"), 2, owner);
	intents.finish("paused", false, true);
	assert.notEqual(first, second);
	assert.equal(intents.begin(request("a"), 3, owner), first);
});

test("reselection cannot evade a no-input recovery budget by changing the requested action", () => {
	const intents = new DesktopIntents();
	const owner = {};
	const first = intents.begin(request("a"), 1, owner, "10:20");
	intents.finish("paused", false, true);
	assert.throws(() => intents.begin(request("b"), 2, {}, "10:20"), /target_changed/);
	assert.notEqual(intents.begin(request("b", true), 3, {}, "10:20"), first);
});

for (const reselect of [false, true])
	test(`unrelated window work cannot hide an unresolved no-input budget (reselect=${reselect})`, () => {
		const intents = new DesktopIntents();
		const owner = {};
		const first = intents.begin(request("a"), 1, owner, "10:20");
		intents.finish("paused", false, true);
		intents.begin(request("b"), 2, {}, "10:21");
		intents.finish("confirmed", false);
		if (reselect) assert.throws(() => intents.begin(request("c"), 3, {}, "10:20"), /target_changed/);
		else assert.equal(intents.begin(request("c"), 3, owner, "10:20"), first);
	});

test("a satisfied condition does not reconcile a partially dispatched request", () => {
	const intents = new DesktopIntents();
	const owner = {};
	const first = intents.begin(request("a"), 1, owner);
	intents.finish("confirmed", true);
	assert.throws(() => intents.begin(request("a"), 2, owner), /previous_intent_unresolved/);
	assert.notEqual(intents.begin(request("b", true), 3, owner), first);
});

test("reconciliation still requires newer evidence and cannot cross an unrelated owner", () => {
	const intents = new DesktopIntents();
	const owner = {};
	intents.begin(request("a"), 5, owner);
	intents.finish("outcome_unknown", true);
	assert.throws(() => intents.begin(request("b", true), 5, owner), /new_visible_evidence/);
	assert.throws(() => intents.begin(request("b", true), 6, {}), /new_visible_evidence/);
});
