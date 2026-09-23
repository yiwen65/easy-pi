import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "../../config.ts";
import { KeybindingsManager } from "../keybindings.ts";
import type { ComputerSessionBinding } from "./binding.ts";

export interface NativeComputerFeature {
	readonly binding: ComputerSessionBinding;
	/** Process/embedding-host lifetime, not a child/session close operation. */
	close(): Promise<void>;
}

export interface NativeComputerOptions {
	/** One trusted app-format physical key chord; fixed until a new feature/host is created. */
	emergencyChord?: string | readonly string[];
	/** Explicit trusted host path. Never taken from model input or project discovery. */
	manifestPath?: string;
	/** Select the isolated DOM profile instead of native-window/pixel operations. */
	browserBundlePath?: string;
}

/** The explicit allowlist overrides no-tools, while exclusion always wins (existing SDK policy). */
export function shouldActivateComputer(options: {
	computer?: boolean;
	help?: boolean;
	listModels?: string | boolean;
	tools?: readonly string[];
	excludeTools?: readonly string[];
	noTools?: boolean;
}): boolean {
	if (!options.computer || options.help || options.listModels !== undefined) return false;
	if (options.excludeTools?.includes("computer")) return false;
	return options.tools !== undefined ? options.tools.includes("computer") : !options.noTools;
}

/**
 * Explicit SDK activation; the CLI enables this capability by default unless filtered.
 * Construction loads only the installed JS bridge. Native loading, renderer startup
 * and desktop ownership remain lazy until the first Computer tool execution.
 */
export function createNativeComputerFeature(options: NativeComputerOptions = {}): NativeComputerFeature {
	if (options.manifestPath !== undefined && !isAbsolute(options.manifestPath)) {
		throw new Error("Computer capability manifest must be an absolute trusted-host path");
	}
	if (options.browserBundlePath !== undefined && !isAbsolute(options.browserBundlePath)) {
		throw new Error("Computer browser bundle must be an absolute trusted-host path");
	}
	const entry = join(getPackageDir(), "computer", "bridge.js");
	let loaded: unknown;
	try {
		loaded = createRequire(pathToFileURL(entry))(entry);
	} catch (error) {
		throw new Error("Computer is unavailable: install the matching optional Computer assets for this runtime", {
			cause: error,
		});
	}
	if (
		typeof loaded !== "object" ||
		loaded === null ||
		!("computerFeatureVersion" in loaded) ||
		loaded.computerFeatureVersion !== 2 ||
		!("createComputerFeature" in loaded) ||
		typeof loaded.createComputerFeature !== "function"
	) {
		throw new Error("Computer assets do not match this host interface");
	}
	// An explicitly installed, trusted module, not a model-selected plugin/FFI.
	const module = loaded as {
		createComputerFeature(options: NativeComputerOptions): NativeComputerFeature;
	};
	const emergencyChord =
		options.emergencyChord !== undefined
			? options.emergencyChord
			: KeybindingsManager.create().getKeys("app.computer.emergencyStop");
	return module.createComputerFeature({ ...options, emergencyChord });
}
