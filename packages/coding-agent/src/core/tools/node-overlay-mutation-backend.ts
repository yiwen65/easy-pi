import { randomUUID } from "node:crypto";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
	type EditPlan,
	type EditPlanOperation,
	ExecutionEnvMutationBackend,
	type MutationBackend,
	type MutationCapabilities,
	type MutationCommitResult,
	observeMutationPath,
	V2ToolError,
	validateEditPlan,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const OVERLAY_VERSION = 1;
const DEFAULT_MAX_OVERLAYS = 20;
const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type OverlayState = "copying" | "applying" | "pending" | "accepting" | "accepted" | "discarded";
const OVERLAY_STATES = new Set<OverlayState>(["copying", "applying", "pending", "accepting", "accepted", "discarded"]);

type OverlayManifest = {
	version: 1;
	id: string;
	state: OverlayState;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
	ownerPid: number;
	workspacePath: string;
	plan: EditPlan;
};

export interface OverlayValidationContext {
	id: string;
	workspacePath: string;
	changedPaths: string[];
}

export interface OverlayRecord {
	id: string;
	state: "pending" | "indeterminate";
	workspacePath: string;
	createdAt: number;
	expiresAt: number;
}

export interface NodeOverlayMutationBackendOptions {
	workspaceRoot: string;
	overlayRoot: string;
	acceptBackend?: MutationBackend;
	maxOverlays?: number;
	maxFiles?: number;
	maxBytes?: number;
	ttlMs?: number;
	validate?: (context: OverlayValidationContext, signal?: AbortSignal) => void | Promise<void>;
}

type CopyBudget = { files: number; bytes: number };

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Opt-in reference overlay backend using a private bounded workspace copy.
 * It isolates file mutations but is not an OS sandbox; commands can still access paths outside the copy.
 */
export class NodeOverlayMutationBackend implements MutationBackend {
	readonly id = "node-overlay-mutation-v1";
	readonly capabilities: MutationCapabilities = {
		atomicRenameSameFilesystem: false,
		fsyncFile: false,
		fsyncDirectory: false,
		preserveMode: true,
		detectCrossFilesystem: false,
		durableJournal: false,
	};
	private readonly workspaceRoot: string;
	private readonly overlayRoot: string;
	private readonly acceptBackend: MutationBackend;
	private readonly maxOverlays: number;
	private readonly maxFiles: number;
	private readonly maxBytes: number;
	private readonly ttlMs: number;
	private readonly validateOverlay:
		| ((context: OverlayValidationContext, signal?: AbortSignal) => void | Promise<void>)
		| undefined;
	private readonly busy = new Set<string>();
	private closed = false;

	constructor(options: NodeOverlayMutationBackendOptions) {
		this.workspaceRoot = path.resolve(options.workspaceRoot);
		this.overlayRoot = path.resolve(options.overlayRoot);
		if (isWithin(this.workspaceRoot, this.overlayRoot) || isWithin(this.overlayRoot, this.workspaceRoot)) {
			throw new V2ToolError("EDIT_CONFLICT", "overlayRoot and workspaceRoot must not contain each other.");
		}
		this.acceptBackend =
			options.acceptBackend ?? new ExecutionEnvMutationBackend(new NodeExecutionEnv({ cwd: this.workspaceRoot }));
		this.maxOverlays = options.maxOverlays ?? DEFAULT_MAX_OVERLAYS;
		this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.validateOverlay = options.validate;
	}

