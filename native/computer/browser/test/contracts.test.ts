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
});

test("model input cannot choose executable/profile/session, script, foreground or credential URLs", () => {
	for (const request of [
		{ op: "prepare", executable: "/arbitrary" },
		{ op: "prepare", profile: "personal" },
		{ op: "observe", session: "foreign" },
		{ op: "execute", script: "arbitrary()" },
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
