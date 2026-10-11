import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const diffScript = fileURLToPath(new URL("./diff-model-catalog.mjs", import.meta.url));

function json(path, value) {
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function model(id, type = "chat", provider = "fixture") {
	return {
		type, id, provider, name: `${type} ${id}`, api: type === "chat" ? "custom-chat" : "custom-image",
		baseUrl: "https://fixture.invalid", input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		...(type === "chat" ? { reasoning: false, contextWindow: 1000, maxTokens: 100 } : { output: ["image"] }),
	};
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

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-offline-diff-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const before = join(root, "before catalog");
	const after = join(root, "after catalog");
	const calls = join(root, "calls.json");
	json(calls, []);
	const guard = join(root, "offline-guard.mjs");
	writeFileSync(guard, `import cp from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const log = ${JSON.stringify(calls)};
function record(value) { const calls = JSON.parse(readFileSync(log, 'utf8')); calls.push(value); writeFileSync(log, JSON.stringify(calls)); }
const spawn = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  record({ command, args });
  if (!(command === 'git' && args[0] === 'diff' && args.includes('--no-index')) && !(command === process.execPath && args[0].endsWith('generate-thinking-capabilities.mjs'))) throw new Error('Forbidden offline subprocess: ' + command + ' ' + args.join(' '));
  return spawn(command, args, options);
};
syncBuiltinESMExports();
globalThis.fetch = async () => { record({ fetch: true }); throw new Error('Forbidden offline network'); };
`);
	const run = (args = [], { paired = true, scriptPath = diffScript } = {}) => spawnSync(process.execPath, [scriptPath, ...(paired ? ["--before", before, "--after", after] : []), ...args], {
		cwd: root, // Not a git repository: offline mode must not inspect HEAD/create worktrees.
		env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(guard).href}` },
		encoding: "utf8", timeout: 20_000,
	});
	return { root, before, after, calls, run };
}

function output(result) {
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.replace(/\u001b\[[0-9;]*m/g, "");
}

function snapshot(root) {
	return Object.fromEntries(readdirSync(root, { recursive: true }).filter((entry) => entry.endsWith(".json")).map((entry) => [entry, readFileSync(join(root, entry), "utf8")]));
}

test("offline default diff compares same-ID chat/image edits and independent additions/removals", (t) => {
	const f = fixture(t);
	const before = [model("same"), model("same", "image"), model("gone"), model("gone", "image")];
	const after = [
		{ ...model("same"), name: "Changed chat" },
		{ ...model("same", "image"), headers: { "x-image": "changed" }, output: ["image", "text"] },
		model("new"), model("new", "image"),
	];
	writeCatalog(f.before, before);
	writeCatalog(f.after, after);
	const beforeFiles = snapshot(f.before);
	const afterFiles = snapshot(f.after);
	const text = output(f.run());
	assert.match(text, /6 model catalog entries changed/);
	for (const type of ["chat", "image"]) for (const id of ["same", "gone", "new"]) assert.ok(text.includes(`- fixture/${type}:${id}`));
	assert.match(text, /Changed chat/);
	assert.match(text, /"x-image": "changed"/);
	assert.deepEqual(snapshot(f.before), beforeFiles);
	assert.deepEqual(snapshot(f.after), afterFiles);
	const calls = JSON.parse(readFileSync(f.calls, "utf8"));
	assert.equal(calls.length, 6);
	assert.ok(calls.every((call) => call.command === "git" && call.args[0] === "diff"));
});

test("executes offline diff through an absolute symlink path rather than silently skipping main", (t) => {
	const f = fixture(t);
	writeCatalog(f.before, [model("same")]);
	writeCatalog(f.after, [model("same")]);
	const link = join(f.root, "linked-diff.mjs");
	symlinkSync(diffScript, link);
	assert.match(output(f.run([], { scriptPath: link })), /No model catalog changes/);
});

test("image-only metadata changes are not silently ignored", (t) => {
	const f = fixture(t);
	writeCatalog(f.before, [model("same"), model("same", "image")]);
	writeCatalog(f.after, [model("same"), { ...model("same", "image"), cost: { input: 5, output: -1, cacheRead: 0, cacheWrite: 0 } }]);
	const text = output(f.run());
	assert.match(text, /1 model catalog entry changed/);
	assert.match(text, /- fixture\/image:same/);
	assert.ok(!text.includes("- fixture/chat:same"));
});

test("provider identity and filtering remain independent for same operation/ID", (t) => {
	const f = fixture(t);
	writeCatalog(f.before, [model("same", "image", "one"), model("same", "image", "two")]);
	writeCatalog(f.after, [{ ...model("same", "image", "one"), name: "Changed one" }, { ...model("same", "image", "two"), name: "Changed two" }]);
	const text = output(f.run(["one"]));
	assert.match(text, /1 model catalog entry changed/);
	assert.match(text, /- one\/image:same/);
	assert.ok(!text.includes("two/image:same"));
});

test("compares newly added and fully removed image-only providers", (t) => {
	const f = fixture(t);
	writeCatalog(f.before, [model("same", "image", "removed")]);
	writeCatalog(f.after, [model("same", "image", "added")]);
	const text = output(f.run());
	assert.match(text, /2 model catalog entries changed/);
	assert.match(text, /- removed\/image:same/);
	assert.match(text, /- added\/image:same/);
});

test("legacy-only keyed catalogs normalize missing chat types and expose new mixed images", (t) => {
	const f = fixture(t);
	const chat = model("same");
	delete chat.type;
	writeCatalog(f.before, [chat], { legacy: true });
	writeCatalog(f.after, [model("same"), model("same", "image")]);
	const text = output(f.run());
	assert.match(text, /1 model catalog entry changed/);
	assert.match(text, /- fixture\/image:same/);
	assert.ok(!text.includes("- fixture/chat:same"));
});

test("legacy-only catalogs can be compared on both sides without generating models", (t) => {
	const f = fixture(t);
	const before = model("same");
	delete before.type;
	writeCatalog(f.before, [before], { legacy: true });
	writeCatalog(f.after, [{ ...before, name: "New legacy chat" }], { legacy: true });
	const text = output(f.run());
	assert.match(text, /1 model catalog entry changed/);
	assert.match(text, /- fixture\/chat:same/);
});

test("operation and JSON key ordering do not create false changes", (t) => {
	const f = fixture(t);
	const chat = model("same");
	const image = model("same", "image");
	writeCatalog(f.before, [chat, image]);
	writeCatalog(f.after, [Object.fromEntries(Object.entries(image).reverse()), Object.fromEntries(Object.entries(chat).reverse())]);
	assert.match(output(f.run()), /No model catalog changes/);
	assert.deepEqual(JSON.parse(readFileSync(f.calls, "utf8")), []);
});

test("--thinking remains chat-only even when image data and same-ID images change", (t) => {
	const f = fixture(t);
	writeCatalog(f.before, [model("same"), model("same", "image")]);
	writeCatalog(f.after, [model("same"), { ...model("same", "image"), reasoning: true, thinkingLevels: ["high"], name: "Ignore image" }]);
	assert.match(output(f.run(["--thinking"])), /No model catalog changes/);
	const calls = JSON.parse(readFileSync(f.calls, "utf8"));
	assert.equal(calls.length, 2);
	assert.ok(calls.every((call) => call.args[0].endsWith("generate-thinking-capabilities.mjs")));
});

test("offline --thinking compares chat capability changes using the current implementation", (t) => {
	const f = fixture(t);
	writeCatalog(f.before, [model("same"), model("same", "image")]);
	writeCatalog(f.after, [{ ...model("same"), reasoning: true, thinkingLevels: ["low", "high"] }, model("same", "image")]);
	const text = output(f.run(["--thinking"]));
	assert.match(text, /1 model catalog entry changed/);
	assert.match(text, /- fixture\/chat:same/);
	assert.ok(!text.includes("- fixture/image:same"));
});

for (const args of [["--before", "/tmp/before"], ["--after", "/tmp/after"], ["--before"], ["--after", "--thinking"], ["--wat"]]) {
	test(`rejects invalid offline arguments before any subprocess: ${args.join(" ")}`, (t) => {
		const f = fixture(t);
		const result = f.run(args, { paired: false });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /must be supplied together|requires a directory|Unknown argument/);
		assert.deepEqual(JSON.parse(readFileSync(f.calls, "utf8")), []);
	});
}

test("fails rather than falling back to generation when explicit input is missing", (t) => {
	const f = fixture(t);
	const result = f.run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /ENOENT/);
	assert.deepEqual(JSON.parse(readFileSync(f.calls, "utf8")), []);
});

test("rejects unknown selected providers and malformed mixed catalogs", (t) => {
	const f = fixture(t);
	writeCatalog(f.before, [model("same")]);
	writeCatalog(f.after, [model("same")]);
	let result = f.run(["../escape"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Unknown provider/);
	json(join(f.after, "models.all.json"), [{ ...model("same"), type: "classifier" }]);
	result = f.run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Invalid model entry/);
	assert.deepEqual(JSON.parse(readFileSync(f.calls, "utf8")), []);
});
