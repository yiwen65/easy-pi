import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import type * as CuaSdk from "@trycua/cua-driver";
import { watchRenderer } from "../renderer-health.ts";

const enabled = process.env.COMPUTER_EMERGENCY_VALUE_TESTS === "true";
test(
	"genuine generated renderer states stop once, distinguish emergency and dispose polling",
	{ skip: !enabled },
	(t) => {
		assert.equal(process.env.ALLOW_GUI_TESTS, "false");
		assert.equal(process.env.ALLOW_REAL_APIS, "false");
		const directory = process.env.COMPUTER_EMERGENCY_SDK;
		assert.ok(directory && isAbsolute(directory));
		for (const [name, hash] of [
			["libcua_driver_sdk.dylib", "08b4fdbdb39b0322ffb7529c8a06ed8b87d88962b8c652bea1c79b8d081f3575"],
			["cua_driver_node_runtime.node", "93ffdcc7fbba3437af84c61d60d5d6a8cbf231129f5b1ad4c947abeb8a5aed5a"],
		] as const)
			assert.equal(
				createHash("sha256")
					.update(readFileSync(join(directory, "node_modules/@trycua/cua-driver-darwin-arm64", name)))
					.digest("hex"),
				hash,
			);
		const api = createRequire(import.meta.url)(join(directory, "dist/computer.js")) as typeof CuaSdk;
		// Only generated values are constructed; never ComputerHost or permission methods.
		const config = new api.ComputerRendererConfig.Required({
			helperPath: "/not-executed",
			emergencyChord: { key: "escape", modifiers: [api.ComputerModifier.Control, api.ComputerModifier.Option] },
		});
		assert.equal(config.inner.emergencyChord?.key, "escape");
		t.mock.timers.enable({ apis: ["setInterval"] });
		for (const [state, expected] of [
			[new api.ComputerRendererStatus.EmergencyStopped(), { status: "emergency_stopped" }],
			[new api.ComputerRendererStatus.Failed({ code: "helper_eof" }), { status: "failed", code: "helper_eof" }],
			[new api.ComputerRendererStatus.DisabledDiagnostic(), { status: "failed", code: "renderer_required" }],
		] as const) {
			let current: CuaSdk.ComputerRendererStatus = new api.ComputerRendererStatus.Ready({ pid: 123, windowId: 456 });
			let calls = 0;
			let health: unknown;
			let stopped = false;
			const stopWatching = watchRenderer(
				api,
				{
					rendererStatus: () => {
						calls++;
						return current;
					},
				},
				{
					get stopped() {
						return stopped;
					},
					update(value) {
						health = value;
						stopped = value.status !== "ready";
					},
				},
			);
			assert.deepEqual(health, { status: "ready", pid: 123, windowId: 456 });
			t.mock.timers.tick(100);
			assert.equal(calls, 2);
			current = state;
			stopWatching.refresh(); // native terminal must not await the 100ms timer
			assert.deepEqual(health, expected);
			const count = calls;
			t.mock.timers.tick(1000);
			assert.equal(calls, count);
			stopWatching.dispose();
			stopWatching.dispose();
			stopWatching.refresh();
			assert.equal(calls, count);
		}
		let calls = 0;
		const dispose = watchRenderer(
			api,
			{
				rendererStatus: () => {
					calls++;
					return new api.ComputerRendererStatus.Ready({ pid: 1, windowId: 2 });
				},
			},
			{ stopped: false, update() {} },
		);
		dispose.dispose();
		dispose.refresh();
		t.mock.timers.tick(1000);
		assert.equal(calls, 1);
		let failure: unknown;
		watchRenderer(
			api,
			{
				rendererStatus: () => {
					throw new Error("status read failed");
				},
			},
			{
				get stopped() {
					return failure !== undefined;
				},
				update(value) {
					failure = value;
				},
			},
		);
		assert.deepEqual(failure, { status: "failed", code: "renderer_status_unavailable" });
	},
);
