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
/** Bounded shutdown steps; none of them extends the 90-second read budget. */
const CLOSE_REQUEST_MS = 1_000;
const GROUP_TERM_MS = 1_000;
const GROUP_KILL_MS = 1_000;
/** A browser's helper processes can outlive its main child by a few hundred milliseconds. */
const GROUP_DRAIN_ATTEMPTS = 10;
const GROUP_DRAIN_INTERVAL_MS = 100;

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;

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
	fakeIpDelegated: boolean;
	metrics: ReadMetrics;
}

/** Per-read counters. Numbers only: never page text, URLs, query strings, headers or credentials. */
export interface ReadMetrics {
	elapsedMs: number;
	startupMs: number;
	navigateMs: number;
	scanMs: number;
	cleanupMs: number;
	/** Page samples the scanner evaluated in the browser, including the end re-verification pass. */
	samples: number;
	/** Of those samples, the ones that rebuilt the full page text in the collector. */
	serializations: number;
	cdpBytesIn: number;
	cdpBytesOut: number;
	/** Requests this read's proxy received, refusals included. */
	proxyRequests: number;
	/** Raw proxy transfer bytes; see PublicProxy.transferBytes (not decompressed body size). */
	proxyBytes: number;
	browsers: number;
	/** True when this read had to wait for a browser slot before it created anything. */
	queued: boolean;
}

/** Monotonic milliseconds between two process.hrtime.bigint() readings. */
function elapsedMs(start: bigint, end: bigint): number {
	return Number(end - start) / 1e6;
}

/**
 * The host configures the per-process browser cap through its launcher environment only;
 * a tool argument or a page can never change it. Missing and invalid values mean 2.
 */
function configuredConcurrency(): number {
	const raw = process.env.PI_WEB_FETCH_CONCURRENCY?.trim() ?? "";
	if (!/^[0-9]+$/.test(raw)) return DEFAULT_CONCURRENCY;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 1 && value <= MAX_CONCURRENCY ? value : DEFAULT_CONCURRENCY;
}

interface SlotWaiter {
	readonly signal?: AbortSignal;
	onAbort?: () => void;
	grant(): void;
}

/**
 * One module-level limiter shared by every read in this host process, so nested codemode
 * calls share the same browser budget instead of each creating its own semaphore. It only
 * ever holds counters and pending waiters: no timer, page data or browser reference lives here.
 */
class BrowserSlots {
	private running = 0;
	private queue: SlotWaiter[] = [];
	private peak = 0;

	get stats(): { running: number; queued: number; maxObserved: number; limit: number } {
		return {
			running: this.running,
			queued: this.queue.length,
			maxObserved: this.peak,
			limit: configuredConcurrency(),
		};
	}

