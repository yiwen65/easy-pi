import childProcess from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import timers from "node:timers/promises";
import { PageScanner, type ScanResult } from "./frame-scan.ts";
import { type PublicProxy, publicTarget, startPublicProxy, WebError } from "./network.ts";

const READ_TIMEOUT_MS = 90_000;
const MAX_CDP_BYTES = 4_194_304;

type Message = {
	id?: number;
	sessionId?: string;
	method?: string;
	params?: any;
	result?: any;
	error?: { code: number; message: string };
};

export interface RenderedPage extends ScanResult {
	blockedRequests: number;
}

async function browserExecutable(): Promise<string> {
	if (!["darwin", "linux"].includes(process.platform)) {
		throw new WebError("Web Fetch currently supports Chrome/Chromium on macOS and Linux.");
	}
	const override = process.env.PI_WEB_FETCH_BROWSER;
	const candidates = override
		? [override]
		: process.platform === "darwin"
			? [
					"/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
					"/Applications/Chromium.app/Contents/MacOS/Chromium",
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				]
			: [
					"/usr/bin/chromium",
					"/usr/bin/chromium-browser",
					"/usr/bin/google-chrome",
					"/usr/bin/google-chrome-stable",
				];
	for (const candidate of candidates) {
		if (!path.isAbsolute(candidate)) continue;
		try {
			await fs.access(candidate, constants.X_OK);
			if ((await fs.stat(candidate)).isFile()) return candidate;
		} catch {}
	}
	throw new WebError(
		"Chrome/Chromium is unavailable. Install it or set PI_WEB_FETCH_BROWSER to an absolute executable path; no browser is downloaded automatically.",
	);
}

/** Only fresh directories and non-secret constants are supplied to Chromium. */
export function browserLaunch(root: string, proxy: string): { args: string[]; env: NodeJS.ProcessEnv } {
	return {
		args: [
			"--headless=new",
			"--disable-gpu",
			"--disable-extensions",
			"--no-first-run",
			"--no-default-browser-check",
			"--no-startup-window",
			"--disable-background-networking",
			"--disable-sync",
			"--disable-component-update",
			"--password-store=basic",
			"--use-mock-keychain",
			"--remote-debugging-pipe",
			"--disable-quic",
			"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
			"--disable-features=WebTransport,MediaRouter",
			`--proxy-server=${proxy}`,
			"--proxy-bypass-list=<-loopback>",
			"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
			`--user-data-dir=${path.join(root, "profile")}`,
		],
		env: {
			HOME: path.join(root, "home"),
			TMPDIR: path.join(root, "tmp"),
			PATH: "/usr/bin:/bin",
			LANG: "en_US.UTF-8",
			XDG_CONFIG_HOME: path.join(root, "home", ".config"),
			XDG_CACHE_HOME: path.join(root, "home", ".cache"),
		},
	};
}

class BrowserPipe {
	private nextId = 0;
	private buffer = "";
	private stopped = false;
	private pending = new Map<
		number,
		{ resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
	>();
	private output: Writable;
	private onAbort: () => void;
	readonly exited: Promise<void>;
	onEvent: (message: Message) => void = () => {};
	readonly process: childProcess.ChildProcess;
	private signal: AbortSignal;

	constructor(process: childProcess.ChildProcess, signal: AbortSignal) {
		this.process = process;
		this.signal = signal;
		this.output = process.stdio[3] as Writable;
		const input = process.stdio[4] as Readable;
		this.exited = new Promise((resolve) => {
			process.once("exit", () => {
				this.fail(new WebError("Browser exited before the page could be read."));
				resolve();
			});
			process.once("error", () => {
				this.fail(new WebError("Chrome/Chromium could not be started."));
				resolve();
			});
		});
		this.output.on("error", () => this.fail(new WebError("Browser connection failed.")));
		input.on("error", () => this.fail(new WebError("Browser connection failed.")));
		input.on("end", () => this.fail(new WebError("Browser connection closed.")));
		input.setEncoding("utf8");
		input.on("data", (chunk: string) => {
			this.buffer += chunk;
			if (Buffer.byteLength(this.buffer) > MAX_CDP_BYTES) {
				this.fail(new WebError("Browser response exceeds the 4 MiB protocol limit."));
				return;
			}
			while (true) {
				const end = this.buffer.indexOf("\0");
				if (end < 0) break;
				const value = this.buffer.slice(0, end);
				this.buffer = this.buffer.slice(end + 1);
				if (!value) continue;
				let message: Message;
				try {
					message = JSON.parse(value);
				} catch {
					this.fail(new WebError("Browser returned invalid protocol data."));
					return;
				}
				if (!message || typeof message !== "object") {
					this.fail(new WebError("Browser returned invalid protocol data."));
					return;
				}
				if (message.id && this.pending.has(message.id)) {
					const pending = this.pending.get(message.id)!;
					this.pending.delete(message.id);
					clearTimeout(pending.timer);
					if (message.error) {
						const changed = /context.*destroyed|Cannot find context|navigated/i.test(message.error.message ?? "");
						pending.reject(
							new WebError(
								changed ? "Browser frame changed during navigation." : "Browser protocol command failed.",
							),
						);
					} else pending.resolve(message.result);
				} else this.onEvent(message);
			}
		});
		this.onAbort = () => this.fail(new WebError("Web request cancelled."));
		signal.addEventListener("abort", this.onAbort, { once: true });
		if (signal.aborted) this.onAbort();
	}

	call<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
		if (this.stopped || this.signal.aborted) return Promise.reject(new WebError("Browser connection is closed."));
		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new WebError("Browser protocol command timed out."));
			}, READ_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.output.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
		});
	}

	private fail(error: Error): void {
		this.stopped = true;
		this.buffer = "";
		for (const item of this.pending.values()) {
			clearTimeout(item.timer);
			item.reject(error);
		}
		this.pending.clear();
	}

	async close(): Promise<void> {
		this.signal.removeEventListener("abort", this.onAbort);
		if (!this.stopped) {
			await Promise.race([this.call("Browser.close").catch(() => {}), timers.setTimeout(1000)]);
		}
		if (this.process.exitCode === null && this.process.signalCode === null && this.process.pid) {
			try {
				process.kill(-this.process.pid, "SIGTERM");
			} catch {}
			await Promise.race([this.exited, timers.setTimeout(1000)]);
			if (this.process.exitCode === null && this.process.signalCode === null) {
				try {
					process.kill(-this.process.pid, "SIGKILL");
				} catch {}
				await Promise.race([this.exited, timers.setTimeout(1000)]);
			}
		}
		this.fail(new WebError("Browser connection closed."));
		if (this.process.exitCode === null && this.process.signalCode === null && this.process.pid) {
			throw new WebError("Browser cleanup failed; its temporary profile was preserved.");
		}
	}
}

