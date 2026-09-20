import assert from "node:assert/strict";
import { loadControlledSdk } from "./loader.ts";

assert.equal(process.env.ALLOW_NATIVE_LOAD_TESTS, "true");
assert.equal(process.env.ALLOW_GUI_TESTS, "false");
assert.equal(process.env.ALLOW_REAL_APIS, "false");
const sdkDirectory = process.argv[2];
assert.ok(sdkDirectory, "P03 SDK directory required");
const sdk = loadControlledSdk(sdkDirectory);
assert.equal(typeof sdk.ComputerHost.create, "function");
assert.equal(typeof sdk.ComputerHost.prototype.openSession, "function");
assert.equal(typeof sdk.ComputerSession.prototype.close, "function");
assert.equal(typeof sdk.ComputerOperation.prototype.cancel, "function");
assert.equal(typeof sdk.ComputerOperation.prototype.result, "function");
// No constructor, desktop lease, permission getter, native operation or forced exit.
setImmediate(() => console.log("controlled-sdk-loaded; event-loop-turn; no-host-or-permission-call"));