	/** Resolves true when the caller had to wait. An aborted waiter rejects `cancelled`. */
	acquire(signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return Promise.reject(new WebError("Web request cancelled.", "cancelled"));
		if (this.running < configuredConcurrency()) {
			this.running++;
			this.notePeak();
			return Promise.resolve(false);
		}
		return new Promise<boolean>((resolve, reject) => {
			const waiter: SlotWaiter = { signal, grant: () => resolve(true) };
			const onAbort = () => {
				if (!this.take(waiter)) return;
				signal?.removeEventListener("abort", onAbort);
				reject(new WebError("Web request cancelled.", "cancelled"));
			};
			waiter.onAbort = onAbort;
			this.queue.push(waiter);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	release(): void {
		if (this.running > 0) this.running--;
		while (this.queue.length && this.running < configuredConcurrency()) {
			const waiter = this.queue.shift()!;
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			this.running++;
			this.notePeak();
			waiter.grant();
		}
	}

	private take(waiter: SlotWaiter): boolean {
		const index = this.queue.indexOf(waiter);
		if (index < 0) return false;
		this.queue.splice(index, 1);
		return true;
	}

	private notePeak(): void {
		if (this.running > this.peak) this.peak = this.running;
	}
}

const browserSlots = new BrowserSlots();

/** Test-facing diagnostics: counters only, never page data, URLs or credentials. */
export function webFetchSlotStats(): { running: number; queued: number; maxObserved: number; limit: number } {
	return browserSlots.stats;
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
	private closing = false;
	/** The child's exit (or spawn error) was observed, so its pid must never be signalled again. */
	private exitedObserved = false;
	private closingPromise: Promise<void> | undefined;
	private bytesIn = 0;
	private bytesOut = 0;
	private pending = new Map<
		number,
		{ resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
	>();
	private output: Writable;
	private input: Readable;
	private onAbort: () => void;
	readonly exited: Promise<void>;
	onEvent: (message: Message) => void = () => {};
	readonly process: childProcess.ChildProcess;
	private signal: AbortSignal;

	constructor(process: childProcess.ChildProcess, signal: AbortSignal) {
		this.process = process;
		this.signal = signal;
		this.output = process.stdio[3] as Writable;
		this.input = process.stdio[4] as Readable;
		this.exited = new Promise((resolve) => {
			process.once("exit", () => {
				this.exitedObserved = true;
				this.fail(new WebError("Browser exited before the page could be read.", "protocol-failed"));
				resolve();
			});
			process.once("error", () => {
				this.exitedObserved = true;
				this.fail(new WebError("Chrome/Chromium could not be started.", "protocol-failed"));
				resolve();
			});
		});
		this.output.on("error", () => this.fail(new WebError("Browser connection failed.", "protocol-failed")));
		this.input.on("error", () => this.fail(new WebError("Browser connection failed.", "protocol-failed")));
		this.input.on("end", () => this.fail(new WebError("Browser connection closed.", "protocol-failed")));
		this.input.setEncoding("utf8");
		this.input.on("data", (chunk: string) => this.receive(chunk));
		this.onAbort = () => this.fail(new WebError("Web request cancelled.", "cancelled"));
		signal.addEventListener("abort", this.onAbort, { once: true });
		if (signal.aborted) this.onAbort();
	}

	get bytesReceived(): number {
		return this.bytesIn;
	}

	get bytesSent(): number {
		return this.bytesOut;
	}

	/** Parse one chunk of NUL-framed CDP messages; every failure rejects all pending calls. */
	private receive(chunk: string): void {
		if (this.stopped) return;
		this.bytesIn += Buffer.byteLength(chunk);
		this.buffer += chunk;
		while (true) {
			const end = this.buffer.indexOf("\0");
			if (end < 0) break;
			const value = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 1);
			if (!value) continue;
			if (Buffer.byteLength(value) > MAX_CDP_BYTES) {
				this.fail(new WebError("Browser response exceeds the 4 MiB protocol limit.", "protocol-failed"));
				return;
			}
			let message: Message;
			try {
				message = JSON.parse(value);
			} catch {
				this.fail(new WebError("Browser returned invalid protocol data.", "protocol-failed"));
				return;
			}
			if (!message || typeof message !== "object") {
				this.fail(new WebError("Browser returned invalid protocol data.", "protocol-failed"));
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
							changed ? "frame-changed" : "protocol-failed",
						),
					);
				} else pending.resolve(message.result);
			} else this.onEvent(message);
		}
		// A single unterminated frame may never exceed the cap, however it is split up.
		if (Buffer.byteLength(this.buffer) > MAX_CDP_BYTES)
			this.fail(new WebError("Browser response exceeds the 4 MiB protocol limit.", "protocol-failed"));
	}

