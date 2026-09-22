import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { getSessionsDir } from "../../config.ts";
import { buildSnapshot } from "./aggregate.ts";
import { scanSessions } from "./scan.ts";
import type { ScanResult, StatsQuery, StatsSnapshot } from "./types.ts";

/**
 * Local HTTP service behind `epi stats`.
 *
 * Scope: serve the browser panel shipped in `./web` and expose the frozen
 * `/api/stats` snapshot. It binds loopback only, holds one in-memory scan in a
 * short-lived cache (no index, no disk writes) and never touches the session
 * files it reports on.
 */

/** Hosts a local panel may bind to. Anything else (for example `0.0.0.0`) is refused. */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const DEFAULT_STATS_PORT = 8787;
export const DEFAULT_STATS_HOST = "127.0.0.1";
export const DEFAULT_CACHE_TTL_MS = 30_000;

/** Default cap for `byModel`/`byProvider`/`byProject` rows in `/api/stats` (`?top=0` disables it). */
const DEFAULT_ROW_CAP = 500;

/** URL path -> asset filename. Static serving never uses request input as a path. */
const ASSET_ROUTES = new Map<string, string>([
	["/", "index.html"],
	["/index.html", "index.html"],
	["/app.js", "app.js"],
	["/app.css", "app.css"],
]);

const ASSET_CONTENT_TYPES: Record<string, string> = {
	"index.html": "text/html; charset=utf-8",
	"app.js": "text/javascript; charset=utf-8",
	"app.css": "text/css; charset=utf-8",
};

export interface StatsScanCacheOptions {
	/** Session roots; defaults to `getSessionsDir()` when omitted. */
	roots?: readonly string[];
	/** How long a scan result is reused before the next request rescans. */
	cacheTtlMs?: number;
	/** Test seam: replace the scanner without changing cache semantics. */
	scan?: (roots: readonly string[]) => ScanResult;
}

/**
 * One-scan cache shared by the API routes (and reusable by `--json` callers).
 *
 * The scan itself is synchronous, so overlapping requests cannot interleave;
 * the single-flight promise keeps that guarantee explicit if the scanner ever
 * becomes asynchronous.
 */
export class StatsScanCache {
	private readonly roots: readonly string[];
	private readonly cacheTtlMs: number;
	private readonly scan: (roots: readonly string[]) => ScanResult;
	private result: ScanResult | null = null;
	private scannedAt = 0;
	private inFlight: Promise<ScanResult> | null = null;

	constructor(options: StatsScanCacheOptions = {}) {
		this.roots = options.roots && options.roots.length > 0 ? [...options.roots] : [getSessionsDir()];
		this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		this.scan = options.scan ?? ((roots) => scanSessions({ roots }));
	}

	/** Snapshot for one query. `refresh` forces a rescan; `scan.cached` reports reuse. */
	async getSnapshot(query: StatsQuery = {}, refresh = false): Promise<StatsSnapshot> {
		const reused = !refresh && this.result !== null && Date.now() - this.scannedAt < this.cacheTtlMs;
		if (reused && this.result !== null) {
			return buildSnapshot(this.result, { ...query, cached: true });
		}
		const result = await this.scanOnce();
		return buildSnapshot(result, { ...query, cached: false });
	}

	/** Drop the cached scan so the next request rescans. */
	invalidate(): void {
		this.result = null;
		this.scannedAt = 0;
	}

	private scanOnce(): Promise<ScanResult> {
		if (this.inFlight === null) {
			this.inFlight = Promise.resolve()
				.then(() => this.scan(this.roots))
				.then((result) => {
					this.result = result;
					this.scannedAt = Date.now();
					return result;
				})
				.finally(() => {
					this.inFlight = null;
				});
		}
		return this.inFlight;
	}
}

export interface StatsServerOptions {
	/** Session roots; defaults to `getSessionsDir()` when omitted. */
	roots?: readonly string[];
	/** Directory holding `index.html`, `app.js`, `app.css`. */
	webDir: string;
	/** Defaults to 8787; a busy port falls back to an ephemeral one. */
	port?: number;
	/** Defaults to 127.0.0.1. Only loopback hosts are accepted. */
	host?: string;
	/** Scan reuse window; defaults to 30s. */
	cacheTtlMs?: number;
	/** Test seam: replace the scanner without changing cache semantics. */
	scan?: (roots: readonly string[]) => ScanResult;
}

