import assert from "node:assert/strict";
import { loadPinnedSdk } from "../loader.ts";

assert.equal(process.env.ALLOW_NATIVE_LOAD_TESTS, "true");
assert.equal(process.env.ALLOW_GUI_TESTS, "false");
assert.equal(process.env.ALLOW_REAL_APIS, "false");
const sdkDirectory = process.argv[2];
assert.ok(sdkDirectory, "SDK directory required");
const sdk = loadPinnedSdk(sdkDirectory);
assert.equal(typeof sdk.CuaDriver.createConfiguredWithHostIntegrations, "function");
// Pure generated record/union codecs, with a JS allocator: no native operation is dispatched.
// This deliberately oversized ID tests u64 precision, not a valid macOS window.
const windowId = 9_007_199_254_740_993n;
const converters = sdk.default.cua_driver_contract.default.converters;
const observation = sdk.GetWindowStateInput.create({ pid: 42, windowId, includeScreenshot: false });
const observationCodec = converters.FfiConverterTypeGetWindowStateInput;
assert.equal(
	observationCodec.lift(observationCodec.lower(observation, (size) => new Uint8Array(size))).windowId,
	windowId,
);
const click = sdk.ClickInput.create({
	target: new sdk.ActionTarget.Window({ pid: 42, windowId }),
	position: new sdk.ClickPosition.Coordinates({ x: 1, y: 2 }),
	deliveryMode: sdk.InputDeliveryMode.Background,
});
const clickCodec = converters.FfiConverterTypeClickInput;
const decoded = clickCodec.lift(clickCodec.lower(click, (size) => new Uint8Array(size)));
assert.ok(sdk.ActionTarget.Window.instanceOf(decoded.target));
assert.equal(decoded.target.inner.windowId, windowId);
assert.equal(decoded.deliveryMode, sdk.InputDeliveryMode.Background);
const effectCodec = converters.FfiConverterTypeActionResult;
const unconfirmed = sdk.ActionResult.create({
	effect: sdk.ActionEffect.Unverifiable,
	route: sdk.ActionRoute.Accessibility,
});
assert.equal(
	effectCodec.lift(effectCodec.lower(unconfirmed, (size) => new Uint8Array(size))).effect,
	sdk.ActionEffect.Unverifiable,
);
console.log("generated-codecs: u64-window; click-target; unconfirmed-effect");
// Deliberately do NOT call a driver constructor/method, permission getter, or TCC function.
setImmediate(() => console.log("pinned-sdk-initialized; event-loop-responsive; no-driver-method-invoked"));
// No process.exit(): natural exit (or a test timeout) is part of the result.
