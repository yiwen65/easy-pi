import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	NativeComputerFeature,
	NativeComputerOptions,
} from "../../../packages/coding-agent/src/core/computer/activation.ts";
import { ComputerHost } from "../../../packages/coding-agent/src/core/computer/host.ts";
import { createContextBrowserBinding } from "../browser/context-binding.ts";
import { ControlledComputerRuntime, type ControlledComputerSession } from "../controlled/adapter.ts";
import { createDesktopBinding } from "./binding.ts";
import { loadDesktopSdk } from "./loader.ts";
import pins from "./pinned-inputs.json" with { type: "json" };

/** Fixed host-side interface, independent from the genuine generated native ABI. */
export const computerFeatureVersion = 1;

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
			throw error;
		}
	};
	const host = new ComputerHost<ControlledComputerSession>({
		desktopId: "native-computer-desktop",
		createRuntime: () => {
			const sdk = getApi();
			// Allocate before native ownership; retain this root on any unproved close.
			if (browserBundlePath) browserDirectory = mkdtempSync(join(tmpdir(), "epi-computer-browser-"));
			const mode = manifestPath ? sdk.SessionPermissionMode.Bounded : sdk.SessionPermissionMode.Unrestricted;
			const native = sdk.ComputerHost.create({
				claudeCodeCompatibility: false,
				authorization: {
					allowedModes: [mode],
					compatibilityMode: mode,
					compatibilityCapabilityManifestPath: manifestPath,
					unrestrictedAcknowledged: manifestPath === undefined,
					maxSessionTtlSeconds: 3600n,
					maxIdleTtlSeconds: 600n,
				},
			});
			return new ControlledComputerRuntime(
				{
					host: native,
					destroy: () => {
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
		binding: browserBundlePath ? createContextBrowserBinding(session, getApi) : createDesktopBinding(session, getApi),
		close() {
			if (closing) return closing;
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
