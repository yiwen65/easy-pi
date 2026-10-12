import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createModelDataManifest, validateNormalizedSnapshot } from "../packages/ai/scripts/model-data.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const version = "0.1.2";
const generatedAt = "2026-01-02T03:04:05.678Z";
const chat = {
	type: "chat", id: "same", provider: "fixture", api: "custom-chat", name: "Chat same",
	baseUrl: "https://fixture.invalid", input: ["text"], reasoning: false,
	cost: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 3 }, contextWindow: 1000, maxTokens: 100,
};
const image = {
	type: "image", id: "same", provider: "fixture", api: "custom-image", name: "Image same",
	baseUrl: "https://fixture.invalid", input: ["text", "image"], output: ["image", "text"],
	cost: { input: 0.10000000000000002, output: -1, cacheRead: 0, cacheWrite: 0 },
};

function write(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/**
 * Skip reason for tests that need `git archive --mtime`, or undefined when the installed git
 * supports it. The option was added in git 2.38; older builds reject it with
 * "error: unknown option `mtime=@...`". The source archive must stay byte-deterministic, so the
 * script refuses to run instead of falling back to checkout timestamps.
 */
function gitArchiveMtimeSkipReason() {
	const result = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 10_000 });
	if (result.error !== undefined || result.status !== 0) return "git is not available on PATH";
	const versionOutput = result.stdout.trim();
	const match = /^git version (\d+)\.(\d+)(?:\.\d+)?/.exec(versionOutput);
	if (match === null) return `unexpected git --version output: ${versionOutput}`;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	if (major > 2 || (major === 2 && minor >= 38)) return undefined;
	return `git ${versionOutput.split(" ")[2]} does not support \`git archive --mtime\` (added in git 2.38)`;
}

