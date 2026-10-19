import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/publish-easy-pi.yml", import.meta.url), "utf8"));

test("clean release checkout hydrates ignored model data before the offline build", () => {
	const commands = workflow.jobs.publish.steps.map((step) => step.run);
	const install = commands.indexOf("npm ci --ignore-scripts");
	const hydrate = commands.findIndex((command) => command?.startsWith("npm --prefix packages/ai run hydrate-model-data -- --normalized-input"));
	const build = commands.indexOf("npm run build:offline");
	assert.ok(install >= 0 && hydrate > install && build > hydrate);
});

test("manual recovery builds the validated original release tag", () => {
	assert.equal(workflow.on.workflow_dispatch.inputs.release_tag.required, true);
	const steps = workflow.jobs.publish.steps;
	assert.equal(steps[0].id, "release");
	assert.match(steps[0].run, /Invalid beta release tag/);
	const tooling = steps.findIndex((step) => step.name === "Checkout release tooling");
	const preserve = steps.findIndex((step) => step.name === "Preserve frozen release model data");
	const checkout = steps.findIndex((step) => step.name === "Checkout release source");
	assert.ok(tooling >= 0 && preserve > tooling && checkout > preserve);
	assert.equal(steps[checkout].with.ref, "${{ steps.release.outputs.ref }}");
	assert.equal(workflow.jobs.publish.environment, "npm-publish");
	assert.equal(workflow.permissions["id-token"], "write");
});