	call<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
		if (this.stopped || this.closing || this.signal.aborted)
			return Promise.reject(
				new WebError("Browser connection is closed.", this.signal.aborted ? "cancelled" : "protocol-failed"),
			);
		return this.send(method, params, sessionId);
	}

	/** Internal write path: usable while closing, so shutdown can still ask for a normal close. */
	private send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
		if (this.stopped) return Promise.reject(new WebError("Browser connection is closed.", "protocol-failed"));
		return new Promise<T>((resolve, reject) => {
			const id = ++this.nextId;
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) reject(new WebError("Browser protocol command timed out.", "read-timeout"));
			}, READ_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			try {
				// A broken pipe must resolve this call now; its async "error" event may never come.
				this.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
			} catch (error) {
				if (this.pending.delete(id)) {
					clearTimeout(timer);
					reject(
						error instanceof WebError ? error : new WebError("Browser connection failed.", "protocol-failed"),
					);
				}
			}
		});
	}

	private write(value: string): void {
		this.output.write(value);
		this.bytesOut += Buffer.byteLength(value);
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

	private async waitExit(ms: number): Promise<void> {
		if (this.hasExited()) return;
		await this.boundedWait(ms, this.exited);
	}

	/** A bounded wait that clears its timer when the awaited work finishes first. */
	private async boundedWait(ms: number, work: Promise<unknown>): Promise<void> {
		const stop = new AbortController();
		try {
			await Promise.race([
				work.then(
					() => {},
					() => {},
				),
				timers.setTimeout(ms, undefined, { signal: stop.signal }).catch(() => {}),
			]);
		} finally {
			stop.abort();
		}
	}

	/** The exit event, or the exit status Node sets with it, both prove the child is gone. */
	private hasExited(): boolean {
		return this.exitedObserved || this.process.exitCode !== null || this.process.signalCode !== null;
	}

	/**
	 * Signal only this read's own spawned process group: no name matching, no other pid.
	 * Once the child's exit was observed its pid may already be reused, so it is not
	 * signalled again and a surviving group is reported as a cleanup failure instead.
	 */
	private signalGroup(signal: NodeJS.Signals): void {
		const pid = this.process.pid;
		if (this.hasExited() || pid === undefined) return;
		try {
			process.kill(-pid, signal);
		} catch {}
	}

	/**
	 * The main child's exit is not proof for its descendants, so the owned process group
	 * is probed instead. A live group means descendants may remain; only ESRCH proves it empty.
	 */
	private groupAlive(): boolean {
		const pid = this.process.pid;
		if (pid === undefined) return false;
		try {
			process.kill(-pid, 0);
			return true;
		} catch (error) {
			// EPERM: the group exists but is not ours to signal. ESRCH: it is gone.
			return error instanceof Error && "code" in error && error.code === "EPERM";
		}
	}

	/**
	 * Bounded drain of the owned group. Chrome's helpers keep the group alive for a short
	 * while after the main child exits, so a single probe would report a false failure; a
	 * group that is still there when the bounded drain expires is a real cleanup failure.
	 */
	private async waitForGroupExit(): Promise<boolean> {
		for (let attempt = 0; ; attempt++) {
			if (!this.groupAlive()) return true;
			if (attempt >= GROUP_DRAIN_ATTEMPTS) return false;
			await timers.setTimeout(GROUP_DRAIN_INTERVAL_MS);
		}
	}

	private closePipes(): void {
		this.input.removeAllListeners("data");
		this.input.destroy();
		this.output.destroy();
	}

	/**
	 * Ordered, bounded shutdown of this read's own browser: stop new work, request a normal
	 * close, escalate with bounded signals over the owned group, verify the group is gone,
	 * then release the pipes. Throws `cleanup-failed` when the group cannot be confirmed gone.
	 */
	close(): Promise<void> {
		this.closingPromise ??= this.performClose();
		return this.closingPromise;
	}

	private async performClose(): Promise<void> {
		this.closing = true;
		try {
			if (!this.stopped) await this.boundedWait(CLOSE_REQUEST_MS, this.send("Browser.close"));
			if (!this.hasExited() && this.process.pid !== undefined) {
				this.signalGroup("SIGTERM");
				if (!this.hasExited()) await this.waitExit(GROUP_TERM_MS);
				if (!this.hasExited()) {
					this.signalGroup("SIGKILL");
					await this.waitExit(GROUP_KILL_MS);
				}
			}
		} finally {
			this.signal.removeEventListener("abort", this.onAbort);
			this.fail(new WebError("Browser connection closed.", "protocol-failed"));
			this.closePipes();
		}
		if (!(await this.waitForGroupExit()))
			throw new WebError(
				"Browser cleanup could not be confirmed; its temporary profile was preserved.",
				"cleanup-failed",
			);
	}
}