function fixture(t, { includeModelCatalog = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-source-archive-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		GIT_AUTHOR_DATE: generatedAt, GIT_COMMITTER_DATE: generatedAt,
	};
	// Every git command, including initial staging/commit, operates only in this
	// independent synthetic repository; no worktree index or history is touched.
	const git = (...args) => {
		const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	git("-c", "init.templateDir=", "init", "--quiet");
	const sources = [
		"scripts/create-source-archive.sh", "packages/ai/scripts/check-model-data.ts",
		"packages/ai/scripts/model-data.ts",
		...(includeModelCatalog ? ["packages/ai/src/model-catalog.ts"] : []),
	];
	for (const path of sources) write(join(root, path), readFileSync(join(repoRoot, path)));
	const files = {
		".gitignore": "packages/ai/src/providers/data/\n",
		"package.json": JSON.stringify({ name: "archive-fixture", private: true, type: "module", version }),
		"package-lock.json": JSON.stringify({ name: "archive-fixture", lockfileVersion: 3 }),
		"scripts/build-binaries.sh": "#!/usr/bin/env bash\n# fixture only; never run\n",
		"packages/coding-agent/package.json": JSON.stringify({ name: "archive-fixture-agent", version }),
		"packages/coding-agent/src/utils/image-resize-worker.ts": "// fixture worker\n",
		"packages/coding-agent/src/core/export-html/template.css": "/* fixture template */\n",
		"packages/ai/src/models.generated.ts": 'import { FIXTURE_MODELS, FIXTURE_IMAGE_MODELS } from "./providers/fixture.models.ts";\nexport const MODELS = { fixture: FIXTURE_MODELS };\nexport const IMAGE_MODELS = { fixture: FIXTURE_IMAGE_MODELS };\n',
		"packages/ai/src/providers/fixture.models.ts": 'import values from "./data/fixture.json" with { type: "json" };\nimport { flattenChatModelCatalog, flattenImageModelCatalog } from "../model-catalog.ts";\nexport const FIXTURE_MODELS = flattenChatModelCatalog("fixture", values);\nexport const FIXTURE_IMAGE_MODELS = flattenImageModelCatalog("fixture", values);\n',
	};
	for (const [path, content] of Object.entries(files)) write(join(root, path), content);
	git("add", "--", ...sources, ...Object.keys(files));
	git("commit", "--quiet", "-m", "Synthetic unified archive fixture");
	const commit = git("rev-parse", "HEAD");
	const dataDir = join(root, "packages/ai/src/providers/data");
	const data = { "custom-chat": { "chat:same": chat }, "custom-image": { "image:same": image } };
	validateNormalizedSnapshot({ generatedAt, models: [chat, image] });
	const writeData = (values = data) => {
		const content = `${JSON.stringify(values)}\n`;
		write(join(dataDir, "fixture.json"), content);
		write(join(dataDir, ".manifest.json"), `${JSON.stringify(createModelDataManifest(
			{ fixture: { "chat:same": "custom-chat", "image:same": "custom-image" } },
			{ "fixture.json": content }, generatedAt,
		))}\n`);
	};
	writeData();
	assert.equal(git("ls-files", "--", "packages/ai/src/providers/data"), "");
	const indexBytes = readFileSync(join(root, ".git/index"));
	const archive = (output = join(root, "source.tar.gz")) => {
		const result = spawnSync("bash", [join(root, "scripts/create-source-archive.sh"), "--version", version, "--ref", commit, "--out", output], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
		assert.deepEqual(readFileSync(join(root, ".git/index")), indexBytes, "Temporary index injection must not change the repository index");
		assert.ok(!readdirSync(root).some((name) => /\.tar\.gz\.(?:tmp|index|manifest|validation)\./.test(name)), "Temporary archive/index/validation files must be cleaned");
		return { ...result, output };
	};
	return { root, dataDir, data, env, commit, git, archive, writeData };
}

test("archives schema4 same-ID chat/image data and validates it from archived source", (t) => {
	const skipReason = gitArchiveMtimeSkipReason();
	if (skipReason !== undefined) {
		t.skip(skipReason);
		return;
	}
	const f = fixture(t);
	const result = f.archive();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Generated model data is valid/);
	const list = spawnSync("tar", ["-tzf", result.output], { encoding: "utf8" });
	assert.equal(list.status, 0, list.stderr);
	const paths = list.stdout.trim().split("\n");
	const prefix = `pi-${version}/`;
	assert.ok(paths.every((path) => path.startsWith(prefix)));
	assert.ok(paths.includes(`${prefix}packages/ai/src/model-catalog.ts`));
	assert.ok(paths.includes(`${prefix}packages/ai/src/providers/data/fixture.json`));
	assert.ok(!paths.includes(`${prefix}packages/ai/src/image-models.generated.ts`));
	assert.ok(!paths.some((path) => path.includes("/node_modules/")));
	const extracted = join(f.root, "extracted");
	mkdirSync(extracted);
	const extraction = spawnSync("tar", ["-xzf", result.output, "-C", extracted], { encoding: "utf8" });
	assert.equal(extraction.status, 0, extraction.stderr);
	const aiRoot = join(extracted, `pi-${version}`, "packages/ai");
	const values = JSON.parse(readFileSync(join(aiRoot, "src/providers/data/fixture.json"), "utf8"));
	assert.deepEqual(values["custom-chat"]["chat:same"], chat);
	assert.deepEqual(values["custom-image"]["image:same"], image);
	const manifest = JSON.parse(readFileSync(join(aiRoot, "src/providers/data/.manifest.json"), "utf8"));
	assert.equal(manifest.schemaVersion, 4);
	assert.equal(manifest.generatedAt, generatedAt);
	const checker = spawnSync(process.execPath, [join(aiRoot, "scripts/check-model-data.ts")], { cwd: extracted, env: f.env, encoding: "utf8" });
	assert.equal(checker.status, 0, checker.stderr);
	assert.match(checker.stdout, /Generated model data is valid/);
	assert.equal(f.git("rev-parse", "HEAD"), f.commit);
	assert.equal(f.git("diff", "--cached", "--name-only"), "");
});

test("same commit and ignored mixed data produce byte-identical deterministic archives", (t) => {
	const skipReason = gitArchiveMtimeSkipReason();
	if (skipReason !== undefined) {
		t.skip(skipReason);
		return;
	}
	const f = fixture(t);
	const first = f.archive(join(f.root, "first.tar.gz"));
	const second = f.archive(join(f.root, "second.tar.gz"));
	assert.equal(first.status, 0, first.stderr);
	assert.equal(second.status, 0, second.stderr);
	const firstBytes = readFileSync(first.output);
	const secondBytes = readFileSync(second.output);
	assert.deepEqual(firstBytes, secondBytes);
	assert.equal(createHash("sha256").update(firstBytes).digest("hex"), createHash("sha256").update(secondBytes).digest("hex"));
});

test("still requires the unified model-catalog source module", (t) => {
	const skipReason = gitArchiveMtimeSkipReason();
	if (skipReason !== undefined) {
		t.skip(skipReason);
		return;
	}
	const f = fixture(t, { includeModelCatalog: false });
	const result = f.archive();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Source archive is missing required path: packages\/ai\/src\/model-catalog\.ts/);
	assert.equal(existsSync(result.output), false);
});

