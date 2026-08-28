import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
	type EditPlan,
	type FileObservation,
	type MutationBackend,
	type MutationCapabilities,
	type MutationCommitResult,
	V2ToolError,
	validateEditPlan,
} from "@earendil-works/pi-agent-core";

const MANIFEST_VERSION = 1;
const DEFAULT_MAX_TRANSACTIONS = 100;
const DEFAULT_MAX_JOURNAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_FILE = "mutation.lock";
const LOCK_INITIALIZATION_GRACE_MS = 30_000;

type JournalState =
	| "planned"
	| "staged"
	| "originals_secured"
	| "installing"
	| "committed"
	| "cleanup_complete"
	| "rollback_started"
	| "rollback_complete"
	| "indeterminate";

const JOURNAL_STATES = new Set<JournalState>([
	"planned",
	"staged",
	"originals_secured",
	"installing",
	"committed",
	"cleanup_complete",
	"rollback_started",
	"rollback_complete",
	"indeterminate",
]);

export type JournalFailurePoint =
	| `after_state:${JournalState}`
	| `after_install:${number}`
	| "before_payload_write"
	| "before_install_fsync"
	| "before_install_directory_fsync"
	| "before_install_rename"
	| "before_cleanup";

type StateDescriptor = {
	exists: boolean;
	hash?: string;
	size: number;
	mode?: number;
};

type JournalEntry = {
	path: string;
	initial: StateDescriptor;
	final: StateDescriptor;
	stageFile?: string;
	backupFile?: string;
};

type JournalManifest = {
	version: 1;
	id: string;
	state: JournalState;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
	entries: JournalEntry[];
	parentDirectories: string[];
};

type LoadedState = StateDescriptor & { bytes?: Buffer; identity?: string; mtimeMs?: number };

type LockHandle = { token: string; release(): Promise<void> };

export interface NodeJournaledMutationBackendOptions {
	workspaceRoot: string;
	journalRoot: string;
	maxTransactions?: number;
	maxJournalBytes?: number;
	ttlMs?: number;
	failureInjector?: (point: JournalFailurePoint, transactionRoot: string) => void | Promise<void>;
}

export interface JournalRecoveryResult {
	recovered: string[];
	cleaned: string[];
	indeterminate: string[];
}

function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function descriptor(state: LoadedState): StateDescriptor {
	return { exists: state.exists, hash: state.hash, size: state.size, mode: state.mode };
}

function statesEqual(left: StateDescriptor, right: StateDescriptor): boolean {
	return (
		left.exists === right.exists && left.hash === right.hash && left.size === right.size && left.mode === right.mode
	);
}

function pathDepth(value: string): number {
	return value.split(path.sep).length;
}

function isStateDescriptor(value: unknown): value is StateDescriptor {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.exists === "boolean" &&
		Number.isSafeInteger(candidate.size) &&
		(candidate.size as number) >= 0 &&
		(candidate.exists ? typeof candidate.hash === "string" : candidate.hash === undefined) &&
		(candidate.mode === undefined || (Number.isSafeInteger(candidate.mode) && (candidate.mode as number) >= 0))
	);
}

/**
 * Opt-in local Darwin/Unix journal backend with fail-closed crash recovery.
 * Individual installs are atomic renames; the backend does not claim cross-file atomic visibility.
 */
export class NodeJournaledMutationBackend implements MutationBackend {
	readonly id = "node-journaled-mutation-v1";
	readonly capabilities: MutationCapabilities = {
		atomicRenameSameFilesystem: true,
		fsyncFile: true,
		fsyncDirectory: true,
		preserveMode: true,
		detectCrossFilesystem: true,
		durableJournal: true,
	};
	private readonly workspaceRoot: string;
	private readonly journalRoot: string;
	private readonly maxTransactions: number;
	private readonly maxJournalBytes: number;
	private readonly ttlMs: number;
	private readonly failureInjector:
		| ((point: JournalFailurePoint, transactionRoot: string) => void | Promise<void>)
		| undefined;
	private closed = false;

