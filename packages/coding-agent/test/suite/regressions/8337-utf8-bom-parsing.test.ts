import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processFileArguments } from "../../../src/cli/file-processor.ts";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../../../src/config.ts";
import { AuthStorage, ReadOnlyAuthStorage, readStoredCredential } from "../../../src/core/auth-storage.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelConfig } from "../../../src/core/model-config.ts";
import { FileModelsStore } from "../../../src/core/models-store.ts";
import { DefaultPackageManager } from "../../../src/core/package-manager.ts";
import { readPiManifest } from "../../../src/core/pi-manifest.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createEditTool } from "../../../src/core/tools/edit.ts";
import { computeEditsDiff } from "../../../src/core/tools/edit-diff.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { runMigrations } from "../../../src/migrations.ts";
import { editInExternalEditor } from "../../../src/modes/interactive/external-editor.ts";
import { loadThemeFromPath } from "../../../src/modes/interactive/theme/theme.ts";
import { parseFrontmatter, stripFrontmatter } from "../../../src/utils/frontmatter.ts";
import { splitBom, stripBom } from "../../../src/utils/text.ts";
import { createHarness, type Harness } from "../harness.ts";

const configUrl = new URL("../../../src/config.ts", import.meta.url).href;
const darkThemePath = fileURLToPath(new URL("../../../src/modes/interactive/theme/dark.json", import.meta.url));

describe("leading UTF-8 BOM helpers", () => {
	it.each([
		{ content: "", bom: "", text: "" },
		{ content: "plain", bom: "", text: "plain" },
		{ content: "\uFEFF", bom: "\uFEFF", text: "" },
		{ content: "\uFEFFplain", bom: "\uFEFF", text: "plain" },
		{ content: "plain\uFEFFtext", bom: "", text: "plain\uFEFFtext" },
		{ content: "\uFEFF\uFEFFplain", bom: "\uFEFF", text: "\uFEFFplain" },
		{ content: " \uFEFFplain", bom: "", text: " \uFEFFplain" },
	])("normalizes only one leading marker in $content", ({ content, bom, text }) => {
		expect(splitBom(content)).toEqual({ bom, text });
		expect(stripBom(content)).toBe(text);
		expect(bom + text).toBe(content);
	});
});

