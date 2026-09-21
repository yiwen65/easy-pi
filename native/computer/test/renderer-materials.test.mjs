import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectRendererMaterials } from "../scripts/package.mjs";

test("renderer material schema requires matched executable, authored source, build provenance and license", () => {
	const root = mkdtempSync(join(tmpdir(), "renderer-materials-"));
	try {
		const files = {};
		for (const name of ["helper", "source.swift", "build.json", "LICENSE"]) {
			writeFileSync(join(root, name), `inert fixture ${name}`, { mode: name === "helper" ? 0o755 : 0o644 });
			files[name] = createHash("sha256").update(`inert fixture ${name}`).digest("hex");
		}
		const renderer = {
			helperPath: "helper",
			sha256: files.helper,
			sourcePaths: ["source.swift"],
			buildPath: "build.json",
			licensePath: "LICENSE",
			compiler: "fixture",
			lifetimeProtocol: 2,
			datagramProtocol: 1,
		};
		const manifest = { files, renderer, computerFeatureVersion: 2 };
		assert.equal(inspectRendererMaterials(root, manifest).helper, join(root, "helper"));
		for (const change of [
			{ lifetimeProtocol: 1 },
			{ sourcePaths: [] },
			{ compiler: "" },
			{ sha256: "0".repeat(64) },
			{ buildPath: "../build.json" },
			{ licensePath: "missing" },
		])
			assert.throws(() => inspectRendererMaterials(root, { ...manifest, renderer: { ...renderer, ...change } }));
		assert.throws(() => inspectRendererMaterials(root, { ...manifest, computerFeatureVersion: 1 }));
		symlinkSync(join(root, "helper"), join(root, "link"));
		assert.throws(
			() => inspectRendererMaterials(root, { ...manifest, renderer: { ...renderer, helperPath: "link" } }),
			/symlinks/,
		);
		chmodSync(join(root, "helper"), 0o644);
		assert.throws(() => inspectRendererMaterials(root, manifest), /executable/);
	} finally {
		rmSync(root, { recursive: true });
	}
});
