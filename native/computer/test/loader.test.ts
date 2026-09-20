import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createPinnedNativeComputer,
	inspectPinnedSdk,
	loadPinnedSdk,
	type NativeHostConfiguration,
} from "../loader.ts";

const configuration: NativeHostConfiguration = [
	{
		claudeCodeCompatibility: false,
		authorization: {
			allowedModes: [],
			compatibilityMode: 0,
			unrestrictedAcknowledged: false,
			maxSessionTtlSeconds: 1n,
			maxIdleTtlSeconds: 1n,
		},
	},
	{
		authorize: async () => {
			throw new Error("Test must not invoke authorization");
		},
	},
	{
		onActivity: () => {
			throw new Error("Test must not invoke activity observer");
		},
	},
];

test("construct and close without open never resolve or load the absent optional SDK", async () => {
	const adapter = createPinnedNativeComputer("/absent-computer-sdk", ...configuration);
	await adapter.close();
	await assert.rejects(adapter.open(), /closed/i);
});

test("missing SDK rejects once without any driver or callback", async () => {
	const adapter = createPinnedNativeComputer("/absent-computer-sdk", ...configuration);
	await assert.rejects(adapter.open());
	await assert.rejects(adapter.open());
	await adapter.close();
});

test("inspection requires an absolute directory and rejects drift before executing upstream JS", (t) => {
	assert.throws(() => inspectPinnedSdk("relative"), /must be absolute/);
	const directory = mkdtempSync(join(tmpdir(), "computer-loader-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	mkdirSync(join(directory, "dist/native"), { recursive: true });
	writeFileSync(join(directory, "package.json"), '{"type":"module"}');
	writeFileSync(join(directory, "dist/index.js"), 'throw new Error("UNAPPROVED_JS_EXECUTED")');
	writeFileSync(join(directory, "dist/index.d.ts"), "export {};");
	assert.throws(() => inspectPinnedSdk(directory), /integrity mismatch/);
});

test("platform mismatch rejects before any SDK lookup", (t) => {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	t.after(() => Object.defineProperty(process, "platform", descriptor));
	Object.defineProperty(process, "platform", { value: "unsupported", configurable: true });
	assert.throws(() => loadPinnedSdk("not-even-an-absolute-path"), /requires Node .* on darwin\/arm64/);
});