	constructor(options: NodeJournaledMutationBackendOptions) {
		if (process.platform === "win32") {
			throw new V2ToolError(
				"EDIT_MOVE_NOT_SUPPORTED",
				"Durable journaled mutation is supported only on explicitly configured Darwin/Unix hosts.",
			);
		}
		this.workspaceRoot = path.resolve(options.workspaceRoot);
		this.journalRoot = path.resolve(options.journalRoot);
		this.maxTransactions = options.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS;
		this.maxJournalBytes = options.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.failureInjector = options.failureInjector;
	}

	async commit(plan: EditPlan, signal?: AbortSignal): Promise<MutationCommitResult> {
		this.assertOpen();
		validateEditPlan(plan);
		await this.initializeRoot();
		const lock = await this.acquireLock();
		try {
			const recovery = await this.recoverUnlocked();
			if (recovery.indeterminate.length > 0) {
				throw this.indeterminateError(recovery.indeterminate, "Existing journal transactions need inspection.");
			}
			this.throwIfAborted(signal);
			const initial = await this.loadAndVerifyInitial(plan.observations, signal);
			const final = this.simulateFinalStates(plan, initial);
			const transactionId = randomUUID();
			const manifest = this.createManifest(transactionId, plan, initial, final);
			const estimatedBytes =
				[...initial.values()].reduce((total, state) => total + state.size, 0) +
				[...final.values()].reduce((total, state) => total + state.size, 0) +
				Buffer.byteLength(JSON.stringify(manifest)) * 2;
			await this.enforceQuota(estimatedBytes);
			const transactionRoot = path.join(this.journalRoot, transactionId);
			await mkdir(path.join(transactionRoot, "stages"), { recursive: true, mode: 0o700 });
			await mkdir(path.join(transactionRoot, "backups"), { recursive: true, mode: 0o700 });
			await this.fsyncDirectory(transactionRoot);
			await this.fsyncDirectory(this.journalRoot);
			let committedResult: MutationCommitResult | undefined;
			try {
				await this.persistState(transactionRoot, manifest, "planned");
				await this.writeJournalPayloads(transactionRoot, manifest, initial, final, signal);
				await this.persistState(transactionRoot, manifest, "staged");
				await this.persistState(transactionRoot, manifest, "originals_secured");
				await this.persistState(transactionRoot, manifest, "installing");
				await this.installFinalStates(transactionRoot, manifest, signal);
				await this.persistState(transactionRoot, manifest, "committed");
				committedResult = {
					completedOperationIndexes: plan.operations.map((_, index) => index),
					changedPaths: [
						...new Set(
							plan.operations.flatMap((operation) => [
								operation.path,
								operation.kind === "move" ? operation.to : operation.path,
							]),
						),
					],
					createdDirectories: manifest.parentDirectories,
				};
				await this.persistState(transactionRoot, manifest, "cleanup_complete");
				await this.removeTransaction(transactionRoot, manifest);
				return committedResult;
			} catch (error) {
				if (manifest.state === "committed" || manifest.state === "cleanup_complete") {
					await this.removeTransaction(transactionRoot, manifest).catch(() => {});
					return (
						committedResult ?? {
							completedOperationIndexes: plan.operations.map((_, index) => index),
							changedPaths: manifest.entries.map((entry) => entry.path),
							createdDirectories: manifest.parentDirectories,
						}
					);
				}
				if (manifest.state === "planned" || manifest.state === "staged" || manifest.state === "originals_secured") {
					await this.removeTransaction(transactionRoot, manifest).catch(() => {});
					throw new V2ToolError(
						"EDIT_ROLLED_BACK",
						"Journal preparation failed before workspace installation. No files were changed.",
						{ recovery: { kind: "inspect_paths", paths: manifest.entries.map((entry) => entry.path) } },
						error instanceof Error ? error : undefined,
					);
				}
				try {
					await this.rollback(transactionRoot, manifest, signal);
					await this.removeTransaction(transactionRoot, manifest);
					throw new V2ToolError(
						"EDIT_ROLLED_BACK",
						"Journaled commit failed and the original file states were restored.",
						{ recovery: { kind: "inspect_paths", paths: manifest.entries.map((entry) => entry.path) } },
						error instanceof Error ? error : undefined,
					);
				} catch (rollbackError) {
					if (rollbackError instanceof V2ToolError && rollbackError.code === "EDIT_ROLLED_BACK")
						throw rollbackError;
					if (manifest.state === "rollback_complete") {
						await this.removeTransaction(transactionRoot, manifest).catch(() => {});
						throw new V2ToolError(
							"EDIT_ROLLED_BACK",
							"Journaled commit failed and durable rollback completed.",
							{ recovery: { kind: "inspect_paths", paths: manifest.entries.map((entry) => entry.path) } },
							rollbackError instanceof Error ? rollbackError : undefined,
						);
					}
					throw this.indeterminateError(
						[transactionId],
						"Rollback could not be confirmed. Unknown external state was not overwritten.",
						rollbackError,
					);
				}
			}
		} finally {
			await lock.release();
		}
	}

