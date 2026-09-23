import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComputerDragInput } from "../drag-contracts.ts";
import { candidateSdk } from "./sdk.ts";
import { fixture } from "./segment-fixture.ts";

const enabled = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
function drag(from = "image-1", to = "image-2"): ComputerDragInput["request"] {
	return {
		op: "drag_between",
		from: { ref: from, x: 1, y: 1 },
		to: { ref: to, x: 1, y: 1 },
		expected: { kind: "visual", description: "The destination received one item" },
	};
}
async function selectPair(f: ReturnType<typeof fixture>) {
	await f.call({ op: "discover" });
	await f.call({ op: "select", ref: "window" });
	await f.call({ op: "discover" });
	await f.call({ op: "select_destination", ref: "window" });
	return f.call({ op: "capture_pair", maxDimension: 512 });
}

test("genuinely generated cross-window method exists without creating a native host", { skip: !enabled }, () => {
	assert.equal(typeof candidateSdk().ComputerOperation.prototype.startCrossWindowDrag, "function");
});

test(
	"selected source survives destination replacement; selecting a new source retires both",
	{ skip: !enabled },
	async () => {
		const f = fixture({ windowIds: [1n, 2n, 3n, 4n] });
		try {
			await selectPair(f);
			assert.deepEqual(f.closed, []);
			assert.deepEqual(f.captures, [1, 2]);
			await f.call({ op: "discover" });
			await f.call({ op: "select_destination", ref: "window" });
			assert.deepEqual(f.closed, [2]);
			await f.call({ op: "capture_pair", maxDimension: 512 });
			assert.deepEqual(f.captures, [1, 2, 1, 3]);
			await f.call({ op: "discover" });
			await f.call({ op: "select", ref: "window" });
			assert.deepEqual(f.closed, [2, 1, 3]);
			await assert.rejects(f.call({ op: "capture_pair", maxDimension: 512 }), /native_fault/);
			assert.equal(f.captures.length, 4);
		} finally {
			await f.host.close();
		}
	},
);

test(
	"one pair grants one dedicated peer call and returns fresh two-image evidence after terminal",
	{ skip: !enabled },
	async () => {
		const f = fixture({ windowIds: [1n, 2n] });
		try {
			const pair = await selectPair(f);
			assert.equal(pair.content.filter((item) => item.type === "image").length, 2);
			const result = await f.call(drag());
			assert.equal(f.dragPeers.length, 1);
			assert.equal(f.segments.length, 1);
			assert.equal(result.content.filter((item) => item.type === "image").length, 2);
			assert.match(JSON.stringify(result.details), /global_input/);
			assert.match(JSON.stringify(result.details), /foreground/);
			assert.doesNotMatch(JSON.stringify(result.details), /base64|png|data/);
			assert.ok(f.events.indexOf("segment:terminal") < f.events.lastIndexOf("capture"));
			await f.call(drag("image-3", "image-4"));
			assert.equal(
				f.segments[0]!.intentRef,
				f.segments[1]!.intentRef,
				"new captures do not renew a repeated intent",
			);
		} finally {
			await f.host.close();
		}
	},
);

test(
	"pair cannot be assembled from independent captures or used with reversed references",
	{ skip: !enabled },
	async () => {
		for (const mode of ["single", "reversed", "same_target"] as const) {
			const f = fixture({ windowIds: mode === "same_target" ? [1n, 1n] : [1n, 2n] });
			try {
				if (mode === "same_target") await assert.rejects(selectPair(f), /native_fault/);
				else {
					await selectPair(f);
					if (mode === "single") await f.call({ op: "capture", maxDimension: 512 });
					await assert.rejects(
						f.call(mode === "single" ? drag("image-3", "image-2") : drag("image-2", "image-1")),
						/stale_image_pair/,
					);
				}
				assert.equal(f.dragPeers.length, 0);
			} finally {
				await f.host.close();
			}
		}
	},
);

test(
	"activation-only result preserves committed preparation without inventing drag or renewing intent",
	{ skip: !enabled },
	async () => {
		const f = fixture({ mode: "prepared", windowIds: [1n, 2n] });
		try {
			await selectPair(f);
			const result = await f.call(drag());
			assert.match(JSON.stringify(result.details), /drag_foreground_prepared/);
			assert.match(JSON.stringify(result.details), /not_dispatched/);
			assert.match(JSON.stringify(result.details), /"inputCommitted":true/);
			assert.equal(result.content.filter((item) => item.type === "image").length, 2);
			await f.call({
				...drag("image-3", "image-4"),
				from: { ref: "image-3", x: 0, y: 2 },
				to: { ref: "image-4", x: 0, y: 0 },
			});
			assert.equal(f.segments[0]!.intentRef, f.segments[1]!.intentRef);
		} finally {
			await f.host.close();
		}
	},
);

