import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SearchV2Details } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FffSearchProvider } from "../../src/core/tools/fff-search-provider.ts";
import { LocalSearchProviderV2 } from "../../src/core/tools/local-search-provider-v2.ts";
import { createV2ToolRuntime } from "../../src/core/tools/tool-profile.ts";
import { type SearchEvidenceTrial, summarizeSearchEvidence } from "./search-evidence.ts";

type ProviderKind = "local" | "fff";

type QueryFixture = {
	targetPath: string;
	typoQuery: string;
	fallbackQuery: string;
};

const QUERIES: QueryFixture[] = [
	{
		targetPath: "src/services/AuthenticationService.ts",
		typoQuery: "authneticationservice",
		fallbackQuery: "AuthenticationService",
	},
	{
		targetPath: "src/controllers/ConfigurationController.ts",
		typoQuery: "configruationcontroller",
		fallbackQuery: "ConfigurationController",
	},
	{
		targetPath: "src/payments/PaymentReconciliation.ts",
		typoQuery: "paymentreconicliation",
		fallbackQuery: "PaymentReconciliation",
	},
	{
		targetPath: "src/telemetry/ObservabilityPipeline.ts",
		typoQuery: "observabiltiypipeline",
		fallbackQuery: "ObservabilityPipeline",
	},
	{
		targetPath: "src/security/PermissionMiddleware.ts",
		typoQuery: "permissino middleware",
		fallbackQuery: "PermissionMiddleware",
	},
];

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

function writeQualityFixture(cwd: string): void {
	for (const query of QUERIES) {
		const directory = join(cwd, query.targetPath, "..");
		mkdirSync(directory, { recursive: true });
		const targetName = basename(query.targetPath, ".ts");
		writeFileSync(join(cwd, query.targetPath), `export const marker = "${basename(query.targetPath)}";\n`);
		for (const suffix of ["Factory", "Legacy", "Spec"]) {
			writeFileSync(join(directory, `${targetName}${suffix}.ts`), `export const related = "${suffix}";\n`);
		}
	}
	for (let index = 0; index < 400; index++) {
		const group = `group-${String(index % 40).padStart(2, "0")}`;
		mkdirSync(join(cwd, "src", "noise", group), { recursive: true });
		const family = ["authentication", "configuration", "payment", "observability", "permission"][index % 5];
		writeFileSync(
			join(cwd, "src", "noise", group, `${family}-support-${String(index).padStart(3, "0")}.ts`),
			`export const noise${index} = ${index};\n`,
		);
	}
}

async function runQualityTrials(cwd: string, kind: ProviderKind): Promise<SearchEvidenceTrial[]> {
	const runtime = createV2ToolRuntime(cwd, {
		searchProvider: () =>
			kind === "fff"
				? new FffSearchProvider(new NodeExecutionEnv({ cwd }))
				: new LocalSearchProviderV2(new NodeExecutionEnv({ cwd })),
	});
	const search = runtime.definitions.search;
	const extensionContext = {} as Parameters<typeof search.execute>[4];
	const trials: SearchEvidenceTrial[] = [];
	try {
		for (const fixture of QUERIES) {
			const outputs: string[] = [];
			const allHitPaths: string[] = [];
			const startedAt = performance.now();
			const first = await search.execute(
				`${kind}-${fixture.typoQuery}-first`,
				{ query: fixture.typoQuery, kind: "files", limit: 5, ranking: "global" },
				undefined,
				undefined,
				extensionContext,
			);
			const firstDetails = first.details as SearchV2Details;
			const firstHitPaths = firstDetails.hits.map((hit) => hit.path);
			outputs.push(resultText(first));
			allHitPaths.push(...firstHitPaths);
			let selectedRank = firstHitPaths.indexOf(fixture.targetPath) + 1;
			let searchCalls = 1;
			if (selectedRank === 0) {
				const fallback = await search.execute(
					`${kind}-${fixture.typoQuery}-fallback`,
					{ query: fixture.fallbackQuery, kind: "files", limit: 5, ranking: "global" },
					undefined,
					undefined,
					extensionContext,
				);
				const fallbackDetails = fallback.details as SearchV2Details;
				const fallbackHitPaths = fallbackDetails.hits.map((hit) => hit.path);
				outputs.push(resultText(fallback));
				allHitPaths.push(...fallbackHitPaths);
				selectedRank = fallbackHitPaths.indexOf(fixture.targetPath) + 1;
				searchCalls++;
			}
			trials.push({
				targetPath: fixture.targetPath,
				firstHitPaths,
				allHitPaths,
				modelVisibleResults: outputs,
				searchCalls,
				selectedRank: selectedRank || null,
				elapsedMs: performance.now() - startedAt,
			});
		}
		return trials;
	} finally {
		await runtime.close();
	}
}

