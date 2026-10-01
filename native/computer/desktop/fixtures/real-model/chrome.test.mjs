import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fixtureStateExpression } from "./chrome.mjs";

const url = "http://127.0.0.1:45678/";
test("failed-task diagnostics read only the exact fixture origin", () => {
	for (const origin of ["https://example.com", "http://127.0.0.1:45679", "null"]) {
		const result = runInNewContext(fixtureStateExpression(url), {
			location: { origin },
			get document() {
				throw Error("must not inspect another origin");
			},
		});
		assert.equal(JSON.stringify(result), '{"status":"outside_fixture"}');
	}
	for (const invalid of ["https://example.com", "file:///tmp/fixture.html", "about:blank"])
		assert.throws(() => fixtureStateExpression(invalid), /loopback fixture/);
});

test("failed-task diagnostics bound text and preserve readiness without changing the page", () => {
	const text = "x".repeat(5000);
	const document = Object.freeze({
		readyState: "complete",
		visibilityState: "hidden",
		hasFocus: () => false,
		body: Object.freeze({
			innerText: text,
			getBoundingClientRect: () => ({ x: 40, y: 40, width: 1020, height: 240 }),
		}),
	});
	const result = runInNewContext(fixtureStateExpression(url), {
		location: Object.freeze({ origin: new URL(url).origin, pathname: "/records" }),
		document,
		innerWidth: 1100,
		innerHeight: 750,
	});
	assert.equal(result.status, "observed");
	assert.equal(result.path, "/records");
	assert.equal(result.ready, "complete");
	assert.equal(result.visibility, "hidden");
	assert.equal(result.focused, false);
	assert.equal(result.bodyText.length, 4096);
	assert.equal(result.bodyTextTruncated, true);
	assert.equal(JSON.stringify(result.bodyRect), "[40,40,1020,240]");
	assert.equal(JSON.stringify(result.viewport), "[1100,750]");
	assert.equal(document.body.innerText, text);
});

test("failed-task diagnostics preserve an unfinished document instead of fabricating content", () => {
	const result = runInNewContext(fixtureStateExpression(url), {
		location: { origin: new URL(url).origin, pathname: "/records" },
		document: { readyState: "loading", visibilityState: "visible", hasFocus: () => true, body: null },
		innerWidth: 1100,
		innerHeight: 750,
	});
	assert.equal(result.ready, "loading");
	assert.equal(result.bodyText, "");
	assert.equal(result.bodyTextTruncated, false);
	assert.equal(result.bodyRect, null);
});
