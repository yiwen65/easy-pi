import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MAX_SUBAGENT_TOKENS_PER_TASK, MIN_SUBAGENT_TOKENS_PER_TASK } from "./contracts.ts";

export const MAX_SUBAGENT_BUDGET_PREFERENCES_BYTES = 256;

export interface SubagentBudgetPreferencesV1 {
	version: 1;
	maxTokens: number;
}

export type SubagentBudgetPreferences = SubagentBudgetPreferencesV1;

export class SubagentBudgetPreferencesError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SubagentBudgetPreferencesError";
	}
}

export function defaultSubagentBudgetPreferencesPath(agentDir: string): string {
	return join(agentDir, "subagent", "budget.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBudget(maxTokens: unknown): asserts maxTokens is number {
	if (
		typeof maxTokens !== "number" ||
		!Number.isSafeInteger(maxTokens) ||
		maxTokens < MIN_SUBAGENT_TOKENS_PER_TASK ||
		maxTokens > MAX_SUBAGENT_TOKENS_PER_TASK
	) {
		throw new SubagentBudgetPreferencesError(
			`Subagent task budget must be between ${MIN_SUBAGENT_TOKENS_PER_TASK.toLocaleString("en-US")} and ${MAX_SUBAGENT_TOKENS_PER_TASK.toLocaleString("en-US")} tokens`,
		);
	}
}

export function parseSubagentBudgetPreferences(input: string | Buffer): SubagentBudgetPreferences {
	const bytes = Buffer.byteLength(input);
	if (bytes > MAX_SUBAGENT_BUDGET_PREFERENCES_BYTES) {
		throw new SubagentBudgetPreferencesError(
			`Subagent budget preferences exceed ${MAX_SUBAGENT_BUDGET_PREFERENCES_BYTES} bytes`,
		);
	}
	const text = typeof input === "string" ? input : input.toString("utf8");
	if (text.includes("\0")) throw new SubagentBudgetPreferencesError("Subagent budget preferences contain NUL");
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch (error) {
		throw new SubagentBudgetPreferencesError("Subagent budget preferences contain invalid JSON", { cause: error });
	}
	if (!isRecord(decoded)) throw new SubagentBudgetPreferencesError("Subagent budget preferences must be an object");
	const unknown = Object.keys(decoded).filter((key) => key !== "version" && key !== "maxTokens");
	if (unknown.length > 0) {
		throw new SubagentBudgetPreferencesError(
			`Subagent budget preferences contain unknown field(s): ${unknown.join(", ")}`,
		);
	}
	if (decoded.version !== 1) {
		throw new SubagentBudgetPreferencesError(
			`Unsupported Subagent budget preferences version: ${String(decoded.version)}`,
		);
	}
	assertBudget(decoded.maxTokens);
	return { version: 1, maxTokens: decoded.maxTokens };
}

export async function readSubagentBudgetPreferences(path: string): Promise<SubagentBudgetPreferences | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = await handle.stat();
		if (!stat.isFile()) {
			throw new SubagentBudgetPreferencesError(`Subagent budget preferences path is not a regular file: ${path}`);
		}
		if (stat.size > MAX_SUBAGENT_BUDGET_PREFERENCES_BYTES) {
			throw new SubagentBudgetPreferencesError(
				`Subagent budget preferences exceed ${MAX_SUBAGENT_BUDGET_PREFERENCES_BYTES} bytes`,
			);
		}
		return parseSubagentBudgetPreferences(await handle.readFile());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if ((error as NodeJS.ErrnoException).code === "ELOOP") {
			throw new SubagentBudgetPreferencesError(`Subagent budget preferences path is not a regular file: ${path}`);
		}
		if (error instanceof SubagentBudgetPreferencesError) throw error;
		throw new SubagentBudgetPreferencesError(`Could not read Subagent budget preferences at ${path}`, {
			cause: error,
		});
	} finally {
		await handle?.close();
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

export async function writeSubagentBudgetPreferences(path: string, maxTokens: number): Promise<void> {
	const preferences = parseSubagentBudgetPreferences(JSON.stringify({ version: 1, maxTokens }));
	const serialized = `${JSON.stringify(preferences, null, 2)}\n`;
	const parent = dirname(path);
	await ensurePrivateDirectory(parent);
	const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		await handle.writeFile(serialized, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
		await syncDirectory(parent);
	} finally {
		await handle?.close().catch(() => undefined);
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

export async function resetSubagentBudgetPreferences(path: string): Promise<boolean> {
	const parent = dirname(path);
	await ensurePrivateDirectory(parent);
	try {
		await unlink(path);
		await syncDirectory(parent);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