describe("FFF Search evidence", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-fff-evidence-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("measures quality, discovery effort, tool-result volume, and retained context", async () => {
		writeQualityFixture(cwd);
		const local = summarizeSearchEvidence(await runQualityTrials(cwd, "local"));
		const fff = summarizeSearchEvidence(await runQualityTrials(cwd, "fff"));

		expect(fff.recallAt5).toBeGreaterThanOrEqual(local.recallAt5);
		expect(fff.meanReciprocalRank).toBeGreaterThanOrEqual(local.meanReciprocalRank);
		expect(fff.firstRankRate).toBeGreaterThanOrEqual(local.firstRankRate);
		expect(fff.meanSearchCalls).toBeLessThanOrEqual(local.meanSearchCalls);
		expect(fff.meanDiscoveryToolCalls).toBeLessThanOrEqual(local.meanDiscoveryToolCalls);
		expect(fff.duplicateHitCount).toBe(0);
		expect(local.duplicateHitCount).toBe(0);
		expect(fff.totalModelVisibleBytes).toBeLessThanOrEqual(local.totalModelVisibleBytes);
		expect(fff.estimatedResultTokens).toBeLessThanOrEqual(local.estimatedResultTokens);
		expect(fff.peakRetainedResultTokens).toBeLessThanOrEqual(local.peakRetainedResultTokens);
		expect(fff.cumulativeVisibleResultTokens).toBeLessThanOrEqual(local.cumulativeVisibleResultTokens);
		console.log(JSON.stringify({ eval: "fff-search-evidence", local, fff }));
	});

	it("covers noisy indexes, large-file text, bounded continuation, approximate scans, and fallback", async () => {
		for (let index = 0; index < 3000; index++) {
			const directory = join(cwd, "noise", `group-${index % 100}`);
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, `item-${index}.ts`), `export const noise${index} = ${index};\n`);
		}
		mkdirSync(join(cwd, "src"), { recursive: true });
		const lines = Array.from({ length: 12_000 }, (_, index) => `// filler ${index + 1}`);
		lines[10_499] = "export const LARGE_FILE_TARGET = true;";
		writeFileSync(join(cwd, "src", "large.ts"), `${lines.join("\n")}\n`);
		for (let index = 0; index < 12; index++) {
			writeFileSync(join(cwd, "src", `shared-${index}.ts`), `export const SHARED_PAGE_TARGET = ${index};\n`);
		}

		const approximateProvider = new FffSearchProvider(new NodeExecutionEnv({ cwd }), { initialScanTimeoutMs: 0 });
		try {
			const approximate = await approximateProvider.search(
				{
					kind: "files",
					query: "large",
					path: cwd,
					case: "smart",
					regex: false,
					context: 0,
					limit: 5,
					ranking: "fast",
				},
				{ workspaceRoot: cwd, scopeId: "approximate" },
			);
			expect(approximate.approximate).toBe(true);
			expect(approximate.partial).toBe(true);
		} finally {
			await approximateProvider.close();
		}

		const runtime = createV2ToolRuntime(cwd, {
			searchProvider: () => new FffSearchProvider(new NodeExecutionEnv({ cwd })),
		});
		const search = runtime.definitions.search;
		const extensionContext = {} as Parameters<typeof search.execute>[4];
		try {
			const largeFile = await search.execute(
				"large-file",
				{ query: "LARGE_FILE_TARGET", kind: "text", limit: 5 },
				undefined,
				undefined,
				extensionContext,
			);
			expect(largeFile.details).toMatchObject({
				generation: expect.stringMatching(/^fff-/),
				hits: [expect.objectContaining({ path: "src/large.ts", line: 10_500 })],
			});

			const first = await search.execute(
				"page-first",
				{ query: "SHARED_PAGE_TARGET", kind: "text", limit: 3 },
				undefined,
				undefined,
				extensionContext,
			);
			const firstDetails = first.details as SearchV2Details;
			expect(firstDetails).toMatchObject({ returnedCount: 3, nextCursor: expect.any(String) });
			expect(resultText(first)).toContain("truncated by max_results_global; continue with cursor=");
			const second = await search.execute(
				"page-second",
				{ query: "SHARED_PAGE_TARGET", kind: "text", limit: 3, cursor: firstDetails.nextCursor },
				undefined,
				undefined,
				extensionContext,
			);
			const secondDetails = second.details as SearchV2Details;
			expect(secondDetails.returnedCount).toBe(3);
			expect(
				new Set([...firstDetails.hits, ...secondDetails.hits].map((hit) => `${hit.path}:${hit.kind}`)).size,
			).toBe(6);

			const fallback = await search.execute(
				"fallback-case",
				{ query: "LARGE_FILE_TARGET", kind: "text", case: "sensitive", limit: 5 },
				undefined,
				undefined,
				extensionContext,
			);
			expect(fallback.details).toMatchObject({ generation: expect.stringMatching(/^local-/), returnedCount: 1 });
		} finally {
			await runtime.close();
		}
	}, 30_000);
});