	async commit(plan: EditPlan, signal?: AbortSignal): Promise<MutationCommitResult> {
		this.assertOpen();
		validateEditPlan(plan);
		await this.initializeRoot();
		await this.cleanupExpired();
		const records = await this.scan();
		if (records.some((record) => record.state === "indeterminate")) {
			throw new V2ToolError(
				"EDIT_INDETERMINATE",
				"An overlay has an indeterminate accept state. Inspect it before creating another overlay.",
				{ overlayIds: records.filter((record) => record.state === "indeterminate").map((record) => record.id) },
			);
		}
		if (records.filter((record) => record.state === "pending").length >= this.maxOverlays) {
			throw new V2ToolError(
				"EDIT_PLAN_TOO_LARGE",
				`Overlay quota ${this.maxOverlays} is exhausted. Accept or discard one.`,
			);
		}
		for (const observation of plan.observations) this.mapBasePath(observation.path, this.workspaceRoot);
		for (const operation of plan.operations) {
			this.mapBasePath(operation.path, this.workspaceRoot);
			if (operation.kind === "move") this.mapBasePath(operation.to, this.workspaceRoot);
		}

		const id = randomUUID();
		const root = path.join(this.overlayRoot, id);
		const workspacePath = path.join(root, "workspace");
		const now = Date.now();
		const manifest: OverlayManifest = {
			version: OVERLAY_VERSION,
			id,
			state: "copying",
			createdAt: now,
			updatedAt: now,
			expiresAt: now + this.ttlMs,
			ownerPid: process.pid,
			workspacePath,
			plan,
		};
		await mkdir(root, { recursive: true, mode: 0o700 });
		await this.writeManifest(root, manifest);
		try {
			const budget = { files: 0, bytes: 0 };
			await this.copyTree(
				this.workspaceRoot,
				workspacePath,
				budget,
				{
					source: await realpath(this.workspaceRoot),
					destination: workspacePath,
				},
				signal,
			);
			manifest.state = "applying";
			await this.writeManifest(root, manifest);
			const mapped = await this.mapPlanToOverlay(plan, workspacePath, signal);
			const overlayEnv = new NodeExecutionEnv({ cwd: workspacePath });
			try {
				await new ExecutionEnvMutationBackend(overlayEnv).commit(mapped, signal);
			} finally {
				await overlayEnv.cleanup();
			}
			const changedPaths = [
				...new Set(
					plan.operations.flatMap((operation) => [
						operation.path,
						operation.kind === "move" ? operation.to : operation.path,
					]),
				),
			];
			await this.validateOverlay?.({ id, workspacePath, changedPaths }, signal);
			manifest.state = "pending";
			await this.writeManifest(root, manifest);
			return {
				completedOperationIndexes: plan.operations.map((_, index) => index),
				changedPaths,
				createdDirectories: [],
				pendingAcceptance: { id, workspacePath },
			};
		} catch (error) {
			manifest.state = "discarded";
			await this.writeManifest(root, manifest).catch(() => {});
			await rm(root, { recursive: true, force: true }).catch(() => {});
			if (signal?.aborted) throw new V2ToolError("ABORTED", "Overlay preparation was aborted.");
			throw new V2ToolError(
				"EDIT_ROLLED_BACK",
				"Overlay preparation or validation failed. The base workspace was unchanged.",
				{ overlayId: id, recovery: { kind: "inspect_paths", paths: plan.observations.map((item) => item.path) } },
				error instanceof Error ? error : undefined,
			);
		}
	}

	async accept(id: string, signal?: AbortSignal): Promise<MutationCommitResult> {
		return this.withOverlay(id, async (root, manifest) => {
			if (manifest.state !== "pending") {
				throw new V2ToolError("EDIT_INDETERMINATE", `Overlay ${id} is ${manifest.state}, not pending.`);
			}
			manifest.state = "accepting";
			await this.writeManifest(root, manifest);
			try {
				const result = await this.acceptBackend.commit(manifest.plan, signal);
				manifest.state = "accepted";
				await this.writeManifest(root, manifest);
				await rm(root, { recursive: true, force: true }).catch(() => {});
				return result;
			} catch (error) {
				if (
					error instanceof V2ToolError &&
					(error.code === "STALE_FILE" ||
						error.code === "EDIT_ROLLED_BACK" ||
						error.code === "EDIT_PLAN_TOO_LARGE")
				) {
					manifest.state = "pending";
					await this.writeManifest(root, manifest).catch(() => {});
				}
				throw error;
			}
		});
	}

	async discard(id: string): Promise<void> {
		await this.withOverlay(id, async (root, manifest) => {
			if (manifest.state === "accepting") {
				throw new V2ToolError(
					"EDIT_INDETERMINATE",
					`Overlay ${id} may be accepting and cannot be discarded automatically.`,
				);
			}
			manifest.state = "discarded";
			await this.writeManifest(root, manifest);
			await rm(root, { recursive: true, force: true });
		});
	}

	async list(): Promise<OverlayRecord[]> {
		this.assertOpen();
		await this.initializeRoot();
		await this.cleanupExpired();
		return this.scan();
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	private assertOpen(): void {
		if (this.closed) throw new V2ToolError("EDIT_INDETERMINATE", "The overlay backend is closed.");
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) throw new V2ToolError("ABORTED", "Overlay operation was aborted.");
	}

