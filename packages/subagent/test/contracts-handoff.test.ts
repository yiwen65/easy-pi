import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	assertSubagentToolRequestSize,
	compileSubagentDagExpansion,
	compileSubagentDagRequest,
	compileSubagentToolDagRequest,
	createSubagentToolRequestSchema,
	DEFAULT_SUBAGENT_POLICY,
	MAX_SUBAGENT_REQUEST_BYTES,
	parseSubagentToolRequest,
} from "../src/contracts.ts";
import { createSubmitHandoffSchema, decodeHandoffJson, HANDOFF_LIMITS } from "../src/handoff.ts";

const writerPolicy = {
	...DEFAULT_SUBAGENT_POLICY,
	allowedValidationCommandIds: ["unit:test", "lint"],
	maxTaskAttempts: 2,
};

function analystRequest() {
	return {
		operation: "start" as const,
		tasks: [
			{
				id: "auth-analysis",
				role: "analyst" as const,
				objective: "Find authentication entry points",
			},
		],
	};
}

function modelAnalystRequest() {
	return {
		tasks: [{ id: "auth-analysis", objective: "Find authentication entry points" }],
	};
}

function handoff(overrides: Record<string, unknown> = {}) {
	return {
		summary: "Found the authentication boundary",
		outcome: "accepted",
		evidence: [{ path: "src/auth.ts", lineRange: "10-20", claim: "Defines login" }],
		...overrides,
	};
}

