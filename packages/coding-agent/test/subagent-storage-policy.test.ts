import { describe, expect, test } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { parseSubagentStoragePolicy, storageDaysToMs } from "../src/core/subagent-storage-policy.ts";

describe("global subagent storage policy", () => {
	test("defaults disable cleanup and byte thresholds", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getSubagentStoragePolicy()).toEqual({
			autoGc: false,
			maxAgeDays: 0,
			maxTeamBytes: 0,
			maxTotalBytes: 0,
			logMaxAgeDays: 0,
			logMaxTotalBytes: 0,
		});
	});

	test("project settings and overrides cannot enable cleanup or change global budgets", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ subagentStorage: { maxTeamBytes: 1024 } }));
		storage.withLock("project", () => JSON.stringify({ subagentStorage: { autoGc: true, maxTeamBytes: 1 } }));
		const manager = SettingsManager.fromStorage(storage);
		manager.applyOverrides({ subagentStorage: { autoGc: true, maxTeamBytes: 2 } });
		expect(manager.getSubagentStoragePolicy()).toMatchObject({ autoGc: false, maxTeamBytes: 1024 });
	});

	test("global opt-in is explicit and returned policy is detached", () => {
		const manager = SettingsManager.inMemory({
			subagentStorage: { autoGc: true, maxAgeDays: 30, maxTotalBytes: 4096, logMaxAgeDays: 7 },
		});
		const result = manager.getSubagentStoragePolicy();
		expect(result).toMatchObject({ autoGc: true, maxAgeDays: 30, maxTotalBytes: 4096, logMaxAgeDays: 7 });
		result.autoGc = false;
		expect(manager.getSubagentStoragePolicy().autoGc).toBe(true);
		expect(storageDaysToMs(result.maxAgeDays)).toBe(30 * 86_400_000);
	});

	test.each([
		null,
		[],
		true,
		{ autoGc: "true" },
		{ autoGc: 1 },
		{ enabled: true },
		{ maxTeamBytes: -1 },
		{ maxTotalBytes: 0.5 },
		{ maxTotalBytes: Number.MAX_SAFE_INTEGER + 1 },
		{ maxAgeDays: Number.MAX_SAFE_INTEGER },
		{ logMaxAgeDays: -1 },
		{ logMaxTotalBytes: Infinity },
		{ logMaxTotalBytes: "1024" },
	])("rejects invalid destructive policy %j", (value) => {
		expect(() => parseSubagentStoragePolicy(value)).toThrow(/Invalid subagentStorage/);
	});
});
