import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExternalMutationPostState, ExternalMutationRecord } from "./journal-types.ts";

export const EXTERNAL_MUTATION_JOURNAL_VERSION = 1 as const;
export const MAX_EXTERNAL_MUTATIONS_PER_ATTEMPT = 256;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_PATH_CHARS = 4_096;
const MAX_ID_CHARS = 256;
const JOURNAL_DIRECTORY_PREFIX = "wj-pi-external-journal-";
const JOURNAL_FILE_NAME = "mutation-journal.jsonl";

export interface ExternalMutationJournalPolicy {
	version: typeof EXTERNAL_MUTATION_JOURNAL_VERSION;
	path: string;
	runId: string;
	taskId: string;
	attemptId: string;
	attemptNumber: number;
}

export interface ExternalMutationAuthorizedEvent {
	journalVersion: typeof EXTERNAL_MUTATION_JOURNAL_VERSION;
	journalSequence: number;
	type: "authorized";
	mutation: ExternalMutationRecord;
}

export interface ExternalMutationObservedEvent {
	journalVersion: typeof EXTERNAL_MUTATION_JOURNAL_VERSION;
	journalSequence: number;
	type: "observed";
	mutationId: string;
	toolResult: "succeeded" | "failed";
	observedAt: number;
	postState: ExternalMutationPostState;
}

export type ExternalMutationJournalEvent = ExternalMutationAuthorizedEvent | ExternalMutationObservedEvent;

export interface ExternalMutationJournalHandle {
	policy: ExternalMutationJournalPolicy;
	cleanup(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS && !/[\p{Cc}\p{Cf}]/u.test(value)
	);
}

function validTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertPrivateJournalFile(path: string): string {
	if (!isAbsolute(path) || path.includes("\0") || resolve(path) !== path) {
		throw new Error("External mutation journal path must be a normalized absolute path");
	}
	const parent = dirname(path);
	const parentMetadata = lstatSync(parent);
	if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || (parentMetadata.mode & 0o077) !== 0) {
		throw new Error("External mutation journal parent must be a private real directory");
	}
	if (realpathSync(parent) !== parent) throw new Error("External mutation journal parent path is not canonical");
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
		throw new Error("External mutation journal must be a private regular file");
	}
	return join(parent, basename(path));
}

export function validateExternalMutationJournalPolicy(value: unknown): ExternalMutationJournalPolicy {
	if (!isRecord(value)) throw new Error("External mutation journal policy must be an object");
	if (value.version !== EXTERNAL_MUTATION_JOURNAL_VERSION) {
		throw new Error("Unsupported external mutation journal policy version");
	}
	if (!validId(value.runId) || !validId(value.taskId) || !validId(value.attemptId)) {
		throw new Error("External mutation journal identity is invalid");
	}
	if (!Number.isSafeInteger(value.attemptNumber) || Number(value.attemptNumber) < 1) {
		throw new Error("External mutation journal attemptNumber must be a positive safe integer");
	}
	if (typeof value.path !== "string") throw new Error("External mutation journal path is required");
	return {
		version: EXTERNAL_MUTATION_JOURNAL_VERSION,
		path: assertPrivateJournalFile(value.path),
		runId: value.runId,
		taskId: value.taskId,
		attemptId: value.attemptId,
		attemptNumber: Number(value.attemptNumber),
	};
}

export async function createExternalMutationJournal(
	identity: Omit<ExternalMutationJournalPolicy, "version" | "path">,
	parentDirectory: string = tmpdir(),
): Promise<ExternalMutationJournalHandle> {
	const canonicalParent = realpathSync(parentDirectory);
	const root = await mkdtemp(join(canonicalParent, JOURNAL_DIRECTORY_PREFIX));
	const path = join(root, JOURNAL_FILE_NAME);
	try {
		await chmod(root, 0o700);
		const file = await open(path, "wx", 0o600);
		try {
			await file.sync();
		} finally {
			await file.close();
		}
		await chmod(path, 0o600);
		const policy = validateExternalMutationJournalPolicy({
			version: EXTERNAL_MUTATION_JOURNAL_VERSION,
			path,
			...identity,
		});
		return {
			policy,
			async cleanup(): Promise<void> {
				await unlink(path).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
				await rmdir(root).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
				});
			},
		};
	} catch (error) {
		await unlink(path).catch(() => undefined);
		await rmdir(root).catch(() => undefined);
		throw error;
	}
}

