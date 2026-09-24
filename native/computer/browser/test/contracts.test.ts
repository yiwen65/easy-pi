import assert from "node:assert/strict";
import { test } from "node:test";
import { parseControlledBrowserInput } from "../contracts.ts";

test("observation text search is literal, bounded and exclusive to observe", () => {
	for (const text of ["Tempor", "你好", ".*", "x".repeat(256)])
		assert.deepEqual(parseControlledBrowserInput({ request: { op: "observe", text } }), {
			request: { op: "observe", text },
		});
	for (const request of [
		{ op: "observe", text: "" },
		{ op: "observe", text: " " },
		{ op: "observe", text: "界".repeat(86) },
		{ op: "prepare", text: "x" },
	])
		assert.throws(() => parseControlledBrowserInput({ request }), /Invalid/);
});

test("browser protocol is fixed preparation/navigation plus the existing bounded plan language", () => {
	assert.deepEqual(parseControlledBrowserInput({ request: { op: "prepare" } }), { request: { op: "prepare" } });
	for (const url of ["about:blank", "http://127.0.0.1:1234/form", "https://example.test/"]) {
		assert.deepEqual(parseControlledBrowserInput({ request: { op: "prepare", url }, observeAfter: true }), {
			request: { op: "prepare", url },
			observeAfter: true,
		});
		assert.deepEqual(parseControlledBrowserInput({ request: { op: "navigate", url } }), {
			request: { op: "navigate", url },
		});
	}
	const input = { request: { op: "observe" } };
	assert.notEqual(parseControlledBrowserInput(input), input);
	const click = { request: { op: "click", ref: "observation", target: "observation:0" } };
	assert.deepEqual(parseControlledBrowserInput(click), click);
	const option = { request: { op: "select_option", ref: "observation", target: "observation:1" } };
	assert.deepEqual(parseControlledBrowserInput(option), option);
	const scroll = { request: { op: "scroll_into_view", ref: "observation", target: "observation:2" } };
	assert.deepEqual(parseControlledBrowserInput(scroll), scroll);
});

test("model input cannot choose executable/profile/session, script, foreground or credential URLs", () => {
	for (const request of [
		{ op: "prepare", executable: "/arbitrary" },
		{ op: "prepare", profile: "personal" },
		{ op: "observe", session: "foreign" },
		{ op: "execute", script: "arbitrary()" },
		{ op: "click", ref: "o", target: "t", x: 1 },
		{ op: "click", ref: "o", target: { selector: { role: "button", label: "guessed" } } },
		{ op: "click", ref: "o", target: "界".repeat(100) },
		{ op: "select_option", ref: "o", target: "t", value: "guessed" },
		{ op: "select_option", ref: "o", target: "界".repeat(100) },
		{ op: "scroll_into_view", ref: "o", target: "t", script: "arbitrary()" },
		{ op: "scroll_into_view", ref: "o", target: "t", direction: "down" },
		{ op: "scroll_into_view", ref: "o", target: "界".repeat(43) },
		{ op: "scroll_into_view", ref: "界".repeat(43), target: "t" },
		...[
			"javascript:1",
			"file:///private",
			"https://user:password@example.test",
			"about:settings",
			`https://example.test/${"界".repeat(700)}`,
		].flatMap((url) => [
			{ op: "navigate", url },
			{ op: "prepare", url },
		]),
	])
		assert.throws(() => parseControlledBrowserInput({ request }), /Invalid/);
});

test("optional post-action observation is browser-only, true-only and does not loosen action bounds", () => {
	for (const request of [
		{ op: "navigate", url: "https://example.test/" },
		{ op: "click", ref: "o", target: "o:1" },
		{ op: "select_option", ref: "o", target: "o:1" },
		{ op: "scroll_into_view", ref: "o", target: "o:1" },
		{ op: "execute", ref: "o", steps: [{ op: "fill", target: { ref: "o:1" }, text: "你好" }] },
	]) {
		const input = { request, observeAfter: true };
		assert.deepEqual(parseControlledBrowserInput(input), input);
	}
	for (const input of [
		{ request: { op: "prepare" }, observeAfter: true },
		{ request: { op: "observe" }, observeAfter: true },
		{ request: { op: "click", ref: "o", target: "o:1" }, observeAfter: false },
		{ request: { op: "click", ref: "o", target: "界".repeat(100) }, observeAfter: true },
	])
		assert.throws(() => parseControlledBrowserInput(input), /Invalid/);
});
