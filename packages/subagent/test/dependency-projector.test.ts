import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { DEPENDENCY_VIEW_MAX_BYTES, projectDependencyArtifacts } from "../src/dependency-projector.ts";
import type { TaskArtifact, ValidationResult } from "../src/types.ts";

function artifact(
	taskId: string,
	overrides: Partial<TaskArtifact> = {},
	validations: ValidationResult[] = [],
): TaskArtifact {
	return {
		artifactVersion: 2,
		artifactId: `${taskId}-artifact`,
		taskId,
		contractHash: taskId.padEnd(64, "a").slice(0, 64),
		handoff: {
			taskId,
			summary: `Summary for ${taskId}`,
			outcome: "accepted",
			evidence: [{ path: `src/${taskId}.ts`, lineRange: "1-4", claim: `Claim for ${taskId}` }],
			verification: [],
			assumptions: [],
			risks: [],
			nextActions: [],
			verificationLevel: "unverified",
		},
		changedPaths: [`src/${taskId}.ts`],
		validations,
		commit: taskId.repeat(40).slice(0, 40),
		createdAt: 1,
		...overrides,
		quality: overrides.quality ?? {
			semanticOutcome: "accepted",
			pathAudit: "not_applicable",
			validation: { status: "not_applicable", passedCommandIds: [] },
			review: { status: "not_applicable" },
		},
	};
}

