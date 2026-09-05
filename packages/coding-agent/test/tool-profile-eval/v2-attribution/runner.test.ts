import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convertResponsesTools } from "../../../../ai/src/api/openai-responses-shared.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { assertToolBoundary, safeEnvironment } from "../unified-tools-real-eval.ts";
import {
	applyExternalChange,
	attemptId,
	collateralUnchanged,
	DEV_IDS,
	fixture,
	materialize,
	PROBE_IDS,
	targetCorrect,
	VALIDATION_IDS,
	VALIDATION_ORDER,
	validAttempt,
	verify,
} from "./fixtures.ts";
import { bytes, LIMITS, object, PayloadMeter } from "./metrics.ts";
import {
	checkedCommand,
	createHost,
	FixtureMonitor,
	normalizeSystem,
	PI_ROOT,
	protocol,
	sourceIdentity,
} from "./runner.ts";

const roots: string[] = [];
function temporary(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-attribution-runner-")));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("new independent fixtures and frozen allocation", () => {
	it("bounds every declared stage without old cases and counterbalances validation", () => {
		expect(PROBE_IDS.length + DEV_IDS.length * 2 * 8 + DEV_IDS.length * 2 * 8 + VALIDATION_ORDER.length * 9).toBe(
			238,
		);
		expect(238).toBeLessThanOrEqual(LIMITS.requests);
		expect(
			new Set(VALIDATION_ORDER.map(({ caseId, variant }) => attemptId("validation", caseId, variant, 0))).size,
		).toBe(18);
		expect(VALIDATION_ORDER.slice(0, 6).map(({ variant }) => variant)).toEqual(["A", "B", "C", "C", "A", "B"]);
		expect(validAttempt("validation", "U-01", "A", 0)).toBe(false);
		expect(validAttempt("validation", "Q-11", "C", 1)).toBe(false);
		expect(validAttempt("development", "D-11", "C", 3)).toBe(false);
	});
	for (const id of [...DEV_IDS, ...VALIDATION_IDS])
		it(`${id}: exact oracle distinguishes initial, intended, collateral and concurrent results`, () => {
			const cwd = temporary();
			const data = fixture(id);
			materialize(cwd, data);
			expect(targetCorrect(cwd, data, false)).toBe(false);
			if (data.external) {
				applyExternalChange(cwd, data);
				expect(targetCorrect(cwd, data, false)).toBe(false);
			} else writeFileSync(join(cwd, data.target), data.desired);
			expect(targetCorrect(cwd, data, !!data.external)).toBe(true);
			expect(collateralUnchanged(cwd, data)).toBe(true);
			expect(verify(cwd, data)).toBe(true);
			writeFileSync(join(cwd, "extra.txt"), "extra");
			expect(collateralUnchanged(cwd, data)).toBe(false);
		});
	it("checks exact command literals, symlink/outside boundaries, immutable checker and scrubbed environment", () => {
		const cwd = temporary();
		const data = fixture("D-11");
		materialize(cwd, data);
		expect(checkedCommand(cwd, data, "grep -R -n leaseWindowTicks src", cwd)).toBe(
			"/usr/bin/grep -R -n leaseWindowTicks src",
		);
		for (const value of ["env", "node check.cjs; env", "grep -R -n retryLimit src"])
			expect(() => checkedCommand(cwd, data, value, cwd)).toThrow("restricted_command");
		for (const path of ["../secret", "/etc/passwd", "~/.pi/auth.json"])
			expect(() => assertToolBoundary(cwd, { operations: [{ path }] })).toThrow("workspace_boundary");
		symlinkSync(tmpdir(), join(cwd, "escape"));
		expect(() => assertToolBoundary(cwd, { path: "escape/other" })).toThrow("workspace_boundary");
		writeFileSync(join(cwd, "check.cjs"), "throw 1");
		expect(() => checkedCommand(cwd, data, "node check.cjs", cwd)).toThrow("protected_verifier");
		expect(Object.keys(safeEnvironment(cwd)).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]);
	});
});

