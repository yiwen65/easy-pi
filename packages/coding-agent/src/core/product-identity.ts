/** Package-level branding overrides; the public piConfig manifest key stays compatible. */
export interface ProductConfig {
	name?: string;
	configDir?: string;
}

export function resolveProductIdentity(config: ProductConfig = {}) {
	const appName = config.name || "easy-pi";
	// Upstream manifests carry .pi even without a custom product name. Do not
	// let that inherited default silently opt easy-pi into upstream user data.
	const configDirName = appName === "easy-pi" && config.configDir === ".pi" ? ".epi" : config.configDir || ".epi";
	const envPrefix = appName.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
	return {
		appName,
		appTitle: appName,
		configDirName,
		envAgentDir: `${envPrefix}_CODING_AGENT_DIR`,
		envSessionDir: `${envPrefix}_CODING_AGENT_SESSION_DIR`,
	};
}
