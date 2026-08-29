import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditV2Details, ReadV2Details, SearchV2Details } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSearchProviderV2 } from "../../src/core/tools/local-search-provider-v2.ts";
import { createV2ToolRuntime } from "../../src/core/tools/tool-profile.ts";

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

function bytes(value: string): number {
	return Buffer.byteLength(value);
}

async function errorCode(operation: Promise<unknown>): Promise<string | undefined> {
	try {
		await operation;
		return undefined;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
	}
}

describe("locator-safe toolchain evidence", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-locator-evidence-"));
		for (const directory of ["src", "test", "vendor", "generated"]) {
			mkdirSync(join(cwd, directory), { recursive: true });
		}
	});

	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("measures locator context and rejects every exercised unsafe edit", async () => {
		const source = ["export class PaymentGateway {", "  settlement_timeout_ms = 2750;", "}", ""].join("\n");
		const testCopy = "expect(gateway.settlement_timeout_ms).toBe(2750);\n";
		const vendorCopy = "settlement_timeout_ms = 2750; // vendored default\n";
		const generatedCopy = `${"x".repeat(6_000)}settlement_timeout_ms = 2750${"y".repeat(6_000)}\n`;
		writeFileSync(join(cwd, "src", "payment.ts"), source);
		writeFileSync(join(cwd, "test", "payment.test.ts"), testCopy);
		writeFileSync(join(cwd, "vendor", "payment.ts"), vendorCopy);
		writeFileSync(join(cwd, "generated", "payment.ts"), generatedCopy);
		writeFileSync(join(cwd, "src", "ambiguous.ts"), "same same\n");
		writeFileSync(join(cwd, "src", "stale.ts"), "old\n");

		const runtime = createV2ToolRuntime(cwd, {
			searchProvider: () => new LocalSearchProviderV2(new NodeExecutionEnv({ cwd })),
		});
		const { search, read, edit } = runtime.definitions;
		const extensionContext = {} as Parameters<typeof search.execute>[4];
		try {
			const broad = await search.execute(
				"broad",
				{ query: "settlement_timeout_ms", include: ["**/*.ts"], maxResultsGlobal: 20 },
				undefined,
				undefined,
				extensionContext,
			);
			const broadDetails = broad.details as SearchV2Details;
			expect(broadDetails).toMatchObject({ status: "complete", returnedCount: 4 });
			const sourceLines = new Map([
				["src/payment.ts", source.split("\n")[1]],
				["test/payment.test.ts", testCopy.trimEnd()],
				["vendor/payment.ts", vendorCopy.trimEnd()],
				["generated/payment.ts", generatedCopy.trimEnd()],
			]);
			const fullLineBaseline = broadDetails.hits
				.map((hit) => {
					if (hit.kind !== "text") return hit.path;
					return `${hit.path}:${hit.line}:${hit.column}: ${sourceLines.get(hit.path) ?? hit.text}`;
				})
				.join("\n");
			const locatorOutput = resultText(broad);
			expect(locatorOutput).not.toContain("x".repeat(100));
			expect(bytes(locatorOutput)).toBeLessThan(bytes(fullLineBaseline));
			expect(new Set(broadDetails.locators.map((locator) => locator.locatorId)).size).toBe(4);

			const located = await search.execute(
				"locate",
				{
					query: "settlement_timeout_ms = 2750",
					path: "src/payment.ts",
					maxResultsGlobal: 5,
				},
				undefined,
				undefined,
				extensionContext,
			);
			const locatedDetails = located.details as SearchV2Details;
			expect(locatedDetails).toMatchObject({ status: "complete", returnedCount: 1 });
			const viewResult = await read.execute(
				"view",
				{ locatorId: locatedDetails.locators[0].locatorId, beforeLines: 1, afterLines: 1, maxBytes: 1024 },
				undefined,
				undefined,
				extensionContext,
			);
			const view = viewResult.details as ReadV2Details;
			expect(view).toMatchObject({ range: [1, 3], editable: true });
			const preparedResult = await edit.execute(
				"prepare",
				{
					action: "prepare",
					operations: [
						{
							kind: "update",
							path: "src/payment.ts",
							oldText: "settlement_timeout_ms = 2750",
							newText: "settlement_timeout_ms = 3000",
							viewId: view.viewId,
							expectedFileHash: view.fileHash,
							range: { startLine: 2, endLine: 2 },
							matchPolicy: "exactly_one_in_range",
						},
					],
				},
				undefined,
				undefined,
				extensionContext,
			);
			const prepared = preparedResult.details as EditV2Details;
			expect(prepared.status).toBe("prepared");
			expect(readFileSync(join(cwd, "src", "payment.ts"), "utf8")).toBe(source);
			const committed = await edit.execute(
				"commit",
				{ action: "commit", patchId: prepared.patchId },
				undefined,
				undefined,
				extensionContext,
			);
			expect((committed.details as EditV2Details).status).toBe("applied");
			const verified = await read.execute(
				"verify",
				{ path: "src/payment.ts", startLine: 2, endLine: 2, maxLines: 1, maxBytes: 1024 },
				undefined,
				undefined,
				extensionContext,
			);
			expect(resultText(verified)).toContain("settlement_timeout_ms = 3000");
			expect(readFileSync(join(cwd, "test", "payment.test.ts"), "utf8")).toBe(testCopy);
			expect(readFileSync(join(cwd, "vendor", "payment.ts"), "utf8")).toBe(vendorCopy);
			expect(readFileSync(join(cwd, "generated", "payment.ts"), "utf8")).toBe(generatedCopy);

			const ambiguousView = (
				await read.execute(
					"ambiguous-read",
					{ path: "src/ambiguous.ts", maxLines: 1, maxBytes: 1024 },
					undefined,
					undefined,
					extensionContext,
				)
			).details as ReadV2Details;
			const ambiguousCode = await errorCode(
				edit.execute(
					"ambiguous",
					{
						action: "prepare",
						operations: [
							{
								kind: "update",
								path: "src/ambiguous.ts",
								oldText: "same",
								newText: "changed",
								viewId: ambiguousView.viewId,
								range: { startLine: 1, endLine: 1 },
							},
						],
					},
					undefined,
					undefined,
					extensionContext,
				),
			);
			expect(ambiguousCode).toBe("AMBIGUOUS_MATCH");
			expect(readFileSync(join(cwd, "src", "ambiguous.ts"), "utf8")).toBe("same same\n");

			const staleView = (
				await read.execute(
					"stale-read",
					{ path: "src/stale.ts", maxLines: 1, maxBytes: 1024 },
					undefined,
					undefined,
					extensionContext,
				)
			).details as ReadV2Details;
			const stalePrepared = (
				await edit.execute(
					"stale-prepare",
					{
						action: "prepare",
						operations: [
							{
								kind: "update",
								path: "src/stale.ts",
								oldText: "old",
								newText: "new",
								viewId: staleView.viewId,
								range: { startLine: 1, endLine: 1 },
							},
						],
					},
					undefined,
					undefined,
					extensionContext,
				)
			).details as EditV2Details;
			writeFileSync(join(cwd, "src", "stale.ts"), "external\n");
			const staleCode = await errorCode(
				edit.execute(
					"stale-commit",
					{ action: "commit", patchId: stalePrepared.patchId },
					undefined,
					undefined,
					extensionContext,
				),
			);
			expect(staleCode).toBe("STALE_PATCH");

			const overflow = await search.execute(
				"overflow",
				{ query: "settlement_timeout_ms", include: ["**/*.ts"], maxResultsGlobal: 1 },
				undefined,
				undefined,
				extensionContext,
			);
			expect(overflow.details).toMatchObject({
				status: "overflow",
				coverage: { truncated: true, truncatedBy: "max_results_global" },
			});
			expect(resultText(overflow)).toContain("truncated by max_results_global");
			const generatedLocator = broadDetails.locators.find((locator) => locator.path === "generated/payment.ts");
			if (!generatedLocator) throw new Error("generated locator is missing");
			const longLine = await read.execute(
				"long-line",
				{ locatorId: generatedLocator.locatorId, maxBytes: 512 },
				undefined,
				undefined,
				extensionContext,
			);
			expect(resultText(longLine)).toContain("settlement_timeout_ms");
			expect(bytes(resultText(longLine))).toBeLessThanOrEqual(512);
			expect((longLine.details as ReadV2Details).truncation).toBeDefined();

			const unsupportedCode = await errorCode(
				search.execute(
					"unsupported",
					{ query: "PaymentGateway", mode: "symbol_definition" },
					undefined,
					undefined,
					extensionContext,
				),
			);
			expect(unsupportedCode).toBe("SYMBOL_INDEX_UNAVAILABLE");

			const chainOutputs = [located, viewResult, preparedResult, committed, verified].map(resultText);
			const chainVisibleBytes = chainOutputs.reduce((total, output) => total + bytes(output), 0);
			const metrics = {
				broadMatches: broadDetails.locators.length,
				scopedPrecisionAt1: 1,
				locatorSearchBytes: bytes(locatorOutput),
				fullLineBaselineBytes: bytes(fullLineBaseline),
				locatorReductionRate: 1 - bytes(locatorOutput) / bytes(fullLineBaseline),
				callsToSafeEdit: 4,
				totalCallsWithVerification: 5,
				chainVisibleBytes,
				chainEstimatedTokens: Math.ceil(chainVisibleBytes / 4),
				duplicateLocators:
					broadDetails.locators.length - new Set(broadDetails.locators.map((item) => item.locatorId)).size,
				ambiguityRejectionRate: ambiguousCode === "AMBIGUOUS_MATCH" ? 1 : 0,
				staleRejectionRate: staleCode === "STALE_PATCH" ? 1 : 0,
				truncationDisclosureRate: (overflow.details as SearchV2Details).coverage.truncated ? 1 : 0,
				unsupportedDisclosureRate: unsupportedCode === "SYMBOL_INDEX_UNAVAILABLE" ? 1 : 0,
				wrongLocationWrites: 0,
			};
			expect(metrics.locatorReductionRate).toBeGreaterThan(0.9);
			expect(metrics.chainVisibleBytes).toBeLessThan(metrics.fullLineBaselineBytes);
			expect(metrics).toMatchObject({
				duplicateLocators: 0,
				ambiguityRejectionRate: 1,
				staleRejectionRate: 1,
				truncationDisclosureRate: 1,
				unsupportedDisclosureRate: 1,
				wrongLocationWrites: 0,
			});
			console.log(JSON.stringify({ eval: "locator-safe-chain-evidence", metrics }));
		} finally {
			await runtime.close();
		}
	});
});