export interface StatsServerHandle {
	/** Base URL with a trailing slash, ready to open in a browser. */
	url: string;
	/** Actually bound port (differs from the requested one after an EADDRINUSE fallback). */
	port: number;
	host: string;
	/** Idempotent; resolves once the listener is closed. */
	close(): Promise<void>;
	/** Invalidate the cached scan (the next request rescans). */
	refresh(): void;
}

/** Start the loopback panel service. Rejects only for invalid options or a failed bind. */
export async function startStatsServer(options: StatsServerOptions): Promise<StatsServerHandle> {
	const host = options.host ?? DEFAULT_STATS_HOST;
	if (!ALLOWED_HOSTS.has(host)) {
		throw new Error(`Refusing to bind stats server to ${host}; only loopback hosts are allowed`);
	}
	const cache = new StatsScanCache({
		roots: options.roots,
		cacheTtlMs: options.cacheTtlMs,
		scan: options.scan,
	});
	const requestedPort = options.port ?? DEFAULT_STATS_PORT;
	const server = createServer((request, response) => {
		void handleRequest(request, response, { cache, webDir: options.webDir }).catch(() => {
			// Nothing else can be done once the response is under way; the request
			// handler answers 500 for anything it can still report.
		});
	});

	let boundPort: number;
	try {
		boundPort = await listen(server, requestedPort, host);
	} catch (error) {
		if (requestedPort === 0) throw error;
		// Port already in use (or otherwise unavailable): fall back to an ephemeral port.
		boundPort = await listen(server, 0, host);
	}

	const address = server.address() as AddressInfo | null;
	const finalPort = address?.port ?? boundPort;
	let closed = false;

	return {
		url: `http://${formatHost(host)}:${finalPort}/`,
		port: finalPort,
		host,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
				// Drop keep-alive sockets so close() does not wait on an idle browser tab.
				server.closeAllConnections();
			});
		},
		refresh(): void {
			cache.invalidate();
		},
	};
}