describe("Subagent tool request schema", () => {
	it("exposes a provider-safe root without Controller-owned fields", () => {
		const schema = createSubagentToolRequestSchema(DEFAULT_SUBAGENT_POLICY);
		const jsonSchema = schema as unknown as {
			type?: string;
			properties?: Record<string, unknown>;
			required?: string[];
		};
		expect(jsonSchema.type).toBe("object");
		const properties = jsonSchema.properties;
		expect(Object.keys(properties ?? {})).toEqual(["tasks"]);
		expect(jsonSchema.required).toEqual(["tasks"]);
		const anthropicLegacyProjection = {
			type: "object",
			properties: properties ?? {},
			required: jsonSchema.required ?? [],
		};
		expect(Object.keys(anthropicLegacyProjection.properties)).toHaveLength(1);
		const taskProperties =
			(properties?.tasks as { items?: { properties?: Record<string, { description?: string }> } } | undefined)?.items
				?.properties ?? {};
		expect(Object.keys(taskProperties).sort()).toEqual(
			["dependsOn", "externalOwnedPaths", "id", "objective", "ownedPaths", "reviewOf"].sort(),
		);
		expect(taskProperties).not.toHaveProperty("role");
		expect(taskProperties.objective?.description).toContain("outcome and scope");
		expect(taskProperties.objective?.description).toContain("implementation details");
		expect(taskProperties.dependsOn?.description).toContain("ordering");
		expect(taskProperties.reviewOf?.description).toContain("independent verdict");
		expect(properties).not.toHaveProperty("maxTokensPerTask");
		expect(taskProperties.ownedPaths?.description).toContain("isolated Writer");
		expect(taskProperties.externalOwnedPaths?.description).toContain("irreversible external Writer");
		expect(taskProperties).not.toHaveProperty("maxAttempts");
		expect(taskProperties).not.toHaveProperty("validationCommandIds");
		expect(properties).not.toHaveProperty("expectedGraphVersion");
		expect(() => makeStrictJsonSchema(schema)).not.toThrow();
		expect(Value.Check(schema, modelAnalystRequest())).toBe(true);
		expect(Value.Check(schema, { ...modelAnalystRequest(), maxTokensPerTask: 100_000 })).toBe(false);
		expect(() => parseSubagentToolRequest({ ...modelAnalystRequest(), maxTokensPerTask: 100_000 }, schema)).toThrow(
			"does not match the registered schema",
		);
		expect(Value.Check(schema, { operation: "resume", runId: "run-1" })).toBe(false);
		expect(Value.Check(schema, { operation: "inspect", runId: "run-1" })).toBe(false);
		expect(Value.Check(schema, { operation: "inspect", runId: "run-1", taskId: "task-1" })).toBe(false);
		expect(Value.Check(schema, { operation: "message", runId: "run-1", taskId: "task-1", message: "focus" })).toBe(
			false,
		);
		expect(Value.Check(schema, { operation: "follow_up", runId: "run-1", taskId: "task-1", message: "verify" })).toBe(
			false,
		);
		expect(Value.Check(schema, { operation: "interrupt", runId: "run-1", taskId: "task-1" })).toBe(false);
		expect(
			Value.Check(schema, {
				operation: "expand",
				runId: "run-1",
				tasks: [],
				sealGraph: true,
			}),
		).toBe(false);
		expect(
			Value.Check(schema, {
				operation: "expand",
				runId: "run-1",
				expectedGraphVersion: 1,
				tasks: [],
				sealGraph: true,
			}),
		).toBe(false);
		expect(() => parseSubagentToolRequest({ operation: "resume", runId: "run-1", taskId: "task-1" }, schema)).toThrow(
			"does not match the registered schema",
		);
		expect(Value.Check(schema, { operation: "resume", runId: "run-1", maxTokensPerTask: 1_000_000 })).toBe(false);
		expect(Value.Check(schema, { ...modelAnalystRequest(), operation: "start" })).toBe(false);
		expect(Value.Check(schema, { ...modelAnalystRequest(), runId: "run-1" })).toBe(false);
		expect(Value.Check(schema, { ...modelAnalystRequest(), taskId: "task-1" })).toBe(false);
		expect(Value.Check(schema, { ...modelAnalystRequest(), objective: "legacy" })).toBe(false);
		expect(Value.Check(schema, { ...modelAnalystRequest(), createCandidate: true })).toBe(false);
		expect(Value.Check(schema, { ...modelAnalystRequest(), openGraph: true })).toBe(false);
		expect(
			Value.Check(schema, {
				...modelAnalystRequest(),
				tasks: [{ ...modelAnalystRequest().tasks[0], focusPaths: ["src"] }],
			}),
		).toBe(false);
		expect(
			Value.Check(schema, {
				...modelAnalystRequest(),
				tasks: [{ ...modelAnalystRequest().tasks[0], nonGoals: ["none"] }],
			}),
		).toBe(false);
		expect(
			Value.Check(schema, {
				...modelAnalystRequest(),
				tasks: [{ ...modelAnalystRequest().tasks[0], acceptance: ["done"] }],
			}),
		).toBe(false);
		expect(
			Value.Check(schema, {
				...modelAnalystRequest(),
				tasks: [{ ...modelAnalystRequest().tasks[0], role: "analyst" }],
			}),
		).toBe(false);
		expect(Value.Check(schema, { ...modelAnalystRequest(), version: 2 })).toBe(false);
		expect(Value.Check(schema, { ...modelAnalystRequest(), budget: { maxTokens: 10 } })).toBe(false);
		expect(Value.Check(schema, { ...modelAnalystRequest(), merge: { enabled: true } })).toBe(false);
		expect(
			Value.Check(schema, {
				...modelAnalystRequest(),
				tasks: [{ id: "write", objective: "Write", ownedPaths: ["src"], validationCommandIds: [] }],
			}),
		).toBe(false);
	});

	it("infers report and isolated-writer execution without a Parent-selected role", () => {
		const schema = createSubagentToolRequestSchema(writerPolicy);
		expect(() => makeStrictJsonSchema(schema)).not.toThrow();
		const request = {
			tasks: [{ id: "write", objective: "Implement the module and verify it", ownedPaths: ["src"] }],
		};
		expect(Value.Check(schema, request)).toBe(true);
		expect(Value.Check(schema, { ...request, tasks: [{ ...request.tasks[0], role: "writer" }] })).toBe(false);
		expect(
			Value.Check(schema, { ...request, tasks: [{ ...request.tasks[0], validationCommandIds: ["unit:test"] }] }),
		).toBe(false);
		expect(Value.Check(schema, { ...request, tasks: [{ ...request.tasks[0], maxAttempts: 2 }] })).toBe(false);
		expect(Value.Check(schema, { ...request, maxTokens: 40_000 })).toBe(false);
		expect(() => parseSubagentToolRequest({}, schema)).toThrow("does not match the registered schema");
		expect(() => parseSubagentToolRequest({ operation: "start" }, schema)).toThrow(
			"does not match the registered schema",
		);

		const reader = compileSubagentToolDagRequest(modelAnalystRequest(), writerPolicy, ["unit:test", "lint"]);
		expect(reader.tasks[0]).toMatchObject({ role: "scout", objective: "Find authentication entry points" });
		const writer = compileSubagentToolDagRequest(request, writerPolicy, ["unit:test", "lint"]);
		expect(writer.tasks[0]).toMatchObject({
			role: "writer",
			ownedPaths: ["src"],
			validationCommandIds: ["unit:test", "lint"],
		});
	});

	it("infers irreversible external execution and rejects incompatible structural fields", () => {
		const schema = createSubagentToolRequestSchema(writerPolicy);
		const external = {
			tasks: [
				{
					id: "publish",
					objective: "Publish output",
					externalOwnedPaths: ["/tmp/wj-published.txt"],
				},
			],
		};
		expect(Value.Check(schema, external)).toBe(true);
		expect(parseSubagentToolRequest(external, schema)).toEqual(external);
		expect(compileSubagentToolDagRequest(external, writerPolicy).tasks[0]).toMatchObject({
			role: "external-writer",
			maxAttempts: 1,
		});
		expect(() =>
			parseSubagentToolRequest({ ...external, tasks: [{ ...external.tasks[0], ownedPaths: ["src"] }] }, schema),
		).toThrow("mutually exclusive");
	});

	it("derives Reviewer semantics from reviewOf and rejects incomplete review closure before execution", () => {
		const schema = createSubagentToolRequestSchema(writerPolicy);
		const reviewed = {
			tasks: [
				{ id: "write-a", objective: "Implement A", ownedPaths: ["src/a"] },
				{ id: "write-b", objective: "Implement B", ownedPaths: ["src/b"] },
				{
					id: "review",
					objective: "Independently review the complete candidate",
					reviewOf: ["write-a", "write-b"],
				},
			],
		};
		expect(Value.Check(schema, reviewed)).toBe(true);
		const compiled = compileSubagentToolDagRequest(reviewed, writerPolicy, ["unit:test", "lint"]);
		expect(compiled.tasks[2]).toMatchObject({
			role: "reviewer",
			dependsOn: ["write-a", "write-b"],
		});
		expect(() =>
			compileSubagentToolDagRequest(
				{ ...reviewed, tasks: [...reviewed.tasks.slice(0, 2), { ...reviewed.tasks[2], reviewOf: ["write-a"] }] },
				writerPolicy,
				["unit:test", "lint"],
			),
		).toThrow("must cover every isolated Writer");
		expect(() =>
			compileSubagentToolDagRequest(
				{ tasks: [{ id: "review", objective: "Review", reviewOf: ["missing"] }] },
				writerPolicy,
			),
		).toThrow("depends on unknown task missing");
		expect(() =>
			compileSubagentToolDagRequest(
				{ tasks: [{ id: "review", objective: "Review", reviewOf: ["review"] }] },
				writerPolicy,
			),
		).toThrow("cannot depend on itself");
		expect(() =>
			parseSubagentToolRequest(
				{ tasks: [{ id: "bad", objective: "Write and review", ownedPaths: ["src"], reviewOf: ["other"] }] },
				schema,
			),
		).toThrow("reviewOf cannot be combined");
	});

	it("compiles additive open-graph expansions and revalidates the complete graph", () => {
		const open = compileSubagentDagRequest({ ...analystRequest(), openGraph: true }, writerPolicy);
		expect(open.graph).toEqual({ sealed: false });
		const expanded = compileSubagentDagExpansion(
			open,
			{
				operation: "expand",
				runId: "run-1",
				tasks: [
					{
						id: "review",
						role: "reviewer",
						objective: "Review",
						focusPaths: ["/shared/reference.md"],
						dependsOn: ["auth-analysis"],
					},
				],
				sealGraph: true,
			},
			writerPolicy,
		);
		expect(expanded.tasks.map((task) => [task.id, task.role, task.readPaths, task.dependsOn])).toEqual([
			["auth-analysis", "scout", [], []],
			["review", "reviewer", ["/shared/reference.md"], ["auth-analysis"]],
		]);
		expect(expanded.graph).toEqual({ sealed: true });
		const externalExpansion = compileSubagentDagExpansion(
			open,
			{
				operation: "expand",
				runId: "run-1",
				tasks: [
					{
						id: "publish",
						role: "external-writer",
						objective: "Publish",
						externalOwnedPaths: ["/tmp/wj-expanded-output"],
						dependsOn: ["auth-analysis"],
					},
				],
				sealGraph: true,
			},
			writerPolicy,
		);
		expect(externalExpansion.tasks[1]).toMatchObject({ role: "external-writer", maxAttempts: 1 });
		expect(() =>
			compileSubagentDagExpansion(
				open,
				{
					operation: "expand",
					runId: "run-1",
					tasks: [{ id: "auth-analysis", role: "analyst", objective: "duplicate" }],
				},
				writerPolicy,
			),
		).toThrow("ids must be unique");
		expect(() =>
			compileSubagentDagExpansion(
				open,
				{
					operation: "expand",
					runId: "run-1",
					tasks: [{ id: "bad", role: "analyst", objective: "bad", dependsOn: ["missing"] }],
				},
				writerPolicy,
			),
		).toThrow("unknown task missing");
	});
});