describe("production SDK and post-Read concurrency fault", () => {
	for (const variant of ["A", "B"] as const)
		it(`${variant}: snapshots actual public protocol, executes production tools and observes every write before rollback`, async () => {
			process.env.PI_HF_COMPACTION = "off";
			delete process.env.PI_EXPERIMENTAL;
			const root = temporary();
			const cwd = join(root, "workspace");
			const data = fixture("D-12");
			materialize(cwd, data);
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const monitor = new FixtureMonitor(cwd, data);
			const host = await createHost(cwd, join(root, "agent"), data, variant, runtime, monitor);
			try {
				const snapshot = protocol(host);
				expect(snapshot.systemPrompt).toContain("/reference/pi/README.md");
				expect(snapshot.systemPrompt).not.toContain(PI_ROOT);
				expect(snapshot.tools.map((tool) => tool.name)).toHaveLength(4);
				expect(snapshot.tools.every((tool) => tool.constrainedSampling === undefined)).toBe(true);
				const converted = convertResponsesTools(snapshot.tools, { strict: null, supportsStrictMode: true });
				const measured = new PayloadMeter().observe({
					instructions: snapshot.systemPrompt,
					tools: converted,
					input: [],
				});
				expect(Object.values(measured.sections).reduce((a, b) => a + b, 0)).toBe(measured.bytes);
				expect(measured.toolParameterBytes.read).toBe(
					bytes(
						converted.find((tool) => tool.type === "function" && tool.name === "read")?.type === "function"
							? snapshot.tools.find((tool) => tool.name === "read")?.parameters
							: undefined,
					),
				);
				const read = host.session.agent.state.tools.find((tool) => tool.name === "read")!;
				const edit = host.session.agent.state.tools.find((tool) => tool.name === "edit")!;
				const result = await read.execute("read-initial", { path: data.target });
				expect(readFileSync(join(cwd, data.target), "utf8")).toBe(data.initial[data.target]);
				expect(monitor.after("read", { path: data.target }, result.details, false)).toBe(true);
				expect(monitor.after("read", { path: data.target }, result.details, false)).toBe(false);
				const oldText = data.initial[data.target]
					.split("\n")
					.find((line) => line.startsWith("export const batchQuota"))!;
				const newText = data.desired.split("\n").find((line) => line.startsWith("export const batchQuota"))!;
				if (variant === "A") {
					await edit.execute("stale-edit", { path: data.target, edits: [{ oldText, newText }] });
					expect(monitor.unsafeWriteEvents).toBe(1);
					await edit.execute("rollback", { path: data.target, edits: [{ oldText: newText, newText: oldText }] });
					expect(monitor.unsafeWriteEvents).toBe(1);
				} else {
					const viewId = object(result.details)?.viewId;
					expect(typeof viewId).toBe("string");
					await expect(
						edit.execute("stale-edit", {
							operations: [{ kind: "update", path: data.target, viewId, oldText, newText }],
						}),
					).rejects.toMatchObject({ code: "STALE_VIEW" });
					expect(monitor.unsafeWriteEvents).toBe(0);
				}
				expect(targetCorrect(cwd, data, monitor.faultApplied)).toBe(true);
				expect(monitor.collateralWriteEvents).toBe(0);
			} finally {
				await host.close();
			}
		});
});

it("proves runtime aliases are local and leaves production guidance intact during reference normalization", () => {
	const identity = sourceIdentity();
	if (process.env.PI_V2_ATTRIBUTION_PRINT_IDENTITY === "1")
		console.log(JSON.stringify({ stage: "identity", ...identity }));
	expect(identity.productHash).toMatch(/^[a-f0-9]{64}$/);
	expect(identity.runnerHash).toMatch(/^[a-f0-9]{64}$/);
	expect(normalizeSystem(`guidance\n${PI_ROOT}/packages/coding-agent/docs\n${PI_ROOT}/other`)).toBe(
		`guidance\n/reference/pi/docs\n${PI_ROOT}/other`,
	);
});
