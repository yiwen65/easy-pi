import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./segment-fixture.ts";

const enabled = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";

test("pointer-keyboard boundary explains fresh semantic recovery without replay", { skip: !enabled }, async () => {
	const f = fixture({ mode: "confirmed_boundary" });
	try {
		await f.setup(true);
		const result = await f.call({
			op: "segment",
			ref: "image-1",
			actions: [
				{ op: "click", point: { ref: "image-1", x: 1, y: 1 } },
				{ op: "type_text", text: "new text" },
			],
			expected: { kind: "window_focused" },
		});
		const text = result.content
			.filter((row) => row.type === "text")
			.map((row) => row.text)
			.join("\n");
		assert.match(text, /Action 2 of 2 was not dispatched/);
		assert.match(text, /explicit click\/drag\/button_down.*new keyboard input/s);
		assert.match(text, /observe.*Observation ref.*keyboard/s);
		assert.match(text, /previousEffect:'observed'.*not_dispatched suffix/s);
		assert.match(text, /Never replay the dispatched prefix/);
		await assert.rejects(
			f.call({
				op: "segment",
				ref: "image-2",
				actions: [{ op: "type_text", text: "new text" }],
				expected: { kind: "visual", description: "Field filled" },
			}),
			/previous_intent_unresolved/,
		);
		assert.equal(f.segments.length, 1);
	} finally {
		await f.host.close();
	}
});

test("legacy refusal explains segment recovery without resolving unknown input", { skip: !enabled }, async () => {
	const f = fixture({ mode: "partial" });
	try {
		await f.setup();
		const request = {
			op: "segment" as const,
			ref: "snapshot-1",
			actions: [{ op: "key" as const, key: "Tab" }],
			expected: { kind: "visual" as const, description: "Field focused" },
		};
		await f.call(request);
		const before = [...f.events];
		await assert.rejects(f.call({ op: "key", ref: "image-2", key: "Return" }), (error: Error) => {
			assert.match(error.message, /use_segment_for_unresolved_intent/);
			assert.match(error.message, /No input dispatched by this call/);
			assert.match(error.message, /fresh.*segment.*previousEffect:'observed'/s);
			assert.match(error.message, /unknown.*stop.*never replay/s);
			return true;
		});
		assert.deepEqual(f.events, before);
		await f.call({ op: "observe" });
		await assert.rejects(f.call({ ...request, ref: "snapshot-3" }), /previous_intent_unresolved/);
		assert.equal(f.segments.length, 1);
		await f.call({ op: "observe" });
		await f.call({
			...request,
			ref: "snapshot-4",
			actions: [{ op: "key", key: "Return" }],
			previousEffect: "observed",
		});
		assert.equal(f.segments.length, 2);
	} finally {
		await f.host.close();
	}
});

test(
	"semantic refs rejected as image points direct recovery to capture, not another observe",
	{ skip: !enabled },
	async () => {
		const f = fixture();
		try {
			await f.setup();
			await assert.rejects(
				f.call({
					op: "segment",
					ref: "snapshot-1",
					actions: [{ op: "click", point: { ref: "snapshot-1", x: 1, y: 1 } }],
					expected: { kind: "visual", description: "Target opens" },
				}),
				/stale_image.*capture.*Image ref.*Observation/s,
			);
			assert.equal(f.segments.length, 0);
			assert.equal(f.captures.length, 0);
			await f.call({ op: "capture", maxDimension: 512 });
			await f.call({
				op: "segment",
				ref: "image-2",
				actions: [{ op: "click", point: { ref: "image-2", x: 1, y: 1 } }],
				expected: { kind: "visual", description: "Target opens" },
			});
			assert.equal(f.segments.length, 1);
		} finally {
			await f.host.close();
		}
	},
);

test(
	"changed image stops before input and explains how to obtain usable evidence without replay",
	{ skip: !enabled },
	async () => {
		const f = fixture({ stopCode: "stale_image_observation" });
		try {
			await f.setup(true);
			const result = await f.call({
				op: "segment",
				ref: "image-1",
				actions: [{ op: "click", point: { ref: "image-1", x: 1, y: 1 } }],
				expected: { kind: "visual", description: "Destination opens" },
			});
			const text = result.content
				.filter((row) => row.type === "text")
				.map((row) => row.text)
				.join("\n");
			assert.match(text, /Action 1 of 1 was not dispatched/);
			assert.match(text, /stale_image_observation.*capture.*recompute/s);
			assert.match(text, /observe.*keyboard/s);
			assert.equal(f.segments.length, 1);
			assert.equal(f.captures.length, 2);
			assert.match(JSON.stringify(result.details), /"inputCommitted":false/);
		} finally {
			await f.host.close();
		}
	},
);

test(
	"held input after a shortcut reports the unfinished suffix and retains uncertainty of the prefix",
	{ skip: !enabled },
	async () => {
		const f = fixture({ stopCode: "physical_input_held_at_target" });
		try {
			await f.setup();
			const result = await f.call({
				op: "segment",
				ref: "snapshot-1",
				actions: [
					{ op: "key", key: "l", modifiers: ["command"] },
					{ op: "type_text", text: "test value" },
					{ op: "key", key: "Return" },
				],
				expected: { kind: "visual", description: "Destination opens" },
			});
			const text = result.content
				.filter((row) => row.type === "text")
				.map((row) => row.text)
				.join("\n");
			assert.match(text, /Action 2 of 3 was not dispatched/);
			assert.match(text, /Earlier actions may already have taken effect/);
			assert.match(text, /held key or button.*remote.*Do not synthesize/s);
			assert.match(JSON.stringify(result.details), /"inputCommitted":true/);
			assert.equal(f.segments.length, 1);
			await assert.rejects(
				f.call({
					op: "segment",
					ref: "image-2",
					actions: [{ op: "type_text", text: "test value" }],
					expected: { kind: "visual", description: "Destination opens" },
				}),
				/previous_intent_unresolved/,
			);
		} finally {
			await f.host.close();
		}
	},
);
