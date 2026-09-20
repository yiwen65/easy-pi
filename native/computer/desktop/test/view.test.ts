import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { DesktopView } from "../view.ts";

function result(): ToolResultMessage {
	return {
		role: "toolResult",
		toolName: "computer",
		toolCallId: "capture-1",
		isError: false,
		timestamp: 1,
		content: [
			{ type: "text", text: "Image ref: session-local-ref" },
			{ type: "image", data: "cG5n", mimeType: "image/png" },
		],
	};
}

function pending(message = result()) {
	const view = new DesktopView<string>();
	view.publish(message.toolCallId, message.content, "session-local-ref");
	return view;
}

test("a published image is not authority until present in actual provider context", () => {
	assert.equal(pending().consume(), undefined);
	const view = pending();
	view.observeContext(true, [structuredClone(result())]);
	assert.equal(view.consume(), "session-local-ref");
	assert.equal(view.consume(), undefined);
});

test("image filtering, disabled vision and compaction permanently invalidate", () => {
	for (const mode of ["filtered", "disabled", "compacted"] as const) {
		const view = pending();
		view.observeContext(true, [result()]);
		const message = result();
		message.content = message.content.filter((part) => part.type !== "image");
		view.observeContext(mode !== "disabled", mode === "compacted" ? [] : [message]);
		view.observeContext(true, [result()]);
		assert.equal(view.consume(), undefined, mode);
	}
});

test("altered text, pixels, mime type, tool, error or duplicate result cannot grant authority", () => {
	const mutations: Array<(message: ToolResultMessage) => void> = [
		(message) => {
			message.content[0] = { type: "text", text: "another ref" };
		},
		(message) => {
			message.content[1] = { type: "image", data: "changed", mimeType: "image/png" };
		},
		(message) => {
			message.content[1] = { type: "image", data: "cG5n", mimeType: "image/jpeg" };
		},
		(message) => {
			message.toolName = "foreign";
		},
		(message) => {
			message.isError = true;
		},
		(message) => {
			message.toolCallId = "foreign";
		},
	];
	for (const mutate of mutations) {
		const view = pending();
		const message = result();
		mutate(message);
		view.observeContext(true, [message]);
		assert.equal(view.consume(), undefined);
	}
	const view = pending();
	view.observeContext(true, [result(), result()]);
	assert.equal(view.consume(), undefined);
});

test("an observer exception cannot retain or later restore the old grant", () => {
	const view = pending();
	view.observeContext(true, [result()]);
	const messages = new Proxy<Message[]>([], {
		get() {
			throw new Error("transformed context failure");
		},
	});
	assert.throws(() => view.observeContext(true, messages), /transformed context failure/);
	view.observeContext(true, [result()]);
	assert.equal(view.consume(), undefined);
});

test("renewed views never infer authority from persisted messages", () => {
	const view = new DesktopView<string>();
	view.observeContext(true, [result()]);
	assert.equal(view.consume(), undefined);
});

test("text-only catalog grants do not require vision but do require exact visible content", () => {
	const message = result();
	message.content = [{ type: "text", text: "Window ref: opaque-window" }];
	const view = pending(message);
	view.observeContext(false, [message]);
	assert.equal(view.consume(), "session-local-ref");
});

test("new publication and explicit retirement invalidate previous authority", () => {
	const view = pending();
	view.observeContext(true, [result()]);
	const next = result();
	next.toolCallId = "capture-2";
	view.publish(next.toolCallId, next.content, "new-ref");
	view.observeContext(true, [result()]);
	assert.equal(view.consume(), undefined);
	view.publish(next.toolCallId, next.content, "new-ref");
	view.clear();
	view.observeContext(true, [next]);
	assert.equal(view.consume(), undefined);
});
