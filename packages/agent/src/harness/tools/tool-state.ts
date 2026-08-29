import type { ExecutionEnv, FileInfo } from "../types.ts";
import type { EditPlan } from "./mutation-core.ts";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_LOCATORS = 200;
const DEFAULT_MAX_VIEWS = 100;
const DEFAULT_MAX_PATCHES = 50;

export interface ToolFileVersion {
	identity?: string;
	size: number;
	mtimeMs: number;
	mode?: number;
}

export interface ToolLocator {
	id: string;
	scopeId: string;
	snapshotId: string;
	path: string;
	kind: "text" | "file";
	startLine?: number;
	endLine?: number;
	startColumn?: number;
	endColumn?: number;
	byteOffset?: number;
	lineLengthBytes?: number;
	match?: string;
	matchKind?: string;
	enclosingSymbol?: string;
	nodeKind?: string;
	nodeId?: string;
	fileClass?: string;
	rankReasons?: string[];
	fileVersion?: ToolFileVersion;
}

export interface ToolView {
	id: string;
	scopeId: string;
	snapshotId: string;
	locatorId?: string;
	path: string;
	range: [number, number];
	lines: string[];
	fileVersion: ToolFileVersion;
	fileHash?: string;
	editable: boolean;
	byteRange?: [number, number];
}

export interface ToolPatch {
	id: string;
	scopeId: string;
	plan: EditPlan;
	data: unknown;
}

export interface ToolStateEvidence {
	locators: ToolLocator[];
	views: Array<Omit<ToolView, "lines">>;
	patches: Array<{
		id: string;
		scopeId: string;
		operations: Array<{ kind: EditPlan["operations"][number]["kind"]; path: string; to?: string }>;
	}>;
}

type Stored<T> = { value: T; expiresAt: number };

export function fileVersion(info: FileInfo): ToolFileVersion {
	return {
		identity: info.identity,
		size: info.size,
		mtimeMs: info.mtimeMs,
		mode: info.mode,
	};
}

export function sameFileVersion(left: ToolFileVersion, right: ToolFileVersion): boolean {
	return (
		left.identity === right.identity &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.mode === right.mode
	);
}

/** Short-lived runtime state for locator → view handoff. It stores only bounded metadata and selected view lines. */
export class ToolStateLedger {
	private readonly ttlMs: number;
	private readonly maxLocators: number;
	private readonly maxViews: number;
	private readonly maxPatches: number;
	private readonly locators = new Map<string, Stored<ToolLocator>>();
	private readonly views = new Map<string, Stored<ToolView>>();
	private readonly patches = new Map<string, Stored<ToolPatch>>();
	private sequence = 0;

	constructor(options: { ttlMs?: number; maxLocators?: number; maxViews?: number; maxPatches?: number } = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.maxLocators = options.maxLocators ?? DEFAULT_MAX_LOCATORS;
		this.maxViews = options.maxViews ?? DEFAULT_MAX_VIEWS;
		this.maxPatches = options.maxPatches ?? DEFAULT_MAX_PATCHES;
	}

	addLocator(locator: Omit<ToolLocator, "id">): ToolLocator {
		this.prune();
		for (const [id, stored] of this.locators) {
			const previous = stored.value;
			if (
				previous.scopeId === locator.scopeId &&
				previous.path === locator.path &&
				previous.startLine === locator.startLine &&
				previous.endLine === locator.endLine &&
				previous.startColumn === locator.startColumn &&
				previous.matchKind === locator.matchKind
			) {
				this.locators.delete(id);
			}
		}
		const value = { ...locator, id: this.id("loc") };
		this.locators.set(value.id, { value, expiresAt: Date.now() + this.ttlMs });
		this.trim(this.locators, this.maxLocators);
		return value;
	}

	getLocator(id: string, scopeId: string): ToolLocator | undefined {
		this.prune();
		const stored = this.locators.get(id);
		return stored?.value.scopeId === scopeId ? stored.value : undefined;
	}

	removeLocator(id: string): void {
		this.locators.delete(id);
	}