describe.each(["", "\uFEFF"])("issue #8337 UTF-8 BOM parsing (prefix %j)", (prefix) => {
	let harness: Harness;
	let agentDir: string;
	let projectDir: string;

	beforeEach(async () => {
		harness = await createHarness();
		agentDir = join(harness.tempDir, "agent");
		projectDir = join(harness.tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		vi.stubEnv("HOME", harness.tempDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		harness.cleanup();
	});

	it("loads frontmatter across CRLF and preserves embedded markers in the body", () => {
		const body = "Body\uFEFFtext";
		const document = `${prefix}---\r\nname: demo\r\ndescription: Test\r\n---\r\n${body}`;
		expect(parseFrontmatter(document)).toEqual({
			frontmatter: { name: "demo", description: "Test" },
			body,
		});
		expect(stripFrontmatter(document)).toBe(body);
		expect(parseFrontmatter(`${prefix}${body}`)).toEqual({ frontmatter: {}, body });
	});

	it("loads global/project settings and merges current file settings when writing", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, `${prefix}${JSON.stringify({ defaultModel: "global-model" })}`);
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			`${prefix}${JSON.stringify({ defaultProvider: "project-provider" })}`,
		);
		const settings = SettingsManager.create(projectDir, agentDir);
		expect(settings.getDefaultModel()).toBe("global-model");
		expect(settings.getDefaultProvider()).toBe("project-provider");
		expect(settings.drainErrors()).toEqual([]);
		writeFileSync(settingsPath, `${prefix}${JSON.stringify({ defaultModel: "global-model", unknown: "keep" })}`);
		settings.setTheme("dark");
		await settings.flush();
		expect(settings.drainErrors()).toEqual([]);
		const written = readFileSync(settingsPath, "utf-8");
		expect(written).not.toMatch(/^\uFEFF/);
		expect(JSON.parse(written)).toEqual({ defaultModel: "global-model", unknown: "keep", theme: "dark" });
		await settings.reload();
		expect(settings.getDefaultModel()).toBe("global-model");
	});

	it("reads synthetic credentials through all auth readers and preserves unrelated entries on mutation", async () => {
		const authPath = join(agentDir, "auth.json");
		const credential = { type: "api_key" as const, key: "8337-synthetic-key" };
		writeFileSync(authPath, `${prefix}${JSON.stringify({ demo: credential, other: credential })}`);
		expect(readStoredCredential("demo", authPath)).toEqual(credential);
		await expect(new ReadOnlyAuthStorage(authPath).read("demo")).resolves.toEqual(credential);
		const auth = AuthStorage.create(authPath);
		await expect(auth.read("demo")).resolves.toEqual(credential);
		await auth.modify("demo", async () => ({ type: "api_key", key: "updated-synthetic-key" }));
		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			demo: { type: "api_key", key: "updated-synthetic-key" },
			other: credential,
		});
	});

	it("loads commented model configuration and cached provider catalogs", async () => {
		const modelsPath = join(agentDir, "models.json");
		writeFileSync(modelsPath, `${prefix}{\n// local configuration\n"providers": {"demo": {"name": "Demo"}}\n}`);
		const config = await ModelConfig.load(modelsPath);
		expect(config.getError()).toBeUndefined();
		expect(config.getProvider("demo")).toEqual({ name: "Demo" });
		const storePath = join(agentDir, "models-store.json");
		const entry = { models: [harness.getModel()], checkedAt: 100 };
		writeFileSync(storePath, `${prefix}${JSON.stringify({ demo: entry })}`);
		const store = new FileModelsStore(storePath);
		await expect(store.read("demo")).resolves.toEqual(entry);
		await store.write("other", { models: [], checkedAt: 200 });
		expect(JSON.parse(readFileSync(storePath, "utf-8"))).toEqual({
			demo: entry,
			other: { models: [], checkedAt: 200 },
		});
	});

	it("loads keybindings and migrates legacy keybindings and auth files", () => {
		const keybindingsPath = join(agentDir, "keybindings.json");
		writeFileSync(keybindingsPath, `${prefix}${JSON.stringify({ interrupt: "ctrl+q" })}`);
		expect(KeybindingsManager.create(agentDir).getEffectiveConfig()["app.interrupt"]).toBe("ctrl+q");
		writeFileSync(
			join(agentDir, "oauth.json"),
			`${prefix}${JSON.stringify({ demo: { access: "fake", refresh: "fake", expires: 123 } })}`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			`${prefix}${JSON.stringify({ apiKeys: { other: "fake-key" }, theme: "dark" })}`,
		);
		const migrated = runMigrations(projectDir);
		expect(migrated.migratedAuthProviders).toEqual(["demo", "other"]);
		expect(JSON.parse(readFileSync(keybindingsPath, "utf-8"))).toEqual({ "app.interrupt": "ctrl+q" });
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"))).toEqual({ theme: "dark" });
		expect(readStoredCredential("other", join(agentDir, "auth.json"))).toEqual({ type: "api_key", key: "fake-key" });
	});

	it("loads trust decisions and retains them when adding a new decision", () => {
		const path = join(agentDir, "trust.json");
		writeFileSync(path, `${prefix}${JSON.stringify({ [realpathSync(harness.tempDir)]: false })}`);
		const trust = new ProjectTrustStore(agentDir);
		expect(trust.get(projectDir)).toBe(false);
		trust.set(projectDir, true);
		expect(trust.get(projectDir)).toBe(true);
		expect(trust.get(agentDir)).toBe(false);
	});

	it("resolves installed package versions and non-conventional manifest resources offline", async () => {
		const packageDir = join(agentDir, "npm", "node_modules", "bom-package");
		const promptPath = join(packageDir, "custom", "demo.md");
		mkdirSync(join(packageDir, "custom"), { recursive: true });
		writeFileSync(promptPath, "Prompt");
		const manifest = { prompts: ["custom/demo.md"] };
		const packagePath = join(packageDir, "package.json");
		writeFileSync(packagePath, `${prefix}${JSON.stringify({ name: "bom-package", version: "1.0.0", pi: manifest })}`);
		expect(readPiManifest(packagePath)).toEqual(manifest);
		const manager = new DefaultPackageManager({
			cwd: projectDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ packages: ["npm:bom-package@1.0.0"] }),
		});
		const resources = await manager.resolve();
		expect(resources.prompts.map((prompt) => prompt.path)).toContain(promptPath);
	});

	it("detects missing Git-package dependencies in a BOM-prefixed manifest without invoking installation", () => {
		const packageDir = join(harness.tempDir, "git-package");
		mkdirSync(packageDir);
		writeFileSync(
			join(packageDir, "package.json"),
			`${prefix}${JSON.stringify({ dependencies: { demo: "1.0.0" } })}`,
		);
		const manager = new DefaultPackageManager({
			cwd: projectDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
		});
		const internals = manager as unknown as { hasMissingGitDependencies(path: string): boolean };
		expect(internals.hasMissingGitDependencies(packageDir)).toBe(true);
		mkdirSync(join(packageDir, "node_modules", "demo"), { recursive: true });
		expect(internals.hasMissingGitDependencies(packageDir)).toBe(false);
	});

	it("normalizes CLI text attachments, context, file-backed prompts, skills and prompt templates", async () => {
		const text = "First\uFEFFsecond\n";
		const textPath = join(projectDir, "input.txt");
		writeFileSync(textPath, `${prefix}${text}`);
		expect(await processFileArguments([textPath])).toEqual({
			text: `<file name="${textPath}">\n${text}\n</file>\n`,
			images: [],
		});
		writeFileSync(join(agentDir, "AGENTS.md"), `${prefix}Global context`);
		writeFileSync(join(projectDir, "AGENTS.md"), `${prefix}Project context`);
		writeFileSync(join(agentDir, "SYSTEM.md"), `${prefix}System prompt`);
		writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), `${prefix}Append prompt`);
		mkdirSync(join(agentDir, "skills", "demo"), { recursive: true });
		mkdirSync(join(agentDir, "prompts"), { recursive: true });
		writeFileSync(
			join(agentDir, "skills", "demo", "SKILL.md"),
			`${prefix}---\nname: demo\ndescription: Demo skill\n---\nSkill body`,
		);
		writeFileSync(join(agentDir, "prompts", "demo.md"), `${prefix}---\ndescription: Demo prompt\n---\nPrompt body`);
		const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir, noExtensions: true, noThemes: true });
		await loader.reload();
		expect(
			loader
				.getAgentsFiles()
				.agentsFiles.filter((file) => file.path.startsWith(harness.tempDir))
				.map((file) => file.content),
		).toEqual(["Global context", "Project context"]);
		expect(loader.getSystemPrompt()).toBe("System prompt");
		expect(loader.getAppendSystemPrompt()).toEqual(["Append prompt"]);
		expect(loader.getSkills().skills.find((skill) => skill.name === "demo")?.description).toBe("Demo skill");
		expect(loader.getPrompts().prompts.find((prompt) => prompt.name === "demo")).toMatchObject({
			description: "Demo prompt",
			content: "Prompt body",
		});
	});

	it("loads custom theme JSON", () => {
		const themePath = join(agentDir, "theme.json");
		const original = JSON.parse(readFileSync(darkThemePath, "utf-8"));
		writeFileSync(themePath, `${prefix}${JSON.stringify({ ...original, name: "bom-demo" })}`);
		expect(loadThemeFromPath(themePath).name).toBe("bom-demo");
	});

	it("loads the application package metadata without changing .epi identity", () => {
		const packageDir = join(harness.tempDir, "assets");
		mkdirSync(packageDir);
		writeFileSync(
			join(packageDir, "package.json"),
			`${prefix}${JSON.stringify({ name: "demo-package", version: "1.2.3" })}`,
		);
		const probePath = join(harness.tempDir, "config-probe.mjs");
		writeFileSync(
			probePath,
			`import { VERSION, PACKAGE_NAME, CONFIG_DIR_NAME } from ${JSON.stringify(configUrl)};\nconsole.log(JSON.stringify({ VERSION, PACKAGE_NAME, CONFIG_DIR_NAME }));\n`,
		);
		const probe = spawnSync(process.execPath, [probePath], {
			encoding: "utf-8",
			env: { ...process.env, PI_PACKAGE_DIR: packageDir },
		});
		expect(probe.status, probe.stderr).toBe(0);
		expect(JSON.parse(probe.stdout)).toEqual({
			VERSION: "1.2.3",
			PACKAGE_NAME: "demo-package",
			CONFIG_DIR_NAME: ".epi",
		});
	});

	it("strips an editor-produced marker but preserves embedded markers and removes only one final newline", async () => {
		const editorPath = join(harness.tempDir, "fake-editor.mjs");
		const edited = `${prefix}Edited\uFEFFtext\n\n`;
		writeFileSync(
			editorPath,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], ${JSON.stringify(edited)});\n`,
		);
		await expect(
			editInExternalEditor({ command: `${process.execPath} ${editorPath}`, content: "Original" }),
		).resolves.toEqual({ status: "complete", content: "Edited\uFEFFtext\n" });
	});

	it("preserves BOM, CRLF and untouched fuzzy-edit bytes in both preview and writeback", async () => {
		const path = join(projectDir, "edit.txt");
		const original = `${prefix}const label = “old”;  \r\nconst untouched = “keep”;  \r\n`;
		writeFileSync(path, original);
		const edits = [{ oldText: 'const label = "old";', newText: 'const label = "new";' }];
		const preview = await computeEditsDiff(path, edits, projectDir);
		expect(preview).not.toHaveProperty("error");
		expect(readFileSync(path, "utf-8")).toBe(original);
		const result = await createEditTool(projectDir).execute("bom-edit", { path, edits });
		expect(result.details).toMatchObject(preview);
		expect(readFileSync(path, "utf-8")).toBe(`${prefix}const label = "new";\r\nconst untouched = “keep”;  \r\n`);
	});
});
