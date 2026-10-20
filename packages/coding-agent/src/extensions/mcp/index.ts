/** Built-in MCP support. Configured and registered servers connect in the background;
 * deferred tools are discovered with tool_search or authorized codemode scripts. Lifecycle and cancellation state machine
 * adapted from upstream e37cdc420669e48b4df4bbce0fb2617fc3c71328.
 */

import { join, resolve } from "node:path";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { getAgentDir } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "../../core/extensions/types.ts";
import { createToolNameMatcher, DEFAULT_MCP_EXPOSURE, mcpNamespace } from "../../core/mcp-servers.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { CODEMODE_TOOL_NAME, isCodemodeTool } from "../codemode/tool.ts";
import { isToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "../tool-search/tool.ts";
import { canReachMcpServer } from "./authority.ts";
import {
	getMcpToolExposure,
	type LoadedMcpConfig,
	loadMcpConfig,
	type McpExposure,
	type McpServerConfigPatch,
	type McpServerEntry,
	updateMcpServerConfig,
} from "./config.ts";
import type { McpOAuthCredentialStore, McpSignInPrompt } from "./oauth.ts";
import {
	createMcpResourceToolDefinitions,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	LIST_MCP_RESOURCES_TOOL,
	READ_MCP_RESOURCE_TOOL,
} from "./resources.ts";
import { loadMcpRuntime } from "./runtime.lazy.ts";
import type * as McpRuntime from "./runtime.ts";
import type { McpServerConnection, McpServerLog, McpTransportFactory } from "./runtime.ts";
import { createMcpToolDefinition, createMcpToolName, type McpToolDetails } from "./tools.ts";
import { type McpMenu, type McpUi, showMcpManager } from "./ui.ts";

export type { McpTransportFactory } from "./runtime.ts";

export interface McpExtensionOptions {
	/** Owns configuration, credentials, logs, and refresh locks of this instance. */
	agentDir: string;
	/** Host policy checked before creating transports, including registered servers. */
	canConnectServer?: (entry: McpServerEntry, ctx: ExtensionContext) => boolean;
	/** Resource reach. Restricted children must pass an explicit list (usually empty). */
	resourceServerScope?: readonly string[];
	/** Restricted child hosts do not expose generic resources without an explicit server scope. */
	restricted?: boolean;
	/** Defaults to reading `mcp.json` from the agent directory and the trusted project. */
	loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig;
	/** Defaults to stdio and streamable HTTP transports built from the server config. */
	createTransport?: McpTransportFactory;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	credentials?: McpOAuthCredentialStore;
	/** File server log messages are appended to. Defaults to `mcp.log` in the agent directory. */
	logPath?: string;
	/** Opens the OAuth authorization URL. Defaults to the platform browser. */
	openUrl?: (url: string) => void;
	/**
	 * Saves `/mcp` changes to the server's config file: its project `override` when set, else its
	 * `source`. Defaults to editing that `mcp.json`.
	 */
	updateConfig?: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;
	/**
	 * How long the first prompt waits for servers with `direct` tools that are still connecting at
	 * startup, in milliseconds. Their tools become available when they connect. Other servers are
	 * waited for when a script or search needs them. Default: 10000.
	 */
	startupWaitMs?: number;
}

const DEFAULT_STARTUP_WAIT_MS = 10_000;

/** Live, session-approved configuration, not a second read of mutable config files. */
const sessionConfigViews = new WeakMap<ReadonlySessionManager, () => LoadedMcpConfig>();
const sessionFactories = new WeakMap<ReadonlySessionManager, () => ExtensionFactory>();

/** New session-owned clients using only the source session's approved configuration and adapters. */
export function createInheritedMcpExtension(manager: ReadonlySessionManager): ExtensionFactory {
	const create = sessionFactories.get(manager);
	if (!create) throw new Error("Parent MCP session configuration is unavailable.");
	return create();
}

/** Detached approved configuration for child hosts; excludes connections and OAuth credential storage.
 * Raw headers, env, and clientSecret values remain authorized configuration and may contain secrets.
 */
export function getSessionMcpConfig(manager: ReadonlySessionManager): LoadedMcpConfig | undefined {
	const view = sessionConfigViews.get(manager);
	return view ? structuredClone(view()) : undefined;
}

const RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
	LIST_MCP_RESOURCES_TOOL,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	READ_MCP_RESOURCE_TOOL,
]);

/** A configured server. Disabled servers have no connection. */
interface McpServer {
	entry: McpServerEntry;
	connection?: McpServerConnection;
	/** For servers extensions registered: the config as registered, to detect re-registrations. */
	registeredConfig?: string;
	/** Result of the last `/mcp` action that failed, shown in the manager. */
	message?: string;
	/** Identifies the current connection attempt; disabling or replacing it invalidates earlier work. */
	attempt?: symbol;
	/** Settles when the connection started for the server connected or failed. */
	ready?: Promise<void>;
	/** Cleanup of a detached connection; a replacement waits for it before opening a transport. */
	closing?: Promise<void>;
}

