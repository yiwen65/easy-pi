import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeSession } from "../../controlled/adapter.ts";
import { type BrowserNativeHost, createControlledBrowserRuntime } from "../adapter.ts";

function fixture() {
	const sessions: NativeSession[] = [];
	const opens: Parameters<BrowserNativeHost["openBrowserSession"]>[] = [];
	let windowOpens = 0;
	let allocations = 0;
	let closes = 0;
	let destroys = 0;
	const host: BrowserNativeHost = {
		openSession() {
			windowOpens++;
			throw new Error("Native-window route must not be borrowed");
		},
		openBrowserSession(...args) {
			opens.push(args);
			const session: NativeSession = {
				newOperation() {
					allocations++;
					throw new Error("Unexpected native operation");
				},
				revoke() {},
				async close() {
					closes++;
				},
			};
			sessions.push(session);
			return session;
		},
		revoke() {},
		async close() {
			closes++;
		},
	};
	const configuration = { qualifiedBundle: "/qualified/CfT.app", privateParent: "/private/owned" };
	const runtime = createControlledBrowserRuntime(
		{
			host,
			destroy: () => {
				destroys++;
			},
		},
		configuration,
	);
	return { runtime, configuration, opens, sessions, counts: () => ({ windowOpens, allocations, closes, destroys }) };
}

test("browser factory passes genuine parent handles and frozen trusted paths without dummy targets", async () => {
	const value = fixture();
	value.configuration.qualifiedBundle = "/changed/not-used";
	const root = value.runtime.openSession();
	const child = value.runtime.openSession(root);
	assert.deepEqual(value.opens[0], ["/qualified/CfT.app", "/private/owned", undefined]);
	assert.deepEqual(value.opens[1], ["/qualified/CfT.app", "/private/owned", value.sessions[0]]);
	root.revoke();
	assert.equal(child.revoked, true);
	const call = child.observe(8, 4);
	await assert.rejects(call.result, /revoked/);
	await call.terminal;
	await value.runtime.close();
	assert.deepEqual(value.counts(), { windowOpens: 0, allocations: 0, closes: 3, destroys: 1 });
	assert.throws(() => value.runtime.openSession(), /closed/);
});

test("browser factory rejects a foreign parent before any native allocation", async () => {
	const first = fixture();
	const second = fixture();
	const foreign = second.runtime.openSession();
	assert.throws(() => first.runtime.openSession(foreign), /foreign/);
	assert.equal(first.opens.length, 0);
	await first.runtime.close();
	await second.runtime.close();
});