export async function readPage(requestedUrl: string, callerSignal?: AbortSignal): Promise<RenderedPage> {
	if (callerSignal?.aborted) throw new WebError("Web request cancelled.");
	publicTarget(requestedUrl);
	const executable = await browserExecutable();
	const deadline = AbortSignal.timeout(READ_TIMEOUT_MS);
	const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
	let root: string | undefined;
	let proxy: PublicProxy | undefined;
	let browser: BrowserPipe | undefined;
	let scanner: PageScanner | undefined;
	try {
		root = await fs.mkdtemp(path.join(tmpdir(), "pi-web-fetch-"));
		for (const name of ["home", "tmp"]) await fs.mkdir(path.join(root, name), { mode: 0o700 });
		signal.throwIfAborted();
		proxy = await startPublicProxy(signal);
		signal.throwIfAborted();
		const launch = browserLaunch(root, proxy.url);
		const child = childProcess.spawn(executable, launch.args, {
			cwd: root,
			env: launch.env,
			detached: true,
			stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
		});
		browser = new BrowserPipe(child, signal);
		await browser.call("Browser.getVersion");
		await browser.call("Browser.setDownloadBehavior", { behavior: "deny" });
		const { targetId } = await browser.call<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await browser.call<{ sessionId: string }>("Target.attachToTarget", {
			targetId,
			flatten: true,
		});
		scanner = new PageScanner(browser, sessionId, signal);
		browser.onEvent = (message) => {
			if (message.method === "Target.attachedToTarget" && message.params?.targetInfo?.type === "iframe") {
				scanner!.onAttached(
					message.params.targetInfo.targetId,
					message.params.sessionId,
					message.params.targetInfo.parentFrameId,
				);
			} else if (message.method === "Target.detachedFromTarget") {
				scanner!.onDetached(message.params?.sessionId);
			} else if (message.method === "Network.responseReceived" && message.params?.type === "Document") {
				scanner!.onResponse(message.params.frameId, message.params.response?.status ?? 0);
			}
		};
		await scanner.prepare(sessionId);
		const navigation = await browser.call<{ frameId?: string; errorText?: string }>(
			"Page.navigate",
			{ url: requestedUrl },
			sessionId,
		);
		const mainFrame = navigation.frameId;
		if (navigation.errorText || !mainFrame) {
			// Keep Chromium's bounded error code, never arbitrary protocol text or URLs.
			const reason =
				typeof navigation.errorText === "string" && /^net::ERR_[A-Z0-9_]{1,64}$/.test(navigation.errorText)
					? navigation.errorText
					: navigation.errorText
						? "navigation reason unavailable"
						: "missing main frame";
			throw new WebError(
				`Could not load the webpage (${reason}). Public-network guard rejected ${proxy.blockedRequests} request(s); these may be unrelated to navigation.`,
			);
		}
		const result = await scanner.scan(mainFrame, requestedUrl);
		if (scanner.status >= 400)
			throw new WebError(`Webpage returned HTTP ${scanner.status}; anonymous content could not be read.`);
		if (!result.text.trim())
			throw new WebError(
				"No visible webpage text was returned. The page may require login, block automation, or still be loading.",
			);
		return { ...result, blockedRequests: proxy.blockedRequests };
	} catch (error) {
		if (callerSignal?.aborted) throw new WebError("Web request cancelled.");
		if (deadline.aborted) {
			const partial = scanner?.result("timeout");
			if (partial?.text.trim() && scanner!.status < 400)
				return { ...partial, blockedRequests: proxy?.blockedRequests ?? 0 };
			throw new WebError("Webpage read timed out after 90 seconds.");
		}
		if (error instanceof WebError) throw error;
		throw new WebError("Anonymous browser read failed. No Tavily request or credential fallback was made.");
	} finally {
		try {
			await browser?.close();
		} finally {
			await proxy?.close();
		}
		if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
	}
}