describe("compileSubagentDagRequest", () => {
	it("uses only the configured session policy budget", () => {
		expect(DEFAULT_SUBAGENT_POLICY.defaultBudget).toEqual({ maxTokens: 10_000_000 });
		expect(DEFAULT_SUBAGENT_POLICY.maximumBudget).toEqual({ maxTokens: 1_000_000_000 });
		expect(compileSubagentDagRequest(analystRequest())).toMatchObject({
			budget: { maxTokens: 10_000_000 },
			budgetScope: "task",
			tasks: [{ maxAttempts: DEFAULT_SUBAGENT_POLICY.maxTaskAttempts }],
		});
		expect(
			compileSubagentDagRequest(analystRequest(), {
				...DEFAULT_SUBAGENT_POLICY,
				defaultBudget: { maxTokens: 20_000_000 },
			}),
		).toMatchObject({
			budget: { maxTokens: 20_000_000 },
			budgetScope: "task",
		});
		expect(() =>
			compileSubagentDagRequest(analystRequest(), {
				...DEFAULT_SUBAGENT_POLICY,
				defaultBudget: { maxTokens: 99_999 },
			}),
		).toThrow("between 100,000 and 1,000,000,000");
	});

	it("derives single-task durable labels and candidate intent", () => {
		const readOnly = compileSubagentDagRequest(analystRequest());
		expect(readOnly).toMatchObject({
			objective: "Find authentication entry points",
			merge: { enabled: false },
		});
		const writer = compileSubagentDagRequest({
			operation: "start",
			tasks: [{ id: "write", role: "writer", objective: "Write output", ownedPaths: ["src/output.ts"] }],
		});
		expect(writer).toMatchObject({ objective: "Write output", merge: { enabled: true } });
	});

	it("maps the lean caller contract to durable DAG v2", () => {
		const compiled = compileSubagentDagRequest(
			{
				operation: "start",
				tasks: [
					{ id: "inspect", role: "analyst", objective: "Inspect auth", focusPaths: ["./src", "src"] },
					{
						id: "write",
						role: "writer",
						objective: "Update auth",
						dependsOn: ["inspect"],
						ownedPaths: ["./src/auth", "src/auth"],
						validationCommandIds: ["unit:test"],
						maxAttempts: 2,
					},
				],
			},
			writerPolicy,
		);

		expect(compiled).toMatchObject({
			version: 2,
			handoffProtocolVersion: 2,
			objective: "Coordinate 2 delegated tasks",
			budget: { maxTokens: writerPolicy.defaultBudget.maxTokens },
			budgetScope: "task",
			merge: { enabled: true, refPrefix: "pi/subagent/integration" },
		});
		expect(compiled.tasks[0]).toMatchObject({ role: "scout", readPaths: ["src"] });
		expect(compiled.tasks[1]).toMatchObject({
			role: "writer",
			dependsOn: ["inspect"],
			ownedPaths: ["src/auth"],
			validationCommandIds: ["unit:test"],
			maxAttempts: 2,
		});
		expect(compiled.tasks.every((task) => /^[a-f0-9]{64}$/.test(task.contractHash))).toBe(true);
	});

	it("rejects candidate writers without registered validation coverage before start or expansion", () => {
		const missingValidation = [
			{ id: "write-a", role: "writer" as const, objective: "Write A", ownedPaths: ["src/a"] },
			{ id: "write-b", role: "writer" as const, objective: "Write B", ownedPaths: ["src/b"] },
		];
		expect(() =>
			compileSubagentDagRequest(
				{ operation: "start", objective: "Candidate", tasks: missingValidation },
				writerPolicy,
			),
		).toThrow("Candidate writer tasks require at least one registered validation command: write-a, write-b");
		expect(() =>
			compileSubagentDagRequest(
				{ operation: "start", objective: "No candidate", createCandidate: false, tasks: missingValidation },
				writerPolicy,
			),
		).not.toThrow();
		expect(() =>
			compileSubagentDagRequest(
				{
					operation: "start",
					objective: "Candidate without registered commands",
					createCandidate: true,
					tasks: missingValidation,
				},
				DEFAULT_SUBAGENT_POLICY,
			),
		).not.toThrow();

		const openCandidate = compileSubagentDagRequest(
			{
				operation: "start",
				objective: "Expandable candidate",
				createCandidate: true,
				openGraph: true,
				tasks: [
					{
						id: "write-covered",
						role: "writer",
						objective: "Write covered",
						ownedPaths: ["src/covered"],
						validationCommandIds: ["unit:test"],
					},
				],
			},
			writerPolicy,
		);
		expect(() =>
			compileSubagentDagExpansion(
				openCandidate,
				{
					operation: "expand",
					runId: "candidate-run",
					tasks: [
						{ id: "write-uncovered", role: "writer", objective: "Write uncovered", ownedPaths: ["src/new"] },
					],
					sealGraph: true,
				},
				writerPolicy,
			),
		).toThrow("Candidate writer tasks require at least one registered validation command: write-uncovered");
	});

	it("compiles external writers as one-attempt side effects and rejects unsafe combinations", () => {
		const externalTask = {
			id: "publish",
			role: "external-writer" as const,
			objective: "Publish output",
			externalOwnedPaths: ["/tmp/wj-published.txt"],
		};
		const compiled = compileSubagentDagRequest(
			{ operation: "start", objective: "Publish", tasks: [externalTask] },
			writerPolicy,
		);
		expect(compiled.tasks[0]).toMatchObject({
			role: "external-writer",
			maxAttempts: 1,
			externalOwnedPaths: [expect.stringContaining("wj-published.txt")],
		});
		expect(() =>
			compileSubagentDagRequest(
				{ operation: "start", objective: "Retry", tasks: [{ ...externalTask, maxAttempts: 2 }] },
				writerPolicy,
			),
		).toThrow("must use maxAttempts 1");
		expect(() =>
			compileSubagentDagRequest(
				{ operation: "start", objective: "Candidate", createCandidate: true, tasks: [externalTask] },
				writerPolicy,
			),
		).toThrow("cannot create candidates");
		expect(() =>
			compileSubagentDagRequest(
				{
					operation: "start",
					objective: "Mixed",
					tasks: [externalTask, { id: "write", role: "writer", objective: "Write", ownedPaths: ["src"] }],
				},
				writerPolicy,
			),
		).toThrow("cannot be mixed");
		expect(() =>
			compileSubagentDagRequest(
				{
					operation: "start",
					objective: "Relative",
					tasks: [{ ...externalTask, externalOwnedPaths: ["relative.txt"] }],
				},
				writerPolicy,
			),
		).toThrow("requires normalized absolute externalOwnedPaths");
		expect(() =>
			compileSubagentDagRequest(
				{
					operation: "start",
					objective: "Overlap",
					tasks: [externalTask, { ...externalTask, id: "publish-2", externalOwnedPaths: ["/tmp"] }],
				},
				writerPolicy,
			),
		).toThrow("overlaps");
	});

	it("rejects cycles, unsafe ownership, overlaps, and unregistered commands", () => {
		const writer = { id: "write-a", role: "writer" as const, objective: "Write A", ownedPaths: ["src/a"] };
		expect(() =>
			compileSubagentDagRequest(
				{
					operation: "start",
					objective: "Cycle",
					tasks: [
						{ id: "a", role: "analyst", objective: "A", dependsOn: ["b"] },
						{ id: "b", role: "analyst", objective: "B", dependsOn: ["a"] },
					],
				},
				writerPolicy,
			),
		).toThrow("dependency cycle");
		expect(() =>
			compileSubagentDagRequest(
				{ operation: "start", objective: "Unsafe", tasks: [{ ...writer, ownedPaths: ["../outside"] }] },
				writerPolicy,
			),
		).toThrow("unsafe owned path");
		const absoluteFocus = compileSubagentDagRequest(
			{
				operation: "start",
				objective: "Absolute focus",
				tasks: [
					{ id: "inspect", role: "analyst", objective: "Inspect", focusPaths: ["/absolute", "/", "C:/shared"] },
				],
			},
			writerPolicy,
		);
		expect(absoluteFocus.tasks[0]?.readPaths).toEqual(["/absolute", "/", "C:/shared"]);
		expect(() =>
			compileSubagentDagRequest(
				{ operation: "start", objective: "Unsafe focus", tasks: [{ ...writer, ownedPaths: ["/absolute"] }] },
				writerPolicy,
			),
		).toThrow("unsafe owned path");
		expect(() =>
			compileSubagentDagRequest(
				{
					operation: "start",
					objective: "Overlap",
					tasks: [writer, { ...writer, id: "write-b", ownedPaths: ["src/a/nested"] }],
				},
				writerPolicy,
			),
		).toThrow("overlaps");
		expect(() =>
			compileSubagentDagRequest(
				{
					operation: "start",
					objective: "Command",
					tasks: [{ ...writer, validationCommandIds: ["arbitrary"] }],
				},
				writerPolicy,
			),
		).toThrow("unregistered validation command arbitrary; registered: lint, unit:test");
	});

	it("rejects aggregate requests above 128 KiB before orchestration", () => {
		expect(() => assertSubagentToolRequestSize(modelAnalystRequest())).not.toThrow();
		const oversized = {
			...modelAnalystRequest(),
			tasks: [{ ...modelAnalystRequest().tasks[0], objective: "x".repeat(MAX_SUBAGENT_REQUEST_BYTES) }],
		};
		expect(() => assertSubagentToolRequestSize(oversized)).toThrow(`${MAX_SUBAGENT_REQUEST_BYTES}-byte limit`);
	});
});