/** Fixed, credential-free explanation for a fake-ip refusal; never echoes resolver or page data. */
function fakeIpNote(proxy: PublicProxy | undefined): string {
	if (!proxy?.fakeIpBlocked) return "";
	return " At least one hostname was answered with an address in 198.18.0.0/15, the range local proxy clients return in fake-ip DNS mode; Web Fetch pins DNS to the resolved public addresses and cannot verify a fake one. Switch that client to real-IP DNS resolution, or add the target host to its fake-ip filter.";
}

/** Fixed, credential-free note that the destination was chosen by a local fake-ip DNS client. */
function delegatedNote(proxy: PublicProxy | undefined): string {
	if (!proxy?.fakeIpDelegated) return "";
	return " At least one hostname was answered with a 198.18.0.0/15 fake-ip address, so the destination was routed by that local DNS client instead of a pinned public IP.";
}

export async function readPage(requestedUrl: string, callerSignal?: AbortSignal): Promise<RenderedPage> {
	if (callerSignal?.aborted) throw new WebError("Web request cancelled.", "cancelled");
	publicTarget(requestedUrl);
	const startedAt = process.hrtime.bigint();
	// Queueing happens before anything is created, so a waiting read owns no browser,
	// proxy or temporary directory, and an aborted waiter leaves nothing behind.
	const queued = await browserSlots.acquire(callerSignal);
	const counters = {
		startupMs: 0,
		navigateMs: 0,
		scanMs: 0,
		cleanupMs: 0,
		samples: 0,
		serializations: 0,
		cdpBytesIn: 0,
		cdpBytesOut: 0,
		proxyRequests: 0,
		proxyBytes: 0,
		browsers: 0,
	};
	let root: string | undefined;
	let proxy: PublicProxy | undefined;
	let browser: BrowserPipe | undefined;
	let scanner: PageScanner | undefined;
	let deadline: AbortSignal | undefined;
	let blockedRequests = 0;
	let fakeIpDelegated = false;
	let result: ScanResult | undefined;
	let failure: WebError | undefined;
	let cleanupFailure: WebError | undefined;
	// Phase marks: a phase that a stalled read never finished at its normal boundary is
	// closed by the finally below, so it reports its real duration instead of zero.
	let phaseName: "startupMs" | "navigateMs" | "scanMs" | undefined;
	let phaseAt = startedAt;
	const finishPhase = (next?: "startupMs" | "navigateMs" | "scanMs"): void => {
		const now = process.hrtime.bigint();
		if (phaseName) counters[phaseName] = elapsedMs(phaseAt, now);
		phaseName = next;
		phaseAt = now;
	};
	try {
		const executable = await browserExecutable();
		deadline = AbortSignal.timeout(READ_TIMEOUT_MS);
		const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
		finishPhase("startupMs");
		root = await fs.mkdtemp(path.join(tmpdir(), "pi-web-fetch-"));
		for (const name of ["home", "tmp"]) await fs.mkdir(path.join(root, name), { mode: 0o700 });
		signal.throwIfAborted();
		proxy = await startPublicProxy(signal);
		signal.throwIfAborted();
		const launch = browserLaunch(root, proxy.url);
		// Nothing is spawned for an already-cancelled read, including a cancellation that
		// arrived while the proxy was starting.
		signal.throwIfAborted();
		const child = childProcess.spawn(executable, launch.args, {
			cwd: root,
			env: launch.env,
			detached: true,
			stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
		});
		counters.browsers = 1;
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
				scanner!.onResponse(message.params.frameId, message.params.response?.status ?? 0, message.params.loaderId);
			}
		};
		await scanner.prepare(sessionId);
		finishPhase("navigateMs");
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
				`Could not load the webpage (${reason}). Public-network guard rejected ${proxy.blockedRequests} request(s); these may be unrelated to navigation.${fakeIpNote(proxy)}${delegatedNote(proxy)}`,
			);
		}
		finishPhase("scanMs");
		const scanned = await scanner.scan(mainFrame, requestedUrl);
		finishPhase();
		if (scanner.status >= 400)
			throw new WebError(
				`Webpage returned HTTP ${scanner.status}; anonymous content could not be read.${fakeIpNote(proxy)}`,
			);
		if (!scanned.text.trim())
			throw new WebError(
				"No visible webpage text was returned. The page may require login, block automation, or still be loading.",
			);
		result = scanned;
	} catch (error) {
		if (callerSignal?.aborted) failure = new WebError("Web request cancelled.", "cancelled");
		else if (deadline?.aborted) {
			const partial = scanner?.result("timeout");
			if (partial?.text.trim() && scanner!.status < 400) result = partial;
			else failure = new WebError("Webpage read timed out after 90 seconds.", "read-timeout");
		} else if (error instanceof WebError) failure = error;
		else
			failure = new WebError(
				"Anonymous browser read failed. No Tavily request or credential fallback was made.",
				"protocol-failed",
			);
	} finally {
		finishPhase();
		const cleanupAt = process.hrtime.bigint();
		try {
			if (browser) {
				counters.cdpBytesIn = browser.bytesReceived;
				counters.cdpBytesOut = browser.bytesSent;
				// Order matters: confirm this read's browser is gone before its proxy,
				// its pipes and finally its temporary directory are released.
				await browser.close();
			}
		} catch (error) {
			cleanupFailure =
				error instanceof WebError
					? error
					: new WebError(
							"Browser cleanup could not be confirmed; its temporary profile was preserved.",
							"cleanup-failed",
						);
		}
		try {
			if (proxy) {
				// Read the counters before closing: transfer bytes are counted for still-open
				// sockets too, so the value is identical and survives a close error.
				counters.proxyRequests = proxy.requests;
				counters.proxyBytes = proxy.transferBytes;
				blockedRequests = proxy.blockedRequests;
				fakeIpDelegated = proxy.fakeIpDelegated;
				await proxy.close();
			}
		} catch {}
		counters.samples = scanner?.samples ?? 0;
		counters.serializations = scanner?.serialized ?? 0;
		// A directory whose browser could not be confirmed gone is preserved: it may still
		// be in use, and a cleanup failure must never look like a successful read.
		try {
			if (root && !cleanupFailure)
				await fs.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
		} finally {
			counters.cleanupMs = elapsedMs(cleanupAt, process.hrtime.bigint());
			browserSlots.release();
		}
	}
	const metrics: ReadMetrics = {
		...counters,
		elapsedMs: elapsedMs(startedAt, process.hrtime.bigint()),
		queued,
	};
	if (cleanupFailure) {
		// Caller cancellation keeps its stable code, but the preserved directory and the
		// rejected read still make the unclean shutdown visible; nothing is reported as success.
		if (callerSignal?.aborted) throw new WebError("Web request cancelled.", "cancelled");
		throw cleanupFailure;
	}
	if (callerSignal?.aborted) throw new WebError("Web request cancelled.", "cancelled");
	if (failure) throw failure;
	// Reaching here means a result exists; the guard is defensive, not a silent success path.
	if (!result)
		throw new WebError(
			"Anonymous browser read failed. No Tavily request or credential fallback was made.",
			"protocol-failed",
		);
	return { ...result, blockedRequests, fakeIpDelegated, metrics };
}