describe("projectDependencyArtifacts", () => {
	it("projects deterministic dependency facts and never carries validation stdout or stderr", () => {
		const failedValidation: ValidationResult = {
			commandId: "unit",
			status: "failed",
			exitCode: 1,
			stdout: "STDOUT-SECRET-THAT-MUST-NOT-ENTER-THE-PROMPT",
			stderr: "STDERR-SECRET-THAT-MUST-NOT-ENTER-THE-PROMPT",
			durationMs: 12,
		};
		const selfReported = artifact("a", {
			handoff: {
				taskId: "a",
				summary: "Self-reported dependency",
				outcome: "accepted",
				evidence: [],
				verification: [{ check: "manual inspection", status: "passed" }],
				assumptions: [],
				risks: ["Manual inspection may miss generated files"],
				nextActions: [],
				verificationLevel: "self_reported",
			},
			validations: [
				{
					commandId: "smoke",
					status: "passed",
					exitCode: 0,
					stdout: "PASSED-OUTPUT-MUST-NOT-ENTER-THE-PROMPT",
					stderr: "",
					durationMs: 4,
				},
			],
		});
		const failed = artifact(
			"b",
			{
				quality: {
					semanticOutcome: "rejected",
					pathAudit: "passed",
					validation: { status: "failed", passedCommandIds: [] },
					review: { status: "not_applicable" },
				},
			},
			[failedValidation],
		);

		const forward = projectDependencyArtifacts([failed, selfReported]);
		const reverse = projectDependencyArtifacts([selfReported, failed]);

		expect(forward).toEqual(reverse);
		expect(forward.dependencies.map((dependency) => dependency.taskId)).toEqual(["a", "b"]);
		expect(forward.dependencies[0]).toMatchObject({
			artifactId: "a-artifact",
			summary: "Self-reported dependency",
			verificationLevel: "self_reported",
			controllerValidations: [{ commandId: "smoke", status: "passed", exitCode: 0, trust: "controller_verified" }],
			childVerifications: [{ check: "manual inspection", status: "passed", trust: "self_reported" }],
			risks: [{ text: "Manual inspection may miss generated files", trust: "self_reported" }],
		});
		expect(forward.dependencies[1]).toMatchObject({
			quality: { semanticOutcome: "rejected", pathAudit: "passed", validation: "failed" },
			verificationLevel: "unverified",
			controllerValidations: [{ commandId: "unit", status: "failed", exitCode: 1 }],
		});
		const serialized = JSON.stringify(forward);
		expect(serialized).not.toContain("stdout");
		expect(serialized).not.toContain("stderr");
		expect(serialized).not.toContain("MUST-NOT-ENTER-THE-PROMPT");
	});

	it("prioritizes failed child verification and risks within the bounded view", () => {
		const dependency = artifact("critical", {
			handoff: {
				taskId: "critical",
				summary: "Critical dependency",
				outcome: "accepted",
				evidence: Array.from({ length: 80 }, (_, index) => ({
					path: `src/noise-${index}.ts`,
					claim: "noise".repeat(100),
				})),
				verification: [
					{ check: "unit tests", status: "failed", details: `assertion failed ${"x".repeat(1_000)}` },
					{ check: "manual smoke", status: "not-run", details: "environment unavailable" },
				],
				assumptions: [],
				risks: [`High-risk incompatibility ${"y".repeat(1_000)}`],
				nextActions: [],
				verificationLevel: "self_reported",
			},
			changedPaths: Array.from({ length: 80 }, (_, index) => `src/noise-${index}.ts`),
		});

		const view = projectDependencyArtifacts([dependency]);
		expect(Buffer.byteLength(JSON.stringify(view), "utf8")).toBeLessThanOrEqual(DEPENDENCY_VIEW_MAX_BYTES);
		expect(view.dependencies[0]).toMatchObject({
			childVerifications: [
				{ check: "unit tests", status: "failed", trust: "self_reported" },
				{ check: "manual smoke", status: "not-run", trust: "self_reported" },
			],
			risks: [{ trust: "self_reported" }],
		});
		expect(view.dependencies[0]?.omitted.childVerificationBytes).toBeGreaterThan(0);
		expect(view.dependencies[0]?.omitted.riskBytes).toBeGreaterThan(0);
		expect(view.omittedTotals.evidence).toBeGreaterThan(0);
	});

	it("reserves wide-fan-in capacity for failed checks and risks before summaries", () => {
		const artifacts = Array.from({ length: 20 }, (_, index) => {
			const taskId = `critical-${index}`;
			return artifact(taskId, {
				handoff: {
					taskId,
					summary: `summary-${"s".repeat(2_000)}`,
					outcome: "accepted",
					evidence: [],
					verification: [{ check: `check-${index}`, status: "failed", details: "failed" }],
					assumptions: [],
					risks: [`risk-${index}`],
					nextActions: [],
					verificationLevel: "self_reported",
				},
			});
		});
		const view = projectDependencyArtifacts(artifacts);
		expect(Buffer.byteLength(JSON.stringify(view), "utf8")).toBeLessThanOrEqual(DEPENDENCY_VIEW_MAX_BYTES);
		expect(view.dependencies.flatMap((dependency) => dependency.childVerifications)).toHaveLength(20);
		expect(view.dependencies.flatMap((dependency) => dependency.risks)).toHaveLength(20);
	});

	it("stays within the fixed UTF-8 cap and truncates optional data fairly across dependencies", () => {
		const artifacts = Array.from({ length: 32 }, (_, index) => {
			const taskId = `task-${String(index).padStart(2, "0")}`;
			return artifact(taskId, {
				handoff: {
					taskId,
					summary: `摘要-${"界".repeat(2_000)}`,
					outcome: "accepted",
					evidence: Array.from({ length: 12 }, (_, evidenceIndex) => ({
						path: `src/${taskId}/${evidenceIndex}-${"p".repeat(300)}.ts`,
						claim: `Evidence ${evidenceIndex}: ${"c".repeat(400)}`,
					})),
					verification: [],
					assumptions: [],
					risks: [],
					nextActions: [],
					verificationLevel: "unverified",
				},
				changedPaths: Array.from(
					{ length: 64 },
					(_, pathIndex) => `src/${taskId}/${pathIndex}-${"x".repeat(300)}.ts`,
				),
				validations: Array.from({ length: 8 }, (_, validationIndex) => ({
					commandId: `check-${validationIndex}`,
					status: "failed" as const,
					exitCode: 1,
					stdout: "o".repeat(10_000),
					stderr: "e".repeat(10_000),
					durationMs: 1,
				})),
			});
		});

		const view = projectDependencyArtifacts(artifacts);
		const bytes = Buffer.byteLength(JSON.stringify(view), "utf8");

		expect(bytes).toBeLessThanOrEqual(DEPENDENCY_VIEW_MAX_BYTES);
		expect(view.dependencies).toHaveLength(32);
		expect(view.truncated).toBe(true);
		for (const dependency of view.dependencies) {
			expect(dependency.taskId).toBeTruthy();
			expect(dependency.artifactId).toBeTruthy();
			expect(dependency.summary).toBeTruthy();
			expect(dependency.omitted.summaryBytes).toBeGreaterThan(0);
			expect(
				dependency.omitted.evidence + dependency.omitted.changedPaths + dependency.omitted.controllerValidations,
			).toBeGreaterThan(0);
		}
		const retainedCounts = view.dependencies.map(
			(dependency) =>
				dependency.evidence.length + dependency.changedPaths.length + dependency.controllerValidations.length,
		);
		expect(Math.max(...retainedCounts) - Math.min(...retainedCounts)).toBeLessThanOrEqual(1);
		expect(view.omittedTotals.summaryBytes).toBeGreaterThan(0);
		expect(view.omittedTotals.evidence).toBeGreaterThan(0);
	});

	it("preserves explicit future outcome and verification metadata when present", () => {
		const futureArtifact = artifact("future", {
			quality: {
				semanticOutcome: "accepted",
				pathAudit: "passed",
				validation: { status: "passed", passedCommandIds: ["unit"] },
				review: { status: "not_applicable" },
			},
		});

		expect(projectDependencyArtifacts([futureArtifact]).dependencies[0]).toMatchObject({
			quality: { semanticOutcome: "accepted", pathAudit: "passed", validation: "passed" },
			verificationLevel: "unverified",
		});
	});
});