	private async initializeRoot(): Promise<void> {
		await mkdir(this.overlayRoot, { recursive: true, mode: 0o700 });
		await chmod(this.overlayRoot, 0o700);
	}

	private mapBasePath(target: string, destinationRoot: string): string {
		const absolute = path.resolve(target);
		if (!isWithin(this.workspaceRoot, absolute) || absolute === this.workspaceRoot) {
			throw new V2ToolError("OUTSIDE_WORKSPACE", `${target} is outside the overlay workspace root.`);
		}
		return path.join(destinationRoot, path.relative(this.workspaceRoot, absolute));
	}

	private async copyTree(
		source: string,
		destination: string,
		budget: CopyBudget,
		roots: { source: string; destination: string },
		signal?: AbortSignal,
	): Promise<void> {
		this.throwIfAborted(signal);
		const info = await lstat(source);
		budget.files++;
		if (budget.files > this.maxFiles) {
			throw new V2ToolError("EDIT_PLAN_TOO_LARGE", `Workspace exceeds the ${this.maxFiles}-entry overlay quota.`);
		}
		if (info.isDirectory()) {
			await mkdir(destination, { mode: info.mode & 0o7777 });
			for (const entry of await readdir(source)) {
				await this.copyTree(path.join(source, entry), path.join(destination, entry), budget, roots, signal);
			}
			return;
		}
		if (info.isSymbolicLink()) {
			const link = await readlink(source);
			let target = path.resolve(path.dirname(source), link);
			try {
				target = await realpath(source);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ELOOP")))
					throw error;
			}
			// Internal links must lead to the copy, including absolute links and relative
			// links that leave and re-enter the source tree. External links stay external;
			// mutation containment checks below reject their use (this is not a sandbox).
			const mapped = isWithin(roots.source, target)
				? path.join(roots.destination, path.relative(roots.source, target))
				: target;
			await symlink(mapped, destination);
			return;
		}
		if (!info.isFile()) throw new V2ToolError("INVALID_INPUT", `Overlay copy does not support ${source}.`);
		budget.bytes += info.size;
		if (budget.bytes > this.maxBytes) {
			throw new V2ToolError("EDIT_PLAN_TOO_LARGE", `Workspace exceeds the ${this.maxBytes}-byte overlay quota.`);
		}
		await copyFile(source, destination);
		await chmod(destination, info.mode & 0o7777);
	}

	private async assertContainedTarget(root: string, target: string): Promise<void> {
		// Resolve the nearest existing ancestor for creates with missing parents.
		// lstat distinguishes a missing path from a dangling link: an unresolved
		// link must fail closed, not be treated as a new contained directory.
		let ancestor = target;
		try {
			for (;;) {
				try {
					await lstat(ancestor);
					break;
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
					const parent = path.dirname(ancestor);
					if (parent === ancestor) throw error;
					ancestor = parent;
				}
			}
			const canonical = await realpath(ancestor);
			if (isWithin(root, canonical) && (canonical !== root || ancestor !== target)) return;
		} catch (error) {
			throw new V2ToolError(
				"OUTSIDE_WORKSPACE",
				`Cannot establish overlay containment for ${target}.`,
				undefined,
				error instanceof Error ? error : undefined,
			);
		}
		throw new V2ToolError("OUTSIDE_WORKSPACE", `${target} resolves outside the overlay workspace.`);
	}

	private async mapPlanToOverlay(plan: EditPlan, workspacePath: string, signal?: AbortSignal): Promise<EditPlan> {
		const env = new NodeExecutionEnv({ cwd: workspacePath });
		try {
			const operations: EditPlanOperation[] = plan.operations.map((operation) => {
				const mappedPath = this.mapBasePath(operation.path, workspacePath);
				switch (operation.kind) {
					case "create":
					case "update":
						return {
							...operation,
							path: mappedPath,
							parentDirectories: operation.parentDirectories?.map((directory) =>
								this.mapBasePath(directory, workspacePath),
							),
						};
					case "move":
						return {
							...operation,
							path: mappedPath,
							to: this.mapBasePath(operation.to, workspacePath),
							parentDirectories: operation.parentDirectories?.map((directory) =>
								this.mapBasePath(directory, workspacePath),
							),
						};
					case "delete":
						return { ...operation, path: mappedPath };
				}
				throw new V2ToolError("INVALID_INPUT", "Unsupported overlay mutation operation.");
			});
			const mappedObservations = plan.observations.map((observation) =>
				this.mapBasePath(observation.path, workspacePath),
			);
			const targets = new Set(mappedObservations);
			for (const operation of operations) {
				targets.add(operation.path);
				if (operation.kind === "move") targets.add(operation.to);
				for (const directory of "parentDirectories" in operation ? (operation.parentDirectories ?? []) : [])
					targets.add(directory);
			}
			const canonicalRoot = await realpath(workspacePath);
			// Validate every endpoint before even reading observations or starting any
			// mutation. Pathname checks are best effort, not protection against races.
			for (const target of targets) {
				this.throwIfAborted(signal);
				await this.assertContainedTarget(canonicalRoot, target);
			}
			const observations = [];
			for (const mapped of mappedObservations) {
				this.throwIfAborted(signal);
				observations.push((await observeMutationPath(env, mapped, plan.limits.maxFileBytes, signal)).observation);
			}
			return { observations, operations, limits: plan.limits };
		} finally {
			await env.cleanup();
		}
	}

