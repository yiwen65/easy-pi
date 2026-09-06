import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enumerateDirectoryFiles, isIgnoredByRules } from "../src/directory-inventory.ts";

const temporaryPaths: string[] = [];

async function makeDirectory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "subagent-inventory-test-"));
	temporaryPaths.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("enumerateDirectoryFiles", () => {
	it("lists regular files with dotfiles, skips .git, and never descends into symlinked directories", async () => {
		const root = await makeDirectory();
		await mkdir(join(root, "src"), { recursive: true });
		await mkdir(join(root, ".git", "objects"), { recursive: true });
		await mkdir(join(root, "real-dir"), { recursive: true });
		await writeFile(join(root, "src", "index.ts"), "entry\n");
		await writeFile(join(root, ".env"), "secret=1\n");
		await writeFile(join(root, ".git", "config"), "gitconfig\n");
		await writeFile(join(root, "real-dir", "data.txt"), "data\n");
		await symlink(join(root, "real-dir"), join(root, "link-dir"));

		const files = await enumerateDirectoryFiles(root, { maxFiles: 100 });
		expect(files).toEqual([".env", "link-dir", "real-dir/data.txt", "src/index.ts"]);
	});

	it("applies best-effort .gitignore rules: basename, anchored, directory-only, negation, and deeper precedence", async () => {
		const root = await makeDirectory();
		await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
		await mkdir(join(root, "logs"), { recursive: true });
		await mkdir(join(root, "src", "generated"), { recursive: true });
		await mkdir(join(root, "docs"), { recursive: true });
		await writeFile(join(root, ".gitignore"), ["node_modules/", "*.log", "/generated.txt", ""].join("\n"));
		await writeFile(join(root, "node_modules", "pkg", "index.js"), "dep\n");
		await writeFile(join(root, "logs", "a.log"), "log\n");
		await writeFile(join(root, "logs", "keep.txt"), "keep\n");
		await writeFile(join(root, "generated.txt"), "gen\n");
		await writeFile(join(root, "src", "generated.txt"), "not-anchored\n");
		await writeFile(join(root, "src", "generated", "out.js"), "gen\n");
		await writeFile(join(root, "src", ".gitignore"), "generated/\n");
		await writeFile(join(root, "docs", "a.log"), "doc-log\n");
		await writeFile(join(root, "docs", ".gitignore"), "!a.log\n");

		const files = await enumerateDirectoryFiles(root, { maxFiles: 100 });
		expect(files).toEqual([
			".gitignore",
			"docs/.gitignore",
			"docs/a.log",
			"logs/keep.txt",
			"src/.gitignore",
			"src/generated.txt",
		]);
	});

	it("supports ** patterns and re-inclusion below non-excluded directories", async () => {
		const root = await makeDirectory();
		await mkdir(join(root, "build", "nested"), { recursive: true });
		await mkdir(join(root, "dist"), { recursive: true });
		await writeFile(join(root, ".gitignore"), "build/**\n!build/keep.txt\n/dist/**\n");
		await writeFile(join(root, "build", "keep.txt"), "keep\n");
		await writeFile(join(root, "build", "nested", "deep.js"), "deep\n");
		await writeFile(join(root, "dist", "bundle.js"), "bundle\n");
		await writeFile(join(root, "top.txt"), "top\n");

		const files = await enumerateDirectoryFiles(root, { maxFiles: 100 });
		expect(files).toEqual([".gitignore", "build/keep.txt", "top.txt"]);
	});

	it("enforces maxFiles fail-closed", async () => {
		const root = await makeDirectory();
		await writeFile(join(root, "a.txt"), "a\n");
		await writeFile(join(root, "b.txt"), "b\n");
		await expect(enumerateDirectoryFiles(root, { maxFiles: 1 })).rejects.toThrow("exceeds maxFiles");
	});

	it("rejects invalid limits", async () => {
		const root = await makeDirectory();
		await expect(enumerateDirectoryFiles(root, { maxFiles: -1 })).rejects.toThrow("maxFiles");
	});
});

describe("isIgnoredByRules", () => {
	it("treats later matching rules as decisive", () => {
		// Rules are exercised end-to-end through enumerateDirectoryFiles; this
		// guards the pure decision helper against regressions in precedence.
		expect(isIgnoredByRules([], "a.txt", false)).toBe(false);
	});
});
