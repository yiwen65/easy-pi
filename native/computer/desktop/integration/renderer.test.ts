import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import type * as CuaSdk from "@trycua/cua-driver";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../../../packages/coding-agent/src/core/extensions/types.ts";
import { createComputerFeature } from "../entry.ts";

const mocks = vi.hoisted(() => ({ api: undefined as unknown, inspect: vi.fn(), load: vi.fn() }));
// Desktop tools do not consume extension context; any accidental access must fail this fixture.
const context = new Proxy({} as ExtensionContext, {
	get() {
		throw new Error("Unexpected context access");
	},
});
vi.mock("../loader.ts", () => ({ loadDesktopSdk: mocks.load }));
vi.mock("../renderer-helper.ts", () => ({
	inspectRendererHelper: mocks.inspect,
	installedRendererSha256: "verified-by-packager",
}));

beforeEach(() => {
	vi.useFakeTimers();
	mocks.inspect.mockReset().mockReturnValue("/trusted/installed/renderer/computer-renderer");
	mocks.load.mockReset().mockImplementation(() => mocks.api);
});
afterEach(() => {
	vi.useRealTimers();
});

function fixture() {
	expect(process.env.ALLOW_GUI_TESTS).toBe("false");
	expect(process.env.ALLOW_REAL_APIS).toBe("false");
	expect(process.env.COMPUTER_EMERGENCY_VALUE_TESTS).toBe("true");
	const directory = process.env.COMPUTER_EMERGENCY_SDK!;
	expect(isAbsolute(directory)).toBe(true);
	for (const [name, hash] of [
		["libcua_driver_sdk.dylib", "b7e0ad955c1fcf7808842bc10286fb76ad3fbb6829ea78172fb4c1e6db66217b"],
		["cua_driver_node_runtime.node", "93ffdcc7fbba3437af84c61d60d5d6a8cbf231129f5b1ad4c947abeb8a5aed5a"],
	] as const)
		expect(
			createHash("sha256")
				.update(readFileSync(join(directory, "node_modules/@trycua/cua-driver-darwin-arm64", name)))
				.digest("hex"),
		).toBe(hash);
	const sdk = createRequire(import.meta.url)(join(directory, "dist/computer.js")) as typeof CuaSdk;
	let status: CuaSdk.ComputerRendererStatus = new sdk.ComputerRendererStatus.Ready({ pid: 7, windowId: 8 });
	const native = {
		rendererStatus: vi.fn(() => status),
		revoke: vi.fn(),
		close: vi.fn(async () => {}),
		uniffiDestroy: vi.fn(() => {
			expect(vi.getTimerCount()).toBe(0);
		}),
		openDiscoverySession: vi.fn(() => ({
			revoke: vi.fn(),
			close: vi.fn(async () => {}),
			newOperation: () => ({
				cancel() {},
				startListWindows() {},
				result: async () => new sdk.ComputerResult.Windows({ windows: [], omittedWindows: 0, filteredOut: 0 }),
				terminal: async () => ({ operationId: "mock", inputCommitted: false, cancelled: false }),
			}),
		})),
	};
	const createWithRenderer = vi.fn(() => native);
	// Replacing the entire host surface makes genuine native construction unreachable.
	mocks.api = { ...sdk, ComputerHost: { createWithRenderer, instanceOf: (value: unknown) => value === native } };
	return {
		sdk,
		native,
		createWithRenderer,
		setStatus: (value: CuaSdk.ComputerRendererStatus) => {
			status = value;
		},
	};
}

it("lazy entry verifies helper before ownership and wires Required with genuine physical chord values", async () => {
	const f = fixture();
	const feature = createComputerFeature({ emergencyChord: "super+shift+a" });
	expect(mocks.inspect).not.toHaveBeenCalled();
	expect(mocks.load).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
	expect(feature.binding.rendererHealth).toEqual({ status: "not_started" });
	await feature.binding.tools[0]!.execute("discover", { request: { op: "discover" } }, undefined, undefined, context);
	expect(mocks.inspect.mock.invocationCallOrder[0]).toBeLessThan(f.createWithRenderer.mock.invocationCallOrder[0]!);
	const args = f.createWithRenderer.mock.calls[0] as unknown as Parameters<
		typeof f.sdk.ComputerHost.createWithRenderer
	>;
	expect(f.sdk.ComputerRendererConfig.Required.instanceOf(args[1])).toBe(true);
	if (!f.sdk.ComputerRendererConfig.Required.instanceOf(args[1])) throw new Error("Required config missing");
	expect(args[1].inner).toEqual({
		helperPath: "/trusted/installed/renderer/computer-renderer",
		emergencyChord: { key: "a", modifiers: [f.sdk.ComputerModifier.Command, f.sdk.ComputerModifier.Shift] },
	});
	expect(feature.binding.rendererHealth).toEqual({ status: "ready", pid: 7, windowId: 8 });
	expect(vi.getTimerCount()).toBe(1);
	const stopped = vi.fn();
	feature.binding.subscribeStop?.(stopped);
	f.setStatus(new f.sdk.ComputerRendererStatus.EmergencyStopped());
	vi.advanceTimersByTime(100);
	expect(stopped).toHaveBeenCalledWith({ status: "emergency_stopped" });
	expect(feature.binding.revoked).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
	await feature.close();
	expect(f.native.uniffiDestroy).toHaveBeenCalledTimes(1);
});

it("missing helper refuses before native import/ownership; unused close allocates no timer", async () => {
	const f = fixture();
	const unused = createComputerFeature();
	await unused.close();
	expect(mocks.load).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
	mocks.inspect.mockImplementation(() => {
		throw new Error("mismatched helper");
	});
	const feature = createComputerFeature();
	await expect(
		feature.binding.tools[0]!.execute("discover", { request: { op: "discover" } }, undefined, undefined, context),
	).rejects.toThrow();
	expect(feature.binding.rendererHealth).toEqual({ status: "failed", code: "renderer_helper_unavailable" });
	expect(mocks.load).not.toHaveBeenCalled();
	expect(f.createWithRenderer).not.toHaveBeenCalled();
	await feature.close();
	expect(vi.getTimerCount()).toBe(0);
});

it("DisabledDiagnostic refuses before opening any session and closing stops a healthy timer before destruction", async () => {
	const f = fixture();
	f.setStatus(new f.sdk.ComputerRendererStatus.DisabledDiagnostic());
	const feature = createComputerFeature();
	await expect(
		feature.binding.tools[0]!.execute("discover", { request: { op: "discover" } }, undefined, undefined, context),
	).rejects.toThrow();
	expect(f.native.openDiscoverySession).not.toHaveBeenCalled();
	expect(feature.binding.rendererHealth).toEqual({ status: "failed", code: "renderer_required" });
	await feature.close();
	const healthy = fixture();
	const next = createComputerFeature();
	await next.binding.tools[0]!.execute("discover", { request: { op: "discover" } }, undefined, undefined, context);
	expect(vi.getTimerCount()).toBe(1);
	await next.close();
	expect(healthy.native.uniffiDestroy).toHaveBeenCalledTimes(1);
	expect(vi.getTimerCount()).toBe(0);
});
