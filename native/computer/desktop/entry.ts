import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	NativeComputerFeature,
	NativeComputerOptions,
} from "../../../packages/coding-agent/src/core/computer/activation.ts";
import { ComputerStopSignal, withComputerStop } from "../../../packages/coding-agent/src/core/computer/binding.ts";
import { ComputerHost } from "../../../packages/coding-agent/src/core/computer/host.ts";
import { createContextBrowserBinding } from "../browser/context-binding.ts";
import { ControlledComputerRuntime, type ControlledComputerSession } from "../controlled/adapter.ts";
import { createDesktopBinding } from "./binding.ts";
import { parseEmergencyChord } from "./emergency-config.ts";
import { loadDesktopSdk } from "./loader.ts";
import pins from "./pinned-inputs.json" with { type: "json" };
import { watchRenderer } from "./renderer-health.ts";
import { inspectRendererHelper, installedRendererSha256 } from "./renderer-helper.ts";

/** Fixed host-side interface, independent from the genuine generated native ABI. */
export const computerFeatureVersion = 2;

/** Built into the optional installation's computer/bridge.js; import is native-inert. */
export function createComputerFeature(options: NativeComputerOptions = {}): NativeComputerFeature {
	if (
		process.platform !== pins.platform ||
		process.arch !== pins.arch ||
		process.versions.node !== pins.nodeVersion ||
		process.versions.bun !== undefined
	) {
		throw new Error(`Computer requires Node ${pins.nodeVersion} on ${pins.platform}/${pins.arch}; no fallback`);
	}
	if (options.manifestPath !== undefined && !isAbsolute(options.manifestPath)) {
		throw new Error("Computer capability manifest must be an absolute trusted-host path");
	}
	if (options.browserBundlePath !== undefined && !isAbsolute(options.browserBundlePath)) {
		throw new Error("Computer browser bundle must be an absolute trusted-host path");
	}
	const manifestPath = options.manifestPath;
	const chord = options.emergencyChord === undefined ? undefined : parseEmergencyChord(options.emergencyChord);
	const stop = new ComputerStopSignal();
	let rendererWatch: ReturnType<typeof watchRenderer> | undefined;
	const browserBundlePath = options.browserBundlePath;
	let browserDirectory: string | undefined;
	const directory = join(dirname(fileURLToPath(import.meta.url)), "sdk");
	let api: ReturnType<typeof loadDesktopSdk> | undefined;
	let failure: { error: unknown } | undefined;
	const getApi = () => {
		if (failure) throw failure.error;
		try {
			api ??= loadDesktopSdk(directory);
			return api;
		} catch (error) {
			failure = { error }; // No implicit reload/retry after a failed native import.
			stop.update({ status: "failed", code: "native_sdk_unavailable" });
			throw error;
		}
	};
	const host = new ComputerHost<ControlledComputerSession>({
		desktopId: "native-computer-desktop",
		createRuntime: () => {
			let helperPath: string;
			try {
				helperPath = inspectRendererHelper(dirname(directory), installedRendererSha256);
			} catch (error) {
				stop.update({ status: "failed", code: "renderer_helper_unavailable" });
				throw error;
			}
			const sdk = getApi();
			// Allocate before native ownership; retain this root on any unproved close.
			if (browserBundlePath) browserDirectory = mkdtempSync(join(tmpdir(), "epi-computer-browser-"));
			const mode = manifestPath ? sdk.SessionPermissionMode.Bounded : sdk.SessionPermissionMode.Unrestricted;
			let native: ReturnType<typeof sdk.ComputerHost.createWithRenderer>;
			try {
				native = sdk.ComputerHost.createWithRenderer(
					{
						claudeCodeCompatibility: false,
						authorization: {
							allowedModes: [mode],
							compatibilityMode: mode,
							...(manifestPath ? { compatibilityCapabilityManifestPath: manifestPath } : {}),
							unrestrictedAcknowledged: manifestPath === undefined,
							maxSessionTtlSeconds: 3600n,
							maxIdleTtlSeconds: 600n,
						},
					},
					new sdk.ComputerRendererConfig.Required({
						helperPath,
						...(chord
							? {
									emergencyChord: {
										key: chord.key,
										modifiers: chord.modifiers.map((modifier) => sdk.ComputerModifier[modifier]),
									},
								}
							: {}),
					}),
				);
			} catch (error) {
				// Host creation also acquires the desktop lease. Preserve this known
				// refusal without exposing arbitrary native error payloads.
				const code =
					sdk.ComputerError.Refused.instanceOf(error) && error.inner.reason === "desktop_lease_unavailable"
						? "desktop_lease_unavailable"
						: "renderer_creation_failed";
				stop.update({ status: "failed", code });
				throw error;
			}
			rendererWatch = watchRenderer(sdk, native, stop);
			return new ControlledComputerRuntime(
				{
					host: native,
					onTerminal: () => rendererWatch?.refresh(),
					destroy: () => {
						rendererWatch?.dispose();
						if (!sdk.ComputerHost.instanceOf(native)) throw new Error("Computer native identity mismatch");
						native.uniffiDestroy();
					},
				},
				(parent) =>
					browserBundlePath
						? native.openBrowserSession(browserBundlePath, browserDirectory!, parent)
						: native.openDiscoverySession(parent),
			);
		},
	});
	const session = host.openSession();
	let closing: Promise<void> | undefined;
	return {
		binding: withComputerStop(
			browserBundlePath ? createContextBrowserBinding(session, getApi) : createDesktopBinding(session, getApi),
			stop,
		),
		close() {
			if (closing) return closing;
			rendererWatch?.dispose();
			let resolve!: () => void;
			let reject!: (error: unknown) => void;
			// Publish before synchronous revoke callbacks can reenter. No timer/retry.
			closing = new Promise<void>((accept, decline) => {
				resolve = accept;
				reject = decline;
			});
			try {
				void host
					.close()
					.then(() => {
						// Native has proved resource drain. Remove only our now-empty parent,
						// never recursively delete an unproved profile or foreign directory.
						if (browserDirectory) rmdirSync(browserDirectory);
						resolve();
					}, reject)
					.catch(reject);
			} catch (error) {
				reject(error);
			}
			return closing;
		},
	};
}
