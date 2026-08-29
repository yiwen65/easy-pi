import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	EditV2Details,
	ReadV2Details,
	SearchCapabilities,
	SearchExecutionContext,
	SearchPage,
	SearchProvider,
	SearchRequest,
	SearchV2Details,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepToolDefinition } from "../../src/core/tools/grep.ts";
import { LocalSearchProviderV2 } from "../../src/core/tools/local-search-provider-v2.ts";
import { createV2ToolRuntime } from "../../src/core/tools/tool-profile.ts";
import { TypeScriptCodeIndexProvider } from "../../src/core/tools/typescript-code-index-provider.ts";
import {
	type ContextObservation,
	type EvidenceVariant,
	type FullRequirementEvidenceInput,
	type RetrievalObservation,
	type SafetyObservation,
	type ScenarioContract,
	summarizeFullRequirementEvidence,
} from "./full-requirement-evidence.ts";

const SCENARIO_CONTRACTS: ScenarioContract[] = [
	{
		id: 1,
		name: "production-doc-test-vendor-duplicates",
		targetType: "production assignment",
		legalTargetCount: 1,
		allowedSearchScope: "synthetic fixture root",
		expectedCoverage: "complete",
		allowedMutationRange: "declared production assignment line",
		expectedErrorCode: null,
	},
	{
		id: 2,
		name: "high-frequency-fields",
		targetType: "qualified property assignment",
		legalTargetCount: 1,
		allowedSearchScope: "synthetic src tree",
		expectedCoverage: "complete",
		allowedMutationRange: "none",
		expectedErrorCode: null,
	},
	{
		id: 3,
		name: "definition-and-many-calls",
		targetType: "definition and call sites",
		legalTargetCount: 1,
		allowedSearchScope: "synthetic TypeScript file",
		expectedCoverage: "complete",
		allowedMutationRange: "none",
		expectedErrorCode: null,
	},
	{
		id: 4,
		name: "same-method-multiple-classes",
		targetType: "qualified method definition",
		legalTargetCount: 1,
		allowedSearchScope: "synthetic src tree",
		expectedCoverage: "complete",
		allowedMutationRange: "none",
		expectedErrorCode: null,
	},
	{
		id: 5,
		name: "target-near-large-file-tail",
		targetType: "literal marker",
		legalTargetCount: 1,
		allowedSearchScope: "one synthetic large file",
		expectedCoverage: "complete",
		allowedMutationRange: "none",
		expectedErrorCode: null,
	},
	{
		id: 6,
		name: "target-in-long-line",
		targetType: "literal marker",
		legalTargetCount: 1,
		allowedSearchScope: "one synthetic long-line file",
		expectedCoverage: "complete",
		allowedMutationRange: "none",
		expectedErrorCode: null,
	},
	{
		id: 7,
		name: "index-file-limit",
		targetType: "uncovered symbol definition",
		legalTargetCount: 1,
		allowedSearchScope: "bounded synthetic TypeScript index",
		expectedCoverage: "partial",
		allowedMutationRange: "none",
		expectedErrorCode: null,
	},
	{
		id: 8,
		name: "global-result-overflow",
		targetType: "literal matches",
		legalTargetCount: 8,
		allowedSearchScope: "synthetic src tree",
		expectedCoverage: "overflow",
		allowedMutationRange: "none",
		expectedErrorCode: null,
	},
	{
		id: 9,
		name: "single-file-result-overflow",
		targetType: "literal matches",
		legalTargetCount: 10,
		allowedSearchScope: "one synthetic file",
		expectedCoverage: "overflow",
		allowedMutationRange: "none",
		expectedErrorCode: null,
	},
	{
		id: 10,
		name: "ambiguous-old-text",
		targetType: "second exact line",
		legalTargetCount: 1,
		allowedSearchScope: "one synthetic text file",
		expectedCoverage: "complete",
		allowedMutationRange: "line 3 only",
		expectedErrorCode: "AMBIGUOUS_MATCH",
	},
	{
		id: 11,
		name: "file-changed-between-read-and-edit",
		targetType: "view-bound update",
		legalTargetCount: 1,
		allowedSearchScope: "one synthetic text file",
		expectedCoverage: "complete",
		allowedMutationRange: "line 1 only",
		expectedErrorCode: "STALE_VIEW",
	},
	{
		id: 12,
		name: "prepared-preimage-changed",
		targetType: "prepared patch",
		legalTargetCount: 1,
		allowedSearchScope: "one synthetic text file",
		expectedCoverage: "complete",
		allowedMutationRange: "line 1 only",
		expectedErrorCode: "STALE_PATCH",
	},
	{
		id: 13,
		name: "unsupported-structured-language",
		targetType: "Python definition",
		legalTargetCount: 1,
		allowedSearchScope: "one synthetic Python file",
		expectedCoverage: "partial",
		allowedMutationRange: "none",
		expectedErrorCode: "SEARCH_CAPABILITY_UNSUPPORTED",
	},
	{
		id: 14,
		name: "ignored-target",
		targetType: "ignored literal marker",
		legalTargetCount: 1,
		allowedSearchScope: "synthetic root with explicit ignore rules",
		expectedCoverage: "complete",
		allowedMutationRange: "none",
		expectedErrorCode: null,
	},
	{
		id: 15,
		name: "multi-file-prevalidation-failure",
		targetType: "two-file prepared patch",
		legalTargetCount: 2,
		allowedSearchScope: "two synthetic text files",
		expectedCoverage: "complete",
		allowedMutationRange: "line 1 in each file",
		expectedErrorCode: "STALE_PATCH",
	},
	{
		id: 16,
		name: "syntax-failure-recovery",
		targetType: "JavaScript function body",
		legalTargetCount: 1,
		allowedSearchScope: "one synthetic JavaScript file",
		expectedCoverage: "complete",
		allowedMutationRange: "line 1 only",
		expectedErrorCode: null,
	},
];

interface Measured<T> {
	value: T;
	inputTokens: number;
	outputBytes: number;
	outputTokens: number;
	latencyMs: number;
	text: string;
}

