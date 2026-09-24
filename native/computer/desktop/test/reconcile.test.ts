import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopInput } from "../contracts.ts";
import { fixture } from "./segment-fixture.ts";

const enabled = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
test("reconcile is an explicit closed non-input request", () => {
	assert.doesNotThrow(() =>
		parseDesktopInput({ request: { op: "reconcile", ref: "fresh", previousEffect: "observed" } }),
	);
	assert.throws(() => parseDesktopInput({ request: { op: "reconcile", ref: "fresh" } }));
	assert.throws(() =>
		parseDesktopInput({ request: { op: "reconcile", ref: "fresh", previousEffect: "observed", actions: [] } }),
	);
});

test(
	"unknown input can be reconciled without another dispatch before switching to a popup",
	{ skip: !enabled },
	async () => {
		const f = fixture({ mode: "partial", windowIds: [1n, 2n] });
		try {
			await f.setup();
			await f.call({
				op: "segment",
				ref: "snapshot-1",
				actions: [{ op: "key", key: "f", modifiers: ["command"] }],
				expected: { kind: "visual", description: "Find popup" },
			});
			await f.call({ op: "discover" });
			await assert.rejects(f.call({ op: "select", ref: "window" }), /reconcile.*do not.*observe/s);
			await f.call({ op: "observe" });
			const before = f.events.length;
			const result = await f.call({ op: "reconcile", ref: "snapshot-3", previousEffect: "observed" });
			assert.equal(f.events.length, before, "reconciliation must not invoke native operations");
			assert.equal(f.segments.length, 1);
			assert.equal((result.details as { status: string }).status, "reconciled");
			await assert.rejects(
				f.call({ op: "reconcile", ref: "snapshot-3", previousEffect: "observed" }),
				/stale_observation/,
			);
			await f.call({ op: "discover" });
			await f.call({ op: "select", ref: "window" });
			assert.equal(f.segments.length, 1);
		} finally {
			await f.host.close();
		}
	},
);

test("reconciliation cannot use filtered or cancelled evidence", { skip: !enabled }, async () => {
	const f = fixture({ mode: "partial" });
	try {
		await f.setup();
		await f.call({
			op: "segment",
			ref: "snapshot-1",
			actions: [{ op: "key", key: "f" }],
			expected: { kind: "visual", description: "Popup" },
		});
		f.desktop.observeContext(true, []);
		await assert.rejects(
			f.call({ op: "reconcile", ref: "image-2", previousEffect: "observed" }),
			/stale_observation/,
		);
		await f.call({ op: "observe" });
		await assert.rejects(
			f.call({ op: "reconcile", ref: "snapshot-3", previousEffect: "observed" }, AbortSignal.abort()),
			/cancelled/,
		);
		await f.call({ op: "discover" });
		await assert.rejects(f.call({ op: "select", ref: "window" }), /previous_intent_unresolved/);
		assert.equal(f.segments.length, 1);
	} finally {
		await f.host.close();
	}
});
