import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { packageComputer } from "../scripts/package.mjs";

const sdkDirectory = process.env.PI_COMPUTER_PACKAGE_SDK;
const materialsDirectory = process.env.PI_COMPUTER_PACKAGE_MATERIALS;
const qualified = Boolean(sdkDirectory && materialsDirectory);
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("packaging rejects relative paths before inspecting assets", async () => {
	await assert.rejects(
		packageComputer({ sdkDirectory: ".", materialsDirectory: ".", outputDirectory: "." }),
		/paths must be absolute/,
	);
});

test("packaging never overwrites an existing output", async () => {
	const outputDirectory = mkdtempSync(join(tmpdir(), "computer-package-existing-"));
	try {
		const sentinel = join(outputDirectory, "sentinel");
		writeFileSync(sentinel, "preserved");
		await assert.rejects(
			packageComputer({
				sdkDirectory: resolve("missing-sdk"),
				materialsDirectory: resolve("missing-materials"),
				outputDirectory,
			}),
			/refusing to overwrite/,
		);
		assert.equal(readFileSync(sentinel, "utf8"), "preserved");
	} finally {
		rmSync(outputDirectory, { recursive: true });
	}
});

for (const mutation of ["traversal", "symlink", "drift", "wrong-binary", "missing-license"]) {
	test(`qualified packaging rejects ${mutation} before creating output`, { skip: !qualified }, async () => {
		const temporary = mkdtempSync(join(tmpdir(), "computer-package-invalid-"));
		try {
			const materials = join(temporary, "materials");
			const outputDirectory = join(temporary, "computer");
			cpSync(materialsDirectory, materials, { recursive: true });
			const manifestPath = join(materials, "manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			let expected;
			switch (mutation) {
				case "traversal":
					manifest.files["../outside"] = "0".repeat(64);
					expected = /Invalid Computer asset path/;
					break;
				case "symlink":
					symlinkSync(join(materials, "NOTICE.md"), join(materials, "linked-notice"));
					manifest.files["linked-notice"] = digest(join(materials, "NOTICE.md"));
					expected = /must not contain symlinks/;
					break;
				case "drift":
					writeFileSync(join(materials, "NOTICE.md"), "changed");
					expected = /material drift/;
					break;
				case "wrong-binary":
					manifest.librarySha256 = "0".repeat(64);
					expected = /do not describe the selected native build/;
					break;
				case "missing-license":
					delete manifest.files["licenses/MPL-2.0.txt"];
					expected = /Missing Computer source\/license/;
					break;
			}
			writeFileSync(manifestPath, JSON.stringify(manifest));
			await assert.rejects(
				packageComputer({ sdkDirectory, materialsDirectory: materials, outputDirectory }),
				expected,
			);
			assert.equal(existsSync(outputDirectory), false);
		} finally {
			rmSync(temporary, { recursive: true });
		}
	});
}

test("qualified bundle preserves runtime pins and external product identity", { skip: !qualified }, async () => {
	const temporary = mkdtempSync(join(tmpdir(), "computer-package-valid-"));
	try {
		const outputDirectory = join(temporary, "computer");
		const manifest = await packageComputer({ sdkDirectory, materialsDirectory, outputDirectory });
		assert.equal(manifest.computerFeatureVersion, 1);
		assert.deepEqual(manifest.externalHostModules, [
			"../dist/core/computer/host.js",
			"../dist/core/computer/binding.js",
		]);
		assert.ok(Object.keys(manifest.sourceInputs).every((path) => path.startsWith("native/computer/")));
		for (const [path, sha256] of Object.entries(manifest.files))
			assert.equal(digest(join(outputDirectory, path)), sha256, path);
		const bridge = readFileSync(join(outputDirectory, "bridge.js"), "utf8");
		assert.ok(bridge.includes('from "../dist/core/computer/host.js"'));
		assert.ok(bridge.includes('from "typebox"'));
		assert.ok(!bridge.includes("class ComputerHost"));
		assert.ok(!bridge.includes("/Users/"));
	} finally {
		rmSync(temporary, { recursive: true });
	}
});