class StaticSemanticProvider implements SearchProvider {
	readonly id = "static-semantic-evidence";
	readonly capabilities: SearchCapabilities = {
		textLiteral: false,
		textRegex: false,
		context: false,
		fuzzyFiles: false,
		glob: false,
		stableCursor: true,
		globalRanking: false,
		taskRanking: true,
		scopeFilters: true,
		wordBoundary: false,
		structuredModes: ["semantic_candidate"],
	};
	calls = 0;

	async search(request: SearchRequest, _context: SearchExecutionContext): Promise<SearchPage> {
		this.calls++;
		const preferred = request.preferredPaths?.length ? "src/preferred/concept.ts" : "src/other/concept.ts";
		const other = preferred === "src/preferred/concept.ts" ? "src/other/concept.ts" : "src/preferred/concept.ts";
		return {
			hits: [preferred, other].map((path, index) => ({
				kind: "text" as const,
				path,
				line: 1,
				endLine: 1,
				column: 14,
				endColumn: 25,
				text: "export const reconcile = true;",
				ranges: [[13, 22] as [number, number]],
				matchKind: "semantic_candidate",
				fileClass: "production",
				score: index,
				rankReasons: index === 0 ? ["preferred_path"] : [],
			})),
			complete: true,
			approximate: false,
			partial: false,
			generation: "static-semantic-generation",
			matchedCount: 2,
			matchedCountRelation: "exact",
		};
	}

	async close(): Promise<void> {}
}

