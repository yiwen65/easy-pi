import { isAbsolute } from "node:path";
import type { ComputerHost } from "@trycua/cua-driver";
import { ControlledComputerRuntime, type NativeHost } from "../controlled/adapter.ts";

export type BrowserNativeHost = NativeHost & Pick<ReturnType<typeof ComputerHost.create>, "openBrowserSession">;

export interface BrowserConfiguration {
	/** Trusted-host, content-qualified CfT bundle; never a tool parameter. */
	qualifiedBundle: string;
	/** Existing canonical private directory; Rust creates a new 0700 child/profile. */
	privateParent: string;
}

/** Same runtime/session/cancel/drain adapter; no dummy PID/window or browser loop. */
export function createControlledBrowserRuntime(
	owned: { host: BrowserNativeHost; destroy: () => void },
	configuration: BrowserConfiguration,
): ControlledComputerRuntime {
	if (!isAbsolute(configuration.qualifiedBundle) || !isAbsolute(configuration.privateParent)) {
		throw new Error("Browser configuration requires absolute trusted paths");
	}
	const captured = Object.freeze({ ...configuration });
	return new ControlledComputerRuntime(owned, (parent) =>
		owned.host.openBrowserSession(captured.qualifiedBundle, captured.privateParent, parent),
	);
}
