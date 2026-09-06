import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type {
	ChildModelOverride,
	ChildModelPolicy,
	ChildModelRole,
	ChildModelSelection,
	SubagentModelPreferences,
} from "./types.ts";
import { CHILD_MODEL_ROLES } from "./types.ts";

export const MAX_SUBAGENT_MODEL_PREFERENCES_BYTES = 32 * 1024;
const LOCK_WAIT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
const STRING_LIMIT = 512;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelSelectionSource = "parent" | "default" | "role" | "trusted-childModel" | "trusted-childModels";

export interface ResolvedRoleModelSelection {
	selection: ChildModelSelection;
	modelSource: ModelSelectionSource;
	thinkingSource: ModelSelectionSource | "unset";
	trustedLocked: boolean;
}

export interface ResolvedSubagentModels {
	childModels: Required<ChildModelPolicy>;
	roles: Record<ChildModelRole, ResolvedRoleModelSelection>;
}

export class SubagentModelPreferencesError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SubagentModelPreferencesError";
	}
}

export function defaultSubagentModelPreferencesPath(agentDir: string): string {
	return join(agentDir, "subagent", "models.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], source: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new SubagentModelPreferencesError(`${source} contains unknown field(s): ${unknown.join(", ")}`);
	}
}

function parseSafeString(value: unknown, source: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new SubagentModelPreferencesError(`${source} must be a non-empty string`);
	}
	if (value.length > STRING_LIMIT)
		throw new SubagentModelPreferencesError(`${source} exceeds ${STRING_LIMIT} characters`);
	if (/\p{Cc}/u.test(value)) throw new SubagentModelPreferencesError(`${source} contains a control character`);
	return value;
}

function parseOverride(value: unknown, source: string): ChildModelOverride {
	if (!isRecord(value)) throw new SubagentModelPreferencesError(`${source} must be an object`);
	assertExactKeys(value, ["provider", "model", "thinkingLevel"], source);
	if (Object.keys(value).length === 0) throw new SubagentModelPreferencesError(`${source} must not be empty`);
	const hasProvider = Object.hasOwn(value, "provider");
	const hasModel = Object.hasOwn(value, "model");
	if (hasProvider !== hasModel) {
		throw new SubagentModelPreferencesError(`${source}.provider and ${source}.model must appear together`);
	}
	const result: ChildModelOverride = {};
	if (hasProvider) {
		result.provider = parseSafeString(value.provider, `${source}.provider`);
		result.model = parseSafeString(value.model, `${source}.model`);
	}
	if (Object.hasOwn(value, "thinkingLevel")) {
		if (typeof value.thinkingLevel !== "string" || !THINKING_LEVELS.includes(value.thinkingLevel as never)) {
			throw new SubagentModelPreferencesError(
				`${source}.thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`,
			);
		}
		result.thinkingLevel = value.thinkingLevel as ChildModelSelection["thinkingLevel"];
	}
	return result;
}

export function parseSubagentModelPreferences(input: string | Buffer): SubagentModelPreferences {
	const bytes = Buffer.byteLength(input);
	if (bytes > MAX_SUBAGENT_MODEL_PREFERENCES_BYTES) {
		throw new SubagentModelPreferencesError(
			`Subagent model preferences exceed ${MAX_SUBAGENT_MODEL_PREFERENCES_BYTES} bytes`,
		);
	}
	const text = typeof input === "string" ? input : input.toString("utf8");
	if (text.includes("\0")) throw new SubagentModelPreferencesError("Subagent model preferences contain NUL");
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch (error) {
		throw new SubagentModelPreferencesError("Subagent model preferences contain invalid JSON", { cause: error });
	}
	if (!isRecord(decoded)) throw new SubagentModelPreferencesError("Subagent model preferences must be an object");
	assertExactKeys(decoded, ["version", "default", "roles"], "Subagent model preferences");
	if (decoded.version !== 1) {
		throw new SubagentModelPreferencesError(
			`Unsupported Subagent model preferences version: ${String(decoded.version)}`,
		);
	}
	const result: SubagentModelPreferences = { version: 1 };
	if (Object.hasOwn(decoded, "default")) result.default = parseOverride(decoded.default, "default");
	if (Object.hasOwn(decoded, "roles")) {
		if (!isRecord(decoded.roles)) throw new SubagentModelPreferencesError("roles must be an object");
		assertExactKeys(decoded.roles, CHILD_MODEL_ROLES, "roles");
		const roles: NonNullable<SubagentModelPreferences["roles"]> = {};
		for (const role of CHILD_MODEL_ROLES) {
			if (Object.hasOwn(decoded.roles, role)) roles[role] = parseOverride(decoded.roles[role], `roles.${role}`);
		}
		result.roles = roles;
	}
	return result;
}

