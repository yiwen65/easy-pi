import timers from "node:timers/promises";
import { publicTarget, publicUrl, WebError } from "./network.ts";
import { ADVANCE_PAGE, MAX_CAPTURE_CHARS, type PageSample, SAMPLE_PAGE } from "./page-scan.ts";

interface Protocol {
	call<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
}
interface FrameTree {
	frame: { id: string; url: string; loaderId?: string; parentId?: string };
	childFrames?: FrameTree[];
}
interface FrameState {
	id: string;
	session: string;
	loader?: string;
	parent?: string;
	context?: number;
	url: string;
	sample?: PageSample;
	done: boolean;
	failed?: boolean;
}
interface Evaluation<T> {
	result?: { value?: T; objectId?: string };
	exceptionDetails?: unknown;
}

export interface ScanResult {
	url: string;
	title: string;
	text: string;
	captureTruncated: boolean;
	stabilized: boolean;
	passwordForm: boolean;
	scanComplete: boolean;
	incompleteReasons: string[];
	framesRead: number;
	scrollSteps: number;
}

// Only the rendered owner is inspected, in its parent's isolated world. Hidden
// auth/preload frames are not document content, even if they have readable text.
const FRAME_VISIBLE = `function() {
	if (!this.getClientRects().length || this.clientWidth < 1 || this.clientHeight < 1) return false;
	for (let el = this; el; el = el.parentElement) {
		const style = getComputedStyle(el);
		if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
	}
	return true;
}`;
const INITIAL_PAGE = `(() => ({ url: location.href, ready: document.readyState === 'complete',
	text: Array.from(document.body?.innerText ?? '').slice(0, ${MAX_CAPTURE_CHARS}).join('') }))()`;

/** Bounded frame traversal; all network access still goes through PublicProxy. */
export class PageScanner {
	private protocol: Protocol;
	private signal: AbortSignal;
	private mainSession: string;
	private sessions = new Map<string, { id: string; parent?: string; ready: Promise<void> }>();
	private frames = new Map<string, FrameState>();
	private reasons = new Set<string>();
	private mainFrame = "";
	private steps = 0;
	private navigations = 0;
	private truncated = false;
	private stopped = false;
	private statuses = new Map<string, number>();

	get status(): number {
		return this.statuses.get(this.mainFrame) ?? 0;
	}

	constructor(protocol: Protocol, mainSession: string, signal: AbortSignal) {
		this.protocol = protocol;
		this.mainSession = mainSession;
		this.signal = signal;
	}

	async prepare(session: string): Promise<void> {
		await this.protocol.call("Page.enable", {}, session);
		await this.protocol.call("Network.enable", {}, session);
		await this.protocol.call("Network.setCacheDisabled", { cacheDisabled: true }, session);
		await this.protocol.call("Network.setBypassServiceWorker", { bypass: true }, session);
		await this.protocol.call(
			"Target.setAutoAttach",
			{
				autoAttach: true,
				waitForDebuggerOnStart: false,
				flatten: true,
				filter: [{ type: "iframe", exclude: false }, { exclude: true }],
			},
			session,
		);
	}

	onAttached(targetId: string, session: string, parent?: string): void {
		if (this.sessions.size >= 24) {
			this.reasons.add("frame_limit");
			return;
		}
		const ready = this.prepare(session).catch(() => {
			if (!this.signal.aborted) this.reasons.add("frame_unavailable");
		});
		this.sessions.set(targetId, { id: session, parent, ready });
	}

	onDetached(session: string): void {
		for (const [id, value] of this.sessions) if (value.id === session) this.sessions.delete(id);
	}

	onResponse(frameId: string, status: number): void {
		// Hidden auth/tracking frames may fail without affecting document text.
		if (this.statuses.size < 256) this.statuses.set(frameId, status);
	}

	private async context(frame: FrameState): Promise<number> {
		const result = await this.protocol.call<{ executionContextId: number }>(
			"Page.createIsolatedWorld",
			{
				frameId: frame.id,
				worldName: "pi-web-fetch",
			},
			frame.session,
		);
		const previous = frame.context;
		frame.context = result.executionContextId;
		if (previous !== undefined && previous !== frame.context) {
			frame.sample = undefined;
			const removeChildren = (id: string) => {
				for (const child of this.frames.values())
					if (child.parent === id) {
						removeChildren(child.id);
						this.frames.delete(child.id);
					}
			};
			removeChildren(frame.id);
			if (frame.id === this.mainFrame) this.reasons.clear();
			if (++this.navigations >= 8) {
				this.reasons.add("navigation_limit");
				this.stopped = true;
			}
			throw new WebError("Browser frame changed during navigation.");
		}
		return result.executionContextId;
	}

