import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

function storage(global: unknown, project: unknown = {}) {
	const result = new InMemorySettingsStorage();
	result.withLock("global", () => JSON.stringify(global));
	result.withLock("project", () => JSON.stringify(project));
	return result;
}

describe("codemode settings", () => {
	it("defaults to additive declarations and the 3000-token inline budget", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getCodemodeMode()).toBe("on");
		expect(settings.getCodemodeInlineBudget()).toBe(3000);
	});

	it("merges trusted project fields without losing global budget and returns detached snapshots", () => {
		const settings = SettingsManager.fromStorage(
			storage({ codemode: { mode: "on", inlineBudget: 23 } }, { codemode: { mode: "only" } }),
		);
		expect(settings.getCodemodeMode()).toBe("only");
		expect(settings.getCodemodeInlineBudget()).toBe(23);
		const snapshot = settings.getSettings();
		snapshot.codemode!.mode = "on";
		snapshot.codemode!.inlineBudget = 999;
		expect(settings.getCodemodeMode()).toBe("only");
		expect(settings.getCodemodeInlineBudget()).toBe(23);
	});

	it("ignores untrusted project mode and budget until trust is granted", () => {
		const settings = SettingsManager.fromStorage(
			storage({ codemode: { mode: "on", inlineBudget: 17 } }, { codemode: { mode: "only", inlineBudget: 0 } }),
			{ projectTrusted: false },
		);
		expect(settings.getCodemodeMode()).toBe("on");
		expect(settings.getCodemodeInlineBudget()).toBe(17);
		settings.setProjectTrusted(true);
		expect(settings.getCodemodeMode()).toBe("only");
		expect(settings.getCodemodeInlineBudget()).toBe(0);
	});

	it.each([-1, "large", null])("falls back safely for malformed mode and budget %j", (inlineBudget) => {
		const settings = SettingsManager.fromStorage(storage({ codemode: { mode: "not-a-mode", inlineBudget } }));
		expect(settings.getCodemodeMode()).toBe("on");
		expect(settings.getCodemodeInlineBudget()).toBe(3000);
	});

	it("honors host overrides without leaking the merged view to persisted global settings", () => {
		const settings = SettingsManager.inMemory({ codemode: { mode: "on", inlineBudget: 3 } });
		settings.applyOverrides({ codemode: { mode: "only", inlineBudget: 0 } });
		expect(settings.getCodemodeMode()).toBe("only");
		expect(settings.getCodemodeInlineBudget()).toBe(0);
		expect(settings.getGlobalSettings().codemode).toEqual({ mode: "on", inlineBudget: 3 });
	});
});
