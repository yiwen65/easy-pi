import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	MAX_SUBAGENT_MODEL_PREFERENCES_BYTES,
	parseSubagentModelPreferences,
	readSubagentModelPreferences,
	resetSubagentModelPreferences,
	resolveSubagentModels,
	writeSubagentModelPreferences,
} from "../src/model-preferences.ts";
import type { ChildModelSelection } from "../src/types.ts";

function model(
	provider: string,
	id: string,
	options: { reasoning?: boolean; thinkingLevelMap?: Model<Api>["thinkingLevelMap"] } = {},
): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://example.invalid",
		reasoning: options.reasoning ?? true,
		...(options.thinkingLevelMap ? { thinkingLevelMap: options.thinkingLevelMap } : {}),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 10_000,
	};
}

const available = [
	model("openai-codex", "parent", { thinkingLevelMap: { max: null } }),
	model("openai-codex", "luna", { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }),
	model("openai-codex", "sol", { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }),
	model("plain", "fast", { reasoning: false }),
];

describe("Subagent model preferences parsing", () => {
	it("accepts a strict v1 document with effort-only role overrides", () => {
		expect(
			parseSubagentModelPreferences(
				JSON.stringify({
					version: 1,
					default: { provider: "openai-codex", model: "luna", thinkingLevel: "medium" },
					roles: { analyst: { thinkingLevel: "low" }, reviewer: { provider: "openai-codex", model: "sol" } },
				}),
			),
		).toEqual({
			version: 1,
			default: { provider: "openai-codex", model: "luna", thinkingLevel: "medium" },
			roles: { analyst: { thinkingLevel: "low" }, reviewer: { provider: "openai-codex", model: "sol" } },
		});
	});

	it.each([
		["unknown version", { version: 2 }],
		["unknown root field", { version: 1, secret: "no" }],
		["unknown role", { version: 1, roles: { scout: { thinkingLevel: "low" } } }],
		["unknown override field", { version: 1, default: { temperature: 1 } }],
		["provider without model", { version: 1, default: { provider: "openai-codex" } }],
		["model without provider", { version: 1, default: { model: "luna" } }],
		["empty override", { version: 1, default: {} }],
		["unsupported syntax-level effort", { version: 1, default: { thinkingLevel: "ultra" } }],
	])("rejects %s", (_name, input) => {
		expect(() => parseSubagentModelPreferences(JSON.stringify(input))).toThrow();
	});

	it("rejects invalid JSON, NUL, and files above 32 KiB", () => {
		expect(() => parseSubagentModelPreferences("{")).toThrow(/invalid JSON/);
		expect(() => parseSubagentModelPreferences('{"version":1}\0')).toThrow(/NUL/);
		expect(() => parseSubagentModelPreferences(Buffer.alloc(MAX_SUBAGENT_MODEL_PREFERENCES_BYTES + 1))).toThrow(
			/exceed/,
		);
	});
});

describe("Subagent model preferences storage", () => {
	it("returns undefined for a missing file and writes private, atomic JSON", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-models-"));
		const path = join(root, "nested", "models.json");
		expect(await readSubagentModelPreferences(path)).toBeUndefined();
		await writeSubagentModelPreferences(path, { version: 1, roles: { writer: { thinkingLevel: "high" } } });
		expect(await readSubagentModelPreferences(path)).toEqual({
			version: 1,
			roles: { writer: { thinkingLevel: "high" } },
		});
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			version: 1,
			roles: { writer: { thinkingLevel: "high" } },
		});
	});

	it("serializes concurrent writers without torn output", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-models-race-"));
		const path = join(root, "models.json");
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				writeSubagentModelPreferences(path, {
					version: 1,
					roles: { writer: { thinkingLevel: index % 2 === 0 ? "low" : "high" } },
				}),
			),
		);
		const parsed = await readSubagentModelPreferences(path);
		expect(["low", "high"]).toContain(parsed?.roles?.writer?.thinkingLevel);
	});

	it("resets idempotently and can repair malformed content", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-models-reset-"));
		const path = join(root, "models.json");
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "not-json", { mode: 0o600 });
		await expect(readSubagentModelPreferences(path)).rejects.toThrow(/invalid JSON/);
		expect(await resetSubagentModelPreferences(path)).toBe(true);
		expect(await resetSubagentModelPreferences(path)).toBe(false);
		expect(await readSubagentModelPreferences(path)).toBeUndefined();
	});

	it("rejects an oversized file before parsing it", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-models-large-"));
		const path = join(root, "models.json");
		await writeFile(path, Buffer.alloc(MAX_SUBAGENT_MODEL_PREFERENCES_BYTES + 1), { mode: 0o600 });
		await expect(readSubagentModelPreferences(path)).rejects.toThrow(/exceed/);
	});

	it("rejects a symlink instead of following it", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-models-link-"));
		const target = join(root, "target.json");
		const path = join(root, "models.json");
		await writeFile(target, '{"version":1}', { mode: 0o600 });
		const { symlink } = await import("node:fs/promises");
		await symlink(target, path);
		await expect(readSubagentModelPreferences(path)).rejects.toThrow(/regular file/);
	});

	it("repairs permissive existing directory and file modes on write", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-models-mode-"));
		const parent = join(root, "subagent");
		const path = join(parent, "models.json");
		await mkdir(parent, { mode: 0o755 });
		await writeFile(path, '{"version":1}', { mode: 0o644 });
		await chmod(parent, 0o755);
		await writeSubagentModelPreferences(path, { version: 1, default: { thinkingLevel: "low" } });
		expect((await stat(parent)).mode & 0o777).toBe(0o700);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
});