for (const mode of ["partial", "lost"] as const)
	test(
		`uncertain ${mode} drag requires fresh whole-pair judgement, not one source image`,
		{ skip: !enabled },
		async () => {
			const f = fixture({ mode, windowIds: [1n, 2n] });
			try {
				await selectPair(f);
				const result = await f.call(drag());
				assert.match(JSON.stringify(result.details), /outcome_unknown/);
				assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
				await assert.rejects(f.call(drag("image-3", "image-4")), /previous_intent_unresolved/);
				await f.call({ op: "capture", maxDimension: 512 });
				await assert.rejects(
					f.call({ ...drag("image-5", "image-4"), previousEffect: "observed" }),
					/stale_image_pair/,
				);
				await f.call({ op: "capture_pair", maxDimension: 512 });
				const reconciled = await f.call({ ...drag("image-6", "image-7"), previousEffect: "observed" });
				assert.match(JSON.stringify(reconciled.details), /model_judgement/);
				assert.notEqual(f.segments[0]!.intentRef, f.segments[1]!.intentRef);
			} finally {
				await f.host.close();
			}
		},
	);

test(
	"reselecting the same ordered windows cannot silently renew an unresolved pair intent",
	{ skip: !enabled },
	async () => {
		const f = fixture({ windowIds: [1n, 2n, 1n, 2n] });
		try {
			await selectPair(f);
			await f.call(drag());
			await selectPair(f);
			await assert.rejects(f.call(drag("image-5", "image-6")), /unresolved_intent_target_changed/);
			assert.equal(f.dragPeers.length, 1);
			await f.call({ op: "capture_pair", maxDimension: 512 });
			await f.call({ ...drag("image-7", "image-8"), previousEffect: "observed" });
			assert.notEqual(f.segments[0]!.intentRef, f.segments[1]!.intentRef);
		} finally {
			await f.host.close();
		}
	},
);

test("partial pair capture failure publishes neither grant nor half-pair", { skip: !enabled }, async () => {
	const f = fixture({ windowIds: [1n, 2n], failCapture: 2 });
	try {
		await assert.rejects(selectPair(f), /native_fault/);
		assert.equal(f.messages.filter((message) => message.content.some((item) => item.type === "image")).length, 0);
		await assert.rejects(f.call(drag()), /stale_image_pair/);
		assert.equal(f.dragPeers.length, 0);
	} finally {
		await f.host.close();
	}
});

test("second capture terminal is required; retirement prevents late pair publication", { skip: !enabled }, async () => {
	const f = fixture({ windowIds: [1n, 2n], hold: "pair_capture" });
	try {
		let published = false;
		const pending = selectPair(f).then(() => {
			published = true;
		});
		await f.entered.promise;
		assert.equal(published, false);
		f.desktop.clear();
		f.held.resolve();
		await assert.rejects(pending, /native_fault/);
		await assert.rejects(f.call(drag()), /stale_image_pair/);
	} finally {
		f.held.resolve();
		await f.host.close();
	}
});

test("cancelled pending drag preserves facts without fresh capture or a late grant", { skip: !enabled }, async () => {
	const f = fixture({ windowIds: [1n, 2n], hold: "segment" });
	try {
		await selectPair(f);
		const controller = new AbortController();
		const pending = f.call(drag(), controller.signal);
		await f.entered.promise;
		assert.equal(f.captures.length, 2);
		controller.abort();
		f.desktop.clear();
		f.held.resolve();
		await pending;
		assert.ok(f.events.includes("cancel"));
		assert.equal(f.captures.length, 2);
		await assert.rejects(f.call(drag()), /stale_image_pair/);
	} finally {
		f.held.resolve();
		await f.host.close();
	}
});

test("unknown drag terminal quarantines without fresh reads or destruction", { skip: !enabled }, async () => {
	const f = fixture({ windowIds: [1n, 2n], terminalFailure: true });
	await selectPair(f);
	await assert.rejects(f.call(drag()), /quarantined/);
	assert.equal(f.captures.length, 2);
	await assert.rejects(f.host.close());
	assert.ok(!f.events.includes("destroy"));
});
