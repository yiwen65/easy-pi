/**
 * MCP server configuration and extension registrations. Core stores configuration only;
 * an extension handling mcp_servers_change owns connections and their lifecycle.
 */

function toolPatternRegExp(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

/** Match exact tool names or patterns where only `*` is special. */
export function createToolNameMatcher(entries: readonly string[]): (name: string) => boolean {
	const names = new Set(entries.filter((entry) => !entry.includes("*")));
	const patterns = entries.filter((entry) => entry.includes("*")).map(toolPatternRegExp);
	return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}

export const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";
export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
	LIST_MCP_RESOURCES_TOOL,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	READ_MCP_RESOURCE_TOOL,
]);

/** MCP server tools and the shared MCP resource tools. This is not an authorization check. */
export function isMcpToolName(name: string): boolean {
	return name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.has(name);
}

/** Codemode tools are script-only; deferred tools require discovery; hidden tools are unreachable. */
export type McpExposure = "deferred" | "direct" | "codemode" | "hidden";

const MCP_EXPOSURES: readonly string[] = ["deferred", "direct", "codemode", "hidden"] satisfies McpExposure[];

/** Exposure of an MCP server's tools when neither the entry nor `toolExposure` selects one. */
export const DEFAULT_MCP_EXPOSURE: McpExposure = "codemode";

interface McpServerConfigBase {
	/** Default: {@link DEFAULT_MCP_EXPOSURE}. */
	exposure?: McpExposure;
	/** Short summary of what the server offers. */
	description?: string;
	/** Exact names take precedence over patterns; the first matching `*` pattern wins. */
	toolExposure?: Record<string, McpExposure>;
	/** Default: true. Disabled entries remain registered without connecting. */
	enabled?: boolean;
	/** Per-request timeout in seconds, reset by progress notifications. Default: 60. */
	timeout?: number;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	/** Values may reference environment variables (`${NAME}`) or commands (`!cmd`). */
	env?: Record<string, string>;
	/** Relative paths resolve against the session working directory. */
	cwd?: string;
}