	private async writeManifest(root: string, manifest: OverlayManifest): Promise<void> {
		manifest.updatedAt = Date.now();
		const target = path.join(root, "manifest.json");
		const temporary = `${target}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
		const handle = await open(temporary, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, target);
		const directory = await open(root, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}

	private async readManifest(root: string, expectedId: string): Promise<OverlayManifest> {
		const value = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as OverlayManifest;
		if (
			value.version !== OVERLAY_VERSION ||
			value.id !== expectedId ||
			!OVERLAY_STATES.has(value.state) ||
			typeof value.ownerPid !== "number" ||
			value.workspacePath !== path.join(root, "workspace") ||
			!Array.isArray(value.plan?.observations) ||
			!Array.isArray(value.plan?.operations)
		) {
			throw new Error("Invalid overlay manifest.");
		}
		for (const observation of value.plan.observations) this.mapBasePath(observation.path, this.workspaceRoot);
		for (const operation of value.plan.operations) {
			this.mapBasePath(operation.path, this.workspaceRoot);
			if (operation.kind === "move") this.mapBasePath(operation.to, this.workspaceRoot);
		}
		return value;
	}

	private async scan(): Promise<OverlayRecord[]> {
		const records: OverlayRecord[] = [];
		for (const entry of await readdir(this.overlayRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const root = path.join(this.overlayRoot, entry.name);
			try {
				const manifest = await this.readManifest(root, entry.name);
				if (manifest.state === "pending") {
					records.push({
						id: manifest.id,
						state: "pending",
						workspacePath: manifest.workspacePath,
						createdAt: manifest.createdAt,
						expiresAt: manifest.expiresAt,
					});
				} else if (
					manifest.state === "accepting" ||
					((manifest.state === "copying" || manifest.state === "applying") &&
						this.processIsAlive(manifest.ownerPid))
				) {
					records.push({
						id: manifest.id,
						state: "indeterminate",
						workspacePath: manifest.workspacePath,
						createdAt: manifest.createdAt,
						expiresAt: manifest.expiresAt,
					});
				} else {
					await rm(root, { recursive: true, force: true });
				}
			} catch {
				records.push({ id: entry.name, state: "indeterminate", workspacePath: "", createdAt: 0, expiresAt: 0 });
			}
		}
		return records;
	}

	private processIsAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return error instanceof Error && "code" in error && error.code !== "ESRCH";
		}
	}

	private async cleanupExpired(): Promise<void> {
		const now = Date.now();
		for (const record of await this.scan()) {
			if (record.state === "pending" && record.expiresAt <= now) await this.discard(record.id);
		}
	}

	private async withOverlay<T>(
		id: string,
		operation: (root: string, manifest: OverlayManifest) => Promise<T>,
	): Promise<T> {
		this.assertOpen();
		if (!/^[0-9a-f-]{36}$/i.test(id)) throw new V2ToolError("INVALID_INPUT", "Invalid overlay ID.");
		if (this.busy.has(id)) throw new V2ToolError("EDIT_CONFLICT", `Overlay ${id} is already in use.`);
		this.busy.add(id);
		try {
			const root = path.join(this.overlayRoot, id);
			let manifest: OverlayManifest;
			try {
				manifest = await this.readManifest(root, id);
			} catch (error) {
				throw new V2ToolError(
					"NOT_FOUND",
					`Overlay ${id} is unavailable.`,
					undefined,
					error instanceof Error ? error : undefined,
				);
			}
			return await operation(root, manifest);
		} finally {
			this.busy.delete(id);
		}
	}
}