	async recover(): Promise<JournalRecoveryResult> {
		this.assertOpen();
		await this.initializeRoot();
		const lock = await this.acquireLock();
		try {
			return await this.recoverUnlocked();
		} finally {
			await lock.release();
		}
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	private assertOpen(): void {
		if (this.closed) throw new V2ToolError("EDIT_INDETERMINATE", "The journal backend is closed.");
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) throw new V2ToolError("ABORTED", "Journaled edit was aborted.");
	}

	private assertTargetPath(target: string): void {
		const absolute = path.resolve(target);
		const journalRelative = path.relative(this.journalRoot, absolute);
		if (
			journalRelative === "" ||
			(!journalRelative.startsWith(`..${path.sep}`) && journalRelative !== ".." && !path.isAbsolute(journalRelative))
		) {
			throw new V2ToolError("EDIT_CONFLICT", `${target} overlaps the private journal root.`);
		}
		const relative = path.relative(this.workspaceRoot, absolute);
		if (
			relative === "" ||
			(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
		) {
			return;
		}
		throw new V2ToolError("OUTSIDE_WORKSPACE", `${target} is outside the journal backend workspace root.`);
	}

	private async initializeRoot(): Promise<void> {
		await mkdir(this.workspaceRoot, { recursive: true });
		await mkdir(this.journalRoot, { recursive: true, mode: 0o700 });
		await chmod(this.journalRoot, 0o700);
	}

	private async fsyncFile(file: string): Promise<void> {
		const handle = await open(file, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async fsyncDirectory(directory: string): Promise<void> {
		const handle = await open(directory, constants.O_RDONLY);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async atomicWriteJson(file: string, value: unknown): Promise<void> {
		const temporary = `${file}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		await this.fsyncFile(temporary);
		await rename(temporary, file);
		await this.fsyncDirectory(path.dirname(file));
	}

	private async acquireLock(): Promise<LockHandle> {
		const lockPath = path.join(this.journalRoot, LOCK_FILE);
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = randomUUID();
			try {
				const handle = await open(lockPath, "wx", 0o600);
				try {
					await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`);
					await handle.sync();
				} finally {
					await handle.close();
				}
				await this.fsyncDirectory(this.journalRoot);
				return {
					token,
					release: async () => {
						try {
							const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
							if (current.token === token) await rm(lockPath, { force: true });
						} catch {}
						await this.fsyncDirectory(this.journalRoot).catch(() => {});
					},
				};
			} catch (error) {
				if (!isNodeError(error) || error.code !== "EEXIST") throw error;
				let pid: number | undefined;
				let lockAge = 0;
				try {
					const existing = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
					if (typeof existing.pid === "number") pid = existing.pid;
				} catch {}
				try {
					lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
				} catch {}
				if (pid !== undefined && this.processIsAlive(pid)) {
					throw new V2ToolError("EDIT_CONFLICT", `Journal root is locked by active process ${pid}.`);
				}
				if (pid === undefined && lockAge < LOCK_INITIALIZATION_GRACE_MS) {
					throw new V2ToolError("EDIT_CONFLICT", "Journal lock initialization is still in progress.");
				}
				await rm(lockPath, { force: true });
			}
		}
		throw new V2ToolError("EDIT_CONFLICT", "Could not acquire the journal recovery lock.");
	}

