import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyInputTree } from "../integrity.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "computer-integrity-"));
	mkdirSync(join(root, "dist"));
	writeFileSync(join(root, "dist/a"), "a");
	writeFileSync(join(root, "dist/b"), "b");
	const digest = (value: string) => createHash("sha256").update(value).digest("hex");
	return { root, pin: { paths: ["dist"], sha256: digest(`dist/a\0${digest("a")}\ndist/b\0${digest("b")}\n`) } };
}

test("verifies the sorted filename/content digest and rejects changed, added, or missing inputs", (t) => {
	const { root, pin } = fixture();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	verifyInputTree(root, pin);
	writeFileSync(join(root, "dist/a"), "changed");
	assert.throws(() => verifyInputTree(root, pin), /integrity mismatch/);
	writeFileSync(join(root, "dist/a"), "a");
	writeFileSync(join(root, "dist/extra"), "extra");
	assert.throws(() => verifyInputTree(root, pin), /integrity mismatch/);
	rmSync(join(root, "dist/extra"));
	rmSync(join(root, "dist/a"));
	assert.throws(() => verifyInputTree(root, pin), /integrity mismatch/);
});

test("rejects file and intermediate-directory symlinks", (t) => {
	const { root, pin } = fixture();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	rmSync(join(root, "dist/a"));
	symlinkSync("b", join(root, "dist/a"));
	assert.throws(() => verifyInputTree(root, pin), /symlink/);
	symlinkSync("dist", join(root, "alias"));
	assert.throws(() => verifyInputTree(root, { ...pin, paths: ["alias/b"] }), /symlink/);
});

test("rejects invalid relative paths before reading them", (t) => {
	const { root, pin } = fixture();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const path of ["../outside", "/absolute", "./dist", "dist//a", ""]) {
		assert.throws(() => verifyInputTree(root, { ...pin, paths: [path] }), /Invalid native input path/);
	}
});
