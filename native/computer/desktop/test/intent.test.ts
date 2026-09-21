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

test("reconciliation still requires newer evidence and cannot cross an unrelated owner", () => {
	const intents = new DesktopIntents();
	const owner = {};
	intents.begin(request("a"), 5, owner);
	intents.finish("outcome_unknown", true);
	assert.throws(() => intents.begin(request("b", true), 5, owner), /new_visible_evidence/);
	assert.throws(() => intents.begin(request("b", true), 6, {}), /new_visible_evidence/);
});
