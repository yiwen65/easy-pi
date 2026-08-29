import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FullRealEvalCase, FullRealEvalOracles } from "./full-real-eval.ts";

export interface FullRealEvalFault {
	kind: "after_target_read" | "after_multifile_prepare";
	relativePath: string;
	apply(): void;
}

export interface FullRealEvalFixture {
	prompt: string;
	targetPath: string;
	semanticQuery: string;
	provenanceToken: string;
	fault?: FullRealEvalFault;
	grade(): { success: boolean; score: number; oracles: FullRealEvalOracles };
	applyExpectedSolutionForTest(): void;
}

interface FixtureDefinition {
	prompt: string;
	targetPath: string;
	semanticQuery: string;
	mutablePaths: string[];
	fault?: FullRealEvalFault;
	applyExpectedSolutionForTest(): void;
	mutationCorrect(): boolean;
	externalChangePreserved(): boolean;
}

function write(cwd: string, path: string, content: string): void {
	mkdirSync(join(cwd, path, ".."), { recursive: true });
	writeFileSync(join(cwd, path), content);
}

function read(cwd: string, path: string): string {
	return readFileSync(join(cwd, path), "utf8");
}

function testPasses(cwd: string): boolean {
	try {
		execFileSync(process.execPath, ["test.js"], { cwd, stdio: "ignore", timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

function prompt(semanticQuery: string, instruction: string): string {
	return `${instruction} If semantic candidate search is configured, first use the exact concept query ${JSON.stringify(semanticQuery)}, then verify the candidate with JS/TS structured search and a bounded read. Otherwise use the available text search. Preserve unrelated code and finish only after node test.js passes.`;
}

function duplicateDefinition(cwd: string, seed: number, token: string): FixtureDefinition {
	const query = "production shipment scheduling policy";
	const target = seed + 11;
	write(
		cwd,
		"src/shipping/service.js",
		`// ${token}\n// ${query}\nexport function calculateDeliveryWindow() { return ${seed}; }\n`,
	);
	write(
		cwd,
		"test/fixture.js",
		`// ${token}\n// ${query}\nexport function calculateDeliveryWindow() { return -1; }\n`,
	);
	write(
		cwd,
		"vendor/shipping.js",
		`// ${token}\n// ${query}\nexport function calculateDeliveryWindow() { return -2; }\n`,
	);
	write(
		cwd,
		"test.js",
		`// ${token}\nimport { calculateDeliveryWindow } from "./src/shipping/service.js";\nif (calculateDeliveryWindow() !== ${target}) process.exit(1);\n`,
	);
	return {
		prompt: prompt(
			query,
			`Update only the production definition for the shipment-window behavior so it returns ${target}.`,
		),
		targetPath: "src/shipping/service.js",
		semanticQuery: query,
		mutablePaths: ["src/shipping/service.js"],
		applyExpectedSolutionForTest: () =>
			write(
				cwd,
				"src/shipping/service.js",
				`// ${token}\n// ${query}\nexport function calculateDeliveryWindow() { return ${target}; }\n`,
			),
		mutationCorrect: () => read(cwd, "src/shipping/service.js").includes(`return ${target};`),
		externalChangePreserved: () => true,
	};
}

function qualifiedAssignment(cwd: string, seed: number, token: string): FixtureDefinition {
	const query = "runtime request deadline configuration";
	const target = seed + 13;
	write(
		cwd,
		"src/runtime/config.js",
		`// ${token}\n// ${query}\nexport class RuntimeConfig {\n  constructor() {\n    this.timeout = ${seed};\n    this.retries = 3;\n  }\n}\n`,
	);
	for (let index = 0; index < 24; index++) {
		write(cwd, `src/noise/timeout-${index}.js`, `// ${token}\nexport const timeout = ${seed + index};\n`);
	}
	write(
		cwd,
		"test.js",
		`// ${token}\nimport { RuntimeConfig } from "./src/runtime/config.js";\nconst value = new RuntimeConfig();\nif (value.timeout !== ${target} || value.retries !== 3) process.exit(1);\n`,
	);
	return {
		prompt: prompt(query, `Change only RuntimeConfig.timeout to ${target}; do not alter other timeout fields.`),
		targetPath: "src/runtime/config.js",
		semanticQuery: query,
		mutablePaths: ["src/runtime/config.js"],
		applyExpectedSolutionForTest: () =>
			write(
				cwd,
				"src/runtime/config.js",
				`// ${token}\n// ${query}\nexport class RuntimeConfig {\n  constructor() {\n    this.timeout = ${target};\n    this.retries = 3;\n  }\n}\n`,
			),
		mutationCorrect: () =>
			read(cwd, "src/runtime/config.js").includes(`this.timeout = ${target};`) &&
			read(cwd, "src/runtime/config.js").includes("this.retries = 3;"),
		externalChangePreserved: () => true,
	};
}

function definitionAmongCalls(cwd: string, seed: number, token: string): FixtureDefinition {
	const query = "tenant quota normalization implementation";
	const target = seed + 17;
	write(
		cwd,
		"src/quota.js",
		`// ${token}\n// ${query}\nexport function normalizeTenantQuota(value) { return value + ${seed}; }\n`,
	);
	const calls = Array.from({ length: 80 }, (_, index) => `normalizeTenantQuota(${index});`).join("\n");
	write(cwd, "src/callers.js", `// ${token}\nimport { normalizeTenantQuota } from "./quota.js";\n${calls}\n`);
	write(
		cwd,
		"test.js",
		`// ${token}\nimport { normalizeTenantQuota } from "./src/quota.js";\nif (normalizeTenantQuota(1) !== ${target + 1}) process.exit(1);\n`,
	);
	return {
		prompt: prompt(
			query,
			`Change the function definition, not its many call sites, so its additive quota is ${target}.`,
		),
		targetPath: "src/quota.js",
		semanticQuery: query,
		mutablePaths: ["src/quota.js"],
		applyExpectedSolutionForTest: () =>
			write(
				cwd,
				"src/quota.js",
				`// ${token}\n// ${query}\nexport function normalizeTenantQuota(value) { return value + ${target}; }\n`,
			),
		mutationCorrect: () => read(cwd, "src/quota.js").includes(`value + ${target};`),
		externalChangePreserved: () => true,
	};
}

function sameMethodMultipleClasses(cwd: string, seed: number, token: string): FixtureDefinition {
	const query = "priority queue conflict resolution strategy";
	const target = seed + 19;
	write(
		cwd,
		"src/resolvers.js",
		`// ${token}\nexport class LocalResolver { resolve() { return ${seed}; } }\n\n// ${token}\n// ${query}\nexport class PriorityQueueResolver { resolve() { return ${seed + 1}; } }\n`,
	);
	write(
		cwd,
		"test.js",
		`// ${token}\nimport { LocalResolver, PriorityQueueResolver } from "./src/resolvers.js";\nif (new LocalResolver().resolve() !== ${seed} || new PriorityQueueResolver().resolve() !== ${target}) process.exit(1);\n`,
	);
	return {
		prompt: prompt(query, `Change only PriorityQueueResolver.resolve() to return ${target}; preserve LocalResolver.`),
		targetPath: "src/resolvers.js",
		semanticQuery: query,
		mutablePaths: ["src/resolvers.js"],
		applyExpectedSolutionForTest: () =>
			write(
				cwd,
				"src/resolvers.js",
				`// ${token}\nexport class LocalResolver { resolve() { return ${seed}; } }\n\n// ${token}\n// ${query}\nexport class PriorityQueueResolver { resolve() { return ${target}; } }\n`,
			),
		mutationCorrect: () =>
			read(cwd, "src/resolvers.js").includes(`LocalResolver { resolve() { return ${seed}; }`) &&
			read(cwd, "src/resolvers.js").includes(`PriorityQueueResolver { resolve() { return ${target}; }`),
		externalChangePreserved: () => true,
	};
}

function largeTailLongLine(cwd: string, seed: number, token: string): FixtureDefinition {
	const query = "archive retention horizon calculation";
	const target = seed + 23;
	const lines = Array.from({ length: 2_500 }, (_, index) => `// filler ${index + 1}`);
	lines[2_398] = `// ${token} ${query}`;
	lines[2_399] = `${" ".repeat(16_000)}export function archiveRetentionHorizon() { return ${seed}; }`;
	write(cwd, "src/archive.js", `${lines.join("\n")}\n`);
	write(
		cwd,
		"test.js",
		`// ${token}\nimport { archiveRetentionHorizon } from "./src/archive.js";\nif (archiveRetentionHorizon() !== ${target}) process.exit(1);\n`,
	);
	return {
		prompt: prompt(
			query,
			`Locate the implementation near the large file tail and change its return value to ${target}.`,
		),
		targetPath: "src/archive.js",
		semanticQuery: query,
		mutablePaths: ["src/archive.js"],
		applyExpectedSolutionForTest: () => {
			const content = read(cwd, "src/archive.js").replace(`return ${seed};`, `return ${target};`);
			write(cwd, "src/archive.js", content);
		},
		mutationCorrect: () => read(cwd, "src/archive.js").includes(`return ${target};`),
		externalChangePreserved: () => true,
	};
}

function overflowNarrowing(cwd: string, seed: number, token: string): FixtureDefinition {
	const query = "regional invoice rounding policy";
	const target = seed + 29;
	for (let index = 0; index < 120; index++) {
		const directory = index === 97 ? "src/production/billing" : index % 2 === 0 ? "test/noise" : "vendor/noise";
		const name = index === 97 ? "regional-policy.js" : `candidate-${index}.js`;
		const value = index === 97 ? seed : -index;
		write(
			cwd,
			`${directory}/${name}`,
			`// ${token}\n// ${query}\nexport function regionalInvoiceRounding() { return ${value}; }\n`,
		);
	}
	write(
		cwd,
		"test.js",
		`// ${token}\nimport { regionalInvoiceRounding } from "./src/production/billing/regional-policy.js";\nif (regionalInvoiceRounding() !== ${target}) process.exit(1);\n`,
	);
	return {
		prompt: prompt(
			query,
			`The broad concept has many test/vendor duplicates. Narrow to production and change only its value to ${target}.`,
		),
		targetPath: "src/production/billing/regional-policy.js",
		semanticQuery: query,
		mutablePaths: ["src/production/billing/regional-policy.js"],
		applyExpectedSolutionForTest: () =>
			write(
				cwd,
				"src/production/billing/regional-policy.js",
				`// ${token}\n// ${query}\nexport function regionalInvoiceRounding() { return ${target}; }\n`,
			),
		mutationCorrect: () => read(cwd, "src/production/billing/regional-policy.js").includes(`return ${target};`),
		externalChangePreserved: () => true,
	};
}

function staleView(cwd: string, seed: number, token: string): FixtureDefinition {
	const query = "adaptive retry delay policy";
	const target = seed + 31;
	const path = "src/retry.js";
	write(cwd, path, `// ${token}\n// ${query}\nexport function retryDelay() { return ${seed}; }\n`);
	write(
		cwd,
		"test.js",
		`// ${token}\nimport { retryDelay } from "./src/retry.js";\nif (retryDelay() !== ${target}) process.exit(1);\n`,
	);
	const marker = `EXTERNAL_CHANGE_${seed}`;
	return {
		prompt: prompt(
			query,
			`Change retryDelay() to return ${target}. Recover safely if the file changes after your first read.`,
		),
		targetPath: path,
		semanticQuery: query,
		mutablePaths: [path],
		fault: {
			kind: "after_target_read",
			relativePath: path,
			apply: () =>
				write(
					cwd,
					path,
					`// ${token}\n// ${query}\n// ${marker}\nexport function retryDelay() { return ${seed + 1}; }\n`,
				),
		},
		applyExpectedSolutionForTest: () =>
			write(
				cwd,
				path,
				`// ${token}\n// ${query}\n// ${marker}\nexport function retryDelay() { return ${target}; }\n`,
			),
		mutationCorrect: () => read(cwd, path).includes(`return ${target};`),
		externalChangePreserved: () => read(cwd, path).includes(marker),
	};
}

function multifileRepair(cwd: string, seed: number, token: string, heldOut: boolean): FixtureDefinition {
	const query = heldOut ? "coordinated ledger checkpoint migration" : "coordinated worker checkpoint migration";
	const firstTarget = seed + 37;
	const secondTarget = seed + 41;
	const firstPath = heldOut ? "src/ledger/checkpoint.js" : "src/worker/checkpoint.js";
	const secondPath = heldOut ? "src/ledger/config.js" : "src/worker/config.js";
	write(cwd, firstPath, `// ${token}\n// ${query}\nexport function checkpointValue() { return ${seed}; }\n`);
	write(
		cwd,
		secondPath,
		`// ${token}\nexport const checkpointLabel = "old";\nexport const checkpointLimit = ${seed};\n`,
	);
	write(
		cwd,
		"test.js",
		`// ${token}\nimport { checkpointValue } from "./${firstPath}";\nimport { checkpointLabel, checkpointLimit } from "./${secondPath}";\nif (checkpointValue() !== ${firstTarget} || checkpointLabel !== "ready-${seed}" || checkpointLimit !== ${secondTarget}) process.exit(1);\n`,
	);
	const marker = `EXTERNAL_PATCH_CHANGE_${seed}`;
	return {
		prompt: prompt(
			query,
			`Update checkpointValue() to ${firstTarget}, checkpointLabel to ready-${seed}, and checkpointLimit to ${secondTarget} as one safe multi-file change. If a prepared preimage becomes stale, reread and prepare again.`,
		),
		targetPath: firstPath,
		semanticQuery: query,
		mutablePaths: [firstPath, secondPath],
		fault: {
			kind: "after_multifile_prepare",
			relativePath: secondPath,
			apply: () => {
				const content = read(cwd, secondPath).replace(
					`export const checkpointLimit = ${seed};`,
					`// ${marker}\nexport const checkpointLimit = ;`,
				);
				write(cwd, secondPath, content);
			},
		},
		applyExpectedSolutionForTest: () => {
			write(
				cwd,
				firstPath,
				`// ${token}\n// ${query}\nexport function checkpointValue() { return ${firstTarget}; }\n`,
			);
			write(
				cwd,
				secondPath,
				`// ${token}\nexport const checkpointLabel = "ready-${seed}";\n// ${marker}\nexport const checkpointLimit = ${secondTarget};\n`,
			);
		},
		mutationCorrect: () =>
			read(cwd, firstPath).includes(`return ${firstTarget};`) &&
			read(cwd, secondPath).includes(`checkpointLabel = "ready-${seed}"`) &&
			read(cwd, secondPath).includes(`checkpointLimit = ${secondTarget}`),
		externalChangePreserved: () => read(cwd, secondPath).includes(marker),
	};
}

export function createFullRealEvalFixture(cwd: string, input: FullRealEvalCase): FullRealEvalFixture {
	rmSync(cwd, { recursive: true, force: true });
	mkdirSync(cwd, { recursive: true });
	write(cwd, "package.json", '{"type":"module"}\n');
	const provenanceToken = `SYNTHETIC_FULL_EVAL_${createHash("sha256")
		.update(`${input.stage}/${input.taskId}/${input.seed}`)
		.digest("hex")
		.slice(0, 16)}`;
	let definition: FixtureDefinition;
	switch (input.taskId) {
		case "duplicate-definition":
			definition = duplicateDefinition(cwd, input.seed, provenanceToken);
			break;
		case "qualified-assignment":
			definition = qualifiedAssignment(cwd, input.seed, provenanceToken);
			break;
		case "definition-among-calls":
			definition = definitionAmongCalls(cwd, input.seed, provenanceToken);
			break;
		case "same-method-multiple-classes":
			definition = sameMethodMultipleClasses(cwd, input.seed, provenanceToken);
			break;
		case "large-tail-long-line":
			definition = largeTailLongLine(cwd, input.seed, provenanceToken);
			break;
		case "overflow-narrowing":
			definition = overflowNarrowing(cwd, input.seed, provenanceToken);
			break;
		case "calibration-stale-view":
			definition = staleView(cwd, input.seed, provenanceToken);
			break;
		case "calibration-multifile-repair":
			definition = multifileRepair(cwd, input.seed, provenanceToken, false);
			break;
		case "stale-patch-syntax-repair":
			definition = multifileRepair(cwd, input.seed, provenanceToken, true);
			break;
		default:
			throw new Error(`Unknown full real evaluation task: ${input.taskId}`);
	}
	const protectedHashes = new Map<string, string>();
	for (const path of [
		"test.js",
		...[
			"test/fixture.js",
			"vendor/shipping.js",
			"src/callers.js",
			...Array.from({ length: 24 }, (_, index) => `src/noise/timeout-${index}.js`),
			...Array.from({ length: 120 }, (_, index) => {
				const directory = index === 97 ? "src/production/billing" : index % 2 === 0 ? "test/noise" : "vendor/noise";
				const name = index === 97 ? "regional-policy.js" : `candidate-${index}.js`;
				return `${directory}/${name}`;
			}),
		].filter((path) => !definition.mutablePaths.includes(path)),
	]) {
		try {
			protectedHashes.set(path, createHash("sha256").update(read(cwd, path)).digest("hex"));
		} catch {
			// The fixture does not contain this optional protected path.
		}
	}
	return {
		prompt: definition.prompt,
		targetPath: definition.targetPath,
		semanticQuery: definition.semanticQuery,
		provenanceToken,
		...(definition.fault ? { fault: definition.fault } : {}),
		grade: () => {
			const oracles: FullRealEvalOracles = {
				mutationCorrect: definition.mutationCorrect(),
				wrongLocationsUnchanged: [...protectedHashes].every(
					([path, expected]) => createHash("sha256").update(read(cwd, path)).digest("hex") === expected,
				),
				verificationPassed: testPasses(cwd),
				externalChangePreserved: definition.externalChangePreserved(),
			};
			const score = Object.values(oracles).filter(Boolean).length / Object.keys(oracles).length;
			return { success: score === 1, score, oracles };
		},
		applyExpectedSolutionForTest: definition.applyExpectedSolutionForTest,
	};
}