export async function readSubagentModelPreferences(path: string): Promise<SubagentModelPreferences | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = await handle.stat();
		if (!stat.isFile()) {
			throw new SubagentModelPreferencesError(`Subagent model preferences path is not a regular file: ${path}`);
		}
		if (stat.size > MAX_SUBAGENT_MODEL_PREFERENCES_BYTES) {
			throw new SubagentModelPreferencesError(
				`Subagent model preferences exceed ${MAX_SUBAGENT_MODEL_PREFERENCES_BYTES} bytes`,
			);
		}
		const content = await handle.readFile();
		return parseSubagentModelPreferences(content);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if ((error as NodeJS.ErrnoException).code === "ELOOP") {
			throw new SubagentModelPreferencesError(`Subagent model preferences path is not a regular file: ${path}`);
		}
		if (error instanceof SubagentModelPreferencesError) throw error;
		throw new SubagentModelPreferencesError(`Could not read Subagent model preferences at ${path}`, { cause: error });
	} finally {
		await handle?.close();
	}
}

async function delay(ms: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function tryRemoveStaleLock(lockPath: string): Promise<void> {
	try {
		const stat = await lstat(lockPath);
		if (!stat.isFile() || Date.now() - stat.mtimeMs <= STALE_LOCK_MS) return;
		await unlink(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function withPreferencesLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const lockPath = `${path}.lock`;
	const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	while (!handle) {
		try {
			handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
			await handle.writeFile(token, "utf8");
			await handle.sync();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				await handle?.close().catch(() => undefined);
				handle = undefined;
				await unlink(lockPath).catch(() => undefined);
				throw error;
			}
			await tryRemoveStaleLock(lockPath);
			if (Date.now() >= deadline) {
				throw new SubagentModelPreferencesError(
					`Timed out waiting for Subagent model preferences lock: ${lockPath}`,
				);
			}
			await delay(20);
		}
	}
	try {
		return await operation();
	} finally {
		await handle.close().catch(() => undefined);
		await readFile(lockPath, "utf8")
			.then(async (current) => {
				if (current === token) await unlink(lockPath);
			})
			.catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
	}
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

async function syncDirectory(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY);
		await handle.sync();
	} catch (error) {
		if (!["EINVAL", "ENOTSUP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	} finally {
		await handle?.close();
	}
}

export async function writeSubagentModelPreferences(
	path: string,
	preferences: SubagentModelPreferences,
): Promise<void> {
	const serialized = `${JSON.stringify(parseSubagentModelPreferences(JSON.stringify(preferences)), null, 2)}\n`;
	if (Buffer.byteLength(serialized) > MAX_SUBAGENT_MODEL_PREFERENCES_BYTES) {
		throw new SubagentModelPreferencesError(
			`Subagent model preferences exceed ${MAX_SUBAGENT_MODEL_PREFERENCES_BYTES} bytes`,
		);
	}
	const parent = dirname(path);
	await ensurePrivateDirectory(parent);
	await withPreferencesLock(path, async () => {
		const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
			await handle.writeFile(serialized, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporary, path);
			await chmod(path, 0o600);
			await syncDirectory(parent);
		} finally {
			await handle?.close().catch(() => undefined);
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	});
}

export async function resetSubagentModelPreferences(path: string): Promise<boolean> {
	const parent = dirname(path);
	await ensurePrivateDirectory(parent);
	return await withPreferencesLock(path, async () => {
		try {
			await unlink(path);
			await syncDirectory(parent);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	});
}

function modelKey(selection: Pick<ChildModelSelection, "provider" | "model">): string {
	return `${selection.provider}/${selection.model}`;
}

function selectAvailableModel(
	selection: ChildModelSelection,
	availableModels: readonly Model<Api>[],
	role: ChildModelRole,
	modelSource: ModelSelectionSource,
	thinkingSource: ModelSelectionSource | "unset" = modelSource,
): Model<Api> {
	const model = availableModels.find(
		(candidate) => candidate.provider === selection.provider && candidate.id === selection.model,
	);
	if (!model) {
		throw new SubagentModelPreferencesError(
			`Role ${role} resolves ${modelKey(selection)} from ${modelSource}, but that model/provider is unavailable; run /subagent-models show or /subagent-models reset`,
		);
	}
	if (selection.thinkingLevel !== undefined) {
		const supported = getSupportedThinkingLevels(model);
		if (!supported.includes(selection.thinkingLevel)) {
			throw new SubagentModelPreferencesError(
				`Role ${role} resolves thinkingLevel=${selection.thinkingLevel} from ${thinkingSource}, but ${modelKey(selection)} supports only ${supported.join(", ") || "none"}; run /subagent-models`,
			);
		}
	}
	return model;
}

function applyOverride(
	selection: Partial<ChildModelSelection>,
	override: ChildModelOverride | undefined,
	modelSource: ModelSelectionSource,
	thinkingSource: ModelSelectionSource | "unset",
	overrideSource: "default" | "role",
): {
	selection: Partial<ChildModelSelection>;
	modelSource: ModelSelectionSource;
	thinkingSource: ModelSelectionSource | "unset";
} {
	if (!override) return { selection, modelSource, thinkingSource };
	const next = { ...selection };
	let nextModelSource = modelSource;
	let nextThinkingSource = thinkingSource;
	if (override.provider !== undefined && override.model !== undefined) {
		next.provider = override.provider;
		next.model = override.model;
		nextModelSource = overrideSource;
	}
	if (override.thinkingLevel !== undefined) {
		next.thinkingLevel = override.thinkingLevel;
		nextThinkingSource = overrideSource;
	}
	return { selection: next, modelSource: nextModelSource, thinkingSource: nextThinkingSource };
}

export function resolveSubagentModels(options: {
	parent?: ChildModelSelection;
	preferences?: SubagentModelPreferences;
	trustedChildModel?: ChildModelSelection;
	trustedChildModels?: ChildModelPolicy;
	availableModels: readonly Model<Api>[];
}): ResolvedSubagentModels {
	const roles = {} as Record<ChildModelRole, ResolvedRoleModelSelection>;
	const childModels = {} as Required<ChildModelPolicy>;
	for (const role of CHILD_MODEL_ROLES) {
		const trustedRole = options.trustedChildModels?.[role];
		const trusted = trustedRole ?? options.trustedChildModel;
		if (trusted) {
			const source: ModelSelectionSource = trustedRole ? "trusted-childModels" : "trusted-childModel";
			selectAvailableModel(
				trusted,
				options.availableModels,
				role,
				source,
				trusted.thinkingLevel === undefined ? "unset" : source,
			);
			childModels[role] = { ...trusted };
			roles[role] = {
				selection: { ...trusted },
				modelSource: source,
				thinkingSource: trusted.thinkingLevel === undefined ? "unset" : source,
				trustedLocked: true,
			};
			continue;
		}
		let resolved = {
			selection: { ...(options.parent ?? {}) } as Partial<ChildModelSelection>,
			modelSource: "parent" as ModelSelectionSource,
			thinkingSource: (options.parent?.thinkingLevel === undefined ? "unset" : "parent") as
				| ModelSelectionSource
				| "unset",
		};
		resolved = applyOverride(
			resolved.selection,
			options.preferences?.default,
			resolved.modelSource,
			resolved.thinkingSource,
			"default",
		);
		resolved = applyOverride(
			resolved.selection,
			options.preferences?.roles?.[role],
			resolved.modelSource,
			resolved.thinkingSource,
			"role",
		);
		if (!resolved.selection.provider || !resolved.selection.model) {
			throw new SubagentModelPreferencesError(
				`Role ${role} has no effective provider/model; select a parent model or run /subagent-models`,
			);
		}
		const selection = resolved.selection as ChildModelSelection;
		selectAvailableModel(selection, options.availableModels, role, resolved.modelSource, resolved.thinkingSource);
		childModels[role] = { ...selection };
		roles[role] = { ...resolved, selection: { ...selection }, trustedLocked: false };
	}
	return { childModels, roles };
}