function resultText(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
	return result.content
		.flatMap((part: unknown) =>
			part &&
			typeof part === "object" &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n");
}

function estimatedTokens(value: string): number {
	return Math.max(1, Math.ceil(Buffer.byteLength(value) / 4));
}

async function measure<T>(input: unknown, operation: () => Promise<T>): Promise<Measured<T>> {
	const startedAt = performance.now();
	const value = await operation();
	const text = resultText(value);
	const outputBytes = Buffer.byteLength(text);
	return {
		value,
		inputTokens: estimatedTokens(JSON.stringify(input)),
		outputBytes,
		outputTokens: estimatedTokens(text),
		latencyMs: Math.max(0, performance.now() - startedAt),
		text,
	};
}

async function errorCode(operation: () => Promise<unknown>): Promise<string | undefined> {
	try {
		await operation();
		return undefined;
	} catch (error) {
		return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
	}
}

function hitIds(details: SearchV2Details): string[] {
	return details.hits.map((hit) => `${hit.path}:${hit.kind === "text" ? hit.line : 0}`);
}

function retrievalObservation(
	variant: EvidenceVariant,
	queryId: string,
	measured: Measured<unknown>,
	details: SearchV2Details,
	legalTargetIds: string[],
	options: { searchCalls?: number; broadQueryRetries?: number } = {},
): RetrievalObservation {
	return {
		variant,
		queryId,
		returnedIds: hitIds(details),
		legalTargetIds,
		coverage: details.status,
		searchCalls: options.searchCalls ?? 1,
		returnedBytes: measured.outputBytes,
		returnedTokens: measured.outputTokens,
		latencyMs: measured.latencyMs,
		broadQueryRetries: options.broadQueryRetries ?? 0,
	};
}

function relevantTokens(text: string, needles: string[]): number {
	const relevant = text
		.split("\n")
		.filter((line) => needles.some((needle) => line.includes(needle)))
		.join("\n");
	return Math.min(estimatedTokens(text), estimatedTokens(relevant));
}

function repeatedTokens(text: string, needle: string): number {
	const count = text.split(needle).length - 1;
	return Math.min(estimatedTokens(text), Math.max(0, count - 1) * estimatedTokens(needle));
}

function contextObservation(phase: ContextObservation["phase"], text: string, needles: string[]): ContextObservation {
	const outputTokens = estimatedTokens(text);
	const relevant = relevantTokens(text, needles);
	return {
		phase,
		outputBytes: Buffer.byteLength(text),
		outputTokens,
		relevantTokens: Math.max(1, relevant),
		minimalTokens: Math.max(1, relevant),
		repeatedTokens: repeatedTokens(text, needles[0] ?? "__missing__"),
	};
}

function write(root: string, relativePath: string, content: string): void {
	mkdirSync(join(root, relativePath, ".."), { recursive: true });
	writeFileSync(join(root, relativePath), content);
}

describe("full P0/P1/P2 deterministic evidence", () => {
	let root: string;
	let runtimes: Array<ReturnType<typeof createV2ToolRuntime>>;

	beforeEach(() => {
		root = join(tmpdir(), `pi-full-tool-evidence-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		runtimes = [];
	});

	afterEach(async () => {
		await Promise.all(runtimes.map((runtime) => runtime.close()));
		rmSync(root, { recursive: true, force: true });
	});

	function runtimeAt(name: string, options: Parameters<typeof createV2ToolRuntime>[1] = {}) {
		const cwd = join(root, name);
		mkdirSync(cwd, { recursive: true });
		const runtime = createV2ToolRuntime(cwd, options);
		runtimes.push(runtime);
		return { cwd, runtime };
	}

	it("executes all 16 declared scenarios and closes every metric without remote calls", async () => {
		expect(SCENARIO_CONTRACTS).toHaveLength(16);
		expect(SCENARIO_CONTRACTS.map((contract) => contract.id)).toEqual(
			Array.from({ length: 16 }, (_, index) => index + 1),
		);
		for (const contract of SCENARIO_CONTRACTS) {
			expect(contract.targetType).not.toBe("");
			expect(contract.legalTargetCount).toBeGreaterThan(0);
			expect(contract.allowedSearchScope).not.toBe("");
			expect(contract.allowedMutationRange).not.toBe("");
		}

		const evidence: FullRequirementEvidenceInput = {
			scenarios: [],
			retrieval: [],
			context: [],
			workflows: [],
			safety: [],
			activationCounts: {
				legacy_baseline: 0,
				text_v2_baseline: 0,
				structured_search: 0,
				semantic_candidate: 0,
				query_template: 0,
				preferred_path_prior: 0,
				partial_coverage: 0,
				overflow: 0,
				context_search: 0,
				context_read: 0,
				context_edit: 0,
				context_full_chain: 0,
			},
		};
		const pass = (id: number): void => {
			evidence.scenarios.push({ id, passed: true });
		};
		const safety = (kind: SafetyObservation["kind"], safe: boolean): void => {
			evidence.safety.push({ kind, safe });
		};

		// 1. Production/docs/tests/vendor duplicates plus actual legacy, text-v2, and structured-v2 baselines.
		{
			const { cwd, runtime } = runtimeAt("scenario-01");
			write(cwd, "src/payment.ts", "export const settlement_timeout_ms = 2750;\n");
			write(cwd, "docs/payment.md", "settlement_timeout_ms = 2750\n");
			write(cwd, "test/payment.test.ts", "expect(gateway.settlement_timeout_ms).toBe(2750);\n");
			write(cwd, "vendor/payment.ts", "export const settlement_timeout_ms = 2750;\n");
			const legacyInput = { pattern: "settlement_timeout_ms", path: ".", literal: true, limit: 20 };
			const legacy = await measure(legacyInput, () =>
				createGrepToolDefinition(cwd).execute("legacy", legacyInput, undefined, undefined, {} as never),
			);
			const legacyIds = legacy.text
				.split("\n")
				.filter((line) => /:\d+:/.test(line))
				.map((line) => line.replace(/:\s.*$/, ""));
			evidence.retrieval.push({
				variant: "legacy",
				queryId: "duplicates",
				returnedIds: legacyIds,
				legalTargetIds: ["src/payment.ts:1"],
				coverage: "complete",
				searchCalls: 1,
				returnedBytes: legacy.outputBytes,
				returnedTokens: legacy.outputTokens,
				latencyMs: legacy.latencyMs,
				broadQueryRetries: 0,
			});
			evidence.activationCounts.legacy_baseline++;

			const search = runtime.definitions.search;
			const context = {} as Parameters<typeof search.execute>[4];
			const textInput = { query: "settlement_timeout_ms", mode: "literal" as const, maxResultsGlobal: 20 };
			const text = await measure(textInput, () => search.execute("text", textInput, undefined, undefined, context));
			const textDetails = text.value.details as SearchV2Details;
			expect(textDetails).toMatchObject({ status: "complete", returnedCount: 4 });
			evidence.retrieval.push(
				retrievalObservation("text_v2", "duplicates", text, textDetails, ["src/payment.ts:1"]),
			);
			evidence.activationCounts.text_v2_baseline++;

			const structuredInput = {
				query: "settlement_timeout_ms",
				queryTemplate: "assignment" as const,
				targetKind: "assignment" as const,
				preferredPaths: ["src/**"],
				maxResultsGlobal: 20,
			};
			const structured = await measure(structuredInput, () =>
				search.execute("structured", structuredInput, undefined, undefined, context),
			);
			const structuredDetails = structured.value.details as SearchV2Details;
			expect(structuredDetails.hits[0]).toMatchObject({ path: "src/payment.ts", matchKind: "assignment" });
			evidence.retrieval.push(
				retrievalObservation("structured_v2", "duplicates", structured, structuredDetails, ["src/payment.ts:1"]),
			);
			evidence.activationCounts.structured_search++;
			evidence.activationCounts.query_template++;
			evidence.activationCounts.preferred_path_prior++;

			const read = runtime.definitions.read;
			const edit = runtime.definitions.edit;
			const locator = structuredDetails.locators[0];
			const readInput = { locatorId: locator.locatorId, beforeLines: 0, afterLines: 0, maxLines: 1 };
			const viewed = await measure(readInput, () => read.execute("read", readInput, undefined, undefined, context));
			const view = viewed.value.details as ReadV2Details;
			const prepareInput = {
				action: "prepare" as const,
				operations: [
					{
						kind: "update" as const,
						path: "src/payment.ts",
						oldText: "2750",
						newText: "3000",
						viewId: view.viewId,
						expectedFileHash: view.fileHash,
						range: { startLine: 1, endLine: 1 },
						matchPolicy: "exactly_one_in_range" as const,
					},
				],
			};
			const prepared = await measure(prepareInput, () =>
				edit.execute("prepare", prepareInput, undefined, undefined, context),
			);
			const patchId = (prepared.value.details as EditV2Details).patchId;
			const commitInput = { action: "commit" as const, patchId: patchId ?? "" };
			const committed = await measure(commitInput, () =>
				edit.execute("commit", commitInput, undefined, undefined, context),
			);
			const verifyInput = { path: "src/payment.ts", startLine: 1, maxLines: 1 };
			const verified = await measure(verifyInput, () =>
				read.execute("verify", verifyInput, undefined, undefined, context),
			);
			expect(verified.text).toContain("settlement_timeout_ms = 3000");
			expect(readFileSync(join(cwd, "vendor/payment.ts"), "utf8")).toContain("2750");
			safety("wrong_location_write", true);

			const editText = `${prepared.text}\n${committed.text}`;
			const chainText = [structured.text, viewed.text, editText, verified.text].join("\n");
			evidence.context.push(
				contextObservation("search", structured.text, ["src/payment.ts"]),
				contextObservation("read", viewed.text, ["settlement_timeout_ms"]),
				contextObservation("edit", editText, ["settlement_timeout_ms"]),
				contextObservation("full_chain", chainText, ["settlement_timeout_ms", "src/payment.ts"]),
			);
			evidence.activationCounts.context_search++;
			evidence.activationCounts.context_read++;
			evidence.activationCounts.context_edit++;
			evidence.activationCounts.context_full_chain++;
			evidence.workflows.push({
				callsToLocate: 1,
				callsToSafeEdit: 4,
				callsToVerify: 5,
				returnedBytes:
					structured.outputBytes +
					viewed.outputBytes +
					prepared.outputBytes +
					committed.outputBytes +
					verified.outputBytes,
				returnedTokens:
					structured.outputTokens +
					viewed.outputTokens +
					prepared.outputTokens +
					committed.outputTokens +
					verified.outputTokens,
				inputTokens:
					structured.inputTokens +
					viewed.inputTokens +
					prepared.inputTokens +
					committed.inputTokens +
					verified.inputTokens,
				latencyMs:
					structured.latencyMs + viewed.latencyMs + prepared.latencyMs + committed.latencyMs + verified.latencyMs,
				costUsd: 0,
				broadQueryRetries: 0,
				ambiguityRelocations: 0,
				toolErrors: 0,
				schemaErrors: 0,
			});
			pass(1);
		}

		// 2. Qualified structured intent selects one target among high-frequency field names.
		{
			const { cwd, runtime } = runtimeAt("scenario-02");
			write(
				cwd,
				"src/status.ts",
				`${Array.from(
					{ length: 20 },
					(_, index) => `class Noise${index} { status = ${index}; id = ${index}; name = "n"; }`,
				).join("\n")}\nexport class Target { status = 99; }\n`,
			);
			const search = runtime.definitions.search;
			const input = { query: "Target.status", queryTemplate: "assignment" as const, maxResultsGlobal: 5 };
			const found = await measure(input, () =>
				search.execute("status", input, undefined, undefined, {} as Parameters<typeof search.execute>[4]),
			);
			const details = found.value.details as SearchV2Details;
			expect(details).toMatchObject({ status: "complete", returnedCount: 1 });
			expect(details.hits[0]).toMatchObject({ matchKind: "assignment", enclosingSymbol: "Target" });
			evidence.retrieval.push(
				retrievalObservation("structured_v2", "qualified-status", found, details, ["src/status.ts:21"]),
			);
			evidence.activationCounts.structured_search++;
			evidence.activationCounts.query_template++;
			pass(2);
		}

		// 3. Definition and calls remain distinct and AST Read returns the function body only.
		{
			const { cwd, runtime } = runtimeAt("scenario-03");
			write(
				cwd,
				"src/work.ts",
				"export function performWork() { return 1; }\n" +
					Array.from({ length: 12 }, (_, index) => `export const call${index} = performWork();`).join("\n") +
					"\n",
			);
			const { search, read } = runtime.definitions;
			const context = {} as Parameters<typeof search.execute>[4];
			const definitionInput = { query: "performWork", queryTemplate: "definition" as const, maxResultsGlobal: 20 };
			const definition = await measure(definitionInput, () =>
				search.execute("definition", definitionInput, undefined, undefined, context),
			);
			const definitionDetails = definition.value.details as SearchV2Details;
			const callsInput = {
				query: "performWork",
				queryTemplate: "calls" as const,
				maxResultsGlobal: 20,
				maxResultsPerFile: 20,
			};
			const calls = await measure(callsInput, () =>
				search.execute("calls", callsInput, undefined, undefined, context),
			);
			const callDetails = calls.value.details as SearchV2Details;
			expect(definitionDetails).toMatchObject({ returnedCount: 1 });
			expect(callDetails.returnedCount).toBe(12);
			expect(callDetails.hits.every((hit) => hit.kind === "text" && hit.matchKind === "call")).toBe(true);
			const body = await read.execute(
				"body",
				{ locatorId: definitionDetails.locators[0].locatorId, beforeLines: 0, afterLines: 0 },
				undefined,
				undefined,
				context,
			);
			expect(body.details).toMatchObject({ range: [1, 1] });
			expect(resultText(body)).toContain("function performWork");
			evidence.retrieval.push(
				retrievalObservation("structured_v2", "function-definition", definition, definitionDetails, [
					"src/work.ts:1",
				]),
			);
			evidence.activationCounts.structured_search += 2;
			evidence.activationCounts.query_template += 2;
			pass(3);
		}

		// 4. Qualified names and preferred-path ranking are independently activated and measured.
		{
			const { cwd, runtime } = runtimeAt("scenario-04");
			write(cwd, "src/a/other.ts", "export class Other { configure() { return 1; } }\n");
			write(cwd, "src/m/middle.ts", "export class Middle { configure() { return 2; } }\n");
			write(cwd, "src/z/preferred.ts", "export class Preferred { configure() { return 3; } }\n");
			const search = runtime.definitions.search;
			const context = {} as Parameters<typeof search.execute>[4];
			const noPriorInput = { query: "configure", mode: "symbol_definition" as const, maxResultsGlobal: 10 };
			const noPrior = await measure(noPriorInput, () =>
				search.execute("no-prior", noPriorInput, undefined, undefined, context),
			);
			const noPriorDetails = noPrior.value.details as SearchV2Details;
			const priorInput = { ...noPriorInput, preferredPaths: ["src/z/**"] };
			const withPrior = await measure(priorInput, () =>
				search.execute("with-prior", priorInput, undefined, undefined, context),
			);
			const withPriorDetails = withPrior.value.details as SearchV2Details;
			expect(noPriorDetails.hits[0]).toMatchObject({ path: "src/a/other.ts" });
			expect(withPriorDetails.hits[0]).toMatchObject({
				path: "src/z/preferred.ts",
				rankReasons: expect.arrayContaining(["preferred_path"]),
			});
			const exact = await search.execute(
				"qualified",
				{ query: "Preferred.configure", mode: "symbol_definition", maxResultsGlobal: 5 },
				undefined,
				undefined,
				context,
			);
			expect(exact.details).toMatchObject({ returnedCount: 1 });
			const legal = ["src/z/preferred.ts:1"];
			evidence.retrieval.push(
				retrievalObservation("structured_no_path_prior", "method-path-prior", noPrior, noPriorDetails, legal),
				retrievalObservation("structured_v2", "method-path-prior", withPrior, withPriorDetails, legal),
			);
			evidence.activationCounts.structured_search += 3;
			evidence.activationCounts.preferred_path_prior++;
			pass(4);
		}

		// 5. A target near a 2,500-line tail is located and read without reading the whole file.
		{
			const { cwd, runtime } = runtimeAt("scenario-05");
			const lines = Array.from({ length: 2_500 }, (_, index) => `// filler ${index + 1}`);
			lines[2_399] = "export const LARGE_TAIL_TARGET = true;";
			write(cwd, "src/large.ts", `${lines.join("\n")}\n`);
			const { search, read } = runtime.definitions;
			const context = {} as Parameters<typeof search.execute>[4];
			const found = await search.execute(
				"large",
				{ query: "LARGE_TAIL_TARGET", mode: "literal", maxResultsGlobal: 5 },
				undefined,
				undefined,
				context,
			);
			const details = found.details as SearchV2Details;
			expect(details.hits[0]).toMatchObject({ path: "src/large.ts", line: 2_400 });
			const viewed = await read.execute(
				"large-read",
				{ locatorId: details.locators[0].locatorId, maxLines: 3, maxBytes: 1024 },
				undefined,
				undefined,
				context,
			);
			expect(viewed.details).toMatchObject({ range: [2395, 2397] });
			expect(resultText(viewed)).not.toContain("filler 1\n");
			pass(5);
		}

		// 6. Match-centered long-line Read discloses truncation and retains the target.
		{
			const { cwd, runtime } = runtimeAt("scenario-06");
			write(cwd, "src/long.ts", `${"x".repeat(16_000)}LONG_LINE_TARGET${"y".repeat(8_000)}\n`);
			const { search, read } = runtime.definitions;
			const context = {} as Parameters<typeof search.execute>[4];
			const found = await search.execute(
				"long",
				{ query: "LONG_LINE_TARGET", mode: "literal", maxResultsGlobal: 5 },
				undefined,
				undefined,
				context,
			);
			const details = found.details as SearchV2Details;
			const viewed = await read.execute(
				"long-read",
				{ locatorId: details.locators[0].locatorId, maxBytes: 512 },
				undefined,
				undefined,
				context,
			);
			expect(resultText(viewed)).toContain("LONG_LINE_TARGET");
			expect(Buffer.byteLength(resultText(viewed))).toBeLessThanOrEqual(512);
			expect((viewed.details as ReadV2Details).truncation).toBeDefined();
			safety("truncation_disclosure", true);
			pass(6);
		}

		// 7. A bounded TypeScript index cannot prove absence when the target file was not covered.
		{
			const cwd = join(root, "scenario-07");
			mkdirSync(cwd, { recursive: true });
			write(cwd, "a-target.ts", "export function UncoveredTarget() { return 1; }\n");
			write(cwd, "z-noise.ts", "export function CoveredNoise() { return 2; }\n");
			const runtime = createV2ToolRuntime(cwd, {
				codeIndexProvider: () => new TypeScriptCodeIndexProvider({ maxFiles: 1 }),
			});
			runtimes.push(runtime);
			const search = runtime.definitions.search;
			const found = await measure({ query: "UncoveredTarget", mode: "symbol_definition" }, () =>
				search.execute(
					"partial",
					{ query: "UncoveredTarget", mode: "symbol_definition", maxResultsGlobal: 5 },
					undefined,
					undefined,
					{} as Parameters<typeof search.execute>[4],
				),
			);
			const details = found.value.details as SearchV2Details;
			expect(details).toMatchObject({ status: "partial", returnedCount: 0, complete: false, partial: true });
			expect(found.text).toContain("SEARCH_INCOMPLETE");
			evidence.retrieval.push(
				retrievalObservation("structured_v2", "partial-index", found, details, ["a-target.ts:1"]),
			);
			evidence.activationCounts.partial_coverage++;
			evidence.activationCounts.structured_search++;
			pass(7);
		}

		// 8. Global overflow carries a cursor and an explicit truncation reason.
		{
			const { cwd, runtime } = runtimeAt("scenario-08");
			for (let index = 0; index < 8; index++)
				write(cwd, `src/item-${index}.ts`, `export const GLOBAL_TARGET = ${index};\n`);
			const search = runtime.definitions.search;
			const input = { query: "GLOBAL_TARGET", mode: "literal" as const, maxResultsGlobal: 2 };
			const found = await measure(input, () =>
				search.execute("overflow", input, undefined, undefined, {} as Parameters<typeof search.execute>[4]),
			);
			const details = found.value.details as SearchV2Details;
			expect(details).toMatchObject({
				status: "overflow",
				returnedCount: 2,
				nextCursor: expect.any(String),
				coverage: { truncated: true, truncatedBy: "max_results_global" },
			});
			expect(found.text).toContain("truncated by max_results_global");
			evidence.retrieval.push(
				retrievalObservation(
					"text_v2",
					"global-overflow",
					found,
					details,
					Array.from({ length: 8 }, (_, index) => `src/item-${index}.ts:1`),
				),
			);
			evidence.activationCounts.overflow++;
			safety("truncation_disclosure", true);
			pass(8);
		}

		// 9. Per-file limits are enforced after provider results and are never silent.
		{
			const { cwd, runtime } = runtimeAt("scenario-09", {
				searchProvider: () => new LocalSearchProviderV2(new NodeExecutionEnv({ cwd: join(root, "scenario-09") })),
			});
			write(
				cwd,
				"many.ts",
				`${Array.from(
					{ length: 10 },
					(_, index) => `export const PER_FILE_TARGET_${index} = "PER_FILE_TARGET";`,
				).join("\n")}\n`,
			);
			const search = runtime.definitions.search;
			const found = await search.execute(
				"per-file",
				{ query: "PER_FILE_TARGET", mode: "literal", maxResultsGlobal: 20, maxResultsPerFile: 2 },
				undefined,
				undefined,
				{} as Parameters<typeof search.execute>[4],
			);
			const details = found.details as SearchV2Details;
			expect(details).toMatchObject({
				status: "overflow",
				returnedCount: 2,
				coverage: { truncated: true, truncatedBy: "max_results_per_file" },
			});
			expect(resultText(found)).toContain("truncated by max_results_per_file");
			evidence.activationCounts.overflow++;
			safety("truncation_disclosure", true);
			pass(9);
		}

		// 10. Ambiguity forces relocation; unversioned dialects and replace-all remain rejected.
		{
			const workflowStartedAt = performance.now();
			const { cwd, runtime } = runtimeAt("scenario-10");
			write(cwd, "ambiguous.txt", "same\nmiddle\nsame\n");
			const { read, edit } = runtime.definitions;
			const context = {} as Parameters<typeof read.execute>[4];
			const broad = await read.execute(
				"broad",
				{ path: "ambiguous.txt", startLine: 1, maxLines: 3 },
				undefined,
				undefined,
				context,
			);
			const broadView = broad.details as ReadV2Details;
			const ambiguous = await errorCode(() =>
				edit.execute(
					"ambiguous",
					{
						action: "prepare",
						operations: [
							{
								kind: "update",
								path: "ambiguous.txt",
								oldText: "same",
								newText: "changed",
								viewId: broadView.viewId,
								range: { startLine: 1, endLine: 3 },
							},
						],
					},
					undefined,
					undefined,
					context,
				),
			);
			expect(ambiguous).toBe("AMBIGUOUS_MATCH");
			const narrow = await read.execute(
				"narrow",
				{ path: "ambiguous.txt", startLine: 3, maxLines: 1 },
				undefined,
				undefined,
				context,
			);
			const narrowView = narrow.details as ReadV2Details;
			const prepared = await edit.execute(
				"prepare",
				{
					action: "prepare",
					operations: [
						{
							kind: "update",
							path: "ambiguous.txt",
							oldText: "same",
							newText: "changed",
							viewId: narrowView.viewId,
							range: { startLine: 3, endLine: 3 },
						},
					],
				},
				undefined,
				undefined,
				context,
			);
			await edit.execute(
				"commit",
				{ action: "commit", patchId: (prepared.details as EditV2Details).patchId },
				undefined,
				undefined,
				context,
			);
			const verified = await read.execute(
				"verify",
				{ path: "ambiguous.txt", startLine: 1, maxLines: 3 },
				undefined,
				undefined,
				context,
			);
			expect(resultText(verified)).toContain("1\tsame");
			expect(resultText(verified)).toContain("3\tchanged");
			expect(readFileSync(join(cwd, "ambiguous.txt"), "utf8")).toBe("same\nmiddle\nchanged\n");
			safety("ambiguity_rejection", true);
			safety("wrong_location_write", true);

			const unboundInputs = [
				{
					dialect: "operations" as const,
					input: {
						operations: [{ kind: "update" as const, path: "ambiguous.txt", oldText: "same", newText: "bad" }],
					},
				},
				{
					dialect: "replacement" as const,
					input: { path: "ambiguous.txt", edits: [{ oldText: "same", newText: "bad" }] },
				},
				{
					dialect: "patch" as const,
					input: {
						patch: [
							"*** Pi Edit Patch v1",
							JSON.stringify({ kind: "update", path: "ambiguous.txt", oldText: "same", newText: "bad" }),
							"*** End Pi Edit Patch",
						].join("\n"),
					},
				},
			];
			for (const attempt of unboundInputs) {
				const isolated = createV2ToolRuntime(cwd, { editDialect: attempt.dialect });
				runtimes.push(isolated);
				const isolatedEdit = isolated.definitions.edit;
				const code = await errorCode(() =>
					isolatedEdit.execute(
						`unbound-${attempt.dialect}`,
						attempt.input,
						undefined,
						undefined,
						{} as Parameters<typeof isolatedEdit.execute>[4],
					),
				);
				expect(code).toBe("INVALID_INPUT");
				safety("unversioned_write", true);
			}
			const replaceAll = await errorCode(() =>
				edit.execute(
					"replace-all",
					{
						operations: [
							{
								kind: "update",
								path: "ambiguous.txt",
								oldText: "same",
								newText: "bad",
								replaceAll: true,
							},
						],
					},
					undefined,
					undefined,
					context,
				),
			);
			expect(replaceAll).toBe("INVALID_INPUT");
			safety("silent_replace_all", true);
			const workflowText = [resultText(broad), resultText(narrow), resultText(prepared), resultText(verified)].join(
				"\n",
			);
			evidence.workflows.push({
				callsToLocate: 2,
				callsToSafeEdit: 5,
				callsToVerify: 6,
				returnedBytes: Buffer.byteLength(workflowText),
				returnedTokens: estimatedTokens(workflowText),
				inputTokens: [
					{ path: "ambiguous.txt", startLine: 1, maxLines: 3 },
					{ action: "prepare", operations: 1, range: [1, 3] },
					{ path: "ambiguous.txt", startLine: 3, maxLines: 1 },
					{ action: "prepare", operations: 1, range: [3, 3] },
					{ action: "commit", patchId: true },
					{ path: "ambiguous.txt", startLine: 1, maxLines: 3 },
				].reduce((sum, input) => sum + estimatedTokens(JSON.stringify(input)), 0),
				latencyMs: Math.max(0, performance.now() - workflowStartedAt),
				costUsd: 0,
				broadQueryRetries: 0,
				ambiguityRelocations: 1,
				toolErrors: 5,
				schemaErrors: 4,
			});
			pass(10);
		}

		// 11. A read view cannot authorize a write after the file changes.
		{
			const { cwd, runtime } = runtimeAt("scenario-11");
			write(cwd, "stale.txt", "old\n");
			const { read, edit } = runtime.definitions;
			const context = {} as Parameters<typeof read.execute>[4];
			const viewed = await read.execute("read", { path: "stale.txt", maxLines: 1 }, undefined, undefined, context);
			writeFileSync(join(cwd, "stale.txt"), "external\n");
			const code = await errorCode(() =>
				edit.execute(
					"stale",
					{
						action: "prepare",
						operations: [
							{
								kind: "update",
								path: "stale.txt",
								oldText: "old",
								newText: "new",
								viewId: (viewed.details as ReadV2Details).viewId,
								range: { startLine: 1, endLine: 1 },
							},
						],
					},
					undefined,
					undefined,
					context,
				),
			);
			expect(code).toBe("STALE_VIEW");
			expect(readFileSync(join(cwd, "stale.txt"), "utf8")).toBe("external\n");
			safety("stale_rejection", true);
			pass(11);
		}

		// 12. A prepared patch rechecks the exact preimage at commit.
		{
			const { cwd, runtime } = runtimeAt("scenario-12");
			write(cwd, "prepared.txt", "old\n");
			const { read, edit } = runtime.definitions;
			const context = {} as Parameters<typeof read.execute>[4];
			const viewed = await read.execute(
				"read",
				{ path: "prepared.txt", maxLines: 1 },
				undefined,
				undefined,
				context,
			);
			const view = viewed.details as ReadV2Details;
			const prepared = await edit.execute(
				"prepare",
				{
					action: "prepare",
					operations: [
						{
							kind: "update",
							path: "prepared.txt",
							oldText: "old",
							newText: "new",
							viewId: view.viewId,
							expectedFileHash: view.fileHash,
							range: { startLine: 1, endLine: 1 },
						},
					],
				},
				undefined,
				undefined,
				context,
			);
			writeFileSync(join(cwd, "prepared.txt"), "external\n");
			const code = await errorCode(() =>
				edit.execute(
					"commit",
					{ action: "commit", patchId: (prepared.details as EditV2Details).patchId },
					undefined,
					undefined,
					context,
				),
			);
			expect(code).toBe("STALE_PATCH");
			safety("stale_rejection", true);
			pass(12);
		}

		// 13. Unsupported structured languages fail closed instead of returning mislabeled text hits.
		{
			const { cwd, runtime } = runtimeAt("scenario-13");
			write(cwd, "module.py", "def configure():\n    return 1\n");
			const search = runtime.definitions.search;
			const code = await errorCode(() =>
				search.execute(
					"unsupported",
					{ query: "configure", path: "module.py", mode: "symbol_definition" },
					undefined,
					undefined,
					{} as Parameters<typeof search.execute>[4],
				),
			);
			expect(code).toBe("SEARCH_CAPABILITY_UNSUPPORTED");
			pass(13);
		}

		// 14. Ignore rules define the complete scope; an explicit retry can opt out.
		{
			const { cwd, runtime } = runtimeAt("scenario-14");
			write(cwd, ".gitignore", "ignored.ts\n");
			write(cwd, "ignored.ts", "export const IGNORE_TARGET = true;\n");
			const search = runtime.definitions.search;
			const context = {} as Parameters<typeof search.execute>[4];
			const first = await search.execute(
				"ignored",
				{ query: "IGNORE_TARGET", mode: "literal" },
				undefined,
				undefined,
				context,
			);
			expect(first.details).toMatchObject({
				status: "complete",
				returnedCount: 0,
				effectiveScope: { honorIgnore: true },
			});
			const retryInput = { query: "IGNORE_TARGET", mode: "literal" as const, honorIgnore: false };
			const retry = await measure(retryInput, () =>
				search.execute("include-ignored", retryInput, undefined, undefined, context),
			);
			const details = retry.value.details as SearchV2Details;
			expect(details).toMatchObject({ status: "complete", returnedCount: 1 });
			evidence.retrieval.push(
				retrievalObservation("text_v2", "ignore-retry", retry, details, ["ignored.ts:1"], {
					searchCalls: 2,
					broadQueryRetries: 1,
				}),
			);
			pass(14);
		}

		// 15. One changed file rejects an entire prepared multi-file plan before any write.
		{
			const { cwd, runtime } = runtimeAt("scenario-15");
			write(cwd, "a.txt", "a-old\n");
			write(cwd, "b.txt", "b-old\n");
			const { read, edit } = runtime.definitions;
			const context = {} as Parameters<typeof read.execute>[4];
			const a = await read.execute("a", { path: "a.txt", maxLines: 1 }, undefined, undefined, context);
			const b = await read.execute("b", { path: "b.txt", maxLines: 1 }, undefined, undefined, context);
			const aView = a.details as ReadV2Details;
			const bView = b.details as ReadV2Details;
			const prepared = await edit.execute(
				"prepare",
				{
					action: "prepare",
					operations: [
						{
							kind: "update",
							path: "a.txt",
							oldText: "a-old",
							newText: "a-new",
							viewId: aView.viewId,
							range: { startLine: 1, endLine: 1 },
						},
						{
							kind: "update",
							path: "b.txt",
							oldText: "b-old",
							newText: "b-new",
							viewId: bView.viewId,
							range: { startLine: 1, endLine: 1 },
						},
					],
				},
				undefined,
				undefined,
				context,
			);
			writeFileSync(join(cwd, "b.txt"), "b-external\n");
			const code = await errorCode(() =>
				edit.execute(
					"commit",
					{ action: "commit", patchId: (prepared.details as EditV2Details).patchId },
					undefined,
					undefined,
					context,
				),
			);
			expect(code).toBe("STALE_PATCH");
			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("a-old\n");
			safety("stale_rejection", true);
			safety("wrong_location_write", true);
			pass(15);
		}

		// 16. A visible syntax failure is repaired through Read -> Edit -> Run with exact state.
		{
			const workflowStartedAt = performance.now();
			const { cwd, runtime } = runtimeAt("scenario-16");
			write(cwd, "check.js", "function value() { return 1; }\n");
			const { read, edit, run } = runtime.definitions;
			const context = {} as Parameters<typeof read.execute>[4];
			const initial = await read.execute(
				"initial",
				{ path: "check.js", maxLines: 1 },
				undefined,
				undefined,
				context,
			);
			const initialView = initial.details as ReadV2Details;
			const broken = await edit.execute(
				"break",
				{
					operations: [
						{
							kind: "update",
							path: "check.js",
							oldText: "function value() { return 1; }",
							newText: "function value() { return 1;",
							viewId: initialView.viewId,
							range: { startLine: 1, endLine: 1 },
						},
					],
				},
				undefined,
				undefined,
				context,
			);
			expect((broken.details as EditV2Details).status).toBe("applied");
			expect(readFileSync(join(cwd, "check.js"), "utf8")).toBe("function value() { return 1;\n");
			const failed = await run.execute(
				"check-fail",
				{ command: `${JSON.stringify(process.execPath)} --check check.js`, cwd, timeout: 10 },
				undefined,
				undefined,
				undefined as never,
			);
			expect(failed.details).toMatchObject({ exitCode: expect.any(Number), timedOut: false });
			expect(failed.details.exitCode).not.toBe(0);
			const current = await read.execute(
				"current",
				{ path: "check.js", maxLines: 1 },
				undefined,
				undefined,
				context,
			);
			const currentView = current.details as ReadV2Details;
			await edit.execute(
				"repair",
				{
					operations: [
						{
							kind: "update",
							path: "check.js",
							oldText: "function value() { return 1;",
							newText: "function value() { return 2; }",
							viewId: currentView.viewId,
							range: { startLine: 1, endLine: 1 },
						},
					],
				},
				undefined,
				undefined,
				context,
			);
			const passed = await run.execute(
				"check-pass",
				{ command: `${JSON.stringify(process.execPath)} --check check.js`, cwd, timeout: 10 },
				undefined,
				undefined,
				undefined as never,
			);
			expect(passed.details).toMatchObject({ exitCode: 0, timedOut: false });
			safety("syntax_failure_state", true);
			evidence.workflows.push({
				callsToLocate: 1,
				callsToSafeEdit: 2,
				callsToVerify: 6,
				returnedBytes: Buffer.byteLength(
					[
						resultText(initial),
						resultText(broken),
						resultText(failed),
						resultText(current),
						resultText(passed),
					].join("\n"),
				),
				returnedTokens: estimatedTokens(
					[
						resultText(initial),
						resultText(broken),
						resultText(failed),
						resultText(current),
						resultText(passed),
					].join("\n"),
				),
				inputTokens: [
					{ path: "check.js", maxLines: 1 },
					{ operations: 1, range: [1, 1] },
					{ command: "node --check", cwd: true, timeout: 10 },
					{ path: "check.js", maxLines: 1 },
					{ operations: 1, range: [1, 1] },
					{ command: "node --check", cwd: true, timeout: 10 },
				].reduce((sum, input) => sum + estimatedTokens(JSON.stringify(input)), 0),
				latencyMs: Math.max(0, performance.now() - workflowStartedAt),
				costUsd: 0,
				broadQueryRetries: 0,
				ambiguityRelocations: 0,
				toolErrors: 0,
				schemaErrors: 0,
			});
			pass(16);
		}

		// Deterministic semantic routing exercises concept templates and preferred paths without HTTP or embeddings.
		{
			const cwd = join(root, "semantic-probe");
			mkdirSync(cwd, { recursive: true });
			write(cwd, "src/preferred/concept.ts", "export const reconcile = true;\n");
			write(cwd, "src/other/concept.ts", "export const reconcile = false;\n");
			const provider = new StaticSemanticProvider();
			const runtime = createV2ToolRuntime(cwd, { semanticSearchProvider: provider });
			runtimes.push(runtime);
			const search = runtime.definitions.search;
			const input = {
				query: "settlement reconciliation",
				queryTemplate: "concept" as const,
				preferredPaths: ["src/preferred/**"],
				maxResultsGlobal: 5,
			};
			const found = await measure(input, () =>
				search.execute("semantic", input, undefined, undefined, {} as Parameters<typeof search.execute>[4]),
			);
			const details = found.value.details as SearchV2Details;
			expect(details).toMatchObject({
				mode: "semantic_candidate",
				queryTemplate: "concept",
				effectiveScope: { preferredPaths: ["src/preferred/**"] },
			});
			expect(details.hits[0]).toMatchObject({ path: "src/preferred/concept.ts" });
			expect(provider.calls).toBe(1);
			evidence.retrieval.push(
				retrievalObservation("semantic_v2", "semantic-concept", found, details, ["src/preferred/concept.ts:1"]),
			);
			evidence.activationCounts.semantic_candidate += provider.calls;
			evidence.activationCounts.query_template++;
			evidence.activationCounts.preferred_path_prior++;
		}

		const summary = summarizeFullRequirementEvidence(evidence);
		expect(summary.scenarios).toEqual({ total: 16, passed: 16 });
		expect(summary.retrieval.structured_v2).toMatchObject({
			queries: expect.any(Number),
			hitAt5: expect.any(Number),
			completeQueries: expect.any(Number),
			partialQueries: 1,
		});
		expect(summary.retrieval.structured_v2?.queries).toBeGreaterThanOrEqual(4);
		expect(summary.retrieval.structured_v2?.precisionAt5).toBeGreaterThanOrEqual(0);
		expect(summary.retrieval.text_v2?.precisionAt5).toBeGreaterThanOrEqual(0);
		const legacyDuplicate = evidence.retrieval.find(
			(observation) => observation.variant === "legacy" && observation.queryId === "duplicates",
		);
		const structuredDuplicate = evidence.retrieval.find(
			(observation) => observation.variant === "structured_v2" && observation.queryId === "duplicates",
		);
		expect(structuredDuplicate?.returnedBytes).toBeLessThan(legacyDuplicate?.returnedBytes ?? 0);
		expect(summary.retrieval.structured_v2?.meanTargetRank).toBeLessThan(
			summary.retrieval.structured_no_path_prior?.meanTargetRank ?? Number.POSITIVE_INFINITY,
		);
		expect(summary.context.search.samples).toBeGreaterThan(0);
		expect(summary.context.read.samples).toBeGreaterThan(0);
		expect(summary.context.edit.samples).toBeGreaterThan(0);
		expect(summary.context.full_chain.samples).toBeGreaterThan(0);
		expect(summary.workflow).toMatchObject({
			runs: 3,
			broadQueryRetries: expect.any(Number),
			ambiguityRelocations: 1,
			toolErrors: 5,
			schemaErrors: 4,
			totalCostUsd: 0,
		});
		for (const metric of Object.values(summary.safety)) {
			expect(metric.activations).toBeGreaterThan(0);
			expect(metric.rate).toBe(1);
		}
		expect(summary.safety.wrong_location_write.safe).toBe(summary.safety.wrong_location_write.activations);
		expect(summary.safety.silent_replace_all.safe).toBe(1);
		expect(summary.safety.unversioned_write.safe).toBe(3);
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain(root);
		expect(serialized).not.toMatch(/settlement_timeout_ms|LONG_LINE_TARGET|IGNORE_TARGET|src\//);
		console.log(JSON.stringify({ eval: "full-requirement-deterministic", summary }));
	});
});
