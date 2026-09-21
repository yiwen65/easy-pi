import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createNativeComputerFeature, shouldActivateComputer } from "../../src/core/computer/activation.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function assets(source?: string): string {
	const directory = mkdtempSync(join(tmpdir(), "computer-activation-"));
	directories.push(directory);
	vi.stubEnv("PI_PACKAGE_DIR", directory);
	writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "commonjs" }));
	if (source) {
		mkdirSync(join(directory, "computer"));
		writeFileSync(join(directory, "computer", "bridge.js"), source);
	}
	return directory;
}

describe("explicit Computer activation", () => {
	it("resolves the trusted application emergency binding without dropping secondary keys", () => {
		const directory = assets(
			"exports.computerFeatureVersion = 2; exports.createComputerFeature = options => { throw Error(JSON.stringify(options)); };",
		);
		vi.stubEnv(ENV_AGENT_DIR, directory);
		writeFileSync(
			join(directory, "keybindings.json"),
			JSON.stringify({ "app.computer.emergencyStop": "super+shift+a" }),
		);
		expect(KeybindingsManager.create(directory).getKeys("app.computer.emergencyStop")).toEqual(["super+shift+a"]);
		expect(() => createNativeComputerFeature()).toThrow(JSON.stringify({ emergencyChord: ["super+shift+a"] }));
		for (const binding of [[], ["ctrl+a", "ctrl+b"], ["ctrl+a", "ctrl+a"], "", null]) {
			writeFileSync(join(directory, "keybindings.json"), JSON.stringify({ "app.computer.emergencyStop": binding }));
			expect(() => KeybindingsManager.create(directory)).toThrow("exactly one");
		}
	});
	it("parses only explicit opt-in and leaves ordinary arguments unchanged", () => {
		expect(parseArgs(["hello"]).computer).toBeUndefined();
		const args = parseArgs(["--computer", "--computer-manifest", "/trusted/capabilities.yaml", "hello"]);
		expect(args.computer).toBe(true);
		expect(args.computerManifest).toBe("/trusted/capabilities.yaml");
		expect(args.messages).toEqual(["hello"]);
		expect(args.unknownFlags.size).toBe(0);
		expect(args.diagnostics).toEqual([]);
		expect(parseArgs(["--computer-manifest"]).diagnostics).toHaveLength(1);
		expect(parseArgs(["--computer-manifest", "/trusted/policy"]).diagnostics).toHaveLength(1);
		const browser = parseArgs(["--computer-browser", "/trusted/Chrome for Testing.app"]);
		expect(browser.computer).toBe(true);
		expect(browser.computerBrowser).toBe("/trusted/Chrome for Testing.app");
		expect(browser.diagnostics).toEqual([]);
		expect(parseArgs(["--computer-browser"]).diagnostics).toHaveLength(1);
	});

	it("rejects empty authority/profile values instead of silently falling back to unrestricted desktop mode", () => {
		for (const flag of ["--computer-manifest", "--computer-browser"]) {
			for (const value of ["", "   "]) {
				expect(parseArgs(["--computer", flag, value]).diagnostics.some((row) => row.type === "error")).toBe(true);
			}
		}
	});

	it("uses existing allowlist/exclusion precedence and suppresses metadata-only activation", () => {
		for (const args of [
			[],
			["--tools", "computer"],
			["--computer", "--no-tools"],
			["--computer", "--tools", "read"],
			["--computer", "--exclude-tools", "computer"],
			["--computer", "--tools", "computer", "--exclude-tools", "computer"],
			["--computer", "--help"],
			["--computer", "--list-models"],
			["--computer-browser", "/trusted/CfT.app", "--no-tools"],
		]) {
			expect(shouldActivateComputer(parseArgs(args)), args.join(" ")).toBe(false);
		}
		for (const args of [
			["--computer"],
			["--computer", "--no-builtin-tools"],
			["--computer", "--no-tools", "--tools", "computer"],
			["--computer", "--tools", "read,computer"],
			["--computer-browser", "/trusted/CfT.app"],
		]) {
			expect(shouldActivateComputer(parseArgs(args)), args.join(" ")).toBe(true);
		}
	});

	it("does not need assets for a disabled or filtered phase", () => {
		assets('throw new Error("must not import");');
		const enabled = shouldActivateComputer(parseArgs(["--computer", "--no-tools"]));
		expect(enabled ? createNativeComputerFeature() : undefined).toBeUndefined();
	});

	it("reports missing and incompatible optional assets without a fallback", () => {
		assets();
		expect(() => createNativeComputerFeature()).toThrow("install the matching optional Computer assets");
		assets("exports.computerFeatureVersion = 0; exports.createComputerFeature = () => { throw Error('wrong'); };");
		expect(() => createNativeComputerFeature()).toThrow("do not match this host interface");
	});

	it("passes only explicit host options to the versioned factory and rejects relative manifests", () => {
		const directory = assets(
			"exports.computerFeatureVersion = 2; exports.createComputerFeature = options => { throw Error(JSON.stringify(options)); };",
		);
		expect(() => createNativeComputerFeature({ manifestPath: "project/policy.yaml" })).toThrow("absolute");
		expect(() => createNativeComputerFeature({ browserBundlePath: "project/CfT.app" })).toThrow("absolute");
		const manifestPath = join(directory, "policy.yaml");
		expect(() => createNativeComputerFeature({ manifestPath })).toThrow(
			JSON.stringify({ manifestPath, emergencyChord: ["ctrl+alt+escape"] }),
		);
		expect(() => createNativeComputerFeature({ emergencyChord: "super+shift+a" })).toThrow(
			JSON.stringify({ emergencyChord: "super+shift+a" }),
		);
	});
});