	private async evaluate<T>(frame: FrameState, expression: string): Promise<T> {
		const result = await this.protocol.call<Evaluation<T>>(
			"Runtime.evaluate",
			{
				expression,
				contextId: await this.context(frame),
				returnByValue: true,
			},
			frame.session,
		);
		if (result.exceptionDetails || result.result?.value === undefined)
			throw new WebError("Browser page scan failed.");
		return result.result.value;
	}

	private async children(frame: FrameState): Promise<FrameTree[]> {
		const result = await this.protocol.call<{ frameTree: FrameTree }>("Page.getFrameTree", {}, frame.session);
		const find = (tree: FrameTree): FrameTree | undefined => {
			if (tree.frame.id === frame.id) return tree;
			for (const child of tree.childFrames ?? []) {
				const found = find(child);
				if (found) return found;
			}
		};
		const children = new Map((find(result.frameTree)?.childFrames ?? []).map((child) => [child.frame.id, child]));
		// Chromium omits OOPIFs from the parent's Page.getFrameTree. Related
		// targets have their own trees; auto-attach alone does not enumerate them.
		for (const attached of this.sessions.values()) {
			if (attached.id === frame.session || (attached.parent && attached.parent !== frame.id)) continue;
			await attached.ready;
			const { frameTree } = await this.protocol.call<{ frameTree: FrameTree }>("Page.getFrameTree", {}, attached.id);
			attached.parent ??= frameTree.frame.parentId;
			if (attached.parent === frame.id) children.set(frameTree.frame.id, frameTree);
		}
		return [...children.values()];
	}

	private async visible(child: FrameTree, parent: FrameState): Promise<boolean> {
		const { backendNodeId } = await this.protocol.call<{ backendNodeId: number }>(
			"DOM.getFrameOwner",
			{ frameId: child.frame.id },
			parent.session,
		);
		const { object } = await this.protocol.call<{ object: { objectId: string } }>(
			"DOM.resolveNode",
			{
				backendNodeId,
				executionContextId: await this.context(parent),
			},
			parent.session,
		);
		try {
			const result = await this.protocol.call<Evaluation<boolean>>(
				"Runtime.callFunctionOn",
				{
					objectId: object.objectId,
					functionDeclaration: FRAME_VISIBLE,
					returnByValue: true,
				},
				parent.session,
			);
			if (result.exceptionDetails || typeof result.result?.value !== "boolean")
				throw new WebError("Browser frame visibility check failed.");
			return result.result.value;
		} finally {
			await this.protocol
				.call("Runtime.releaseObject", { objectId: object.objectId }, parent.session)
				.catch(() => {});
		}
	}

	private async readChildren(parent: FrameState): Promise<boolean> {
		let scanned = false;
		for (const child of await this.children(parent)) {
			if (this.stopped) return scanned;
			try {
				if (!(await this.visible(child, parent))) continue;
				if ((this.statuses.get(child.frame.id) ?? 0) >= 400) {
					this.reasons.add("frame_http_error");
					continue;
				}
				const previous = this.frames.get(child.frame.id);
				if (
					(previous?.done || previous?.failed) &&
					previous.loader === child.frame.loaderId &&
					previous.url === child.frame.url
				)
					continue;
				if (this.frames.size >= 24 && !previous) {
					this.reasons.add("frame_limit");
					continue;
				}
				const attached = this.sessions.get(child.frame.id);
				if (attached) await attached.ready;
				const frame: FrameState = {
					id: child.frame.id,
					parent: parent.id,
					session: attached?.id ?? parent.session,
					url: child.frame.url,
					loader: child.frame.loaderId,
					done: false,
				};
				this.frames.set(frame.id, frame);
				await this.readFrame(frame, false);
				scanned = true;
			} catch (error) {
				this.signal.throwIfAborted();
				if (!(error instanceof WebError) || error.message === "Browser frame changed during navigation.")
					throw error;
				this.reasons.add("frame_unavailable");
				const failed = this.frames.get(child.frame.id);
				if (failed) failed.failed = true;
			}
		}
		return scanned;
	}