export function openExternalMutationJournal(policy: ExternalMutationJournalPolicy): ExternalMutationJournalHandle {
	const validated = validateExternalMutationJournalPolicy(policy);
	const parent = dirname(validated.path);
	if (basename(validated.path) !== JOURNAL_FILE_NAME || !basename(parent).startsWith(JOURNAL_DIRECTORY_PREFIX)) {
		throw new Error("External mutation journal is not in a Controller-owned private directory");
	}
	return {
		policy: validated,
		async cleanup(): Promise<void> {
			await unlink(validated.path).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
			});
		},
	};
}

function appendDurably(path: string, event: ExternalMutationJournalEvent): void {
	const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
	const descriptor = openSync(path, "a", 0o600);
	try {
		let offset = 0;
		while (offset < bytes.length) {
			const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
			if (written < 1) throw new Error("External mutation journal append made no progress");
			offset += written;
		}
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function parsePostState(value: unknown): ExternalMutationPostState {
	if (!isRecord(value) || (value.status !== "confirmed" && value.status !== "unavailable")) {
		throw new Error("External mutation post-state is invalid");
	}
	if (value.status === "unavailable") {
		if (
			value.reason !== "missing" &&
			value.reason !== "not_regular_file" &&
			value.reason !== "changed_during_observation" &&
			value.reason !== "read_error"
		) {
			throw new Error("External mutation unavailable reason is invalid");
		}
		return { status: "unavailable", reason: value.reason };
	}
	if (
		value.fileType !== "regular" ||
		typeof value.size !== "number" ||
		!Number.isSafeInteger(value.size) ||
		value.size < 0 ||
		typeof value.mode !== "number" ||
		!Number.isSafeInteger(value.mode) ||
		value.mode < 0 ||
		typeof value.modifiedAtMs !== "number" ||
		!Number.isFinite(value.modifiedAtMs) ||
		typeof value.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.sha256)
	) {
		throw new Error("External mutation confirmed post-state is invalid");
	}
	return {
		status: "confirmed",
		fileType: "regular",
		size: value.size,
		mode: value.mode,
		modifiedAtMs: value.modifiedAtMs,
		sha256: value.sha256,
	};
}

function parseMutation(value: unknown, policy: ExternalMutationJournalPolicy): ExternalMutationRecord {
	if (!isRecord(value)) throw new Error("External mutation authorization must be an object");
	if (
		!validId(value.mutationId) ||
		value.runId !== policy.runId ||
		value.taskId !== policy.taskId ||
		value.attemptId !== policy.attemptId ||
		value.attemptNumber !== policy.attemptNumber ||
		!Number.isSafeInteger(value.authorizationSequence) ||
		Number(value.authorizationSequence) < 1 ||
		Number(value.authorizationSequence) > MAX_EXTERNAL_MUTATIONS_PER_ATTEMPT ||
		!validId(value.toolCallId) ||
		(value.operation !== "write" && value.operation !== "edit") ||
		typeof value.path !== "string" ||
		value.path.length < 1 ||
		value.path.length > MAX_PATH_CHARS ||
		!isAbsolute(value.path) ||
		resolve(value.path) !== value.path ||
		value.authorizationStatus !== "authorized" ||
		!validTimestamp(value.authorizedAt)
	) {
		throw new Error("External mutation authorization record is invalid");
	}
	return {
		mutationId: value.mutationId,
		runId: policy.runId,
		taskId: policy.taskId,
		attemptId: policy.attemptId,
		attemptNumber: policy.attemptNumber,
		authorizationSequence: Number(value.authorizationSequence),
		toolCallId: value.toolCallId,
		operation: value.operation,
		path: value.path,
		authorizationStatus: "authorized",
		authorizedAt: value.authorizedAt,
	};
}

function parseExternalMutationJournal(
	policy: ExternalMutationJournalPolicy,
	allowIncompleteTail: boolean,
): ExternalMutationJournalEvent[] {
	const validated = validateExternalMutationJournalPolicy(policy);
	const content = readFileSync(validated.path);
	if (content.byteLength > MAX_JOURNAL_BYTES) throw new Error("External mutation journal exceeds its size limit");
	let text = content.toString("utf8");
	if (text.length > 0 && !text.endsWith("\n")) {
		if (!allowIncompleteTail) throw new Error("External mutation journal has an incomplete record");
		text = text.slice(0, text.lastIndexOf("\n") + 1);
	}
	const lines = text.split("\n").filter((line) => line.length > 0);
	const events: ExternalMutationJournalEvent[] = [];
	const mutations = new Map<string, ExternalMutationRecord>();
	const observed = new Set<string>();
	let expectedAuthorizationSequence = 1;
	for (let index = 0; index < lines.length; index++) {
		let value: unknown;
		try {
			value = JSON.parse(lines[index]!);
		} catch {
			throw new Error(`External mutation journal record ${index + 1} is not valid JSON`);
		}
		if (!isRecord(value) || value.journalVersion !== EXTERNAL_MUTATION_JOURNAL_VERSION) {
			throw new Error(`External mutation journal record ${index + 1} has an invalid version`);
		}
		const journalSequence = index + 1;
		if (value.journalSequence !== journalSequence) {
			throw new Error(`External mutation journal sequence is not contiguous at record ${journalSequence}`);
		}
		if (value.type === "authorized") {
			const mutation = parseMutation(value.mutation, validated);
			if (mutation.authorizationSequence !== expectedAuthorizationSequence) {
				throw new Error("External mutation authorization sequence is not contiguous");
			}
			if (mutation.mutationId !== `${validated.attemptId}:${mutation.authorizationSequence}`) {
				throw new Error("External mutation ID does not match its attempt and sequence");
			}
			if (mutations.has(mutation.mutationId)) throw new Error("External mutation ID is duplicated");
			mutations.set(mutation.mutationId, mutation);
			expectedAuthorizationSequence++;
			events.push({
				journalVersion: EXTERNAL_MUTATION_JOURNAL_VERSION,
				journalSequence,
				type: "authorized",
				mutation,
			});
			continue;
		}
		if (value.type !== "observed" || !validId(value.mutationId) || !mutations.has(value.mutationId)) {
			throw new Error(`External mutation observation ${journalSequence} has no authorization`);
		}
		if (observed.has(value.mutationId)) throw new Error("External mutation has multiple post-state observations");
		if (value.toolResult !== "succeeded" && value.toolResult !== "failed") {
			throw new Error("External mutation tool result is invalid");
		}
		if (!validTimestamp(value.observedAt)) throw new Error("External mutation observation timestamp is invalid");
		const postState = parsePostState(value.postState);
		observed.add(value.mutationId);
		events.push({
			journalVersion: EXTERNAL_MUTATION_JOURNAL_VERSION,
			journalSequence,
			type: "observed",
			mutationId: value.mutationId,
			toolResult: value.toolResult,
			observedAt: value.observedAt,
			postState,
		});
	}
	return events;
}

export function readExternalMutationJournal(policy: ExternalMutationJournalPolicy): ExternalMutationJournalEvent[] {
	return parseExternalMutationJournal(policy, false);
}

export class ExternalMutationJournalReader {
	private deliveredSequence = 0;
	readonly policy: ExternalMutationJournalPolicy;

	constructor(policy: ExternalMutationJournalPolicy) {
		this.policy = validateExternalMutationJournalPolicy(policy);
	}

	drain(onEvent: (event: ExternalMutationJournalEvent) => void): number {
		// The Child appends in another process. Ignore only an unterminated tail
		// until a later poll observes its newline; complete records stay strict.
		const events = parseExternalMutationJournal(this.policy, true);
		for (const event of events) {
			if (event.journalSequence <= this.deliveredSequence) continue;
			onEvent(event);
			this.deliveredSequence = event.journalSequence;
		}
		return this.deliveredSequence;
	}
}

export class ExternalMutationJournalWriter {
	private journalSequence = 0;
	private authorizationSequence = 0;
	private appendFailure: unknown;
	private readonly active = new Map<string, ExternalMutationRecord>();
	private readonly authorizedToolCallIds = new Set<string>();
	readonly policy: ExternalMutationJournalPolicy;

	constructor(policy: ExternalMutationJournalPolicy) {
		this.policy = validateExternalMutationJournalPolicy(policy);
		const existing = readExternalMutationJournal(this.policy);
		this.journalSequence = existing.length;
		for (const event of existing) {
			if (event.type !== "authorized") continue;
			this.authorizationSequence++;
			this.authorizedToolCallIds.add(event.mutation.toolCallId);
		}
	}

	private append(event: ExternalMutationJournalEvent): void {
		if (this.appendFailure !== undefined) {
			throw new Error("External mutation journal is unusable after an append failure");
		}
		try {
			appendDurably(this.policy.path, event);
		} catch (error) {
			// A failed append can have written an unknown prefix. Permanently poison
			// this writer so a later call cannot authorize a side effect behind a
			// malformed or sequence-gapped journal.
			this.appendFailure = error;
			throw error;
		}
	}

	authorize(
		toolCallId: string,
		operation: "write" | "edit",
		path: string,
		authorizedAt = Date.now(),
	): ExternalMutationRecord {
		if (this.appendFailure !== undefined) {
			throw new Error("External mutation journal is unusable after an append failure");
		}
		if (!validId(toolCallId)) throw new Error("External mutation toolCallId is invalid");
		if (!isAbsolute(path) || resolve(path) !== path || path.length > MAX_PATH_CHARS) {
			throw new Error("External mutation path is invalid");
		}
		if (this.authorizedToolCallIds.has(toolCallId)) {
			throw new Error(`External mutation tool call has already been authorized: ${toolCallId}`);
		}
		if (this.authorizationSequence >= MAX_EXTERNAL_MUTATIONS_PER_ATTEMPT) {
			throw new Error(
				`External mutation attempt exceeds ${MAX_EXTERNAL_MUTATIONS_PER_ATTEMPT} authorized operations`,
			);
		}
		const authorizationSequence = this.authorizationSequence + 1;
		const journalSequence = this.journalSequence + 1;
		const mutation: ExternalMutationRecord = {
			mutationId: `${this.policy.attemptId}:${authorizationSequence}`,
			runId: this.policy.runId,
			taskId: this.policy.taskId,
			attemptId: this.policy.attemptId,
			attemptNumber: this.policy.attemptNumber,
			authorizationSequence,
			toolCallId,
			operation,
			path,
			authorizationStatus: "authorized",
			authorizedAt,
		};
		this.append({
			journalVersion: EXTERNAL_MUTATION_JOURNAL_VERSION,
			journalSequence,
			type: "authorized",
			mutation,
		});
		this.authorizationSequence = authorizationSequence;
		this.journalSequence = journalSequence;
		this.authorizedToolCallIds.add(toolCallId);
		this.active.set(toolCallId, mutation);
		return mutation;
	}

	async observe(toolCallId: string, toolResult: "succeeded" | "failed", observedAt = Date.now()): Promise<void> {
		const mutation = this.active.get(toolCallId);
		if (!mutation) return;
		const postState = await captureExternalMutationPostState(mutation.path);
		const journalSequence = this.journalSequence + 1;
		this.append({
			journalVersion: EXTERNAL_MUTATION_JOURNAL_VERSION,
			journalSequence,
			type: "observed",
			mutationId: mutation.mutationId,
			toolResult,
			observedAt,
			postState,
		});
		this.journalSequence = journalSequence;
		this.active.delete(toolCallId);
	}
}

export async function captureExternalMutationPostState(path: string): Promise<ExternalMutationPostState> {
	let before: Awaited<ReturnType<typeof lstat>>;
	try {
		before = await lstat(path);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { status: "unavailable", reason: "missing" }
			: { status: "unavailable", reason: "read_error" };
	}
	if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size)) {
		return { status: "unavailable", reason: "not_regular_file" };
	}
	try {
		const hash = createHash("sha256");
		const file = await open(path, "r");
		try {
			const buffer = Buffer.allocUnsafe(64 * 1024);
			for (;;) {
				const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;
				hash.update(buffer.subarray(0, bytesRead));
			}
		} finally {
			await file.close();
		}
		const after = await lstat(path);
		if (
			!after.isFile() ||
			after.isSymbolicLink() ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ino !== before.ino
		) {
			return { status: "unavailable", reason: "changed_during_observation" };
		}
		return {
			status: "confirmed",
			fileType: "regular",
			size: after.size,
			mode: after.mode & 0o7777,
			modifiedAtMs: after.mtimeMs,
			sha256: hash.digest("hex"),
		};
	} catch {
		return { status: "unavailable", reason: "read_error" };
	}
}
