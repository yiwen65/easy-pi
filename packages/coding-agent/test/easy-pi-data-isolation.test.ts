import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as config from "../src/config.ts";
import { resolveProductIdentity } from "../src/core/product-identity.ts";
import { loadSkills } from "../src/core/skills.ts";

// Keep the module identity fixed while replacing only the home used by path getters.
vi.mock("os", async (importOriginal) => ({
	...(await importOriginal()),
	homedir: () => process.env.HOME!,
}));

let root: string;
let home: string;

function fixture(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "easy-pi-isolation-"));
	home = join(root, "home");
	mkdirSync(home);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("EASY_PI_CODING_AGENT_DIR", undefined);
	vi.stubEnv("EASY_PI_CODING_AGENT_SESSION_DIR", undefined);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"));
	vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(home, ".pi", "sessions"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("easy-pi product identity", () => {
	test("defaults to independent branding and shell-safe environment names", () => {
		expect(resolveProductIdentity()).toEqual({
			appName: "easy-pi",
			appTitle: "easy-pi",
			configDirName: ".easy-pi",
			envAgentDir: "EASY_PI_CODING_AGENT_DIR",
			envSessionDir: "EASY_PI_CODING_AGENT_SESSION_DIR",
		});
		expect(resolveProductIdentity({ configDir: ".pi" })).toEqual(resolveProductIdentity());
		expect(resolveProductIdentity({ name: "easy-pi", configDir: ".pi" })).toEqual(resolveProductIdentity());
		expect(resolveProductIdentity({ configDir: ".custom" }).configDirName).toBe(".custom");
	});

	test("preserves explicit custom branding and sanitizes custom hyphens", () => {
		expect(resolveProductIdentity({ name: "my-tau", configDir: ".tau" })).toEqual({
			appName: "my-tau",
			appTitle: "my-tau",
			configDirName: ".tau",
			envAgentDir: "MY_TAU_CODING_AGENT_DIR",
			envSessionDir: "MY_TAU_CODING_AGENT_SESSION_DIR",
		});
		expect(resolveProductIdentity({ name: "tau", configDir: ".pi" }).configDirName).toBe(".pi");
	});

	test("applies independent identity to the actual product manifest", () => {
		expect(config.APP_NAME).toBe("easy-pi");
		expect(config.APP_TITLE).toBe("easy-pi");
		expect(config.CONFIG_DIR_NAME).toBe(".easy-pi");
		expect(config.ENV_AGENT_DIR).toBe("EASY_PI_CODING_AGENT_DIR");
		expect(config.ENV_SESSION_DIR).toBe("EASY_PI_CODING_AGENT_SESSION_DIR");
	});
});

describe("easy-pi data isolation", () => {
	test("ignores legacy overrides and leaves synthetic legacy auth untouched", () => {
		const legacyAuth = join(home, ".pi", "agent", "auth.json");
		fixture(legacyAuth, "synthetic legacy sentinel, not credentials");
		const agentDir = join(home, ".easy-pi", "agent");
		expect(config.getAgentDir()).toBe(agentDir);
		for (const [getter, suffix] of [
			[config.getAuthPath, "auth.json"],
			[config.getModelsPath, "models.json"],
			[config.getSettingsPath, "settings.json"],
			[config.getSessionsDir, "sessions"],
			[config.getCustomThemesDir, "themes"],
			[config.getPromptsDir, "prompts"],
			[config.getToolsDir, "tools"],
			[config.getBinDir, "bin"],
			[config.getDebugLogPath, "easy-pi-debug.log"],
		] as const) {
			expect(getter()).toBe(join(agentDir, suffix));
		}
		expect(readFileSync(legacyAuth, "utf-8")).toBe("synthetic legacy sentinel, not credentials");
		expect(existsSync(agentDir)).toBe(false);
	});

	test("honors easy-pi overrides independently of package relocation", () => {
		vi.stubEnv("EASY_PI_CODING_AGENT_DIR", "~/explicit-agent");
		vi.stubEnv("EASY_PI_CODING_AGENT_SESSION_DIR", "~/explicit-sessions");
		expect(config.getAgentDir()).toBe(join(home, "explicit-agent"));
		expect(config.getAuthPath()).toBe(join(home, "explicit-agent", "auth.json"));
		// CLI applies ENV_SESSION_DIR separately; this getter stays agent-relative.
		expect(config.getSessionsDir()).toBe(join(home, "explicit-agent", "sessions"));
		expect(config.expandTildePath(process.env[config.ENV_SESSION_DIR]!)).toBe(join(home, "explicit-sessions"));
		vi.stubEnv("PI_PACKAGE_DIR", join(root, "other-package"));
		expect(config.getPackageDir()).toBe(join(root, "other-package"));
		expect(config.getAgentDir()).toBe(join(home, "explicit-agent"));
		vi.stubEnv("EASY_PI_CODING_AGENT_DIR", "");
		expect(config.getAgentDir()).toBe(join(home, ".easy-pi", "agent"));
	});

	test("loads only easy-pi default user and project skills", () => {
		const cwd = join(root, "project");
		for (const [base, name] of [
			[join(home, ".pi", "agent"), "legacy-user"],
			[join(cwd, ".pi"), "legacy-project"],
			[join(home, ".easy-pi", "agent"), "easy-user"],
			[join(cwd, ".easy-pi"), "easy-project"],
		]) {
			fixture(join(base, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Synthetic skill\n---\nTest`);
		}
		const result = loadSkills({ cwd, agentDir: config.getAgentDir(), skillPaths: [], includeDefaults: true });
		expect(result.skills.map((skill) => skill.name).sort()).toEqual(["easy-project", "easy-user"]);
		expect(result.diagnostics).toEqual([]);
	});
});
