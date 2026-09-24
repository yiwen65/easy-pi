import assert from "node:assert/strict";
import { test } from "node:test";
import { parseControlledBrowserInput } from "../contracts.ts";

test("browser protocol is fixed preparation/navigation plus the existing bounded plan language", () => {
	assert.deepEqual(parseControlledBrowserInput({ request: { op: "prepare" } }), { request: { op: "prepare" } });
	for (const url of ["about:blank", "http://127.0.0.1:1234/form", "https://example.test/"]) {
		assert.deepEqual(parseControlledBrowserInput({ request: { op: "navigate", url } }), {
			request: { op: "navigate", url },
		});
	}
	const input = { request: { op: "observe" } };
	assert.notEqual(parseControlledBrowserInput(input), input);
	const click = { request: { op: "click", ref: "observation", target: "observation:0" } };
	assert.deepEqual(parseControlledBrowserInput(click), click);
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
		...[
			"javascript:1",
			"file:///private",
			"https://user:password@example.test",
			"about:settings",
			`https://example.test/${"界".repeat(700)}`,
		].map((url) => ({ op: "navigate", url })),
	])
		assert.throws(() => parseControlledBrowserInput({ request }), /Invalid/);
});