for (const [label, filename] of [["manifest", ".manifest.json"], ["provider data", "fixture.json"]]) {
	test(`missing ${label} fails without replacing a previous output`, (t) => {
		const f = fixture(t);
		rmSync(join(f.dataDir, filename));
		const output = join(f.root, "source.tar.gz");
		write(output, "previous output must survive");
		const result = f.archive(output);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Generated model data is missing/);
		assert.equal(readFileSync(output, "utf8"), "previous output must survive");
	});
}

test("archived checker rejects a mismatched data hash without replacing previous output", (t) => {
	const skipReason = gitArchiveMtimeSkipReason();
	if (skipReason !== undefined) {
		t.skip(skipReason);
		return;
	}
	const f = fixture(t);
	const dataPath = join(f.dataDir, "fixture.json");
	writeFileSync(dataPath, readFileSync(dataPath, "utf8").replace("Image same", "Tampered image"));
	const output = join(f.root, "source.tar.gz");
	write(output, "previous output must survive");
	const result = f.archive(output);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /fixture\.json does not match its manifest hash/);
	assert.equal(readFileSync(output, "utf8"), "previous output must survive");
});

test("archived checker rejects malformed image metadata even with a matching manifest hash", (t) => {
	const skipReason = gitArchiveMtimeSkipReason();
	if (skipReason !== undefined) {
		t.skip(skipReason);
		return;
	}
	const f = fixture(t);
	f.writeData({ ...f.data, "custom-image": { "image:same": { ...image, output: ["text"] } } });
	const result = f.archive();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /fixture\/image:same has invalid image output modalities/);
	assert.equal(existsSync(result.output), false);
});

test("archived checker rejects a stale schema3 manifest", (t) => {
	const skipReason = gitArchiveMtimeSkipReason();
	if (skipReason !== undefined) {
		t.skip(skipReason);
		return;
	}
	const f = fixture(t);
	const path = join(f.dataDir, ".manifest.json");
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	manifest.schemaVersion = 3;
	writeFileSync(path, JSON.stringify(manifest));
	const result = f.archive();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /model data schema is 3, expected 4/);
	assert.equal(existsSync(result.output), false);
});

test("fails with an actionable message when git lacks `git archive --mtime`", (t) => {
	const skipReason = gitArchiveMtimeSkipReason();
	if (skipReason === undefined) {
		t.skip("installed git supports `git archive --mtime`; the missing-capability failure is unreachable");
		return;
	}
	const f = fixture(t);
	const result = f.archive();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /does not support 'git archive --mtime' \(added in git 2\.38\)/);
	assert.equal(existsSync(result.output), false);
});
