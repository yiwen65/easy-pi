import assert from "node:assert/strict";
import { test } from "node:test";
import { createComputerFeature } from "../entry.ts";
import pins from "../pinned-inputs.json" with { type: "json" };

const supported =
	process.platform === pins.platform &&
	process.arch === pins.arch &&
	process.versions.node === pins.nodeVersion &&
	process.versions.bun === undefined;

function libraries(): string[] {
	const report = process.report.getReport();
	assert.ok(typeof report === "object" && report !== null && "sharedObjects" in report);
	assert.ok(Array.isArray(report.sharedObjects));
	return report.sharedObjects.filter((value): value is string => typeof value === "string");
}

test(
	"optional entry constructs stable desktop/browser bindings without importing native or acquiring an owner",
	{ skip: !supported },
	async () => {
		const before = libraries();
		assert.ok(!before.some((value) => value.endsWith("libcua_driver_sdk.dylib")));
		for (const options of [{}, { browserBundlePath: "/trusted/not-opened/CfT.app" }]) {
			const feature = createComputerFeature(options);
			assert.equal(feature.binding.tools.length, 1);
			assert.equal(feature.binding.tools[0]?.name, "computer");
			const child = feature.binding.fork();
			await child.close();
			assert.equal(feature.binding.revoked, false);
			const closing = feature.close();
			assert.equal(feature.binding.revoked, true);
			assert.equal(feature.close(), closing);
			await closing;
		}
		assert.deepEqual(libraries(), before);
	},
);

test("optional entry rejects relative authority/bundle paths before native work", { skip: !supported }, () => {
	assert.throws(() => createComputerFeature({ manifestPath: "project.yaml" }), /absolute/);
	assert.throws(() => createComputerFeature({ browserBundlePath: "CfT.app" }), /absolute/);
});