	private async readFrame(frame: FrameState, main: boolean): Promise<void> {
		let stableSince = Date.now(),
			lastRevision = -1,
			initialized = false;
		let initialText = "",
			initialUrl = "";
		const started = Date.now();
		while (!this.stopped) {
			this.signal.throwIfAborted();
			try {
				// Do not retain transient loading UI before the first stable render.
				if (!initialized) {
					const initial = await this.evaluate<{ url: string; text: string; ready: boolean }>(frame, INITIAL_PAGE);
					if (initial.url !== initialUrl || initial.text !== initialText || !initial.ready)
						stableSince = Date.now();
					initialUrl = initial.url;
					initialText = initial.text;
					if (Date.now() - stableSince < (main ? 2000 : 500) && Date.now() - started < 15_000) {
						await timers.setTimeout(200, undefined, { signal: this.signal });
						continue;
					}
					initialized = true;
				}
				const sample = await this.evaluate<PageSample>(frame, SAMPLE_PAGE);
				if (
					!sample ||
					typeof sample.text !== "string" ||
					typeof sample.url !== "string" ||
					typeof sample.title !== "string" ||
					Array.from(sample.text).length > MAX_CAPTURE_CHARS ||
					Buffer.byteLength(sample.text) > 1_048_576 ||
					!Number.isInteger(sample.revision) ||
					!Array.isArray(sample.incompleteReasons)
				)
					throw new WebError("Browser returned invalid or oversized page text.");
				if (main || !["about:blank", "about:srcdoc"].includes(sample.url)) publicTarget(sample.url);
				if (frame.url !== sample.url) {
					frame.sample = undefined;
					frame.url = sample.url;
					stableSince = Date.now();
				}
				frame.sample = sample;
				if (sample.revision !== lastRevision || !sample.ready || sample.busy) stableSince = Date.now();
				lastRevision = sample.revision;
				for (const reason of sample.incompleteReasons) this.reasons.add(reason);
				if (sample.passwordForm) this.reasons.add("password_form");
				if (sample.captureTruncated || this.result().captureTruncated) {
					this.truncated = true;
					this.reasons.add("capture_limit");
					this.stopped = true;
					return;
				}
				if (sample.incompleteReasons.some((reason) => /limit|stalled/.test(reason))) {
					this.stopped = true;
					return;
				}
				if (Date.now() - stableSince >= (sample.pending ? 400 : 2000)) {
					const scannedChildren = await this.readChildren(frame);
					if (this.stopped) return;
					// Also recheck after a failed/detached child, not just successful reads.
					const current = await this.evaluate<PageSample>(frame, SAMPLE_PAGE);
					if (
						current.revision !== sample.revision ||
						current.url !== sample.url ||
						current.pending !== sample.pending ||
						current.busy ||
						!current.ready
					) {
						stableSince = Date.now();
						continue;
					}
					// A child read may take seconds. Recheck the parent before claiming
					// it settled, rather than returning a pre-child navigation snapshot.
					if (scannedChildren) {
						stableSince = Date.now();
						continue;
					}
					if (!sample.pending) {
						frame.done = true;
						return;
					}
					if (this.steps >= 160) {
						this.reasons.add("scroll_limit");
						this.stopped = true;
						return;
					}
					const advance = await this.evaluate<{ moved: boolean; stalled?: boolean }>(frame, ADVANCE_PAGE);
					if (advance.moved) this.steps++;
					if (advance.stalled) {
						this.reasons.add("scroll_stalled");
						this.stopped = true;
						return;
					}
					stableSince = Date.now();
				}
			} catch (error) {
				if (!(error instanceof WebError) || error.message !== "Browser frame changed during navigation.")
					throw error;
				frame.sample = undefined;
				initialized = false;
				stableSince = Date.now();
				lastRevision = -1;
			}
			await timers.setTimeout(200, undefined, { signal: this.signal });
		}
	}

	async scan(mainFrame: string, url: string): Promise<ScanResult> {
		this.mainFrame = mainFrame;
		const frame: FrameState = { id: mainFrame, session: this.mainSession, url, done: false };
		this.frames.set(mainFrame, frame);
		await this.readFrame(frame, true);
		return this.result();
	}

	result(reason?: string): ScanResult {
		if (reason) this.reasons.add(reason);
		const main = this.frames.get(this.mainFrame);
		const samples = [...this.frames.values()].filter((frame) => frame.sample);
		const text = samples
			.filter((frame) => frame.sample!.text.trim())
			.map((frame) =>
				frame.id === this.mainFrame ? frame.sample!.text : `\n[Embedded frame text]\n${frame.sample!.text}`,
			)
			.join("\n");
		const chars = Array.from(text);
		const captureTruncated = this.truncated || chars.length > MAX_CAPTURE_CHARS;
		if (captureTruncated) this.reasons.add("capture_limit");
		return {
			url: main?.sample ? publicUrl(main.sample.url) : "",
			title: main?.sample?.title ?? "",
			text: chars.slice(0, MAX_CAPTURE_CHARS).join(""),
			captureTruncated,
			stabilized: main?.done === true,
			passwordForm: samples.some((frame) => frame.sample?.passwordForm),
			scanComplete: main?.done === true && this.reasons.size === 0 && samples.every((frame) => frame.done),
			incompleteReasons: [...this.reasons],
			framesRead: samples.length,
			scrollSteps: this.steps,
		};
	}
}
