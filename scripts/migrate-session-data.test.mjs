import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateSessions, validateSession } from "./migrate-session-data.mjs";

const session = (version = 3) => Buffer.from([
	JSON.stringify({ type: "session", version, id: "synthetic", timestamp: "2026-09-06T00:00:00Z", cwd: "/project" }),
	JSON.stringify({ type: "compaction", id: "c1", parentId: null, replacementHistory: [{ role: "user", content: "synthetic" }], details: { custom: true } }),
].join("\n") + "\n");

function fixture(fn) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "epi-migration-test-")));
	try {
		const source = join(root, "old");
		const destination = join(root, "new");
		mkdirSync(join(source, "project"), { recursive: true });
		writeFileSync(join(source, "project", "session.jsonl"), session());
		fn({ root, source, destination });
	} finally { rmSync(root, { recursive: true, force: true }); }
}

test("dry run writes nothing; apply preserves bytes and compaction; rerun is idempotent", () => fixture(({ source, destination }) => {
	mkdirSync(join(source, "project/hf"));
	writeFileSync(join(source, "project/hf/events.jsonl"), '{"legacyEvent":true}\n');
	const before = readFileSync(join(source, "project/session.jsonl"));
	const plan = migrateSessions(source, destination);
	assert.equal(plan.planned, 2);
	assert.equal(existsSync(destination), false);
	const result = migrateSessions(source, destination, { dryRun: false });
	assert.deepEqual(result.errors, []);
	assert.equal(result.copied, 2);
	assert.equal(readFileSync(join(destination, "project/hf/events.jsonl"), "utf8"), '{"legacyEvent":true}\n');
	assert.deepEqual(readFileSync(join(destination, "project/session.jsonl")), before);
	assert.deepEqual(readFileSync(join(source, "project/session.jsonl")), before);
	assert.equal(statSync(join(destination, "project/session.jsonl")).mode & 0o777, 0o600);
	assert.equal(migrateSessions(source, destination, { dryRun: false }).identical, 2);
}));

test("conflicts, symlinks and non-session files never get overwritten or imported", () => fixture(({ root, source, destination }) => {
	mkdirSync(join(destination, "project"), { recursive: true });
	writeFileSync(join(destination, "project/session.jsonl"), "existing");
	writeFileSync(join(source, "auth.json"), "synthetic sentinel");
	symlinkSync(join(source, "project/session.jsonl"), join(source, "linked.jsonl"));
	const report = migrateSessions(source, destination, { dryRun: false });
	assert.equal(report.errors.length, 2);
	assert.equal(report.skipped, 1);
	assert.equal(readFileSync(join(destination, "project/session.jsonl"), "utf8"), "existing");
	assert.equal(existsSync(join(destination, "auth.json")), false);
	symlinkSync(source, join(root, "source-link"));
	assert.throws(() => migrateSessions(join(root, "source-link"), destination), /plain directory/);
	assert.throws(() => migrateSessions(source, join(source, "nested")), /overlap/);
}));

test("invalid, future-version and truncated sessions are rejected without dropping entries", () => {
	assert.throws(() => validateSession(Buffer.from("")), /Empty/);
	assert.throws(() => validateSession(session(4)), /Unsupported/);
	assert.throws(() => validateSession(Buffer.concat([session(), Buffer.from('{"type":')])), /Invalid JSON/);
	assert.throws(() => validateSession(Buffer.from([0xff])), /encoded data/);
	assert.equal(validateSession(session(1)).version, 1);
	assert.equal(validateSession(session(2)).version, 2);
});