describe("bounded Subagent handoffs", () => {
	it("uses a three-field schema and injects task-bound Controller fields", () => {
		const schema = createSubmitHandoffSchema() as { properties?: Record<string, unknown>; required?: string[] };
		expect(Object.keys(schema.properties ?? {})).toEqual(["summary", "outcome", "evidence"]);
		expect(schema.required).toEqual(["summary", "outcome"]);
		expect(Value.Check(schema as never, handoff())).toBe(true);
		expect(Value.Check(schema as never, handoff({ evidence: undefined }))).toBe(true);
		expect(Value.Check(schema as never, handoff({ taskId: "other" }))).toBe(false);
		expect(Value.Check(schema as never, handoff({ role: "reviewer" }))).toBe(false);
		expect(Value.Check(schema as never, handoff({ outcome: undefined }))).toBe(false);
		for (const field of ["verification", "assumptions", "risks", "nextActions", "verificationLevel"]) {
			expect(Value.Check(schema as never, handoff({ [field]: [] }))).toBe(false);
		}

		const decoded = decodeHandoffJson(JSON.stringify(handoff({ evidence: undefined })), "auth-analysis", "scout");
		expect(decoded.handoff).toMatchObject({
			taskId: "auth-analysis",
			outcome: "accepted",
			evidence: [],
			verification: [],
			assumptions: [],
			risks: [],
			nextActions: [],
			verificationLevel: "unverified",
		});
		expect(decoded.payload).toMatchObject({ taskId: "auth-analysis", role: "scout", outcome: "accepted" });
		expect(decoded.payload).not.toHaveProperty("verificationLevel");
	});

	it("rejects malformed, extra, and over-limit minimal fields", () => {
		for (const payload of [
			{ ...handoff(), outcome: undefined },
			{ ...handoff(), evidence: {} },
			{ ...handoff(), verification: [] },
			{ ...handoff(), unknown: true },
			{
				...handoff(),
				evidence: Array.from({ length: HANDOFF_LIMITS.evidenceItems + 1 }, (_, index) => ({
					path: `src/file-${index}.ts`,
					claim: `Evidence ${index}`,
				})),
			},
		]) {
			expect(() => decodeHandoffJson(JSON.stringify(payload), "auth-analysis", "scout")).toThrow(
				"task-bound protocol v2 schema",
			);
		}
	});

	it("preserves each explicit semantic outcome", () => {
		for (const outcome of ["accepted", "rejected", "inconclusive"] as const) {
			const decoded = decodeHandoffJson(JSON.stringify(handoff({ outcome })), "auth-analysis", "scout");
			expect(decoded.handoff).toMatchObject({ outcome, verificationLevel: "unverified" });
			expect(decoded.payload).toMatchObject({ outcome });
		}
	});

	it("injects complete reader, writer, reviewer, and external-writer identities", () => {
		expect(decodeHandoffJson(JSON.stringify(handoff()), "auth-analysis", "scout").handoff.evidence[0]?.path).toBe(
			"src/auth.ts",
		);
		expect(decodeHandoffJson(JSON.stringify(handoff()), "auth-analysis", "reviewer").handoff.outcome).toBe(
			"accepted",
		);

		const writerDecoded = decodeHandoffJson(JSON.stringify(handoff()), "write", "writer").handoff;
		expect(writerDecoded).toMatchObject({ taskId: "write", artifactVersion: 2, changedPaths: [] });

		const externalDecoded = decodeHandoffJson(JSON.stringify(handoff()), "publish", "external-writer").handoff;
		expect(externalDecoded).toMatchObject({ taskId: "publish", artifactVersion: 2, externalChangedPaths: [] });
	});

	it("rejects every model-supplied Controller field", () => {
		expect(() =>
			decodeHandoffJson(JSON.stringify(handoff({ artifactVersion: 2, changedPaths: [] })), "auth-analysis", "scout"),
		).toThrow("task-bound protocol v2 schema");
		for (const extra of [
			{ taskId: "write" },
			{ role: "writer" },
			{ artifactVersion: 2 },
			{ changedPaths: ["src/auth.ts"] },
			{ externalChangedPaths: ["/tmp/published.txt"] },
			{ verification: [] },
			{ assumptions: [] },
			{ risks: [] },
			{ nextActions: [] },
		]) {
			expect(() => decodeHandoffJson(JSON.stringify(handoff(extra)), "write", "writer")).toThrow(
				"task-bound protocol v2 schema",
			);
		}
	});

	it("aligns task identity limits and enforces the UTF-8 envelope budget", () => {
		const maxTaskId = `a${"b".repeat(63)}`;
		expect(() => decodeHandoffJson(JSON.stringify(handoff()), maxTaskId, "scout")).not.toThrow();
		expect(() => decodeHandoffJson(JSON.stringify(handoff()), `${maxTaskId}c`, "scout")).toThrow("1-64 characters");
		expect(() => decodeHandoffJson("done", "auth-analysis", "scout")).toThrow("not valid JSON");
		const unicodeHeavy = handoff({ summary: "界".repeat(HANDOFF_LIMITS.maxJsonBytes) });
		expect(() => decodeHandoffJson(JSON.stringify(unicodeHeavy), "auth-analysis", "scout")).toThrow(
			"byte JSON limit",
		);
	});
});
