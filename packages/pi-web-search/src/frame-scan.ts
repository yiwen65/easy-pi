import timers from "node:timers/promises";
import { codePointLength, MAX_CAPTURE_BLOCKS, STRUCTURE_TRUNCATED, type StructureBlock } from "./content-format.ts";
import { publicTarget, publicUrl, WebError } from "./network.ts";
import {
	ADVANCE_PAGE,
	LIGHT_SAMPLE_PAGE,
	MAX_CAPTURE_CHARS,
	type PageProbe,
	type PageSample,
	SAMPLE_PAGE,
} from "./page-scan.ts";

interface Protocol {
	call<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
}
interface FrameNode {
	id: string;
	url: string;
	loaderId?: string;
	parentId?: string;
}
interface FrameTree {
	frame: FrameNode;
	childFrames?: FrameTree[];
}
interface DiscoveredFrame {
	tree: FrameTree;
	/** The parent's own frame tree listed it, so absence from that tree proves DOM removal. */
	owned: boolean;
}
interface Evaluation<T> {
	result?: { value?: T; objectId?: string };
	exceptionDetails?: unknown;
}

export type FrameScanStatus = "complete" | "incomplete" | "skipped" | "failed" | "removed";

export interface FrameReport {
	url: string;
	status: FrameScanStatus;
	reasons: string[];
	/** WF08 addition: which document a provenance entry describes; embedded frames keep discovery order. */
	role?: "main" | "embedded";
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
	/** Confidence caveats from the sampler; never coverage gaps and never part of incompleteReasons. */
	ambiguities: string[];
	/**
	 * WF08 structure of exactly `text`: code point offsets into it, each block carrying the index of
	 * its source frame in `frames`. Bounded; a budget overflow is disclosed through `ambiguities`.
	 */
	blocks: StructureBlock[];
	framesRead: number;
	scrollSteps: number;
	frames: FrameReport[];
}

interface FrameState {
	id: string;
	session: string;
	parent?: string;
	url: string;
	/** loaderId of the committed document, from the frame tree; a new one means new content. */
	loader?: string;
	/** When the committed loader was last identified, used to age out responses from older documents. */
	loaderAt: number;
	context?: number;
	/** Execution context id resolved before the cached one was dropped, for change detection. */
	lastContext?: number;
	generation: number;
	sample?: PageSample;
	chars: number;
	reasons: Set<string>;
	done: boolean;
	status: FrameScanStatus | "active";
	owned: boolean;
	initialized: boolean;
	/** A collector pass ran in the current document's isolated world. */
	collected: boolean;
	initialUrl: string;
	/** Content/layout revision pair observed by the last probe. */
	initialState: string;
	lastRevision: number;
	stableSince: number;
	startedAt: number;
	steps: number;
	budgetSpent: boolean;
	childrenPassed: boolean;
	loaderStale: boolean;
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
const MAX_FRAMES = 24;
const MAX_SESSIONS = 24;
const INITIAL_MAIN_WINDOW_MS = 2000;
const INITIAL_CHILD_WINDOW_MS = 500;
const INITIAL_PROBE_LIMIT_MS = 15_000;
const PENDING_WINDOW_MS = 400;
const STABLE_WINDOW_MS = 2000;
const STEP_PACING_MS = 200;
const GLOBAL_STEP_LIMIT = 160;
const FRAME_STEP_LIMIT = 48;
const FRAME_TIME_LIMIT_MS = 20_000;
const MAIN_NAVIGATION_LIMIT = 8;
/** Bounded end re-verification of frames that already finished. */
const END_CHECK_ROUNDS = 2;
/** browser.ts aborts the whole read at 90s; do not start new verification close to it. */
const END_CHECK_LIMIT_MS = 75_000;
const MAX_STATUS_ENTRIES = 256;
const MAX_URL_CHARS = 2048;

function findTree(tree: FrameTree, frameId: string): FrameTree | undefined {
	if (tree.frame.id === frameId) return tree;
	for (const child of tree.childFrames ?? []) {
		const found = findTree(child, frameId);
		if (found) return found;
	}
}

/** Provenance URLs are bounded and stripped of credentials; they are not a publicness verdict. */
function displayUrl(value: string): string {
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		return url.href.slice(0, MAX_URL_CHARS);
	} catch {
		return value.slice(0, MAX_URL_CHARS);
	}
}

/** Frame-local budget reasons use the frozen frame-prefixed codes. */
function frameReason(reason: string): string {
	return reason === "container_limit" || reason === "node_limit" ? `frame_${reason}` : reason;
}