export interface McpOAuthConfig {
	/** Without a pre-registered id, use dynamic client registration. */
	clientId?: string;
	/** May reference environment variables (`${NAME}`) or commands (`!cmd`). */
	clientSecret?: string;
	callbackPort?: number;
	/** HTTP loopback redirect URI, without query or fragment. */
	callbackUrl?: string;
	scope?: string;
	/** Client name for dynamic registration. Default: pi. */
	clientName?: string;
	/** Only dynamic client registration is supported in this phase. */
	clientRegistration?: "dcr";
	/** Trusted metadata URL: HTTPS, or HTTP on loopback. */
	authServerMetadataUrl?: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
	type?: "http" | "streamable-http";
	url: string;
	/** Values may reference environment variables (`${NAME}`) or commands (`!cmd`). */
	headers?: Record<string, string>;
	oauth?: McpOAuthConfig;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Namespace of a server's tools, with `-` replaced by `_` like the tool names. */
export function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}`;
}

export function isLoopbackRedirectUri(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return (
		url.protocol === "http:" &&
		LOOPBACK_HOSTS.includes(url.hostname) &&
		!url.username &&
		!url.password &&
		url.search === "" &&
		url.hash === ""
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function validateOAuth(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "oauth must be an object";
	if (value.clientId !== undefined && typeof value.clientId !== "string") return "oauth.clientId must be a string";
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") {
		return "oauth.clientSecret must be a string";
	}
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
		return "oauth.callbackPort must be a port number";
	}
	if (value.callbackUrl !== undefined) {
		if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl)) {
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		}
		const urlPort = new URL(value.callbackUrl).port;
		if (urlPort && port !== undefined && Number(urlPort) !== port) {
			return "oauth.callbackUrl and oauth.callbackPort name different ports";
		}
	}
	if (value.scope !== undefined && typeof value.scope !== "string") return "oauth.scope must be a string";
	if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) {
		return "oauth.clientName must be a non-empty string";
	}
	if (value.clientRegistration !== undefined && value.clientRegistration !== "dcr") {
		return 'oauth.clientRegistration must be "dcr"; CIMD is not supported';
	}
	const metadataUrl = value.authServerMetadataUrl;
	if (metadataUrl !== undefined) {
		const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) {
			return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
		}
	}
	return undefined;
}

function isExposure(value: unknown): value is McpExposure {
	return typeof value === "string" && MCP_EXPOSURES.includes(value);
}

/** Exact override, then the first matching wildcard override, then the server/default exposure. */
export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
	const overrides = config.toolExposure ?? {};
	const exact = Object.hasOwn(overrides, toolName) ? overrides[toolName] : undefined;
	if (exact !== undefined) return exact;
	for (const [pattern, exposure] of Object.entries(overrides)) {
		if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
	}
	return config.exposure ?? DEFAULT_MCP_EXPOSURE;
}

/** Validate a server entry, returning a detached copy or an actionable error message. */
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(raw)) return `server "${name}" must be an object`;
	const { type, exposure, enabled, timeout, toolExposure, description } = raw;
	const exposures = MCP_EXPOSURES.map((value) => `"${value}"`).join(", ");
	if (raw.autoEnableCodemode !== undefined) return `server "${name}": autoEnableCodemode is not supported`;
	if (raw.auth !== undefined) return `server "${name}": auth.provider is not supported; use headers or OAuth`;
	if (exposure !== undefined && !isExposure(exposure)) {
		return `server "${name}": exposure must be one of ${exposures}`;
	}
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, value] of Object.entries(toolExposure)) {
			if (!isExposure(value)) return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`;
		}
	}
	if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (description !== undefined && typeof description !== "string")
		return `server "${name}": description must be a string`;
	if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || !(timeout > 0))) {
		return `server "${name}": timeout must be a positive number of seconds`;
	}
	if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
	if (raw.command !== undefined && raw.url !== undefined)
		return `server "${name}": specify either command or url, not both`;
	const oauthError = validateOAuth(raw.oauth);
	if (oauthError) return `server "${name}": ${oauthError}`;

	if (typeof raw.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(raw.url) || !/^https?:$/.test(new URL(raw.url).protocol)) {
			return `server "${name}": url must be an http or https URL`;
		}
		if (raw.headers !== undefined && !isStringRecord(raw.headers))
			return `server "${name}": headers must map names to strings`;
		return structuredClone(raw) as unknown as McpHttpServerConfig;
	}
	if (typeof raw.command === "string" && (type === undefined || type === "stdio")) {
		if (!raw.command.trim()) return `server "${name}": command must be a non-empty string`;
		if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string"))) {
			return `server "${name}": args must be an array of strings`;
		}
		if (raw.env !== undefined && !isStringRecord(raw.env)) return `server "${name}": env must map names to strings`;
		if (raw.cwd !== undefined && typeof raw.cwd !== "string") return `server "${name}": cwd must be a string`;
		return structuredClone(raw) as unknown as McpStdioServerConfig;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

export interface RegisteredMcpServer {
	name: string;
	config: McpServerConfig;
	extensionPath: string;
}

/** Servers owned by the extensions of one runtime. Callers receive detached snapshots. */
export class McpServerRegistry {
	private readonly servers = new Map<string, RegisteredMcpServer>();
	private changeListener: (() => void) | undefined;

	register(server: RegisteredMcpServer): void {
		const owner = this.servers.get(server.name)?.extensionPath;
		if (owner !== undefined && owner !== server.extensionPath) {
			throw new Error(`MCP server "${server.name}" is already registered by extension "${owner}"`);
		}
		for (const existing of this.servers.values()) {
			if (existing.name !== server.name && mcpNamespace(existing.name) === mcpNamespace(server.name)) {
				throw new Error(`MCP server "${server.name}" conflicts with registered server "${existing.name}"`);
			}
		}
		this.servers.set(server.name, structuredClone(server));
		this.changeListener?.();
	}

	/** Another extension cannot unregister the owner's server. Missing entries are a no-op. */
	unregister(name: string, extensionPath: string): void {
		if (this.servers.get(name)?.extensionPath !== extensionPath) return;
		this.servers.delete(name);
		this.changeListener?.();
	}

	get(name: string): RegisteredMcpServer | undefined {
		const server = this.servers.get(name);
		return server ? structuredClone(server) : undefined;
	}

	list(): RegisteredMcpServer[] {
		return [...this.servers.values()].map((server) => structuredClone(server));
	}

	/** Bound by the runner after loading; initial registrations are read at session_start. */
	setChangeListener(listener: (() => void) | undefined): void {
		this.changeListener = listener;
	}
}