describe("Subagent model preference resolution", () => {
	it("preserves parent behavior without configuration and resolves all three roles", () => {
		const resolved = resolveSubagentModels({
			parent: { provider: "openai-codex", model: "parent", thinkingLevel: "medium" },
			availableModels: available,
		});
		expect(resolved.childModels).toEqual({
			analyst: { provider: "openai-codex", model: "parent", thinkingLevel: "medium" },
			reviewer: { provider: "openai-codex", model: "parent", thinkingLevel: "medium" },
			writer: { provider: "openai-codex", model: "parent", thinkingLevel: "medium" },
		});
	});

	it("merges parent, default, and role overlays independently", () => {
		const resolved = resolveSubagentModels({
			parent: { provider: "openai-codex", model: "parent", thinkingLevel: "low" },
			preferences: {
				version: 1,
				default: { provider: "openai-codex", model: "luna", thinkingLevel: "medium" },
				roles: {
					analyst: { thinkingLevel: "low" },
					reviewer: { provider: "openai-codex", model: "sol", thinkingLevel: "high" },
					writer: { thinkingLevel: "max" },
				},
			},
			availableModels: available,
		});
		expect(resolved.childModels).toEqual({
			analyst: { provider: "openai-codex", model: "luna", thinkingLevel: "low" },
			reviewer: { provider: "openai-codex", model: "sol", thinkingLevel: "high" },
			writer: { provider: "openai-codex", model: "luna", thinkingLevel: "max" },
		});
		expect(resolved.roles.reviewer).toMatchObject({ modelSource: "role", thinkingSource: "role" });
	});

	it("retains an effort-only default until roles supply the missing model pair", () => {
		const resolved = resolveSubagentModels({
			preferences: {
				version: 1,
				default: { thinkingLevel: "medium" },
				roles: {
					analyst: { provider: "openai-codex", model: "luna" },
					reviewer: { provider: "openai-codex", model: "sol" },
					writer: { provider: "openai-codex", model: "luna" },
				},
			},
			availableModels: available,
		});
		expect(resolved.childModels.reviewer).toEqual({
			provider: "openai-codex",
			model: "sol",
			thinkingLevel: "medium",
		});
	});

	it("fully locks trusted role and fallback selections ahead of user preferences", () => {
		const resolved = resolveSubagentModels({
			parent: { provider: "openai-codex", model: "parent", thinkingLevel: "low" },
			preferences: {
				version: 1,
				default: { provider: "openai-codex", model: "luna", thinkingLevel: "max" },
			},
			trustedChildModel: { provider: "openai-codex", model: "parent", thinkingLevel: "medium" },
			trustedChildModels: { reviewer: { provider: "openai-codex", model: "sol", thinkingLevel: "high" } },
			availableModels: available,
		});
		expect(resolved.childModels.analyst.model).toBe("parent");
		expect(resolved.childModels.reviewer.model).toBe("sol");
		expect(resolved.childModels.writer.thinkingLevel).toBe("medium");
		expect(resolved.roles.analyst).toMatchObject({ trustedLocked: true, modelSource: "trusted-childModel" });
		expect(resolved.roles.reviewer).toMatchObject({ trustedLocked: true, modelSource: "trusted-childModels" });
	});

	it.each([
		["missing model", { provider: "openai-codex", model: "missing", thinkingLevel: "low" }],
		["missing provider", { provider: "missing", model: "luna", thinkingLevel: "low" }],
		["unsupported effort", { provider: "plain", model: "fast", thinkingLevel: "high" }],
	] satisfies Array<[string, ChildModelSelection]>)("fails closed for %s", (_name, parent) => {
		expect(() => resolveSubagentModels({ parent, availableModels: available })).toThrow(/Role analyst/);
	});
});
