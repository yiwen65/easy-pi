import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectRendererHelper } from "../renderer-helper.ts";

test("installed helper verifies bytes, execution mode and canonical ancestor aliases without executing", () => {
	const root = mkdtempSync(join(tmpdir(), "renderer-integrity-"));
	try {
		const install = join(root, "installed");
		mkdirSync(join(install, "renderer"), { recursive: true });
		const helper = join(install, "renderer/computer-renderer");
		const bytes = "inert test data, never executed";
		const hash = createHash("sha256").update(bytes).digest("hex");
		writeFileSync(helper, bytes, { mode: 0o755 });
		symlinkSync(install, join(root, "alias"));
		assert.equal(inspectRendererHelper(join(root, "alias"), hash), inspectRendererHelper(install, hash));
		renameSync(install, join(root, "relocated"));
		const relocated = join(root, "relocated");
		assert.ok(inspectRendererHelper(relocated, hash).endsWith("relocated/renderer/computer-renderer"));
		assert.throws(() => inspectRendererHelper(relocated, undefined), /no verified/);
		assert.throws(() => inspectRendererHelper(relocated, "0".repeat(64)), /mismatched/);
		chmodSync(join(relocated, "renderer/computer-renderer"), 0o644);
		assert.throws(() => inspectRendererHelper(relocated, hash), /unsafe/);
		rmSync(join(relocated, "renderer/computer-renderer"));
		assert.throws(() => inspectRendererHelper(relocated, hash), /missing/);
		writeFileSync(join(root, "outside"), bytes, { mode: 0o755 });
		symlinkSync(join(root, "outside"), join(relocated, "renderer/computer-renderer"));
		assert.throws(() => inspectRendererHelper(relocated, hash), /unsafe/);
		rmSync(join(relocated, "renderer"), { recursive: true });
		symlinkSync(root, join(relocated, "renderer"));
		assert.throws(() => inspectRendererHelper(relocated, hash), /unsafe/);
	} finally {
		rmSync(root, { recursive: true });
	}
});
