import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MAX_SUBAGENT_BUDGET_PREFERENCES_BYTES,
	parseSubagentBudgetPreferences,
	readSubagentBudgetPreferences,
	resetSubagentBudgetPreferences,
	writeSubagentBudgetPreferences,
} from "../src/budget-preferences.ts";

describe("Subagent budget preferences", () => {
	it("parses only strict v1 values within the 100K-1000M global range", () => {
		expect(parseSubagentBudgetPreferences('{"version":1,"maxTokens":100000}')).toEqual({
			version: 1,
			maxTokens: 100_000,
		});
		expect(parseSubagentBudgetPreferences('{"version":1,"maxTokens":1000000000}')).toEqual({
			version: 1,
			maxTokens: 1_000_000_000,
		});
		for (const input of [
			'{"version":2,"maxTokens":10000000}',
			'{"version":1,"maxTokens":99999}',
			'{"version":1,"maxTokens":1000000001}',
			'{"version":1,"maxTokens":10000000,"extra":true}',
			'{"version":1}',
			"[]",
			"{",
		]) {
			expect(() => parseSubagentBudgetPreferences(input)).toThrow();
		}
		expect(() => parseSubagentBudgetPreferences('{"version":1,"maxTokens":10000000}\0')).toThrow(/NUL/);
		expect(() => parseSubagentBudgetPreferences(Buffer.alloc(MAX_SUBAGENT_BUDGET_PREFERENCES_BYTES + 1))).toThrow(
			/exceed/,
		);
	});

	it("returns undefined when missing and writes private atomic JSON", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-budget-preferences-"));
		const path = join(root, "subagent", "budget.json");
		expect(await readSubagentBudgetPreferences(path)).toBeUndefined();
		await writeSubagentBudgetPreferences(path, 20_000_000);
		expect(await readSubagentBudgetPreferences(path)).toEqual({ version: 1, maxTokens: 20_000_000 });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, maxTokens: 20_000_000 });
	});

	it("fails closed on malformed and symlinked reads while a write safely repairs the entry", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-budget-repair-"));
		const path = join(root, "subagent", "budget.json");
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "not-json", { mode: 0o600 });
		await expect(readSubagentBudgetPreferences(path)).rejects.toThrow(/invalid JSON/);
		await writeSubagentBudgetPreferences(path, 30_000_000);
		expect((await readSubagentBudgetPreferences(path))?.maxTokens).toBe(30_000_000);

		await resetSubagentBudgetPreferences(path);
		const target = join(root, "target.json");
		await writeFile(target, '{"version":1,"maxTokens":40000000}', { mode: 0o600 });
		await symlink(target, path);
		await expect(readSubagentBudgetPreferences(path)).rejects.toThrow(/regular file/);
		await writeSubagentBudgetPreferences(path, 50_000_000);
		expect((await readSubagentBudgetPreferences(path))?.maxTokens).toBe(50_000_000);
		expect(JSON.parse(await readFile(target, "utf8")).maxTokens).toBe(40_000_000);
	});

	it("resets idempotently and repairs existing permissive modes on the next write", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-budget-reset-"));
		const parent = join(root, "subagent");
		const path = join(parent, "budget.json");
		await mkdir(parent, { mode: 0o755 });
		await writeFile(path, '{"version":1,"maxTokens":10000000}', { mode: 0o644 });
		await chmod(parent, 0o755);
		await writeSubagentBudgetPreferences(path, 60_000_000);
		expect((await stat(parent)).mode & 0o777).toBe(0o700);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await resetSubagentBudgetPreferences(path)).toBe(true);
		expect(await resetSubagentBudgetPreferences(path)).toBe(false);
		expect(await readSubagentBudgetPreferences(path)).toBeUndefined();
	});
});