	addView(view: Omit<ToolView, "id">): ToolView {
		this.prune();
		for (const [id, stored] of this.views) {
			const previous = stored.value;
			if (
				previous.scopeId === view.scopeId &&
				previous.path === view.path &&
				previous.range[0] === view.range[0] &&
				previous.range[1] === view.range[1]
			) {
				this.views.delete(id);
			}
		}
		const value = { ...view, id: this.id("view") };
		this.views.set(value.id, { value, expiresAt: Date.now() + this.ttlMs });
		this.trim(this.views, this.maxViews);
		return value;
	}

	getView(id: string, scopeId: string): ToolView | undefined {
		this.prune();
		const stored = this.views.get(id);
		return stored?.value.scopeId === scopeId ? stored.value : undefined;
	}

	addPatch(patch: Omit<ToolPatch, "id">): ToolPatch {
		this.prune();
		const value = { ...patch, id: this.id("patch") };
		this.patches.set(value.id, { value, expiresAt: Date.now() + this.ttlMs });
		this.trim(this.patches, this.maxPatches);
		return value;
	}

	takePatch(id: string, scopeId: string): ToolPatch | undefined {
		this.prune();
		const stored = this.patches.get(id);
		if (stored?.value.scopeId !== scopeId) return undefined;
		this.patches.delete(id);
		return stored.value;
	}

	invalidatePaths(paths: readonly string[], identities: readonly string[] = []): void {
		this.prune();
		const changed = new Set(paths);
		const changedIdentities = new Set(identities);
		for (const [id, stored] of this.locators) {
			if (
				changed.has(stored.value.path) ||
				(stored.value.fileVersion?.identity !== undefined &&
					changedIdentities.has(stored.value.fileVersion.identity))
			) {
				this.locators.delete(id);
			}
		}
		for (const [id, stored] of this.views) {
			if (
				changed.has(stored.value.path) ||
				(stored.value.fileVersion.identity !== undefined &&
					changedIdentities.has(stored.value.fileVersion.identity))
			) {
				this.views.delete(id);
			}
		}
		for (const [id, stored] of this.patches) {
			const touchesChangedPath = stored.value.plan.operations.some(
				(operation) => changed.has(operation.path) || (operation.kind === "move" && changed.has(operation.to)),
			);
			const observesChangedIdentity = stored.value.plan.observations.some(
				(observation) => observation.identity !== undefined && changedIdentities.has(observation.identity),
			);
			if (touchesChangedPath || observesChangedIdentity) this.patches.delete(id);
		}
	}

	getEvidence(): ToolStateEvidence {
		this.prune();
		return {
			locators: [...this.locators.values()].map((stored) => ({ ...stored.value })),
			views: [...this.views.values()].map(({ value: { lines: _lines, ...view } }) => ({ ...view })),
			patches: [...this.patches.values()].map(({ value }) => ({
				id: value.id,
				scopeId: value.scopeId,
				operations: value.plan.operations.map((operation) => ({
					kind: operation.kind,
					path: operation.path,
					to: operation.kind === "move" ? operation.to : undefined,
				})),
			})),
		};
	}

	clear(): void {
		this.locators.clear();
		this.views.clear();
		this.patches.clear();
	}

	async close(): Promise<void> {
		this.clear();
	}

	private id(prefix: "loc" | "view" | "patch"): string {
		return `${prefix}_${Date.now().toString(36)}_${(this.sequence++).toString(36)}`;
	}

	private prune(): void {
		const now = Date.now();
		for (const [id, stored] of this.locators) if (stored.expiresAt <= now) this.locators.delete(id);
		for (const [id, stored] of this.views) if (stored.expiresAt <= now) this.views.delete(id);
		for (const [id, stored] of this.patches) if (stored.expiresAt <= now) this.patches.delete(id);
	}

	private trim<T>(map: Map<string, Stored<T>>, limit: number): void {
		while (map.size > limit) {
			const oldest = map.keys().next().value;
			if (oldest === undefined) break;
			map.delete(oldest);
		}
	}
}

const fallbackLedgers = new WeakMap<ExecutionEnv, ToolStateLedger>();

export function resolveToolState(context: { env: ExecutionEnv; toolState?: ToolStateLedger }): ToolStateLedger {
	if (context.toolState) return context.toolState;
	let ledger = fallbackLedgers.get(context.env);
	if (!ledger) {
		ledger = new ToolStateLedger();
		fallbackLedgers.set(context.env, ledger);
	}
	return ledger;
}