	private processIsAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return isNodeError(error) && error.code !== "ESRCH";
		}
	}

	private async loadState(target: string): Promise<LoadedState> {
		this.assertTargetPath(target);
		try {
			const info = await lstat(target);
			if (!info.isFile()) throw new V2ToolError("NOT_A_FILE", `${target} is not a regular file.`);
			const bytes = await readFile(target);
			return {
				exists: true,
				hash: hash(bytes),
				size: bytes.byteLength,
				mode: info.mode & 0o7777,
				identity: `${info.dev}:${info.ino}`,
				mtimeMs: info.mtimeMs,
				bytes,
			};
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return { exists: false, size: 0 };
			throw error;
		}
	}

	private observationMatches(observation: FileObservation, current: LoadedState): boolean {
		return (
			observation.exists === current.exists &&
			observation.contentHash === current.hash &&
			observation.size === current.size &&
			(observation.identity === undefined || observation.identity === current.identity) &&
			(observation.mtimeMs === undefined || observation.mtimeMs === current.mtimeMs) &&
			(observation.mode === undefined || observation.mode === current.mode)
		);
	}

	private async loadAndVerifyInitial(
		observations: FileObservation[],
		signal?: AbortSignal,
	): Promise<Map<string, LoadedState>> {
		const states = new Map<string, LoadedState>();
		for (const observation of observations) {
			this.throwIfAborted(signal);
			this.assertTargetPath(observation.path);
			if (observation.exists && typeof observation.contentHash !== "string") {
				throw new V2ToolError("INVALID_INPUT", `Existing observation for ${observation.path} has no content hash.`);
			}
			const current = await this.loadState(observation.path);
			if (!this.observationMatches(observation, current)) {
				throw new V2ToolError(
					"STALE_FILE",
					"A file changed after the edit was planned. No files were changed by this call.",
					{ paths: [observation.path], recovery: { kind: "read_again", paths: [observation.path] } },
				);
			}
			states.set(observation.path, current);
		}
		return states;
	}

	private simulateFinalStates(plan: EditPlan, initial: Map<string, LoadedState>): Map<string, LoadedState> {
		for (const operation of plan.operations) {
			if (!initial.has(operation.path) || (operation.kind === "move" && !initial.has(operation.to))) {
				throw new V2ToolError(
					"INVALID_INPUT",
					"Journaled mutation requires an initial observation for every source and destination path.",
				);
			}
		}
		const states = new Map<string, LoadedState>(
			[...initial].map(([target, state]) => [target, { ...state, bytes: state.bytes && Buffer.from(state.bytes) }]),
		);
		const createdMode = 0o666 & ~process.umask();
		for (const operation of plan.operations) {
			this.assertTargetPath(operation.path);
			switch (operation.kind) {
				case "create":
				case "update": {
					const bytes = Buffer.from(operation.content, "utf8");
					const previous = states.get(operation.path);
					states.set(operation.path, {
						exists: true,
						hash: hash(bytes),
						size: bytes.byteLength,
						mode: previous?.exists ? previous.mode : createdMode,
						bytes,
					});
					break;
				}
				case "move": {
					this.assertTargetPath(operation.to);
					const source = states.get(operation.path);
					if (!source?.exists || !source.bytes)
						throw new V2ToolError("STALE_FILE", `${operation.path} is unavailable.`);
					states.set(operation.path, { exists: false, size: 0 });
					states.set(operation.to, { ...source, bytes: Buffer.from(source.bytes) });
					break;
				}
				case "delete":
					states.set(operation.path, { exists: false, size: 0 });
					break;
			}
		}
		return states;
	}

	private createManifest(
		id: string,
		plan: EditPlan,
		initial: Map<string, LoadedState>,
		final: Map<string, LoadedState>,
	): JournalManifest {
		const targets = [...new Set([...initial.keys(), ...final.keys()])].sort();
		const parentDirectories = [
			...new Set(
				plan.operations.flatMap((operation) =>
					"parentDirectories" in operation ? (operation.parentDirectories ?? []) : [],
				),
			),
		]
			.map((directory) => path.resolve(directory))
			.sort((left, right) => pathDepth(left) - pathDepth(right));
		for (const directory of parentDirectories) this.assertTargetPath(directory);
		const now = Date.now();
		return {
			version: MANIFEST_VERSION,
			id,
			state: "planned",
			createdAt: now,
			updatedAt: now,
			expiresAt: now + this.ttlMs,
			entries: targets.map((target, index) => {
				const before = initial.get(target) ?? { exists: false, size: 0 };
				const after = final.get(target) ?? { exists: false, size: 0 };
				return {
					path: target,
					initial: descriptor(before),
					final: descriptor(after),
					backupFile: before.exists ? `backups/${index}.bin` : undefined,
					stageFile: after.exists ? `stages/${index}.bin` : undefined,
				};
			}),
			parentDirectories,
		};
	}

	private async persistState(transactionRoot: string, manifest: JournalManifest, state: JournalState): Promise<void> {
		manifest.state = state;
		manifest.updatedAt = Date.now();
		await this.atomicWriteJson(path.join(transactionRoot, "manifest.json"), manifest);
		await this.failureInjector?.(`after_state:${state}`, transactionRoot);
	}

	private async writeJournalPayloads(
		transactionRoot: string,
		manifest: JournalManifest,
		initial: Map<string, LoadedState>,
		final: Map<string, LoadedState>,
		signal?: AbortSignal,
	): Promise<void> {
		for (const entry of manifest.entries) {
			this.throwIfAborted(signal);
			if (entry.backupFile) {
				await this.failureInjector?.("before_payload_write", transactionRoot);
				const bytes = initial.get(entry.path)?.bytes;
				if (!bytes) throw new Error(`Missing backup bytes for ${entry.path}`);
				const file = path.join(transactionRoot, entry.backupFile);
				await writeFile(file, bytes, { mode: 0o600 });
				await this.fsyncFile(file);
			}
			if (entry.stageFile) {
				await this.failureInjector?.("before_payload_write", transactionRoot);
				const bytes = final.get(entry.path)?.bytes;
				if (!bytes) throw new Error(`Missing staged bytes for ${entry.path}`);
				const file = path.join(transactionRoot, entry.stageFile);
				await writeFile(file, bytes, { mode: 0o600 });
				await this.fsyncFile(file);
			}
		}
		await this.fsyncDirectory(path.join(transactionRoot, "backups"));
		await this.fsyncDirectory(path.join(transactionRoot, "stages"));
	}

	private async installFinalStates(
		transactionRoot: string,
		manifest: JournalManifest,
		signal?: AbortSignal,
	): Promise<void> {
		for (let index = 0; index < manifest.entries.length; index++) {
			this.throwIfAborted(signal);
			const entry = manifest.entries[index];
			const current = descriptor(await this.loadState(entry.path));
			if (!statesEqual(current, entry.initial) && !statesEqual(current, entry.final)) {
				await this.persistState(transactionRoot, manifest, "indeterminate");
				throw this.indeterminateError([manifest.id], `External modification detected at ${entry.path}.`);
			}
			if (!statesEqual(current, entry.final))
				await this.installState(transactionRoot, manifest.id, index, entry, "final");
			await this.failureInjector?.(`after_install:${index}`, transactionRoot);
		}
	}

	private async installState(
		transactionRoot: string,
		transactionId: string,
		index: number,
		entry: JournalEntry,
		which: "initial" | "final",
	): Promise<void> {
		const state = entry[which];
		const payload = which === "initial" ? entry.backupFile : entry.stageFile;
		const parent = path.dirname(entry.path);
		await mkdir(parent, { recursive: true });
		if (!state.exists) {
			await rm(entry.path, { force: true });
			await this.fsyncDirectory(parent);
			return;
		}
		if (!payload) throw new Error(`Journal payload is missing for ${entry.path}`);
		const bytes = await readFile(path.join(transactionRoot, payload));
		if (hash(bytes) !== state.hash || bytes.byteLength !== state.size) {
			throw this.indeterminateError([transactionId], `Journal payload verification failed for ${entry.path}.`);
		}
		const temporary = path.join(parent, `.pi-journal-${transactionId}-${index}.tmp`);
		await writeFile(temporary, bytes, { mode: 0o600 });
		if (state.mode !== undefined) await chmod(temporary, state.mode);
		await this.failureInjector?.("before_install_fsync", transactionRoot);
		await this.fsyncFile(temporary);
		await this.failureInjector?.("before_install_rename", transactionRoot);
		await rename(temporary, entry.path);
		await this.failureInjector?.("before_install_directory_fsync", transactionRoot);
		await this.fsyncDirectory(parent);
	}

	private async rollback(transactionRoot: string, manifest: JournalManifest, signal?: AbortSignal): Promise<void> {
		if (manifest.state !== "rollback_started") await this.persistState(transactionRoot, manifest, "rollback_started");
		for (const entry of manifest.entries) {
			this.throwIfAborted(signal);
			const current = descriptor(await this.loadState(entry.path));
			if (!statesEqual(current, entry.initial) && !statesEqual(current, entry.final)) {
				await this.persistState(transactionRoot, manifest, "indeterminate");
				throw this.indeterminateError([manifest.id], `External modification detected at ${entry.path}.`);
			}
		}
		for (let index = 0; index < manifest.entries.length; index++) {
			const entry = manifest.entries[index];
			const current = descriptor(await this.loadState(entry.path));
			if (!statesEqual(current, entry.initial))
				await this.installState(transactionRoot, manifest.id, index, entry, "initial");
		}
		for (const directory of [...manifest.parentDirectories].sort(
			(left, right) => pathDepth(right) - pathDepth(left),
		)) {
			await rmdir(directory).catch((error) => {
				if (
					!isNodeError(error) ||
					(error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST")
				) {
					throw error;
				}
			});
		}
		await this.persistState(transactionRoot, manifest, "rollback_complete");
	}

	private async recoverUnlocked(): Promise<JournalRecoveryResult> {
		const result: JournalRecoveryResult = { recovered: [], cleaned: [], indeterminate: [] };
		const entries = await readdir(this.journalRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const transactionRoot = path.join(this.journalRoot, entry.name);
			let manifest: JournalManifest;
			try {
				manifest = await this.readManifest(transactionRoot, entry.name);
			} catch {
				result.indeterminate.push(entry.name);
				continue;
			}
			try {
				switch (manifest.state) {
					case "planned":
					case "staged":
					case "originals_secured":
					case "committed":
					case "cleanup_complete":
					case "rollback_complete":
						await this.removeTransaction(transactionRoot, manifest);
						result.cleaned.push(manifest.id);
						break;
					case "installing":
					case "rollback_started":
						await this.rollback(transactionRoot, manifest);
						await this.removeTransaction(transactionRoot, manifest);
						result.recovered.push(manifest.id);
						break;
					case "indeterminate":
						result.indeterminate.push(manifest.id);
						break;
				}
			} catch {
				result.indeterminate.push(manifest.id);
			}
		}
		return result;
	}

	private async readManifest(transactionRoot: string, expectedId: string): Promise<JournalManifest> {
		const canonicalRoot = await realpath(transactionRoot);
		if (path.dirname(canonicalRoot) !== (await realpath(this.journalRoot)))
			throw new Error("Invalid transaction root.");
		const value = JSON.parse(await readFile(path.join(canonicalRoot, "manifest.json"), "utf8")) as unknown;
		if (typeof value !== "object" || value === null) throw new Error("Invalid manifest.");
		const manifest = value as JournalManifest;
		if (
			manifest.version !== MANIFEST_VERSION ||
			manifest.id !== expectedId ||
			!JOURNAL_STATES.has(manifest.state) ||
			typeof manifest.createdAt !== "number" ||
			typeof manifest.updatedAt !== "number" ||
			typeof manifest.expiresAt !== "number" ||
			!Array.isArray(manifest.entries) ||
			!Array.isArray(manifest.parentDirectories) ||
			!manifest.parentDirectories.every((directory) => typeof directory === "string")
		) {
			throw new Error("Invalid manifest contract.");
		}
		for (const [index, entry] of manifest.entries.entries()) {
			if (
				typeof entry !== "object" ||
				entry === null ||
				typeof entry.path !== "string" ||
				!isStateDescriptor(entry.initial) ||
				!isStateDescriptor(entry.final)
			) {
				throw new Error("Invalid journal entry.");
			}
			this.assertTargetPath(entry.path);
			if (entry.stageFile !== undefined && entry.stageFile !== `stages/${index}.bin`)
				throw new Error("Invalid stage path.");
			if (entry.backupFile !== undefined && entry.backupFile !== `backups/${index}.bin`)
				throw new Error("Invalid backup path.");
		}
		for (const directory of manifest.parentDirectories) this.assertTargetPath(directory);
		return manifest;
	}

	private async enforceQuota(estimatedBytes: number): Promise<void> {
		const directories = (await readdir(this.journalRoot, { withFileTypes: true })).filter((entry) =>
			entry.isDirectory(),
		);
		if (directories.length >= this.maxTransactions) {
			throw new V2ToolError(
				"EDIT_PLAN_TOO_LARGE",
				`Journal transaction quota ${this.maxTransactions} is exhausted.`,
			);
		}
		let bytes = 0;
		for (const directory of directories)
			bytes += await this.directoryBytes(path.join(this.journalRoot, directory.name));
		if (bytes + estimatedBytes > this.maxJournalBytes) {
			throw new V2ToolError(
				"EDIT_PLAN_TOO_LARGE",
				`Journal byte quota ${this.maxJournalBytes} would be exceeded. Recover or clean old transactions.`,
			);
		}
	}

	private async directoryBytes(root: string): Promise<number> {
		let total = 0;
		for (const entry of await readdir(root, { withFileTypes: true })) {
			const target = path.join(root, entry.name);
			if (entry.isDirectory()) total += await this.directoryBytes(target);
			else if (entry.isFile()) total += (await stat(target)).size;
		}
		return total;
	}

	private async removeTransaction(transactionRoot: string, manifest: JournalManifest): Promise<void> {
		await this.failureInjector?.("before_cleanup", transactionRoot);
		for (let index = 0; index < manifest.entries.length; index++) {
			const temporary = path.join(
				path.dirname(manifest.entries[index].path),
				`.pi-journal-${manifest.id}-${index}.tmp`,
			);
			await rm(temporary, { force: true }).catch(() => {});
		}
		await rm(transactionRoot, { recursive: true, force: true });
		await this.fsyncDirectory(this.journalRoot);
	}

	private indeterminateError(transactionIds: string[], message: string, cause?: unknown): V2ToolError {
		return new V2ToolError(
			"EDIT_INDETERMINATE",
			message,
			{ transactionIds, recovery: { kind: "inspect_paths" } },
			cause instanceof Error ? cause : undefined,
		);
	}
}
