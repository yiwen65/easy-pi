import type { LookupAddress } from "node:dns";
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

export class WebError extends Error {}

export function publicUrl(value: unknown): string {
	if (typeof value !== "string" || value.length > 2048) throw new WebError("Expected a public HTTP(S) URL.");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new WebError("Expected a public HTTP(S) URL.");
	}
	const host = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		!host.includes(".") ||
		net.isIP(host) ||
		/(^|\.)(localhost|local|internal|invalid|test|example|onion)$/.test(host) ||
		host === "home.arpa" ||
		host.endsWith(".home.arpa")
	) {
		throw new WebError(
			"Only public HTTP(S) domain URLs without credentials are supported; local hosts and IP literals are rejected.",
		);
	}
	if (Buffer.byteLength(url.href) > 2048) throw new WebError("URL exceeds 2048 bytes.");
	return url.href;
}

const nonPublic = new net.BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	nonPublic.addSubnet(address, prefix, "ipv4");
const globalV6 = new net.BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
] as const) {
	nonPublic.addSubnet(address, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
	const family = net.isIP(address);
	if (family === 4) return !nonPublic.check(address, "ipv4");
	return family === 6 && globalV6.check(address, "ipv6") && !nonPublic.check(address, "ipv6");
}

export function publicTarget(value: string): URL {
	const url = new URL(publicUrl(value));
	if (url.port) throw new WebError("Web Fetch only supports standard HTTP/HTTPS ports (80/443).");
	return url;
}

export async function resolvePublicHost(host: string): Promise<LookupAddress[]> {
	let addresses: LookupAddress[];
	try {
		addresses = await dns.lookup(host, { all: true, verbatim: true });
	} catch {
		throw new WebError("Public webpage DNS lookup failed.");
	}
	if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
		throw new WebError("Web Fetch blocked a hostname resolving to private or reserved addresses.");
	}
	// Keep the whole approved snapshot: an unreachable first IP must not strand
	// healthy alternatives. Prefer IPv4 on hosts without IPv6 routing.
	return addresses.sort((a, b) => a.family - b.family);
}

export interface PublicProxy {
	url: string;
	blockedRequests: number;
	close(): Promise<void>;
}

/** A per-read loopback proxy: all browser TCP egress is checked and DNS-pinned. */
export async function startPublicProxy(signal: AbortSignal): Promise<PublicProxy> {
	signal.throwIfAborted();
	const sockets = new Set<Duplex>();
	const hosts = new Map<string, ReturnType<typeof resolvePublicHost>>();
	let closed = false;
	let connections = 0;
	const track = <T extends Duplex>(socket: T): T => {
		sockets.add(socket);
		socket.on("error", () => socket.destroy());
		socket.once("close", () => sockets.delete(socket));
		return socket;
	};
	const addressFor = async (url: URL) => {
		if (closed || ++connections > 512) throw new WebError("Webpage connection limit reached.");
		let address = hosts.get(url.hostname);
		if (!address) {
			if (hosts.size >= 128) throw new WebError("Webpage hostname limit reached.");
			address = resolvePublicHost(url.hostname);
			hosts.set(url.hostname, address);
		}
		const result = await address;
		if (closed) throw new WebError("Web request cancelled.");
		return result;
	};
	const connectTo = (url: URL, addresses: LookupAddress[]) => {
		const socket = track(
			net.connect({
				host: url.hostname,
				port: url.protocol === "https:" ? 443 : 80,
				// This is a pinned lookup, not another DNS query. Node tries only
				// these vetted IPs, before sending any HTTP/TLS application data.
				lookup: (_host, _options, callback) => queueMicrotask(() => callback(null, addresses)),
				autoSelectFamily: true,
				autoSelectFamilyAttemptTimeout: 250,
			}),
		);
		socket.setTimeout(15_000, () => socket.destroy());
		return socket;
	};
	const server = http.createServer((request, response) => {
		void (async () => {
			try {
				const url = publicTarget(request.url ?? "");
				if (url.protocol !== "http:") throw new WebError("Invalid proxy request.");
				const addresses = await addressFor(url);
				const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host, connection: "close" };
				delete headers["proxy-authorization"];
				delete headers["proxy-connection"];
				const upstream = http.request(
					{
						hostname: url.hostname,
						port: 80,
						// No Agent: agent:false would ignore this pinned connector.
						createConnection: () => connectTo(url, addresses),
						method: request.method,
						path: url.pathname + url.search,
						headers,
					},
					(incoming) => {
						response.writeHead(incoming.statusCode ?? 502, incoming.headers);
						incoming.pipe(response);
					},
				);
				upstream.on("error", () => {
					if (!response.headersSent) response.writeHead(502);
					response.end();
				});
				response.once("close", () => upstream.destroy());
				request.pipe(upstream);
			} catch {
				proxy.blockedRequests++;
				response.writeHead(403, { "Content-Type": "text/plain" });
				response.end("Web Fetch public-network policy blocked this request.");
			}
		})();
	});
	server.maxConnections = 128;
	server.on("connection", (socket) => {
		track(socket);
		socket.setTimeout(15_000, () => socket.destroy());
	});
	server.on("upgrade", (_request, socket) => socket.destroy());
	server.on("connect", (request, client, head) => {
		void (async () => {
			try {
				const url = publicTarget(`https://${request.url ?? ""}`);
				if (url.pathname !== "/" || url.search || url.hash) throw new WebError("Invalid CONNECT target.");
				const addresses = await addressFor(url);
				if (client.destroyed) return;
				const upstream = connectTo(url, addresses);
				upstream.once("connect", () => {
					if (closed || client.destroyed) {
						upstream.destroy();
						return;
					}
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					if (head.length) upstream.write(head);
					client.pipe(upstream);
					upstream.pipe(client);
				});
				upstream.once("close", () => client.destroy());
				client.once("close", () => upstream.destroy());
			} catch {
				proxy.blockedRequests++;
				client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			}
		})();
	});
	let closing: Promise<void> | undefined;
	const proxy: PublicProxy = {
		url: "",
		blockedRequests: 0,
		close() {
			if (closing) return closing;
			closed = true;
			signal.removeEventListener("abort", onAbort);
			for (const socket of sockets) socket.destroy();
			closing = new Promise((resolve) => {
				server.close(() => resolve());
			});
			return closing;
		},
	};
	const onAbort = () => {
		void proxy.close();
	};
	server.on("error", onAbort);
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			await proxy.close();
			signal.throwIfAborted();
		}
		const address = server.address() as net.AddressInfo;
		proxy.url = `http://127.0.0.1:${address.port}`;
		return proxy;
	} catch (error) {
		await proxy.close();
		throw error;
	}
}
