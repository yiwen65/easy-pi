import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readModelCatalog } from "./model-catalog.mjs";
import { buildIndex, validateBundle } from "./publish-model-catalog.mjs";

const publisher = fileURLToPath(new URL("./publish-model-catalog.mjs", import.meta.url));
const sourceCommit = "fixture-commit";

function json(path, value) {
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function model(provider, id, type = "chat") {
	return {
		type, provider, id, name: `${type} ${id}`, api: type === "chat" ? "custom-chat" : "custom-image",
		baseUrl: "https://fixture.invalid", input: ["text"],
		cost: { input: 0.10000000000000002, output: type === "chat" ? 4 : -1, cacheRead: 0, cacheWrite: 0 },
		...(type === "chat" ? { reasoning: false, contextWindow: 1000, maxTokens: 100 } : { output: ["image"] }),
	};
}

function records() {
	const chats = Array.from({ length: 500 }, (_, index) => model(["openrouter", "openai", "anthropic"][index % 3], index === 0 ? "same" : `chat-${index}`));
	return [...chats, model("openrouter", "same", "image"), model("image-only", "image", "image")];
}

function writeCatalog(root, models, { legacy = false } = {}) {
	const providers = [...new Set(models.map((entry) => entry.provider))].sort();
	const chats = Object.fromEntries(providers.map((provider) => [provider, Object.fromEntries(models.filter((entry) => entry.provider === provider && entry.type !== "image").map((entry) => [entry.id, entry]))]));
	mkdirSync(join(root, "providers"), { recursive: true });
	json(join(root, "models.json"), chats);
	json(join(root, "providers.json"), providers);
	if (!legacy) json(join(root, "models.all.json"), models);
	for (const provider of providers) {
		json(join(root, "providers", `${provider}.json`), chats[provider]);
		if (!legacy) json(join(root, "providers", `${provider}.all.json`), models.filter((entry) => entry.provider === provider));
	}
}

function fixture(t, models = records()) {
	const root = mkdtempSync(join(tmpdir(), "pi-publish-catalog-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const catalog = join(root, "catalog");
	writeCatalog(catalog, models);
	return { root, catalog };
}

function mockAws(root, currentIndex, { failUpload } = {}) {
	const bin = join(root, "bin");
	mkdirSync(bin);
	const log = join(root, "aws.json");
	json(log, []);
	const script = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const calls = JSON.parse(readFileSync(log, 'utf8'));
const download = args[2]?.startsWith('s3://');
const entry = { args, download };
if (!download) entry.content = readFileSync(args[2], 'utf8');
calls.push(entry); writeFileSync(log, JSON.stringify(calls));
if (args[0] !== 's3' || args[1] !== 'cp') throw new Error('Unexpected AWS command');
if (download) {
  const index = ${JSON.stringify(currentIndex ?? null)};
  if (!index) { console.error('404 NoSuchKey'); process.exit(1); }
  writeFileSync(args[3], JSON.stringify(index));
} else if (args[3].endsWith(${JSON.stringify(failUpload ?? "never-match")})) { console.error('injected upload failure'); process.exit(1); }
`;
	// An executable called aws is always first on PATH; no real CLI/credentials are used.
	writeFileSync(join(bin, "aws"), script, { mode: 0o755 });
	return { log, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

function publish(catalog, env = process.env, args = []) {
	return spawnSync(process.execPath, [publisher, "--input", catalog, "--source-commit", sourceCommit, ...args], { env, encoding: "utf8", timeout: 20_000 });
}

const publishArgs = ["--bucket", "fixture-bucket", "--endpoint", "https://fixture.invalid"];

test("retains keyed chat projections and counts same-ID image and image-only providers separately", (t) => {
	const { catalog } = fixture(t);
	const bundle = validateBundle(catalog);
	assert.equal(bundle.modelCount, 500);
	assert.equal(bundle.imageModelCount, 2);
	assert.equal(bundle.totalModelCount, 502);
	assert.equal(bundle.providerCount, 4);
	assert.deepEqual([...bundle.modelsByProvider.get("openrouter").values()].filter((entry) => entry.id === "same").map((entry) => entry.type), ["chat", "image"]);
	assert.deepEqual(readJson(join(catalog, "providers/image-only.json")), {});
	assert.equal(bundle.files.length, 11);
});

test("revision covers image-only metadata and every validated archived file, not publication time", (t) => {
	const models = records();
	const { catalog } = fixture(t, models);
	const before = validateBundle(catalog).revision;
	const chatBytes = readFileSync(join(catalog, "models.json"), "utf8");
	models.at(-2).headers = { "x-image-setting": "changed" };
	models.at(-2).output = ["text", "image"];
	models.at(-2).cost.output = 8;
	writeCatalog(catalog, models);
	const after = validateBundle(catalog).revision;
	assert.notEqual(before, after);
	assert.equal(readFileSync(join(catalog, "models.json"), "utf8"), chatBytes);
	json(join(catalog, "publication.json"), { publishedAt: "irrelevant" });
	assert.equal(validateBundle(catalog).revision, after);
	const shard = join(catalog, "providers/openrouter.all.json");
	writeFileSync(shard, JSON.stringify(readJson(shard), null, 2));
	assert.notEqual(validateBundle(catalog).revision, after);
});

for (const [label, value] of [["unknown", "classifier"], ["null", null], ["missing", undefined], ["numeric", 7]]) {
	test(`rejects ${label} operation type in mixed arrays`, (t) => {
		const { catalog } = fixture(t);
		const all = readJson(join(catalog, "models.all.json"));
		all.at(-1).type = value;
		json(join(catalog, "models.all.json"), all);
		assert.throws(() => validateBundle(catalog), /Invalid model entry/);
	});
}

for (const [label, value] of [["empty", ""], ["blank", " "], ["null", null], ["numeric", 1], ["control", "bad\nid"]]) {
	test(`rejects ${label} model ID`, (t) => {
		const { catalog } = fixture(t);
		const all = readJson(join(catalog, "models.all.json"));
		all.at(-1).id = value;
		json(join(catalog, "models.all.json"), all);
		assert.throws(() => validateBundle(catalog), /Invalid model entry/);
	});
}

for (const [label, value] of [["unknown", "not-in-index"], ["path traversal", "../escape"], ["empty", ""], ["null", null], ["numeric", 1]]) {
	test(`rejects ${label} model provider`, (t) => {
		const { catalog } = fixture(t);
		const all = readJson(join(catalog, "models.all.json"));
		all.at(-1).provider = value;
		json(join(catalog, "models.all.json"), all);
		assert.throws(() => validateBundle(catalog), /Invalid provider ID|Unknown provider/);
	});
}

test("rejects duplicate operations including cross-API duplicates", (t) => {
	const { catalog } = fixture(t);
	const all = readJson(join(catalog, "models.all.json"));
	all.push({ ...all.at(-1), api: "different-image-api" });
	json(join(catalog, "models.all.json"), all);
	assert.throws(() => validateBundle(catalog), /Duplicate model operation/);
});

for (const [label, mutate, expected] of [
	["chat shard metadata", (catalog) => json(join(catalog, "providers/openrouter.json"), {}), /Provider shard does not match/],
	["mixed shard metadata", (catalog) => json(join(catalog, "providers/openrouter.all.json"), []), /Provider mixed shard does not match/],
	["chat projection metadata", (catalog) => {
		const chats = readJson(join(catalog, "models.json"));
		chats.openrouter.same.name = "not-the-same";
		json(join(catalog, "models.json"), chats);
		json(join(catalog, "providers/openrouter.json"), chats.openrouter);
	}, /Chat projection does not match/],
	["chat keyed ID", (catalog) => {
		const chats = readJson(join(catalog, "models.json"));
		chats.openrouter.same.id = "other";
		json(join(catalog, "models.json"), chats);
		json(join(catalog, "providers/openrouter.json"), chats.openrouter);
	}, /Invalid chat model entry/],
	["extra shard", (catalog) => json(join(catalog, "providers/extra.all.json"), []), /Provider shard files/],
	["missing mixed shard", (catalog) => rmSync(join(catalog, "providers/openrouter.all.json")), /ENOENT/],
	["duplicate providers", (catalog) => json(join(catalog, "providers.json"), ["anthropic", "anthropic", "image-only", "openai", "openrouter"]), /sorted providers/],
	["provider path", (catalog) => json(join(catalog, "providers.json"), ["../escape"]), /Invalid provider ID/],
	["non-array all", (catalog) => json(join(catalog, "models.all.json"), {}), /must contain an array/],
	["missing all", (catalog) => rmSync(join(catalog, "models.all.json")), /required for publication/],
]) {
	test(`rejects inconsistent ${label}`, (t) => {
		const { catalog } = fixture(t);
		mutate(catalog);
		assert.throws(() => validateBundle(catalog), expected);
	});
}

test("preserves publication completeness guards: required providers and minimum chat count", (t) => {
	const { root } = fixture(t);
	const small = join(root, "small");
	writeCatalog(small, [model("anthropic", "a"), model("openai", "a"), model("openrouter", "a"), ...Array.from({ length: 501 }, (_, index) => model("openrouter", `image-${index}`, "image"))]);
	assert.throws(() => validateBundle(small), /only 3 models/);
	const missing = join(root, "missing-provider");
	writeCatalog(missing, records().filter((entry) => entry.provider !== "anthropic"));
	assert.throws(() => validateBundle(missing), /Required provider is missing: anthropic/);
});

test("legacy-only catalogs are allowed only for historical diffs, including implicit chat type", (t) => {
	const { root } = fixture(t);
	const catalog = join(root, "legacy");
	const chat = model("openrouter", "same");
	delete chat.type;
	writeCatalog(catalog, [chat], { legacy: true });
	const bundle = readModelCatalog(catalog, { allowLegacy: true });
	assert.equal(bundle.modelCount, 1);
	assert.equal(bundle.imageModelCount, 0);
	assert.equal([...bundle.modelsByProvider.get("openrouter").values()][0].type, "chat");
	assert.throws(() => validateBundle(catalog), /required for publication/);
	json(join(catalog, "providers/openrouter.all.json"), []);
	assert.throws(() => readModelCatalog(catalog, { allowLegacy: true }), /Provider shard files/);
});

test("dry-run emits schema1 publication with additive image/total counts and invokes no AWS command", (t) => {
	const { root, catalog } = fixture(t);
	const mock = mockAws(root);
	const result = publish(catalog, mock.env, ["--dry-run"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /no objects uploaded/);
	const publication = readJson(join(catalog, "publication.json"));
	assert.equal(publication.schemaVersion, 1);
	assert.equal(publication.modelCount, 500);
	assert.equal(publication.imageModelCount, 2);
	assert.equal(publication.totalModelCount, 502);
	assert.equal(publication.sourceCommit, sourceCommit);
	assert.deepEqual(readJson(mock.log), []);
});

test("executes dry-run through an absolute symlink path rather than silently skipping main", (t) => {
	const { root, catalog } = fixture(t);
	const link = join(root, "linked-publisher.mjs");
	symlinkSync(publisher, link);
	const result = spawnSync(process.execPath, [link, "--input", catalog, "--source-commit", sourceCommit, "--dry-run"], { encoding: "utf8", timeout: 20_000 });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /no objects uploaded/);
	assert.equal(readJson(join(catalog, "publication.json")).modelCount, 500);
});

test("index retains old catalog metadata and adds mixed counts without changing legacy count", (t) => {
	const { catalog } = fixture(t);
	const old = { minimumPiVersion: "0.70.0", revision: "old", modelCount: 700, imageModelCount: 10, totalModelCount: 710, customMetadata: "preserved" };
	const index = buildIndex({ catalogs: [old] }, { ...validateBundle(catalog), sourceCommit });
	assert.equal(index.schemaVersion, 1);
	assert.deepEqual(index.catalogs[0], old);
	assert.equal(index.catalogs[1].modelCount, 500);
	assert.equal(index.catalogs[1].imageModelCount, 2);
	assert.equal(index.catalogs[1].totalModelCount, 502);
});

test("mock subprocess upload archives both projections with exact content and index last", (t) => {
	const { root, catalog } = fixture(t);
	const old = { minimumPiVersion: "0.70.0", revision: "old", modelCount: 700, imageModelCount: 10, totalModelCount: 710 };
	const mock = mockAws(root, { schemaVersion: 1, defaultRevision: "old", catalogs: [old] });
	const result = publish(catalog, mock.env, publishArgs);
	assert.equal(result.status, 0, result.stderr);
	const bundle = validateBundle(catalog);
	const calls = readJson(mock.log);
	assert.equal(calls[0].download, true);
	assert.equal(calls[0].args[2], "s3://fixture-bucket/models/v1/index.json");
	const uploads = calls.slice(1);
	assert.equal(uploads.length, bundle.files.length + 1);
	for (const [index, file] of bundle.files.entries()) {
		const call = uploads[index];
		assert.equal(call.args[3], `s3://fixture-bucket/models/v1/revisions/${bundle.revision}/${file}`);
		assert.equal(call.content, readFileSync(join(catalog, file), "utf8"));
		assert.equal(call.args[call.args.indexOf("--cache-control") + 1], "public, max-age=31536000, immutable");
		assert.equal(call.args[call.args.indexOf("--content-type") + 1], "application/json; charset=utf-8");
	}
	const last = uploads.at(-1);
	assert.equal(last.args[3], "s3://fixture-bucket/models/v1/index.json");
	assert.equal(last.args[last.args.indexOf("--cache-control") + 1], "no-store");
	const index = JSON.parse(last.content);
	assert.deepEqual(index.catalogs[0], old);
	assert.equal(index.catalogs[1].modelCount, 500);
	assert.equal(index.catalogs[1].imageModelCount, 2);
	assert.equal(index.catalogs[1].totalModelCount, 502);
});

test("a missing index is created only after both projections upload", (t) => {
	const { root, catalog } = fixture(t);
	const mock = mockAws(root);
	const result = publish(catalog, mock.env, publishArgs);
	assert.equal(result.status, 0, result.stderr);
	const calls = readJson(mock.log);
	assert.equal(calls.at(-1).args[3], "s3://fixture-bucket/models/v1/index.json");
	assert.equal(JSON.parse(calls.at(-1).content).catalogs.length, 1);
});

test("a failed mixed upload does not advance the index", (t) => {
	const { root, catalog } = fixture(t);
	const mock = mockAws(root, undefined, { failUpload: "/providers/openrouter.all.json" });
	const result = publish(catalog, mock.env, publishArgs);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /injected upload failure/);
	const calls = readJson(mock.log);
	assert.ok(calls.some((call) => !call.download && call.args[3].endsWith("models.all.json")));
	assert.ok(!calls.some((call) => !call.download && call.args[3].endsWith("/index.json")));
});

test("the current mixed revision is idempotent and performs only index download", (t) => {
	const { root, catalog } = fixture(t);
	const publication = { ...validateBundle(catalog), sourceCommit };
	const mock = mockAws(root, buildIndex(undefined, publication));
	const result = publish(catalog, mock.env, publishArgs);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /already current/);
	assert.equal(readJson(mock.log).length, 1);
});