function listen(server: Server, port: number, host: string): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.removeListener("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.removeListener("error", onError);
			const address = server.address() as AddressInfo | null;
			resolve(address?.port ?? port);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

interface RequestContext {
	cache: StatsScanCache;
	webDir: string;
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	context: RequestContext,
): Promise<void> {
	const method = request.method ?? "GET";
	const headOnly = method === "HEAD";
	if (method !== "GET" && !headOnly) {
		sendJson(response, 405, { error: "method_not_allowed", message: `${method} is not supported` }, false, {
			allow: "GET, HEAD",
		});
		return;
	}

	let url: URL;
	try {
		url = new URL(request.url ?? "/", "http://localhost");
	} catch {
		sendJson(response, 400, { error: "invalid_request", message: "Unparsable request URL" }, headOnly);
		return;
	}

	try {
		if (url.pathname === "/api/stats") {
			await handleStats(url, response, context.cache, headOnly);
			return;
		}
		if (url.pathname === "/api/health") {
			await handleHealth(response, context.cache, headOnly);
			return;
		}
		if (url.pathname === "/favicon.ico") {
			response.writeHead(204, { "cache-control": "no-cache", "x-content-type-options": "nosniff" });
			response.end();
			return;
		}
		const asset = ASSET_ROUTES.get(url.pathname);
		if (asset === undefined) {
			sendJson(response, 404, { error: "not_found", message: `No route for ${url.pathname}` }, headOnly);
			return;
		}
		await serveAsset(response, context.webDir, asset, headOnly);
	} catch {
		sendJson(response, 500, { error: "internal_error", message: "Stats service failed to answer" }, headOnly);
	}
}

async function handleStats(
	url: URL,
	response: ServerResponse,
	cache: StatsScanCache,
	headOnly: boolean,
): Promise<void> {
	const parsed = parseStatsQuery(url.searchParams);
	if (!parsed.ok) {
		sendJson(response, 400, { error: "invalid_query", message: parsed.message }, headOnly);
		return;
	}
	const snapshot = await cache.getSnapshot(parsed.query, parsed.refresh);
	sendJson(response, 200, snapshot, headOnly);
}

async function handleHealth(response: ServerResponse, cache: StatsScanCache, headOnly: boolean): Promise<void> {
	// Reuses the cached scan (and triggers the first one) so the numbers are real.
	const snapshot = await cache.getSnapshot();
	sendJson(
		response,
		200,
		{
			ok: true,
			generatedAt: snapshot.generatedAt,
			scanMs: snapshot.scan.scanMs,
			files: snapshot.scan.files,
			cached: snapshot.scan.cached,
		},
		headOnly,
	);
}

async function serveAsset(response: ServerResponse, webDir: string, asset: string, headOnly: boolean): Promise<void> {
	const contentType = ASSET_CONTENT_TYPES[asset];
	if (contentType === undefined) {
		sendJson(response, 404, { error: "not_found", message: `No asset named ${asset}` }, headOnly);
		return;
	}
	let body: Buffer;
	try {
		body = await readFile(join(webDir, asset));
	} catch {
		sendJson(response, 500, { error: "asset_unavailable", message: `Missing panel asset ${asset}` }, headOnly);
		return;
	}
	response.writeHead(200, {
		"content-type": contentType,
		"content-length": body.byteLength,
		"cache-control": "no-cache",
		"x-content-type-options": "nosniff",
	});
	response.end(headOnly ? undefined : body);
}

type ParsedQuery = { ok: true; query: StatsQuery; refresh: boolean } | { ok: false; message: string };

function parseStatsQuery(params: URLSearchParams): ParsedQuery {
	const query: StatsQuery = {};
	const from = parseDay(params, "from");
	if (from !== null && typeof from === "object") return { ok: false, message: from.message };
	query.from = from;

	const to = parseDay(params, "to");
	if (to !== null && typeof to === "object") return { ok: false, message: to.message };
	query.to = to;

	const includeAll = parseFlag(params, "includeAll");
	if (typeof includeAll === "object") return { ok: false, message: includeAll.message };
	query.includeAll = includeAll;

	const refresh = parseFlag(params, "refresh");
	if (typeof refresh === "object") return { ok: false, message: refresh.message };

	const top = parseTop(params);
	if (top !== null && typeof top === "object") return { ok: false, message: top.message };
	// Absent `top` uses the documented default cap; `?top=0` opts out of truncation.
	query.top = top ?? DEFAULT_ROW_CAP;

	return { ok: true, query, refresh: refresh === true };
}

/** `undefined` when absent, a validated `YYYY-MM-DD` string, or an error object. */
function parseDay(params: URLSearchParams, key: string): string | null | { message: string } {
	const raw = params.get(key);
	if (raw === null || raw === "") return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
		return { message: `${key} must be YYYY-MM-DD` };
	}
	const month = Number(raw.slice(5, 7));
	const day = Number(raw.slice(8, 10));
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return { message: `${key} is not a valid calendar day` };
	}
	return raw;
}

/** `undefined` when absent, a boolean, or an error object. Only 0/1 are accepted. */
function parseFlag(params: URLSearchParams, key: string): boolean | undefined | { message: string } {
	const raw = params.get(key);
	if (raw === null || raw === "") return undefined;
	if (raw === "1") return true;
	if (raw === "0") return false;
	return { message: `${key} must be 0 or 1` };
}

/** `null` when absent (aggregator default), a non-negative integer, or an error object. */
function parseTop(params: URLSearchParams): number | null | { message: string } {
	const raw = params.get("top");
	if (raw === null || raw === "") return null;
	if (!/^\d+$/.test(raw)) {
		return { message: "top must be a non-negative integer" };
	}
	return Number(raw);
}

function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
	headOnly: boolean,
	extraHeaders: Record<string, string> = {},
): void {
	const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
	if (response.headersSent) return;
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": payload.byteLength,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		...extraHeaders,
	});
	response.end(headOnly ? undefined : payload);
}

function formatHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}
