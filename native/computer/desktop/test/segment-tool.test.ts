import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopInput } from "../contracts.ts";
import { fixture } from "./segment-fixture.ts";

const enabled = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
function segment(ref = "snapshot-1", text = "你好🦀"): Extract<DesktopInput["request"], { op: "segment" }> {
	return {
		op: "segment",
		ref,
		actions: [{ op: "fill", target: { ref: "field" }, text }],
		expected: { kind: "visual", description: "The field is filled" },
	};
}

test(
	"real segment values use partial retained rows, preserve identifier and publish one fresh image",
	{ skip: !enabled },
	async () => {
		const f = fixture();
		try {
			await f.setup();
			assert.match(JSON.stringify(f.messages), /name-id/);
			assert.match(JSON.stringify(f.messages), /nativeComplete=false/);
			const lease = await f.host.scheduler.acquire(f.desktop.tool.executionResource!);
			let result: Awaited<ReturnType<typeof f.call>>;
			try {
				result = await f.call(segment());
			} finally {
				lease?.release();
			}
			assert.equal(f.segments.length, 1);
			assert.ok(f.segments[0]!.intentRef);
			assert.equal(f.segments[0]!.maxDurationMs, 30_000);
			assert.equal(result.content.filter((item) => item.type === "image").length, 1);
			assert.doesNotMatch(JSON.stringify(result.details), /png|base64|你好/);
			assert.match(JSON.stringify(result.details), /needs_observation|foreground|unverifiable/);
			assert.ok(f.events.indexOf("segment:terminal") < f.events.lastIndexOf("capture"));
			await f.call({ ...segment("image-2", "new work"), actions: [{ op: "key", key: "Tab" }] });
			assert.notEqual(f.segments[0]!.intentRef, f.segments[1]!.intentRef);
		} finally {
			await f.host.close();
		}
	},
);

test(
	"selected native window identity scopes intent without silently renewing reselections",
	{ skip: !enabled },
	async () => {
		const f = fixture({ windowIds: [1n, 2n, 1n] });
		const key = (ref: string) => ({ ...segment(ref), actions: [{ op: "key" as const, key: "Tab" }] });
		try {
			await f.setup();
			await f.call(key("snapshot-1"));
			await f.setup();
			await f.call(key("snapshot-3"));
			assert.notEqual(f.segments[0]!.intentRef, f.segments[1]!.intentRef);
			await f.setup();
			await assert.rejects(f.call(key("snapshot-5")), /unresolved_intent_target_changed/);
			assert.equal(f.segments.length, 2);
			await f.call({ op: "observe" });
			await f.call({ ...key("snapshot-6"), previousEffect: "observed" });
			assert.notEqual(f.segments[0]!.intentRef, f.segments[2]!.intentRef);
		} finally {
			await f.host.close();
		}
	},
);

test(
	"all point endpoints use actual image bounds; capture retires AX references and within tokens",
	{ skip: !enabled },
	async () => {
		for (const action of [
			{ op: "click", point: { ref: "image-1", x: 2, y: 0 } },
			{ op: "pointer_move", point: { ref: "image-1", x: 0, y: 3 } },
			{ op: "scroll", point: { ref: "image-1", x: 2, y: 0 }, deltaX: 1, deltaY: 0 },
			{ op: "drag", from: { ref: "image-1", x: 2, y: 0 }, to: { ref: "image-1", x: 0, y: 0 } },
			{ op: "drag", from: { ref: "image-1", x: 0, y: 0 }, to: { ref: "image-1", x: 0, y: 3 } },
			{ op: "focus", target: { ref: "field" } },
			{ op: "focus", target: { selector: { identifier: "name-id", within: "field" } } },
		] as const) {
			const f = fixture();
			try {
				await f.setup(true);
				await assert.rejects(f.call({ ...segment("image-1"), actions: [action] }), /bounds|stale_element/);
				assert.equal(f.segments.length, 0);
			} finally {
				await f.host.close();
			}
		}
	},
);

test("segment and follow-up read each wait for real terminal before publication", { skip: !enabled }, async () => {
	for (const hold of ["segment", "capture"] as const) {
		const f = fixture({ hold });
		try {
			await f.setup();
			let published = false;
			const pending = f.call(segment()).then((value) => {
				published = true;
				return value;
			});
			await f.entered.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(published, false);
			if (hold === "segment") assert.ok(!f.events.includes("capture"));
			f.held.resolve();
			await pending;
			assert.equal(published, true);
		} finally {
			f.held.resolve();
			await f.host.close();
		}
	}
});

test(
	"cancel racing fulfilled result preserves facts, suppresses reads and late grants",
	{ skip: !enabled },
	async () => {
		const f = fixture({ hold: "segment" });
		try {
			await f.setup();
			const controller = new AbortController();
			const pending = f.call(segment(), controller.signal);
			await f.entered.promise;
			controller.abort();
			f.desktop.clear();
			f.held.resolve();
			const result = await pending;
			assert.match(JSON.stringify(result.details), /needs_observation/);
			assert.ok(f.events.includes("cancel"));
			assert.ok(!f.events.includes("capture"));
			await assert.rejects(f.call(segment()), /stale_observation/);
		} finally {
			f.held.resolve();
			await f.host.close();
		}
	},
);