/** A frame that is gone from the DOM has no current source document to attribute text or status to. */
function frameEntry(frame: FrameState, role: "main" | "embedded"): FrameReport {
	return {
		url: frame.status === "removed" ? "" : displayUrl(frame.url),
		status: frame.status === "active" ? "incomplete" : frame.status,
		reasons: [...frame.reasons],
		role,
	};
}

interface AmbiguityCarrier {
	ambiguities?: unknown;
}

/** Sampling confidence caveats are disclosed separately from coverage gaps. */
function sampleAmbiguities(sample: PageSample | undefined): string[] {
	const value = (sample as AmbiguityCarrier | undefined)?.ambiguities;
	if (!Array.isArray(value)) return [];
	return value.filter((reason): reason is string => typeof reason === "string");
}

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
	/** Full page-text serializations the collector rebuilt; the light path adds none. */
	private serializations = 0;
	/** Frame trees already read in the current driver round; never reused across rounds. */
	private trees = new Map<string, FrameTree>();
	private navigations = 0;
	private truncated = false;
	private stopped = false;
	private startedAt = Date.now();
	/** Page samples evaluated in the browser; exposed as a metric and never used for control flow. */
	private sampleCount = 0;
	/** Latest Document response per frame, kept with the loaderId that produced it. */
	private statuses = new Map<string, { status: number; loader?: string; at: number }>();

	get status(): number {
		return this.statusFor(this.frames.get(this.mainFrame));
	}

	get samples(): number {
		return this.sampleCount;
	}

	get serialized(): number {
		return this.serializations;
	}

	constructor(protocol: Protocol, mainSession: string, signal: AbortSignal) {
		this.protocol = protocol;
		this.mainSession = mainSession;
		this.signal = signal;
	}

	private clearTrees(): void {
		this.trees.clear();
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
		if (this.sessions.size >= MAX_SESSIONS) {
			this.reasons.add("frame_limit");
			return;
		}
		const ready = this.prepare(session).catch(() => {
			if (!this.signal.aborted) this.reasons.add("frame_unavailable");
		});
		// A new session can carry its own frame tree; never serve the previous one.
		this.clearTrees();
		this.sessions.set(targetId, { id: session, parent, ready });
	}

	/** A detached target is not proof that the DOM removed the frame; only the session is dropped. */
	onDetached(session: string): void {
		this.clearTrees();
		for (const [id, value] of this.sessions) if (value.id === session) this.sessions.delete(id);
	}

	onResponse(frameId: string, status: number, loader?: string): void {
		// Hidden auth/tracking frames may fail without affecting document text.
		if (!this.statuses.has(frameId) && this.statuses.size >= MAX_STATUS_ENTRIES) return;
		this.statuses.set(frameId, { status, loader, at: Date.now() });
	}

	private statusFor(frame: FrameState | undefined): number {
		if (!frame) return 0;
		const entry = this.statuses.get(frame.id);
		if (!entry) return 0;
		// A response from a document the frame has not committed to must not describe its content.
		if (entry.loader && frame.loader && entry.loader !== frame.loader) return 0;
		return entry.status;
	}

	/**
	 * The network layer reported a failed document that this frame has not committed to (yet). A
	 * response older than the committed document describes content that was already replaced, so it
	 * is ignored; a newer failure drops the current samples instead of presenting them as current.
	 */
	private syncStatus(frame: FrameState): void {
		const entry = this.statuses.get(frame.id);
		if (!entry?.loader || !frame.loader || entry.loader === frame.loader) return;
		if (entry.status < 400) return;
		if (entry.at < frame.loaderAt) return;
		// The committed loader identity is unchanged: only a commit replaces what this frame shows.
		this.invalidate(frame, "document");
		this.settleFailed(frame, "frame_http_error");
	}

	private createState(id: string, session: string, url: string, parent?: string): FrameState {
		const now = Date.now();
		return {
			id,
			session,
			parent,
			url,
			generation: 0,
			chars: 0,
			reasons: new Set(),
			done: false,
			status: "active",
			owned: false,
			initialized: false,
			collected: false,
			initialUrl: "",
			initialState: "",
			lastRevision: -1,
			loaderAt: 0,
			stableSince: now,
			startedAt: now,
			steps: 0,
			budgetSpent: false,
			childrenPassed: false,
			loaderStale: false,
		};
	}

	/**
	 * The isolated world of one frame/document is stable, so its execution context id is
	 * cached and only re-resolved after this frame's generation was invalidated (new
	 * loader, new session, navigation) or an evaluation proved the cached one destroyed.
	 * The id check stays as strict as before: a re-resolved world that differs from the
	 * last known one still means the document changed under us.
	 */
	private async context(frame: FrameState): Promise<number> {
		if (frame.context !== undefined) return frame.context;
		const result = await this.protocol.call<{ executionContextId: number }>(
			"Page.createIsolatedWorld",
			{ frameId: frame.id, worldName: "pi-web-fetch" },
			frame.session,
		);
		const previous = frame.lastContext;
		frame.context = result.executionContextId;
		frame.lastContext = result.executionContextId;
		// A new isolated world id means the previous execution context was destroyed.
		if (previous !== undefined && previous !== frame.context)
			throw new WebError("Browser frame changed during navigation.", "frame-changed");
		return result.executionContextId;
	}

	private async evaluate<T>(frame: FrameState, expression: string): Promise<T> {
		let contextId: number;
		try {
			contextId = await this.context(frame);
		} catch (error) {
			if (error instanceof WebError && error.code === "frame-changed") frame.context = undefined;
			throw error;
		}
		const result = await this.protocol
			.call<Evaluation<T>>("Runtime.evaluate", { expression, contextId, returnByValue: true }, frame.session)
			.catch((error: unknown) => {
				// A destroyed context is proven by the failed call itself, so the cached id is
				// dropped instead of being re-used by the next evaluation.
				if (error instanceof WebError && error.code === "frame-changed") frame.context = undefined;
				throw error;
			});
		if (result.exceptionDetails || result.result?.value === undefined)
			throw new WebError("Browser page scan failed.");
		return result.result.value;
	}

	/** Every collector evaluation is a page sample; only the ones that rebuilt text serialize. */
	private async collect<T>(frame: FrameState, expression: string): Promise<T> {
		const value = await this.evaluate<T>(frame, expression);
		this.sampleCount++;
		return value;
	}

	private async collectProbe(frame: FrameState, expression: string): Promise<PageProbe> {
		const answer = await this.collect<PageProbe>(frame, expression);
		if (answer.serialized) this.serializations++;
		return answer;
	}

	private async sessionTree(session: string): Promise<FrameTree> {
		const cached = this.trees.get(session);
		if (cached !== undefined) return cached;
		const { frameTree } = await this.protocol.call<{ frameTree: FrameTree }>("Page.getFrameTree", {}, session);
		this.trees.set(session, frameTree);
		return frameTree;
	}

	/** Drop every stored sample and state that belongs to a previous document generation. */
	private invalidate(frame: FrameState, kind: "document" | "url", url?: string): void {
		const hadDocument = frame.sample !== undefined || frame.initialized;
		if (url !== undefined) frame.url = url;
		frame.generation++;
		frame.sample = undefined;
		frame.chars = 0;
		frame.initialized = false;
		frame.collected = false;
		frame.initialUrl = "";
		frame.initialState = "";
		frame.stableSince = Date.now();
		frame.lastRevision = -1;
		frame.childrenPassed = false;
		frame.context = undefined;
		// The previous document's world id is not comparable with the next document's.
		frame.lastContext = undefined;
		frame.steps = 0;
		frame.budgetSpent = false;
		frame.status = "active";
		frame.done = false;
		// A navigation or session change can replace the frame tree of any session.
		this.clearTrees();
		if (kind !== "document") return;
		// A new document replaces the frame's coverage notes and its embedded frames.
		frame.reasons.clear();
		frame.loaderStale = true;
		this.dropDescendants(frame);
		if (frame.id !== this.mainFrame || !hadDocument) return;
		this.reasons.clear();
		if (++this.navigations >= MAIN_NAVIGATION_LIMIT) {
			this.reasons.add("navigation_limit");
			this.stopped = true;
		}
	}

	private dropDescendants(frame: FrameState): void {
		for (const child of [...this.frames.values()]) {
			if (child.parent !== frame.id) continue;
			this.dropDescendants(child);
			child.sample = undefined;
			child.chars = 0;
			child.reasons.clear();
			child.done = false;
			child.status = "removed";
			this.frames.delete(child.id);
		}
	}

	private async treeFor(frame: FrameState): Promise<FrameTree | undefined> {
		return findTree(await this.sessionTree(frame.session), frame.id);
	}

	/** Refresh the committed document identity after a generation change. */
	private async refreshIdentity(frame: FrameState): Promise<void> {
		frame.loaderStale = false;
		try {
			const self = await this.treeFor(frame);
			if (!self) return;
			this.adoptDocument(frame, self.frame);
		} catch (error) {
			this.signal.throwIfAborted();
			if (error instanceof WebError && error.code === "frame-changed") {
				this.invalidate(frame, "document");
				return;
			}
			frame.loaderStale = true;
		}
	}

	/** Adopt the committed loader/url from the frame tree, invalidating samples on a new document. */
	private adoptDocument(frame: FrameState, node: FrameNode): void {
		const loader = node.loaderId;
		if (loader !== undefined && frame.loader !== undefined && loader !== frame.loader) {
			this.invalidate(frame, "document");
			this.setLoader(frame, loader);
			if (node.url) frame.url = node.url;
			return;
		}
		if (loader !== undefined) this.setLoader(frame, loader);
		if (node.url && node.url !== frame.url) this.invalidate(frame, "url", node.url);
	}

	/** A committed loader only re-dates the frame when it is first identified, so older responses age out. */
	private setLoader(frame: FrameState, loader: string): void {
		if (frame.loader === loader) return;
		frame.loader = loader;
		frame.loaderAt = Date.now();
	}

	/**
	 * Wait until the frame's captured content and URL stop changing. The collector's own
	 * content/layout revisions replace the full innerText transfer this probe used to make
	 * on every poll, and only the first probe of a document installs the collector.
	 */
	private async probe(frame: FrameState): Promise<boolean> {
		const answer = await this.collectProbe(frame, frame.collected ? LIGHT_SAMPLE_PAGE : SAMPLE_PAGE);
		frame.collected = true;
		const state = `${answer.contentRevision}:${answer.layoutRevision}`;
		const changed = answer.url !== frame.initialUrl || state !== frame.initialState || !answer.ready;
		if (changed) frame.stableSince = Date.now();
		frame.initialUrl = answer.url;
		frame.initialState = state;
		const stable =
			Date.now() - frame.stableSince >=
			(frame.id === this.mainFrame ? INITIAL_MAIN_WINDOW_MS : INITIAL_CHILD_WINDOW_MS);
		const initialized = stable || Date.now() - frame.startedAt >= INITIAL_PROBE_LIMIT_MS;
		if (initialized) frame.initialized = true;
		return changed || initialized;
	}

	private validStructure(structure: unknown): string | undefined {
		if (structure === undefined) return undefined;
		if (!Array.isArray(structure)) return "structure is not a list";
		if (structure.length > MAX_CAPTURE_BLOCKS) return `structure has ${structure.length} entries`;
		for (const block of structure) {
			if (typeof block !== "object" || block === null) return "structure entry is not an object";
			const value = block as StructureBlock;
			if (typeof value.type !== "string") return "structure entry has no type";
			if (!Number.isInteger(value.start) || !Number.isInteger(value.end))
				return `structure ${value.type} has non-integer offsets`;
			if (value.start < 0 || value.end <= value.start)
				return `structure ${value.type} has offsets ${value.start}..${value.end}`;
		}
		return undefined;
	}

	private validSample(sample: PageSample | undefined): sample is PageSample {
		this.structureFailure = "";
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
			return false;
		// A malformed structure is named with its own bounded shape, never with page text.
		const invalid = this.validStructure(sample.structure);
		if (invalid !== undefined) this.structureFailure = invalid;
		return invalid === undefined;
	}

	/** Bounded shape of the first invalid structure entry, used only for the diagnostic message. */
	private structureFailure = "";

	/** Frame-local notes stay on the frame; only the main document feeds the aggregate reasons. */
	private accountSample(frame: FrameState, sample: PageSample): void {
		const main = frame.id === this.mainFrame;
		for (const reason of sample.incompleteReasons) {
			if (reason === "capture_limit") continue;
			if (main) this.reasons.add(reason);
			else frame.reasons.add(frameReason(reason));
			if (!main && /limit|stalled/.test(reason)) frame.budgetSpent = true;
		}
		if (sample.passwordForm) this.reasons.add("password_form");
	}

	private capturedChars(): number {
		let total = 0;
		for (const frame of this.frames.values()) if (frame.sample) total += frame.chars;
		return total;
	}

	/** `verify` allows re-checking a frame that already settled, without restarting it first. */
	private async sample(frame: FrameState, verify = false): Promise<PageSample | undefined> {
		if (frame.loaderStale) await this.refreshIdentity(frame);
		if (this.stopped) return undefined;
		if (!verify && frame.status !== "active") return undefined;
		const before = frame.status;
		this.syncStatus(frame);
		if (this.stopped || frame.status !== before) return undefined;
		// The driver already holds this frame's text, so the collector may answer with a
		// status-only payload while its own fingerprint of that text is unchanged.
		const carried = frame.sample;
		let answer = await this.collectProbe(frame, carried ? LIGHT_SAMPLE_PAGE : SAMPLE_PAGE);
		if (answer.unchanged) {
			// A status-only answer carries no structure either, so the driver keeps both of its copies.
			answer = carried
				? { ...answer, text: carried.text, structure: carried.structure }
				: await this.collectProbe(frame, SAMPLE_PAGE);
		}
		const sample = answer;
		if (!this.validSample(sample))
			throw new WebError(
				`Browser returned invalid or oversized page text.${this.structureFailure ? ` (${this.structureFailure})` : ""}`,
			);
		if (frame.id === this.mainFrame || !["about:blank", "about:srcdoc"].includes(sample.url))
			publicTarget(sample.url);
		if (sample.url !== frame.url) {
			// Same-document navigation: stored samples and state are no longer current.
			this.invalidate(frame, "url", sample.url);
			return undefined;
		}
		if (this.statusFor(frame) >= 400) {
			this.settleFailed(frame, "frame_http_error");
			return undefined;
		}
		const previous = frame.sample;
		if (!previous || previous.text !== sample.text) frame.chars = Array.from(sample.text).length;
		frame.sample = sample;
		frame.url = sample.url;
		const changed = !previous || previous.revision !== sample.revision || previous.url !== sample.url;
		if (sample.revision !== frame.lastRevision || !sample.ready || sample.busy) frame.stableSince = Date.now();
		frame.lastRevision = sample.revision;
		if (changed) frame.childrenPassed = false;
		this.accountSample(frame, sample);
		if (sample.captureTruncated || this.capturedChars() > MAX_CAPTURE_CHARS) {
			frame.budgetSpent = true;
			this.truncated = true;
			this.reasons.add("capture_limit");
			this.stopped = true;
		}
		if (frame.budgetSpent) {
			this.settleIncomplete(frame);
			return undefined;
		}
		return sample;
	}

	private isSettled(frame: FrameState): boolean {
		return frame.status !== "active";
	}

	private async childrenSettled(parent: FrameState): Promise<boolean> {
		for (const frame of this.frames.values()) {
			if (frame.parent === parent.id && !this.isSettled(frame)) return false;
		}
		return true;
	}

	private settleComplete(frame: FrameState): void {
		frame.done = true;
		frame.status = frame.reasons.size > 0 ? "incomplete" : "complete";
	}

	private settleIncomplete(frame: FrameState, reason?: string): void {
		if (reason !== undefined) {
			frame.reasons.add(reason);
			if (frame.id === this.mainFrame) this.reasons.add(reason);
		}
		frame.done = false;
		frame.status = "incomplete";
	}

	private settleFailed(frame: FrameState, reason: string): void {
		frame.reasons.add(reason);
		frame.sample = undefined;
		frame.chars = 0;
		frame.done = false;
		frame.status = "failed";
	}

	private settleSkipped(frame: FrameState): void {
		frame.sample = undefined;
		frame.chars = 0;
		frame.done = false;
		frame.status = "skipped";
	}

	private settleRemoved(frame: FrameState): void {
		frame.sample = undefined;
		frame.chars = 0;
		frame.done = false;
		frame.status = "removed";
		this.dropDescendants(frame);
	}

	private orderedFrames(): FrameState[] {
		const main = this.frames.get(this.mainFrame);
		return main ? [main, ...[...this.frames.values()].filter((frame) => frame !== main)] : [...this.frames.values()];
	}

	private async discover(parent: FrameState): Promise<Map<string, DiscoveredFrame>> {
		const self = findTree(await this.sessionTree(parent.session), parent.id);
		const children = new Map<string, DiscoveredFrame>();
		for (const child of self?.childFrames ?? []) children.set(child.frame.id, { tree: child, owned: true });
		// Chromium omits OOPIFs from the parent's Page.getFrameTree. Related
		// targets have their own trees; auto-attach alone does not enumerate them.
		for (const attached of this.sessions.values()) {
			if (attached.id === parent.session || (attached.parent && attached.parent !== parent.id)) continue;
			await attached.ready;
			const frameTree = await this.sessionTree(attached.id);
			attached.parent ??= frameTree.frame.parentId;
			if (attached.parent !== parent.id) continue;
			if (!children.has(frameTree.frame.id)) children.set(frameTree.frame.id, { tree: frameTree, owned: false });
		}
		return children;
	}

	private sessionFor(frameId: string, parent: FrameState): string {
		return this.sessions.get(frameId)?.id ?? parent.session;
	}

	/** Returns true when the frame's document identity changed and its samples were invalidated. */
	private updateIdentity(frame: FrameState, discovered: DiscoveredFrame, parent: FrameState): boolean {
		const session = this.sessionFor(frame.id, parent);
		const node = discovered.tree.frame;
		frame.owned = discovered.owned;
		if (session !== frame.session) {
			frame.session = session;
			this.invalidate(frame, "document");
			this.adoptDocument(frame, node);
			return true;
		}
		const loader = node.loaderId;
		if (loader !== undefined && frame.loader !== undefined && loader !== frame.loader) {
			this.invalidate(frame, "document");
			this.adoptDocument(frame, node);
			return true;
		}
		if (loader !== undefined) this.setLoader(frame, loader);
		if (node.url && node.url !== frame.url) {
			this.invalidate(frame, "url", node.url);
			return true;
		}
		return false;
	}

	/** True only when the parent's DOM still owns a frame that enumeration did not list. */
	private async ownedByParent(parent: FrameState, child: FrameState): Promise<boolean> {
		if (child.owned) return false;
		try {
			await this.protocol.call("DOM.getFrameOwner", { frameId: child.id }, parent.session);
			return true;
		} catch (error) {
			this.signal.throwIfAborted();
			if (error instanceof WebError && error.code === "frame-changed") throw error;
			return false;
		}
	}

	private async visible(child: FrameTree, parent: FrameState): Promise<boolean> {
		const { backendNodeId } = await this.protocol.call<{ backendNodeId: number }>(
			"DOM.getFrameOwner",
			{ frameId: child.frame.id },
			parent.session,
		);
		const { object } = await this.protocol.call<{ object: { objectId: string } }>(
			"DOM.resolveNode",
			{ backendNodeId, executionContextId: await this.context(parent) },
			parent.session,
		);
		try {
			const result = await this.protocol.call<Evaluation<boolean>>(
				"Runtime.callFunctionOn",
				{ objectId: object.objectId, functionDeclaration: FRAME_VISIBLE, returnByValue: true },
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

	/** Discover, refresh and settle the parent's child frames. Returns true when children changed. */
	private async enumerateChildren(parent: FrameState): Promise<boolean> {
		let changed = false;
		const discovered = await this.discover(parent);
		if (this.stopped) return changed;
		for (const child of [...this.frames.values()]) {
			if (child.parent !== parent.id || child.status === "removed" || discovered.has(child.id)) continue;
			if (await this.ownedByParent(parent, child)) continue;
			this.settleRemoved(child);
			changed = true;
		}
		for (const entry of discovered.values()) {
			if (this.stopped) break;
			const id = entry.tree.frame.id;
			let frame = this.frames.get(id);
			if (!frame) {
				if (this.frames.size >= MAX_FRAMES) {
					this.reasons.add("frame_limit");
					continue;
				}
				frame = this.createState(id, this.sessionFor(id, parent), entry.tree.frame.url, parent.id);
				if (entry.tree.frame.loaderId !== undefined) this.setLoader(frame, entry.tree.frame.loaderId);
				frame.owned = entry.owned;
				this.frames.set(id, frame);
				changed = true;
			} else if (this.updateIdentity(frame, entry, parent)) {
				changed = true;
			}
			if (frame.status !== "active") continue;
			try {
				if (!(await this.visible(entry.tree, parent))) {
					this.settleSkipped(frame);
					continue;
				}
			} catch (error) {
				this.signal.throwIfAborted();
				if (error instanceof WebError && error.code === "frame-changed") throw error;
				// The frame may still be attaching; keep it active and retry on the next pass.
				frame.reasons.add("frame_unavailable");
				if (Date.now() - frame.startedAt >= FRAME_TIME_LIMIT_MS) this.settleIncomplete(frame);
				continue;
			}
			this.syncStatus(frame);
			if (frame.status !== "active") continue;
			if (this.statusFor(frame) >= 400) {
				this.settleFailed(frame, "frame_http_error");
			}
		}
		return changed;
	}

	private async advance(frame: FrameState): Promise<void> {
		if (this.steps >= GLOBAL_STEP_LIMIT) {
			this.reasons.add("scroll_limit");
			this.stopped = true;
			return;
		}
		if (frame.id !== this.mainFrame && frame.steps >= FRAME_STEP_LIMIT) {
			this.settleIncomplete(frame, "frame_scroll_limit");
			return;
		}
		const advance = await this.evaluate<{ moved: boolean; stalled?: boolean }>(frame, ADVANCE_PAGE);
		if (advance.moved) {
			frame.steps++;
			this.steps++;
		}
		if (advance.stalled) {
			this.settleIncomplete(frame, "scroll_stalled");
			return;
		}
		frame.stableSince = Date.now();
	}

	/**
	 * One short, bounded step for a single frame; the driver gives every active frame turns.
	 * Returns true when this step observed progress (content changed, a frame advanced, a
	 * frame settled or a child set changed), which lets the driver skip its pacing wait.
	 */
	private async step(frame: FrameState): Promise<boolean> {
		if (this.isSettled(frame)) return false;
		try {
			if (frame.id !== this.mainFrame && Date.now() - frame.startedAt >= FRAME_TIME_LIMIT_MS) {
				this.settleIncomplete(frame, "frame_time_limit");
				return true;
			}
			if (!frame.initialized) return await this.probe(frame);
			const previousRevision = frame.lastRevision;
			const sample = await this.sample(frame);
			if (this.stopped) return false;
			// An invalidated, failed or settling sample already changed the frame's state.
			if (!sample || frame.status !== "active") return true;
			// Content and layout that moved in this round are progress: continue without the
			// 200 ms pacing wait, which is kept for rounds that observed nothing.
			if (sample.revision !== previousRevision) return true;
			if (Date.now() - frame.stableSince < (sample.pending ? PENDING_WINDOW_MS : STABLE_WINDOW_MS)) return false;
			if (!frame.childrenPassed) {
				const changed = await this.enumerateChildren(frame);
				if (this.stopped || frame.status !== "active") return changed;
				if (!(await this.childrenSettled(frame))) return changed;
				frame.childrenPassed = true;
				frame.stableSince = Date.now();
				return true;
			}
			if (!sample.pending) {
				this.settleComplete(frame);
				return true;
			}
			await this.advance(frame);
			return true;
		} catch (error) {
			this.signal.throwIfAborted();
			if (error instanceof WebError && (error.code === "cancelled" || error.code === "read-timeout")) throw error;
			if (error instanceof WebError && error.code === "frame-changed") {
				this.invalidate(frame, "document");
				return true;
			}
			if (frame.id !== this.mainFrame) {
				this.settleFailed(frame, "frame_unavailable");
				return true;
			}
			throw error;
		}
	}

	private async settleAll(): Promise<void> {
		while (!this.stopped) {
			const pending = this.orderedFrames().filter((frame) => !this.isSettled(frame));
			if (!pending.length) return;
			// Frame trees read in this round are shared by every frame's discovery pass; a
			// navigation, attach or detach clears them immediately (see invalidate).
			this.clearTrees();
			let progressed = false;
			for (const frame of pending) {
				if (this.stopped) return;
				if (this.frames.get(frame.id) !== frame) continue;
				progressed = (await this.step(frame)) || progressed;
			}
			if (!progressed) await timers.setTimeout(STEP_PACING_MS, undefined, { signal: this.signal });
		}
	}

	/** Restart a frame whose DOM changed after it was already reported as finished. */
	private unsettle(frame: FrameState): void {
		frame.status = "active";
		frame.done = false;
		frame.childrenPassed = false;
		frame.stableSince = Date.now();
		frame.startedAt = Date.now();
	}

	/** Bounded recheck of frames that already finished, so a stale sample is not frozen as final. */
	private async verifySettled(): Promise<boolean> {
		let changed = false;
		this.clearTrees();
		for (const frame of this.orderedFrames()) {
			if (this.stopped) break;
			if (this.signal.aborted) this.signal.throwIfAborted();
			if (this.frames.get(frame.id) !== frame) continue;
			if (!this.isSettled(frame)) {
				changed = true;
				continue;
			}
			try {
				const before = frame.status;
				this.syncStatus(frame);
				if (frame.status !== before) changed = true;
				if (this.isSettled(frame) && (await this.enumerateChildren(frame))) changed = true;
				if (this.stopped) break;
				if (frame.status !== "complete" || !frame.sample) continue;
				const revision = frame.lastRevision;
				const sample = await this.sample(frame, true);
				if (this.stopped || this.frames.get(frame.id) !== frame) break;
				if (!sample) {
					// The sample was invalidated or settled the frame: its coverage changed.
					changed = true;
					continue;
				}
				if (sample.revision === revision) continue;
				// The frame changed after it was reported as done: settle it again within budget.
				this.unsettle(frame);
				changed = true;
			} catch (error) {
				this.signal.throwIfAborted();
				if (error instanceof WebError && error.code === "frame-changed") {
					this.invalidate(frame, "document");
					changed = true;
					continue;
				}
				throw error;
			}
		}
		return changed;
	}

	private endBudgetRemains(): boolean {
		return Date.now() - this.startedAt < END_CHECK_LIMIT_MS;
	}

	async scan(mainFrame: string, url: string): Promise<ScanResult> {
		this.mainFrame = mainFrame;
		this.startedAt = Date.now();
		this.frames.set(mainFrame, this.createState(mainFrame, this.mainSession, url));
		await this.settleAll();
		let rounds = 0;
		let changed = false;
		while (!this.stopped && this.endBudgetRemains() && rounds < END_CHECK_ROUNDS) {
			rounds++;
			changed = await this.verifySettled();
			if (!changed) break;
			await this.settleAll();
		}
		if (changed) this.reasons.add("content_changed_during_scan");
		return this.result();
	}

	result(reason?: string): ScanResult {
		if (reason) this.reasons.add(reason);
		const main = this.frames.get(this.mainFrame);
		const samples = [...this.frames.values()].filter((frame) => frame.sample);
		const ambiguities = new Set<string>();
		for (const frame of this.frames.values()) {
			for (const reason of sampleAmbiguities(frame.sample)) ambiguities.add(reason);
		}
		// Embedded frames come first so a lookup by source URL always finds the frame itself; the
		// main document is reported last, and its settled state is also exposed above.
		const ordered = [...this.frames.values()].filter((frame) => frame !== main);
		if (main) ordered.push(main);
		const entries = ordered.map((frame) => frameEntry(frame, frame === main ? "main" : "embedded"));
		const indexOf = new Map(ordered.map((frame, index) => [frame, index]));
		// One pass builds the capture text and the structure of exactly that text: the same frames,
		// the same order and the same separators the text assembly always used, so text mode is
		// byte-identical and every block offset is a code point offset of the returned capture text.
		const parts: string[] = [];
		const blocks: StructureBlock[] = [];
		let chars = 0;
		let structureTruncated = false;
		for (const frame of samples) {
			const sample = frame.sample!;
			if (!sample.text.trim()) continue;
			const embedded = frame.id !== this.mainFrame;
			const prefix = embedded ? "\n[Embedded frame text]\n" : "";
			if (parts.length) {
				parts.push("\n");
				chars += 1;
			}
			const start = chars + codePointLength(prefix);
			parts.push(prefix, sample.text);
			const frameChars = codePointLength(sample.text);
			chars = start + frameChars;
			const index = indexOf.get(frame) ?? entries.length - 1;
			const clip = (value: number) => Math.max(0, Math.min(value, MAX_CAPTURE_CHARS));
			let ordinal = 0;
			for (const block of sample.structure ?? []) {
				if (blocks.length >= MAX_CAPTURE_BLOCKS) {
					structureTruncated = true;
					break;
				}
				const from = Math.max(0, Math.min(block.start, frameChars));
				const to = Math.max(from, Math.min(block.end, frameChars));
				const blockStart = clip(start + from);
				const blockEnd = clip(start + to);
				if (blockEnd <= blockStart) continue;
				// The frame's own link spans are relative to that frame's text, so they move with it.
				const merged: StructureBlock = {
					...block,
					start: blockStart,
					end: blockEnd,
					frame: index,
					id: `f${index}b${ordinal++}`,
				};
				if (block.links) {
					const links = [];
					for (const link of block.links) {
						const linkStart = clip(start + link.start);
						const linkEnd = clip(start + link.end);
						if (linkEnd <= linkStart) continue;
						links.push({ ...link, start: linkStart, end: linkEnd });
					}
					if (links.length) merged.links = links;
					else delete merged.links;
				}
				blocks.push(merged);
			}
			// An embedded frame is itself a block of the aggregate capture, so a reader can tell where
			// another document's text starts and which frame it came from.
			if (embedded && blocks.length < MAX_CAPTURE_BLOCKS)
				blocks.push({
					type: "frame",
					start: clip(start),
					end: clip(start + frameChars),
					frame: index,
					id: `f${index}frame`,
				});
		}
		if (structureTruncated) ambiguities.add(STRUCTURE_TRUNCATED);
		const text = parts.join("");
		const textChars = Array.from(text);
		const captureTruncated = this.truncated || textChars.length > MAX_CAPTURE_CHARS;
		if (captureTruncated) this.reasons.add("capture_limit");
		let gap = false;
		for (const frame of this.frames.values()) {
			if (frame === main) continue;
			if (frame.status === "incomplete" || frame.status === "failed") gap = true;
		}
		if (gap) this.reasons.add("frame_incomplete");
		return {
			url: main?.sample ? publicUrl(main.sample.url) : "",
			title: main?.sample?.title ?? "",
			text: textChars.slice(0, MAX_CAPTURE_CHARS).join(""),
			captureTruncated,
			stabilized: main?.done === true,
			passwordForm: samples.some((frame) => frame.sample?.passwordForm),
			scanComplete: main?.done === true && this.reasons.size === 0 && samples.every((frame) => frame.done),
			incompleteReasons: [...this.reasons],
			ambiguities: [...ambiguities].sort(),
			blocks,
			framesRead: samples.length,
			scrollSteps: this.steps,
			frames: entries,
		};
	}
}