const EXPOSURE_DESCRIPTIONS: Record<McpExposure, string> = {
	hidden: "registered but unreachable",
	deferred: "load with tool_search for direct calls, or use authorized codemode scripts",
	direct: "declared to the model like built-in tools",
	codemode: "called only from authorized codemode scripts",
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

function isEnabled(server: Pick<McpServer, "entry">): boolean {
	return server.entry.config.enabled !== false;
}

function exposureOf(entry: McpServerEntry): McpExposure {
	return entry.config.exposure ?? DEFAULT_MCP_EXPOSURE;
}

/** Exposures the server's tools can have, known from its config before it connects. */
function configuredExposures(entry: McpServerEntry): Set<McpExposure> {
	return new Set([exposureOf(entry), ...Object.values(entry.config.toolExposure ?? {})]);
}

/** Whether some of the server's tools are declared to the model, so the first prompt waits for them. */
function hasDirectTools(entry: McpServerEntry): boolean {
	return configuredExposures(entry).has("direct");
}

/** Whether some of the server's tools are reached through discovery or scripts. */
function hasIndirectTools(entry: McpServerEntry): boolean {
	const exposures = configuredExposures(entry);
	return exposures.has("deferred") || exposures.has("codemode");
}

/** Name of the system prompt section that lists the servers whose tools are not declared. */
export const MCP_SERVERS_SECTION = "mcp_servers";
/** Characters of a server description in the section, as Codex allows for deferred namespaces. */
const MAX_SERVER_DESCRIPTION_CHARS = 250;
/**
 * Characters of the whole section. Descriptions shrink to fit; when the server lines alone do not
 * fit, the last servers are left out and counted in a closing line.
 */
export const MAX_SERVERS_SECTION_CHARS = 4096;

/** The section's first line. It explains only the ways of reaching tools that the listed servers use. */
function serversSectionIntro(reaches: ReadonlySet<string>): string {
	let intro = "MCP servers whose tools are not declared to you.";
	if (reaches.has("deferred"))
		intro +=
			" For `deferred` tools, use `tool_search` when available to load declarations for direct calls, or discover and call them inside authorized codemode scripts with `searchTools` and `describeTool`, without prior `tool_search`.";
	if (reaches.has("codemode")) intro += " Tools marked `codemode` are called only from authorized codemode scripts.";
	return `${intro} Use only routes and tools authorized in this session.`;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** What the `mcp_servers` section needs of a server. */
export interface McpServerListing {
	entry: McpServerEntry;
	connection?: { instructions?: string };
}

/** First line of the configured description, or of the server instructions once connected. */
function serverSummary(server: McpServerListing): string {
	const text = server.entry.config.description?.trim() || server.connection?.instructions || "";
	return (text.split("\n", 1)[0] ?? "").trim();
}

/**
 * The `mcp_servers` section: every enabled server with deferred tools, with how its
 * tools are reached and a one-line summary. The model learns of the servers from it, since neither
 * tool_search lists them. Undefined when there are no such servers.
 */
export function renderServersSection(servers: readonly McpServerListing[]): string | undefined {
	const listed = servers
		.filter((server) => isEnabled(server) && hasIndirectTools(server.entry))
		.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
	if (listed.length === 0) return undefined;
	const routes = listed.map((server) => {
		const exposures = configuredExposures(server.entry);
		return [
			exposures.has("deferred") ? "deferred" : undefined,
			exposures.has("codemode") ? "codemode" : undefined,
		].filter((value): value is string => value !== undefined);
	});
	const reaches = routes.map((route) => route.join(", "));
	const intro = serversSectionIntro(new Set(routes.flat()));
	const heads = listed.map((server, index) => `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`);
	const omitted = (count: number) =>
		count > 0
			? [`- … ${count} more server${count === 1 ? "" : "s"}; find their authorized tools through the routes above`]
			: [];
	// Characters of the intro, the first `kept` server lines without descriptions, and the omission line.
	const size = (kept: number) => [intro, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
	let kept = listed.length;
	while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
	// Each description also takes a ": " separator.
	const perServer =
		kept === 0
			? 0
			: Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
	const lines = listed.slice(0, kept).map((server, index) => {
		const summary = perServer > 0 ? truncate(serverSummary(server), perServer) : "";
		return summary ? `${heads[index]}: ${summary}` : heads[index];
	});
	return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
}

/** Short state for lists and the startup report. `withError` appends the first line of a failure. */
function describeState(server: McpServer, withError = true): string {
	if (!isEnabled(server)) return "disabled";
	const connection = server.connection;
	if (!connection) return "starting";
	switch (connection.state) {
		case "needs-auth":
			return "needs sign-in";
		case "failed":
			return withError ? `failed: ${firstLine(connection.error ?? "unknown error")}` : "failed";
		case "connected": {
			const { tools, resources } = connection;
			const count = resources.length;
			const resourceCount = count > 0 ? ` · ${count} resource${count === 1 ? "" : "s"}` : "";
			return `connected · ${tools.length} tool${tools.length === 1 ? "" : "s"}${resourceCount}`;
		}
		case "connecting":
			return "connecting…";
		default:
			return connection.state;
	}
}

/** Servers that need the user first. */
function attentionRank(server: McpServer): number {
	if (!isEnabled(server)) return 5;
	switch (server.connection?.state) {
		case "needs-auth":
			return 0;
		case "failed":
			return 1;
		case "disconnected":
			return 2;
		case "connected":
			return 4;
		default:
			return 3;
	}
}

function describeTransport(entry: McpServerEntry): string {
	const { config } = entry;
	if ("url" in config) return config.url;
	return [config.command, ...(config.args ?? [])].join(" ");
}

const MCP_USAGE = "Usage: /mcp, /mcp login [server], /mcp logout [server], /mcp reconnect [server]";

export function createMcpExtension(options: McpExtensionOptions): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let servers: McpServer[] = [];
		/** Servers from `mcp.json`, which take precedence over registered servers of the same name. */
		let configuredEntries: McpServerEntry[] = [];
		let configErrors: string[] = [];
		/** The trusted project's `mcp.json`, where `/mcp` saves project overrides of global servers. */
		let projectConfig: string | undefined;
		let autoEnableCodemode = true;
		/** Registered servers that `mcp.json` overrides, shown in `/mcp`. */
		let overridden: string[] = [];
		/** Whether the "deferred tools unreachable" warning was shown since the session started. */
		let warnedUnreachable = false;
		let pending: Promise<unknown> | undefined;
		/** Whether a prompt already waited for the startup connections since the session started. */
		let waitedForStartup = false;
		const startupWaitMs = options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
		/** Working directory of the session, for stdio servers. */
		let sessionCwd = process.cwd();
		let credentials = options.credentials;
		let lastServersSection: string | undefined;
		let sessionContext: ExtensionContext | undefined;
		let configView: (() => LoadedMcpConfig) | undefined;
		let serverLog: McpServerLog | undefined;
		const openUrl = options.openUrl ?? openBrowser;
		const updateConfig =
			options.updateConfig ??
			((entry, patch) =>
				updateMcpServerConfig(entry.override ?? entry.source, entry.name, patch, {
					override: entry.override !== undefined,
				}));

		/**
		 * Lifetime of the current session: aborted on session_shutdown, and before the first session_start
		 * (registrations before that are read on session_start). Work captures `session.signal` when it
		 * starts and drops late results once it aborted, for example a runtime load that resolves after
		 * shutdown. Work that outlives the command that started it also stops on the signal and is
		 * registered with `track`, so shutdown can wait for its cleanup.
		 */
		let session = new AbortController();
		session.abort();
		/** Work registered with `track`: manager actions opening or closing connections, and sign-ins. */
		const backgroundActions = new Set<Promise<void>>();
		const track = <T>(work: Promise<T>): Promise<T> => {
			const task = work.then(
				() => undefined,
				() => undefined,
			);
			backgroundActions.add(task);
			void task.finally(() => backgroundActions.delete(task));
			return work;
		};
		const listeners = new Set<() => void>();
		const emitChange = () => {
			for (const listener of listeners) listener();
		};
		const subscribe = (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		};

		const connections = () => servers.flatMap((server) => (server.connection ? [server.connection] : []));
		const findServer = (name: string) => servers.find((server) => server.entry.name === name);
		const resourcesAllowed = (name: string) => {
			if (options.resourceServerScope) return options.resourceServerScope.includes(name);
			if (options.restricted) return false;
			const access = sessionContext?.getToolAccess?.();
			const allowed = access?.allowlist === undefined ? () => true : createToolNameMatcher(access.allowlist);
			const excluded = createToolNameMatcher(access?.excluded ?? []);
			return [...RESOURCE_TOOL_NAMES].some((tool) => allowed(tool) && !excluded(tool));
		};
		const canConnect = (entry: McpServerEntry, ctx: ExtensionContext) =>
			canReachMcpServer(entry.name, ctx.getToolAccess?.(), resourcesAllowed(entry.name)) &&
			options.canConnectServer?.(entry, ctx) !== false;

		/** Servers extensions registered, except names `mcp.json` defines, which take precedence. */
		const registeredServers = (): { servers: McpServer[]; overridden: string[] } => {
			const registered: McpServer[] = [];
			const overriddenNames: string[] = [];
			for (const { name, config, extensionPath } of pi.getMcpServers()) {
				if (
					sessionContext &&
					!canConnect({ name, config, source: extensionPath, scope: "extension" }, sessionContext)
				)
					continue;
				const configured = configuredEntries.find((entry) => mcpNamespace(entry.name) === mcpNamespace(name));
				if (configured) {
					overriddenNames.push(
						`"${name}" registered by ${extensionPath} is overridden by "${configured.name}" in ${configured.source}`,
					);
					continue;
				}
				registered.push({
					entry: { name, config, source: extensionPath, scope: "extension" },
					registeredConfig: JSON.stringify(config),
				});
			}
			return { servers: registered, overridden: overriddenNames };
		};

		const getCredentials = (runtime: typeof McpRuntime): McpOAuthCredentialStore => {
			credentials ??= new runtime.McpOAuthCredentialStore(options.agentDir);
			return credentials;
		};

		const getServerLog = (runtime: typeof McpRuntime): McpServerLog => {
			serverLog ??= new runtime.McpServerLog(options.logPath ?? join(options.agentDir, "mcp.log"));
			return serverLog;
		};

		/** pi tool name to the `<server>\0<tool>` it was assigned to, so names stay unique and stable. */
		const toolOwners = new Map<string, string>();
		/** Tool names currently offered by each server. */
		const serverTools = new Map<string, Set<string>>();
		/** Last definition registered under each tool name, to re-register withdrawn tools as hidden. */
		const definitions = new Map<string, ToolDefinition<TSchema, McpToolDetails>>();

		const registerTools = (connection: McpServerConnection) => {
			const server = connection.entry.name;
			const entry = findServer(server)?.entry ?? connection.entry;
			const description = entry.config.description?.trim();
			const namespace = {
				name: mcpNamespace(server),
				...(description ? { description } : {}),
				...(connection.instructions ? { instructions: connection.instructions } : {}),
			};
			const previous = serverTools.get(server) ?? new Set<string>();
			const current = new Set<string>();
			// Like Codex, all tools whose names sanitize to the same name get the hash suffix, so which
			// one would keep the plain name does not depend on the order of the list.
			const plain = [...new Set(connection.tools.map((tool) => tool.name))].map((tool) =>
				createMcpToolName(server, tool),
			);
			const assignName = (tool: string, owner: string) => {
				const name = createMcpToolName(server, tool, (candidate) => {
					const existing = toolOwners.get(candidate);
					return (
						(existing !== undefined && existing !== owner) ||
						current.has(candidate) ||
						plain.indexOf(candidate) !== plain.lastIndexOf(candidate)
					);
				});
				toolOwners.set(name, owner);
				current.add(name);
				return name;
			};
			for (const tool of connection.tools) {
				const definition = createMcpToolDefinition({
					server,
					tool,
					name: assignName(tool.name, `${server}\0${tool.name}`),
					exposure: getMcpToolExposure(entry.config, tool.name),
					namespace,
					timeoutMs: connection.timeoutMs,
					getClient: async () => {
						// A prepared call can outlive this definition's connection while the readiness
						// hook waits for a disable/re-enable. Resolve the replacement at execution time.
						const current = findServer(server);
						if (!current || !isEnabled(current)) throw new Error(`MCP server "${server}" is disabled.`);
						if (sessionContext && !canConnect(current.entry, sessionContext))
							throw new Error(`MCP server "${server}" is no longer authorized.`);
						const client = current.connection;
						if (!client) throw new Error(`MCP server "${server}" is still starting.`);
						if (
							getMcpToolExposure(current.entry.config, tool.name) === "hidden" ||
							(client.state === "connected" && !client.tools.some((offered) => offered.name === tool.name))
						) {
							throw new Error(`MCP tool "${server}/${tool.name}" is no longer available.`);
						}
						return client;
					},
					readableResources: () => resourceServers().some((current) => current.name === server),
				});
				definitions.set(definition.name, definition);
				pi.registerTool(definition);
			}
			serverTools.set(server, current);
			// Tools cannot be unregistered, so tools the server dropped are re-registered as hidden. When
			// the server offers them again they are registered with their configured exposure above.
			for (const name of previous) {
				const definition = definitions.get(name);
				if (!current.has(name) && definition) pi.registerTool({ ...definition, exposure: "hidden" });
			}
			syncResourceTools();
		};

		/** Make a disabled server's tools unreachable. */
		const hideTools = (server: string) => {
			for (const name of serverTools.get(server) ?? []) {
				const definition = definitions.get(name);
				if (definition) pi.registerTool({ ...definition, exposure: "hidden" });
			}
			serverTools.set(server, new Set());
			syncResourceTools();
		};

		/** Enabled servers with resources whose exposure is not `hidden`, which the resource tools reach. */
		const serversWithResources = (): McpServer[] =>
			servers.filter(
				(server) =>
					server.connection?.hasResources &&
					isEnabled(server) &&
					exposureOf(server.entry) !== "hidden" &&
					resourcesAllowed(server.entry.name) &&
					(!sessionContext || canConnect(server.entry, sessionContext)),
			);
		const resourceServers = (): McpServerConnection[] =>
			serversWithResources().flatMap((server) => (server.connection ? [server.connection] : []));

		/** Exposure the resource tools were last registered with; undefined until a server has resources. */
		let resourceToolsExposure: McpExposure | undefined;
		/**
		 * Register the resource tools with the widest exposure of the servers they reach: `direct` when
		 * one of them is direct, and so on. They are hidden when no server has resources.
		 */
		const syncResourceTools = () => {
			const exposures = new Set(serversWithResources().map((server) => exposureOf(server.entry)));
			const exposure = (["direct", "deferred", "codemode"] as const).find((candidate) => exposures.has(candidate));
			const next = exposure ?? "hidden";
			if (next === resourceToolsExposure || (resourceToolsExposure === undefined && next === "hidden")) return;
			const wasDirect = resourceToolsExposure === "direct";
			resourceToolsExposure = next;
			const resourceDefinitions = createMcpResourceToolDefinitions({ exposure: next, servers: resourceServers });
			for (const definition of resourceDefinitions) pi.registerTool(definition);
			if (wasDirect) {
				const names = new Set(resourceDefinitions.map((definition) => definition.name));
				pi.setActiveTools(pi.getActiveTools().filter((name) => !names.has(name)));
			}
		};

		const ensureDiscoveryActive = (ctx: ExtensionContext) => {
			const reachable = servers.filter((server) => isEnabled(server) && canConnect(server.entry, ctx));
			if (!reachable.some((server) => hasIndirectTools(server.entry))) return;
			const exposures = new Set(reachable.flatMap((server) => [...configuredExposures(server.entry)]));
			let active = pi.getActiveTools();
			if (
				exposures.has("codemode") &&
				autoEnableCodemode &&
				!active.includes(CODEMODE_TOOL_NAME) &&
				pi.getAllTools().some(isCodemodeTool)
			) {
				// setActiveTools still applies exact/wildcard grants and exclusions; this never grants a target tool.
				pi.setActiveTools([...active, CODEMODE_TOOL_NAME]);
				active = pi.getActiveTools();
			}
			if (
				exposures.has("deferred") &&
				!active.includes(TOOL_SEARCH_TOOL_NAME) &&
				pi.getAllTools().some(isToolSearchTool)
			) {
				pi.setActiveTools([...active, TOOL_SEARCH_TOOL_NAME]);
				active = pi.getActiveTools();
			}
			const missingSearch =
				exposures.has("deferred") &&
				!active.includes(TOOL_SEARCH_TOOL_NAME) &&
				!active.includes(CODEMODE_TOOL_NAME);
			const missingCodemode = exposures.has("codemode") && !active.includes(CODEMODE_TOOL_NAME);
			if ((!missingSearch && !missingCodemode) || warnedUnreachable) return;
			warnedUnreachable = true;
			ctx.ui.notify(
				missingCodemode
					? "Script-only MCP tools require an authorized codemode tool, but it is not active."
					: "Deferred MCP tools require an authorized tool_search or codemode tool, but neither is active.",
				"warning",
			);
		};

		/**
		 * Stored tokens of servers waiting for a sign-in, as they were when the sign-in was needed.
		 * `pi mcp login` in another process (for example run by the agent) changes them.
		 */
		const tokensAtSignIn = new Map<McpServerConnection, string>();
		const storedTokens = (connection: McpServerConnection): string => {
			const url = connection.oauthUrl;
			return url && credentials ? JSON.stringify(credentials.tokens(connection.name, url) ?? null) : "null";
		};
		const onConnectionChange = (connection: McpServerConnection) => {
			if (connection.state !== "needs-auth") tokensAtSignIn.delete(connection);
			else if (!tokensAtSignIn.has(connection)) tokensAtSignIn.set(connection, storedTokens(connection));
			emitChange();
		};
		/** Reconnect servers that need a sign-in when their credentials were stored since. */
		const reconnectSignedIn = async (ctx: ExtensionContext) => {
			const signedIn = [...tokensAtSignIn].filter(([connection, tokens]) => storedTokens(connection) !== tokens);
			if (signedIn.length === 0) return;
			for (const [connection] of signedIn) tokensAtSignIn.delete(connection);
			await Promise.allSettled(signedIn.map(([connection]) => connection.reconnect()));
			ensureDiscoveryActive(ctx);
		};

		/** Create the server's connection, loading the MCP runtime on first use. */
		const createConnection = async (
			server: McpServer,
			isCurrent: () => boolean,
		): Promise<McpServerConnection | undefined> => {
			const runtime = await loadMcpRuntime();
			if (!isCurrent()) return undefined;
			const connection = new runtime.McpServerConnection({
				entry: server.entry,
				cwd: sessionCwd,
				createTransport: options.createTransport ?? runtime.createDefaultTransport,
				credentials: getCredentials(runtime),
				enableResources: resourcesAllowed(server.entry.name),
				log: getServerLog(runtime),
				onTools: (connection) => {
					if (isCurrent()) registerTools(connection);
				},
				onChange: (connection) => {
					if (isCurrent()) onConnectionChange(connection);
					else tokensAtSignIn.delete(connection);
				},
			});
			server.connection = connection;
			emitChange();
			return connection;
		};

		/**
		 * Connect the server in the background. `server.ready` settles when it connected or failed;
		 * failures show in its state. It starts after `after`, unless disabled, replaced, or shut down
		 * meanwhile. The returned promise rejects when the MCP runtime cannot be loaded.
		 */
		const startConnection = (server: McpServer, after?: Promise<unknown>): Promise<void> => {
			const { signal } = session;
			const attempt = Symbol();
			server.attempt = attempt;
			const isCurrent = () =>
				!signal.aborted &&
				server.attempt === attempt &&
				isEnabled(server) &&
				servers.includes(server) &&
				(!sessionContext || canConnect(server.entry, sessionContext));
			const ready = (async () => {
				await after;
				if (!isCurrent()) return;
				const connection = await createConnection(server, isCurrent);
				if (!connection || !isCurrent()) return;
				await connection.getClient().catch(() => undefined);
			})();
			server.ready = ready.catch(() => undefined);
			return ready;
		};

		/** Wait for the latest connection attempts, including ones queued while waiting, or an abort. */
		const waitForServers = async (waiting: readonly McpServer[], signal: AbortSignal | undefined) => {
			for (;;) {
				const ready = waiting.flatMap((server) =>
					isEnabled(server) && servers.includes(server) && server.ready ? [{ server, ready: server.ready }] : [],
				);
				if (ready.length === 0 || signal?.aborted) return;
				let onAbort: (() => void) | undefined;
				await Promise.race([
					Promise.all(ready.map((attempt) => attempt.ready)),
					new Promise<void>((resolve) => {
						onAbort = () => resolve();
						signal?.addEventListener("abort", onAbort, { once: true });
					}),
				]);
				if (onAbort) signal?.removeEventListener("abort", onAbort);
				if (
					signal?.aborted ||
					ready.every(
						(attempt) =>
							!isEnabled(attempt.server) ||
							!servers.includes(attempt.server) ||
							attempt.ready === attempt.server.ready,
					)
				)
					return;
			}
		};

		/**
		 * One message for everything that needs the user after startup, or only for `only`, servers
		 * that connected later.
		 */
		const reportProblems = (ctx: ExtensionContext, only?: readonly McpServer[]) => {
			const lines = only ? [] : configErrors.map((error) => `config: ${error}`);
			for (const server of only ?? servers) {
				const state = server.connection?.state;
				if (state === "needs-auth" || state === "failed")
					lines.push(`${server.entry.name}: ${describeState(server)}`);
			}
			if (lines.length === 0) return;
			ctx.ui.notify(
				`MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp to fix.`,
				"warning",
			);
		};

		/**
		 * Save a config change; returns an error message when the file could not be updated. Changes to
		 * registered servers only apply to the current session. `inProject` adds a project override.
		 */
		const saveConfig = (server: McpServer, patch: McpServerConfigPatch, inProject = false): string | undefined => {
			const override = inProject ? projectConfig : server.entry.override;
			const entry = override ? { ...server.entry, override } : server.entry;
			if (entry.scope !== "extension") {
				try {
					updateConfig(entry, patch);
				} catch (error) {
					return `Could not update ${entry.override ?? entry.source}: ${errorMessage(error)}`;
				}
			}
			server.entry = { ...entry, config: { ...entry.config, ...patch } };
			return undefined;
		};

		/** Sign in, then reconnect. Returns an error message on failure. `cancel` or the session's end stops the sign-in. */
		const signIn = async (
			server: McpServer,
			prompt: McpSignInPrompt,
			cancel?: AbortSignal,
		): Promise<string | undefined> => {
			const connection = server.connection;
			const url = connection?.oauthUrl;
			if (!connection || !url) return `MCP server "${server.entry.name}" does not use OAuth.`;
			const runtime = await loadMcpRuntime();
			const signal = cancel ? AbortSignal.any([session.signal, cancel]) : session.signal;
			try {
				await track(
					runtime.signInMcpServer({
						serverUrl: url,
						store: getCredentials(runtime).forServer(server.entry.name, url),
						settings: connection.oauthSettings(),
						challenge: connection.challenge,
						prompt,
						signal,
					}),
				);
			} catch (error) {
				if (error instanceof runtime.McpSignInCancelledError) return "Sign-in cancelled.";
				return `Sign-in failed: ${errorMessage(error)}`;
			}
			// The challenge that asked for this sign-in (for example for more scope) is answered.
			connection.challenge = undefined;
			try {
				await connection.reconnect();
			} catch (error) {
				return `Signed in, but ${errorMessage(error)}`;
			}
			return undefined;
		};

		const signOut = async (server: McpServer): Promise<boolean> => {
			const connection = server.connection;
			const url = connection?.oauthUrl;
			if (!connection || !url) return false;
			const removed = getCredentials(await loadMcpRuntime()).remove(server.entry.name, url);
			await connection.signOut();
			return removed;
		};

		const reconnect = async (server: McpServer): Promise<string | undefined> => {
			const connection = server.connection;
			if (!connection) return `MCP server "${server.entry.name}" is disabled.`;
			const previous = server.ready;
			const ready = (async () => {
				await previous;
				await connection.reconnect();
			})();
			server.ready = ready.catch(() => undefined);
			try {
				await ready;
				return undefined;
			} catch (error) {
				return errorMessage(error);
			}
		};

		/** Returns an error message when the config could not be saved; connection errors show in the state. */
		const setEnabled = async (
			server: McpServer,
			enabled: boolean,
			inProject = false,
		): Promise<string | undefined> => {
			const failed = saveConfig(server, { enabled }, inProject);
			if (failed) return failed;
			if (!enabled) {
				const connection = server.connection;
				server.attempt = undefined;
				server.connection = undefined;
				if (connection) {
					// A reconnect may already have detached its old client while awaiting transport
					// shutdown. Closing the connection alone does not wait for that reconnect.
					server.closing = Promise.all([connection.close(), server.ready]).then(() => undefined);
				}
				const closing = server.closing;
				hideTools(server.entry.name);
				emitChange();
				try {
					await closing;
				} finally {
					if (server.closing === closing) server.closing = undefined;
				}
				return undefined;
			}
			await startConnection(server, server.closing);
			return undefined;
		};

		const setExposure = (server: McpServer, exposure: McpExposure): string | undefined => {
			const failed = saveConfig(server, { exposure });
			if (failed) return failed;
			if (server.connection?.state === "connected") registerTools(server.connection);
			syncResourceTools();
			// Tools no longer exposed directly leave the declared set; direct tools are activated on registration.
			const indirect = new Set(
				pi
					.getAllTools()
					.filter((tool) => tool.exposure !== "direct")
					.map((tool) => tool.name),
			);
			const tools = serverTools.get(server.entry.name) ?? new Set<string>();
			pi.setActiveTools(pi.getActiveTools().filter((name) => !tools.has(name) || !indirect.has(name)));
			emitChange();
			return undefined;
		};

		// ---------------------------------------------------------------------------------------
		// Manager (`/mcp` in the TUI)
		// ---------------------------------------------------------------------------------------

		const notices = () => [
			...configErrors.map((error) => `config: ${error}`),
			...overridden.map((line) => `overridden: ${line}`),
		];

		const serversMenu = (): McpMenu => ({
			title: "MCP servers",
			error: notices().join("\n") || undefined,
			items: [...servers]
				.sort((a, b) => attentionRank(a) - attentionRank(b) || a.entry.name.localeCompare(b.entry.name))
				.map((server) => ({
					value: server.entry.name,
					label: server.entry.name,
					description: `${describeState(server)} · ${exposureOf(server.entry)} · ${server.entry.override ? "global, project override" : (server.entry.scope ?? server.entry.source)}`,
				})),
			empty: `No MCP servers configured. Add them to ${resolve(options.agentDir, "mcp.json")} or .pi/mcp.json.`,
			confirmLabel: "manage",
			cancelLabel: "close",
		});

		const serverMenu = (name: string): McpMenu => {
			const server = findServer(name);
			if (!server) {
				return {
					title: name,
					items: [],
					empty: "This server is no longer configured.",
					confirmLabel: "",
					cancelLabel: "back",
				};
			}
			const { entry, connection } = server;
			const saved =
				entry.scope === "extension"
					? "for this session"
					: entry.override
						? "saved to the project mcp.json"
						: entry.scope
							? `saved to the ${entry.scope} mcp.json`
							: "saved to mcp.json";
			// Global servers without an override can be turned on or off for the trusted project alone.
			const inProject = entry.scope === "global" && !entry.override && projectConfig !== undefined;
			const inProjectSaved = "saved to the project mcp.json";
			const items: SelectItem[] = [];
			if (!isEnabled(server)) {
				items.push({ value: "enable", label: "Enable", description: saved });
				if (inProject) {
					items.push({ value: "enable-project", label: "Enable in this project", description: inProjectSaved });
				}
			} else {
				const state = connection?.state;
				if (state === "needs-auth")
					items.push({ value: "signin", label: "Sign in", description: "opens the browser" });
				if (state === "connected" && connection) {
					items.push({ value: "tools", label: "Tools", description: `${connection.tools.length} offered` });
				}
				if (state === "failed" || state === "disconnected" || state === "connected" || state === "needs-auth") {
					items.push({ value: "reconnect", label: "Reconnect" });
				}
				if (state === "connected" && connection?.oauthUrl) {
					items.push({ value: "signout", label: "Sign out", description: "deletes the stored credentials" });
				}
				items.push({ value: "exposure", label: "Exposure", description: exposureOf(entry) });
				items.push({ value: "disable", label: "Disable", description: saved });
				if (inProject) {
					items.push({ value: "disable-project", label: "Disable in this project", description: inProjectSaved });
				}
			}
			const details = [
				describeTransport(entry),
				`${entry.scope ?? "config"}: ${entry.source}`,
				...(entry.override ? [`project override: ${entry.override}`] : []),
				`State: ${describeState(server, false)}`,
			];
			const error = [server.message, connection?.state === "connected" ? undefined : connection?.error]
				.filter((line): line is string => line !== undefined)
				.join("\n");
			return {
				title: `MCP server ${name}`,
				details: details.join("\n"),
				error: error || undefined,
				items,
				selected: items[0]?.value,
				confirmLabel: "select",
				cancelLabel: "back",
			};
		};

		const showTools = async (ui: McpUi, server: McpServer) => {
			const exposure = exposureOf(server.entry);
			const overridden = Object.keys(server.entry.config.toolExposure ?? {}).length > 0;
			await ui.menu(() => ({
				title: `Tools of ${server.entry.name}`,
				details: `Exposure ${exposure}: ${exposure === "hidden" ? "unreachable" : EXPOSURE_DESCRIPTIONS[exposure]}${overridden ? "\nSome tools override it with toolExposure." : ""}`,
				items: (server.connection?.tools ?? []).map((tool) => {
					const toolExposure = getMcpToolExposure(server.entry.config, tool.name);
					const description = firstLine(tool.description ?? "");
					return {
						value: tool.name,
						label: tool.name,
						description: toolExposure === exposure ? description : `[${toolExposure}] ${description}`,
					};
				}),
				empty: "The server offers no tools.",
				confirmLabel: "back",
				cancelLabel: "back",
			}));
		};

		const chooseExposure = async (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			const current = exposureOf(server.entry);
			const choice = await ui.menu(() => ({
				title: `Exposure of ${server.entry.name}`,
				details:
					server.entry.scope === "extension"
						? `Applies to this session; the server is registered by ${server.entry.source}.`
						: `Saved to ${server.entry.override ?? server.entry.source}.`,
				items: (Object.keys(EXPOSURE_DESCRIPTIONS) as (keyof typeof EXPOSURE_DESCRIPTIONS)[]).map((exposure) => ({
					value: exposure,
					label: `${exposure === current ? "✓ " : "  "}${exposure}`,
					description: EXPOSURE_DESCRIPTIONS[exposure],
				})),
				selected: current,
				confirmLabel: "save",
				cancelLabel: "back",
			}));
			if (!choice || choice === current) return undefined;
			return setExposure(server, choice as McpExposure);
		};

		/** Sign in with the manager view's sign-in screen, which shows the URL with a copy key and cancels with Esc. */
		const signInWithUi = (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			const title = `Sign in to ${server.entry.name}`;
			const cancel = new AbortController();
			const status = (message: string) => ui.status(title, message, () => cancel.abort());
			let authorizationUrl = "";
			status("Contacting the authorization server…");
			return signIn(
				server,
				{
					showAuthorizationUrl: (url) => {
						authorizationUrl = url.href;
						openUrl(url.href);
					},
					promptForRedirectUrl: async (signal) => {
						const value = await ui.redirectUrl(title, authorizationUrl, signal);
						status("Connecting…");
						return value;
					},
				},
				cancel.signal,
			);
		};

		/** Keep the subscribed menu usable while a connection opens or closes. */
		const runInBackground = (
			ctx: ExtensionContext,
			server: McpServer,
			operation: () => Promise<string | undefined>,
		) => {
			const ready = operation();
			const attempt = server.attempt;
			const { signal } = session;
			const finish = (message: string | undefined) => {
				if (signal.aborted || server.attempt !== attempt || !servers.includes(server)) return;
				server.message = message;
				ensureDiscoveryActive(ctx);
				emitChange();
			};
			void track(ready.then(finish, (error: unknown) => finish(errorMessage(error))));
		};

		const runAction = async (ui: McpUi, ctx: ExtensionContext, server: McpServer, action: string) => {
			const { signal } = session;
			let message: string | undefined;
			switch (action) {
				case "signin":
					message = await signInWithUi(ui, server);
					break;
				case "reconnect":
					// Connection state and error already report failures, including required sign-ins.
					runInBackground(ctx, server, async () => {
						await reconnect(server);
						return undefined;
					});
					break;
				case "signout":
					await signOut(server);
					break;
				case "tools":
					await showTools(ui, server);
					break;
				case "exposure":
					message = await chooseExposure(ui, server);
					break;
				case "enable":
				case "disable":
				case "enable-project":
				case "disable-project": {
					const enable = action.startsWith("enable");
					runInBackground(ctx, server, () => setEnabled(server, enable, action.endsWith("-project")));
					break;
				}
			}
			// The session ended meanwhile (for example during a sign-in), which made ctx stale.
			if (signal.aborted) return;
			server.message = message;
			ensureDiscoveryActive(ctx);
			emitChange();
		};
		const manage = async (ui: McpUi, ctx: ExtensionContext) => {
			for (;;) {
				const name = await ui.menu(serversMenu, subscribe);
				if (!name) return;
				for (;;) {
					const action = await ui.menu(() => serverMenu(name), subscribe);
					const server = findServer(name);
					if (!action || !server) break;
					await runAction(ui, ctx, server, action);
				}
			}
		};

		// ---------------------------------------------------------------------------------------
		// Subcommands and plain status (no TUI)
		// ---------------------------------------------------------------------------------------

		const formatStatus = (): string => {
			if (servers.length === 0 && configErrors.length === 0 && overridden.length === 0) {
				return `No MCP servers configured. Add them to ${resolve(options.agentDir, "mcp.json")} or .pi/mcp.json.`;
			}
			const lines = servers.map((server) => {
				const { name } = server.entry;
				const exposure = exposureOf(server.entry);
				const connection = server.connection;
				if (connection?.state === "needs-auth")
					return `${name}: needs sign-in, run /mcp login ${name} (${exposure})`;
				const tools = connection?.state === "connected" ? `, ${connection.tools.length} tools` : "";
				const state = !isEnabled(server)
					? "disabled"
					: connection?.state === "disconnected"
						? "disconnected, reconnects on next call"
						: (connection?.state ?? "starting");
				const error =
					connection?.error && connection.state !== "connected"
						? `\n    ${connection.error.split("\n").join("\n    ")}`
						: "";
				return `${name}: ${state}${tools} (${exposure})${error}`;
			});
			for (const error of configErrors) lines.push(`config error: ${error}`);
			for (const line of overridden) lines.push(`overridden: ${line}`);
			return lines.join("\n");
		};

		/** Resolve the server for a subcommand, asking when the name is omitted and ambiguous. */
		const pickServer = async (
			name: string | undefined,
			ctx: ExtensionCommandContext,
			options: { eligible: (server: McpServer) => boolean; preferred: (server: McpServer) => boolean; none: string },
		): Promise<McpServer | undefined> => {
			if (name) {
				const server = findServer(name);
				if (!server) ctx.ui.notify(`No MCP server named "${name}".`, "error");
				else if (!options.eligible(server)) ctx.ui.notify(options.none, "error");
				return server && options.eligible(server) ? server : undefined;
			}
			const candidates = servers.filter(options.eligible);
			if (candidates.length === 0) {
				ctx.ui.notify(options.none, "info");
				return undefined;
			}
			const preferred = candidates.filter(options.preferred);
			if (candidates.length === 1) return candidates[0];
			if (preferred.length === 1) return preferred[0];
			const choice = await ctx.ui.select(
				"MCP server",
				candidates.map((server) => server.entry.name),
			);
			return candidates.find((server) => server.entry.name === choice);
		};

		const usesOAuth = (server: McpServer) => server.connection?.oauthUrl !== undefined;
		const oauthPick = {
			eligible: usesOAuth,
			preferred: (server: McpServer) => server.connection?.state === "needs-auth",
			none: "No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.",
		};

		const loginCommand = async (server: McpServer, ctx: ExtensionCommandContext) => {
			const { name } = server.entry;
			if (!ctx.hasUI) {
				ctx.ui.notify(`Signing in to MCP server "${name}" requires interactive mode.`, "error");
				return;
			}
			const { signal } = session;
			let failure: string | undefined;
			if (ctx.mode === "tui") {
				await showMcpManager(
					ctx,
					async (ui) => {
						failure = await signInWithUi(ui, server);
					},
					session.signal,
				);
			} else {
				failure = await signIn(server, {
					showAuthorizationUrl: (url) => {
						ctx.ui.notify(`Sign in to MCP server "${name}" in your browser:\n${url.href}`, "info");
						openUrl(url.href);
					},
					promptForRedirectUrl: (signal) =>
						ctx.ui.input(
							`Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`,
							"http://127.0.0.1:.../callback?code=...",
							{ signal },
						),
				});
			}
			// The session ended meanwhile, which cancelled the sign-in and made ctx stale.
			if (signal.aborted) return;
			if (failure) {
				ctx.ui.notify(failure, failure === "Sign-in cancelled." ? "info" : "error");
				return;
			}
			ensureDiscoveryActive(ctx);
			ctx.ui.notify(`Signed in to MCP server "${name}" (${server.connection?.tools.length ?? 0} tools).`, "info");
		};

		pi.on("session_start", (_event, ctx) => {
			const loaded = options.loadConfig
				? options.loadConfig(ctx)
				: loadMcpConfig({
						agentDir: options.agentDir,
						cwd: ctx.cwd,
						projectTrusted: ctx.isProjectTrusted(),
					});
			configErrors = loaded.errors;
			projectConfig = loaded.projectConfig;
			autoEnableCodemode = loaded.autoEnableCodemode !== false;
			warnedUnreachable = false;
			waitedForStartup = false;
			sessionCwd = ctx.cwd;
			sessionContext = ctx;
			lastServersSection = undefined;
			session = new AbortController();
			const { signal } = session;
			configuredEntries = loaded.servers;
			const registered = registeredServers();
			overridden = registered.overridden;
			servers = [...loaded.servers.map((entry) => ({ entry })), ...registered.servers].filter((server) =>
				canConnect(server.entry, ctx),
			);
			configView = () => ({
				autoEnableCodemode,
				servers: servers.map((server) => server.entry),
				errors: [...configErrors],
				...(projectConfig ? { projectConfig } : {}),
			});
			sessionConfigViews.set(ctx.sessionManager, configView);
			const approvedView = configView;
			sessionFactories.set(ctx.sessionManager, () => {
				const approved = structuredClone(approvedView());
				return createMcpExtension({
					...options,
					loadConfig: () => structuredClone(approved),
					canConnectServer: (entry) => {
						const current = servers.find((server) => server.entry.name === entry.name);
						return (
							!signal.aborted &&
							!!current &&
							isEnabled(current) &&
							JSON.stringify(current.entry.config) === JSON.stringify(entry.config) &&
							canConnect(current.entry, ctx)
						);
					},
				});
			});
			emitChange();
			// Tool_search is activated from the config: the first prompt does not wait for
			// servers whose tools are not declared to the model, and scripts or searches wait for them.
			ensureDiscoveryActive(ctx);
			const enabled = servers.filter(isEnabled);
			if (enabled.length === 0) {
				reportProblems(ctx);
				return;
			}
			// The MCP client loads only now, so sessions without servers never pay for it. Waiting one
			// event loop turn lets the first render happen before loading and connecting.
			const runtime = new Promise((resolve) => setImmediate(resolve)).then(() => loadMcpRuntime());
			pending = Promise.all(enabled.map((server) => startConnection(server, runtime)))
				.then(() => {
					if (!signal.aborted) reportProblems(ctx);
				})
				.catch((error: unknown) => {
					// The session may have been disposed meanwhile, which makes ctx stale.
					try {
						ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
					} catch {}
				});
		});

		// The first prompt waits for servers whose tools are declared to the model, so they are declared
		// in its first request, but not indefinitely: a slow or hanging server must not hold up the
		// prompt. Other servers are waited for when a script or search needs them (below).
		const waitForDirectServers = async (ctx: ExtensionContext) => {
			if (waitedForStartup) return;
			waitedForStartup = true;
			const ready = servers.flatMap((server) =>
				isEnabled(server) && hasDirectTools(server.entry) && server.ready ? [server.ready] : [],
			);
			const signal = ctx.signal ? AbortSignal.any([ctx.signal, session.signal]) : session.signal;
			if (ready.length === 0 || signal.aborted) return;
			let timer: NodeJS.Timeout | undefined;
			let onAbort: (() => void) | undefined;
			let finished: boolean;
			try {
				finished = await Promise.race([
					Promise.all(ready).then(() => true),
					new Promise<boolean>((resolve) => {
						timer = setTimeout(() => resolve(false), startupWaitMs);
					}),
					new Promise<boolean>((resolve) => {
						onAbort = () => resolve(true);
						signal.addEventListener("abort", onAbort, { once: true });
					}),
				]);
			} finally {
				clearTimeout(timer);
				if (onAbort) signal.removeEventListener("abort", onAbort);
			}
			if (!finished && !signal.aborted) {
				ctx.ui.notify("MCP servers are still connecting; their tools become available once connected.", "info");
			}
		};

		// Every prompt lists the servers in the `mcp_servers` section as they are when it starts. Pi
		// appends the section to the conversation when it changed, for example after a server connected.
		pi.on("session_tree", () => {
			lastServersSection = undefined;
		});
		pi.on("before_agent_start", async (_event, ctx) => {
			await waitForDirectServers(ctx);
			if (session.signal.aborted || ctx.signal?.aborted) return;
			const section = renderServersSection(servers.filter((server) => canConnect(server.entry, ctx)));
			if (section === lastServersSection) return;
			lastServersSection = section;
			return {
				message: {
					customType: MCP_SERVERS_SECTION,
					content: section ?? "No indirect MCP servers are available.",
					display: false,
				},
			};
		});

		// Searches/resources wait for their servers; direct calls wait for their current owner.
		pi.on("tool_call", async (event, ctx) => {
			const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
			if (!tool) return;
			// Readiness can be pending while the display state is still connected: reconnect first
			// closes the old transport, then opens a new one. Settled promises return immediately.
			const readyServers = servers.filter((server) => isEnabled(server) && server.ready);
			if (readyServers.length === 0) return;
			let waiting: McpServer[] = [];
			if (isToolSearchTool(tool) || isCodemodeTool(tool) || RESOURCE_TOOL_NAMES.has(tool.name)) {
				waiting = readyServers;
			} else {
				const owner = toolOwners.get(event.toolName)?.split("\0", 1)[0];
				waiting = readyServers.filter((server) => server.entry.name === owner);
			}
			await waitForServers(waiting, ctx.signal);
		});

		// Pick up sign-ins done outside the session, such as `pi mcp login` run by the agent.
		pi.on("turn_start", async (_event, ctx) => {
			if (tokensAtSignIn.size > 0) await reconnectSignedIn(ctx);
		});

		// Servers registered or unregistered during the session connect or disconnect right away.
		pi.on("mcp_servers_change", (_event, ctx) => {
			const { signal } = session;
			if (signal.aborted) return;
			// The runner may dispatch this event without awaiting it. Register ownership before
			// mutating the live list so shutdown cannot miss a connection detached by this work.
			return track(
				Promise.resolve().then(async () => {
					if (signal.aborted) return;
					const registered = registeredServers();
					overridden = registered.overridden;
					const next = new Map(registered.servers.map((server) => [server.entry.name, server]));
					const removed = servers.filter(
						(server) =>
							server.entry.scope === "extension" &&
							next.get(server.entry.name)?.registeredConfig !== server.registeredConfig,
					);
					for (const server of removed) server.attempt = undefined;
					const closing = track(
						Promise.all(
							removed.flatMap((server) => [server.connection?.close(), server.closing, server.ready]),
						).then(() => undefined),
					);
					servers = servers.filter((server) => !removed.includes(server));
					for (const server of removed) hideTools(server.entry.name);
					const added = registered.servers.filter((server) => !findServer(server.entry.name));
					// Carry cleanup into replacements so another change while closing cannot open a
					// newer transport before its predecessors finish. startConnection checks lifetime.
					for (const server of added) server.closing = closing;
					servers.push(...added);
					emitChange();
					ensureDiscoveryActive(ctx);
					const connecting = added.filter(isEnabled);
					try {
						await Promise.all([closing, ...connecting.map((server) => startConnection(server, closing))]);
					} catch (error) {
						if (!signal.aborted) ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
						return;
					}
					if (signal.aborted) return;
					reportProblems(ctx, connecting);
				}),
			);
		});

		pi.on("session_shutdown", async () => {
			const manager = sessionContext?.sessionManager;
			if (manager && configView && sessionConfigViews.get(manager) === configView) {
				sessionConfigViews.delete(manager);
				sessionFactories.delete(manager);
			}
			configView = undefined;
			session.abort();
			const closing = connections();
			servers = [];
			emitChange();
			await Promise.all([pending, ...backgroundActions, ...closing.map((connection) => connection.close())]);
		});

		pi.registerCommand("mcp", {
			description: "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure",
			getArgumentCompletions: (prefix) => {
				const [action, server, ...rest] = prefix.trimStart().split(/\s+/);
				if (rest.length > 0) return null;
				if (server === undefined) {
					return ["login", "logout", "reconnect"]
						.filter((item) => item.startsWith(action ?? ""))
						.map((item) => ({ value: `${item} `, label: item }));
				}
				if (action !== "login" && action !== "logout" && action !== "reconnect") return null;
				const items = servers
					.filter((candidate) =>
						action === "reconnect" ? candidate.connection !== undefined : usesOAuth(candidate),
					)
					.filter((candidate) => candidate.entry.name.startsWith(server))
					.map((candidate) => ({
						value: `${action} ${candidate.entry.name}`,
						label: candidate.entry.name,
						description: describeState(candidate),
					}));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				if (action === undefined) {
					if (ctx.mode === "tui") await showMcpManager(ctx, (ui) => manage(ui, ctx), session.signal);
					else {
						await pending;
						ctx.ui.notify(formatStatus(), "info");
					}
					return;
				}
				if (extra.length > 0) {
					ctx.ui.notify(MCP_USAGE, "warning");
					return;
				}
				await pending;
				switch (action) {
					case "login": {
						const server = await pickServer(name, ctx, oauthPick);
						if (server) await loginCommand(server, ctx);
						return;
					}
					case "logout": {
						const server = await pickServer(name, ctx, oauthPick);
						if (!server) return;
						const removed = await signOut(server);
						ctx.ui.notify(
							removed
								? `Signed out of MCP server "${server.entry.name}".`
								: `No stored credentials for MCP server "${server.entry.name}".`,
							"info",
						);
						return;
					}
					case "reconnect": {
						const server = await pickServer(name, ctx, {
							eligible: (candidate) => candidate.connection !== undefined,
							preferred: (candidate) =>
								candidate.connection?.state === "failed" || candidate.connection?.state === "disconnected",
							none: "No enabled MCP server to reconnect.",
						});
						if (!server) return;
						const failure = await reconnect(server);
						if (failure) ctx.ui.notify(failure, "error");
						else {
							ensureDiscoveryActive(ctx);
							ctx.ui.notify(
								`Reconnected to MCP server "${server.entry.name}" (${describeState(server)}).`,
								"info",
							);
						}
						return;
					}
					default:
						ctx.ui.notify(MCP_USAGE, "warning");
				}
			},
		});
	};
}

export default createMcpExtension({ agentDir: getAgentDir() });