test(
	"unknown terminal quarantines without starting fresh work or leaking arbitrary errors",
	{ skip: !enabled },
	async () => {
		const f = fixture({ terminalFailure: true });
		await f.setup();
		await assert.rejects(
			f.call(segment()),
			(error: unknown) =>
				error instanceof Error && /quarantined/.test(error.message) && !error.message.includes("PRIVATE"),
		);
		assert.ok(!f.events.includes("capture"));
		await assert.rejects(f.host.close());
		assert.ok(!f.events.includes("destroy"));
	},
);

for (const mode of ["lost", "partial"] as const)
	test(
		`${mode} input requires fresh visible reconciliation; reads cannot renew intent`,
		{ skip: !enabled },
		async () => {
			const f = fixture({ mode });
			try {
				await f.setup();
				const result = await f.call(segment());
				assert.match(JSON.stringify(result.details), /outcome_unknown/);
				assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
				assert.equal(result.content.filter((item) => item.type === "image").length, 1);
				await assert.rejects(
					f.call({ ...segment("image-2"), actions: [{ op: "type_text", text: "same uncertain input" }] }),
					/previous_intent_unresolved/,
				);
				await f.call({ op: "observe" });
				await assert.rejects(f.call(segment("snapshot-3")), /previous_intent_unresolved/);
				assert.equal(f.segments.length, 1);
				await f.call({ op: "observe" });
				const reconciled = await f.call({
					...segment("snapshot-4", "genuinely new value"),
					previousEffect: "observed",
				});
				assert.notEqual(f.segments[0]!.intentRef, f.segments[1]!.intentRef);
				assert.match(JSON.stringify(reconciled), /model.judgement/);
			} finally {
				await f.host.close();
			}
		},
	);

test(
	"non-dispatched recovery and fully delivered visual repeats keep native intent across newer observations",
	{ skip: !enabled },
	async () => {
		for (const mode of ["paused", undefined] as const) {
			const f = fixture(mode ? { mode } : {});
			try {
				await f.setup();
				await f.call(segment());
				await f.call({ op: "observe" });
				await f.call(segment("snapshot-3"));
				assert.equal(f.segments[0]!.intentRef, f.segments[1]!.intentRef);
			} finally {
				await f.host.close();
			}
		}
	},
);

test("filtered fresh image never grants resolution or resurrects old references", { skip: !enabled }, async () => {
	const f = fixture({ mode: "partial" });
	try {
		await f.setup();
		await f.call(segment());
		f.desktop.observeContext(false, f.messages);
		f.desktop.observeContext(true, f.messages);
		await assert.rejects(
			f.call({ ...segment("image-2"), actions: [{ op: "key", key: "Tab" }], previousEffect: "observed" }),
			/stale_observation/,
		);
		assert.equal(f.segments.length, 1);
	} finally {
		await f.host.close();
	}
});

test(
	"fresh capture permits scoped locators but legacy routes cannot bypass unresolved segment intent",
	{ skip: !enabled },
	async () => {
		const f = fixture();
		try {
			await f.setup(true);
			await f.call({
				...segment("image-1"),
				actions: [{ op: "focus", target: { selector: { role: "AXTextField", identifier: "name-id" } } }],
			});
			await assert.rejects(
				f.call({ op: "key", ref: "image-2", key: "Return" }),
				/use_segment_for_unresolved_intent/,
			);
			assert.equal(f.segments.length, 1);
		} finally {
			await f.host.close();
		}
	},
);

test(
	"satisfied condition with an unfinished prefix still publishes fresh dependency evidence",
	{ skip: !enabled },
	async () => {
		const f = fixture({ mode: "confirmed_boundary" });
		try {
			await f.setup();
			const result = await f.call({
				...segment(),
				actions: [
					{ op: "key", key: "a" },
					{ op: "fill", target: { ref: "field" }, text: "remaining" },
				],
				expected: { kind: "value", target: { ref: "field" }, value: "a" },
			});
			assert.match(JSON.stringify(result.details), /"status":"confirmed"/);
			assert.match(JSON.stringify(result.details), /"firstUnfinishedAction":1/);
			assert.match(JSON.stringify(result.details), /"observationRef":"snapshot-2"/);
			assert.equal(f.events.filter((event) => event === "observe").length, 2);
			assert.ok(f.events.indexOf("segment:terminal") < f.events.lastIndexOf("observe"));
			assert.ok(!f.events.includes("capture"));
			await assert.rejects(f.call(segment()), /stale_observation/);
			assert.equal(f.segments.length, 1);
		} finally {
			await f.host.close();
		}
	},
);

test(
	"native-confirmed local condition needs no hidden read and admits genuinely subsequent work",
	{ skip: !enabled },
	async () => {
		const f = fixture({ mode: "confirmed" });
		try {
			await f.setup();
			const result = await f.call({ ...segment(), expected: { kind: "window_focused" } });
			assert.match(JSON.stringify(result.details), /"status":"confirmed"/);
			assert.ok(!f.events.includes("capture"));
			await f.call({ op: "observe" });
			await f.call({ ...segment("snapshot-2"), expected: { kind: "window_focused" } });
			assert.notEqual(f.segments[0]!.intentRef, f.segments[1]!.intentRef);
		} finally {
			await f.host.close();
		}
	},
);
