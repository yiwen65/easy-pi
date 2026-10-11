#!/usr/bin/env node

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readModelCatalog } from "./model-catalog.mjs";

const CATALOG_SCHEMA_VERSION = 1;
const CATALOG_PREFIX = `models/v${CATALOG_SCHEMA_VERSION}`;
const CATALOG_INDEX_KEY = `${CATALOG_PREFIX}/index.json`;
// Bump this only when generated model metadata requires behavior unavailable in older pi clients.
const MINIMUM_PI_VERSION = "0.80.7";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const INDEX_CACHE_CONTROL = "no-store";
const REQUIRED_PROVIDERS = ["anthropic", "openai", "openrouter"];
const MINIMUM_MODEL_COUNT = 500;

function parseArgs(args) {
	const options = {
		input: undefined,
		bucket: undefined,
		endpoint: undefined,
		sourceCommit: undefined,
		dryRun: false,
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--input" || arg === "--bucket" || arg === "--endpoint" || arg === "--source-commit") {
			const value = args[++index];
			if (!value) throw new Error(`${arg} requires a value`);
			options[
				{
					"--input": "input",
					"--bucket": "bucket",
					"--endpoint": "endpoint",
					"--source-commit": "sourceCommit",
				}[arg]
			] = value;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!options.input) throw new Error("--input is required");
	if (!options.dryRun && !options.bucket) throw new Error("--bucket is required when publishing");
	if (!options.dryRun && !options.endpoint) throw new Error("--endpoint is required when publishing");
	return options;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function validateBundle(inputDir) {
	const bundle = readModelCatalog(inputDir);
	for (const providerId of REQUIRED_PROVIDERS) {
		if (!bundle.providerIds.includes(providerId)) throw new Error(`Required provider is missing: ${providerId}`);
	}
	if (bundle.modelCount < MINIMUM_MODEL_COUNT) {
		throw new Error(`Refusing to publish only ${bundle.modelCount} models; expected at least ${MINIMUM_MODEL_COUNT}`);
	}
	return bundle;
}

function gitSourceCommit() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Unable to determine source commit: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function aws(args, { allowNotFound = false } = {}) {
	const result = spawnSync("aws", args, {
		encoding: "utf8",
		env: {
			...process.env,
			AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "auto",
			AWS_EC2_METADATA_DISABLED: "true",
		},
	});
	if (result.error) throw result.error;
	if (result.status === 0) return true;
	const message = `${result.stdout}\n${result.stderr}`.trim();
	if (allowNotFound && /(?:404|NoSuchKey|Not Found)/i.test(message)) return false;
	throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n${message}`);
}

function downloadIndex(bucket, endpoint, outputPath) {
	return aws(
		[
			"s3",
			"cp",
			`s3://${bucket}/${CATALOG_INDEX_KEY}`,
			outputPath,
			"--endpoint-url",
			endpoint,
			"--only-show-errors",
		],
		{ allowNotFound: true },
	);
}

function uploadJson(bucket, endpoint, sourcePath, key, cacheControl) {
	aws([
		"s3",
		"cp",
		sourcePath,
		`s3://${bucket}/${key}`,
		"--endpoint-url",
		endpoint,
		"--content-type",
		JSON_CONTENT_TYPE,
		"--cache-control",
		cacheControl,
		"--only-show-errors",
	]);
}

function validateIndex(index) {
	if (
		typeof index !== "object" ||
		index === null ||
		Array.isArray(index) ||
		index.schemaVersion !== CATALOG_SCHEMA_VERSION
	) {
		throw new Error(`Existing ${CATALOG_INDEX_KEY} has an unsupported schema`);
	}
	if (!Array.isArray(index.catalogs)) throw new Error(`Existing ${CATALOG_INDEX_KEY} has no catalogs array`);
	for (const catalog of index.catalogs) {
		if (
			typeof catalog !== "object" ||
			catalog === null ||
			Array.isArray(catalog) ||
			typeof catalog.minimumPiVersion !== "string" ||
			typeof catalog.revision !== "string"
		) {
			throw new Error(`Existing ${CATALOG_INDEX_KEY} contains an invalid catalog entry`);
		}
	}
	return index;
}

function comparePiVersions(left, right) {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
		const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
		if (difference !== 0) return difference;
	}
	return left.localeCompare(right);
}

export function buildIndex(existingIndex, publication) {
	const entry = {
		minimumPiVersion: MINIMUM_PI_VERSION,
		revision: publication.revision,
		sourceCommit: publication.sourceCommit,
		publishedAt: new Date().toISOString(),
		providerCount: publication.providerCount,
		modelCount: publication.modelCount,
		imageModelCount: publication.imageModelCount,
		totalModelCount: publication.totalModelCount,
	};
	const catalogs = (existingIndex?.catalogs || [])
		.filter((catalog) => catalog.minimumPiVersion !== MINIMUM_PI_VERSION)
		.concat(entry)
		.sort((left, right) => comparePiVersions(left.minimumPiVersion, right.minimumPiVersion));
	return {
		schemaVersion: CATALOG_SCHEMA_VERSION,
		defaultRevision: publication.revision,
		catalogs,
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const inputDir = resolve(options.input);
	const bundle = validateBundle(inputDir);
	const publication = {
		schemaVersion: CATALOG_SCHEMA_VERSION,
		minimumPiVersion: MINIMUM_PI_VERSION,
		revision: bundle.revision,
		sourceCommit: options.sourceCommit || gitSourceCommit(),
		providerCount: bundle.providerCount,
		modelCount: bundle.modelCount,
		imageModelCount: bundle.imageModelCount,
		totalModelCount: bundle.totalModelCount,
	};
	writeFileSync(join(inputDir, "publication.json"), `${JSON.stringify(publication, null, 2)}\n`);

	console.log(JSON.stringify(publication, null, 2));
	if (options.dryRun) {
		console.log(`Validated model catalog at ${inputDir}; no objects uploaded.`);
		return;
	}

	const temporaryDir = mkdtempSync(join(tmpdir(), "pi-model-catalog-"));
	try {
		const currentIndexPath = join(temporaryDir, "index-current.json");
		const hasCurrentIndex = downloadIndex(options.bucket, options.endpoint, currentIndexPath);
		const currentIndex = hasCurrentIndex ? validateIndex(readJson(currentIndexPath)) : undefined;
		const currentEntry = currentIndex?.catalogs.find(
			(catalog) => catalog.minimumPiVersion === MINIMUM_PI_VERSION,
		);
		if (currentIndex?.defaultRevision === bundle.revision && currentEntry?.revision === bundle.revision) {
			console.log(`Model catalog ${bundle.revision} is already current; no objects uploaded.`);
			return;
		}

		const revisionPrefix = `${CATALOG_PREFIX}/revisions/${bundle.revision}`;
		for (const file of bundle.files) {
			uploadJson(options.bucket, options.endpoint, join(inputDir, file), `${revisionPrefix}/${file}`, IMMUTABLE_CACHE_CONTROL);
		}

		const nextIndex = buildIndex(currentIndex, publication);
		const nextIndexPath = join(temporaryDir, "index-next.json");
		writeFileSync(nextIndexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);
		uploadJson(options.bucket, options.endpoint, nextIndexPath, CATALOG_INDEX_KEY, INDEX_CACHE_CONTROL);
		console.log(`Published ${bundle.revision} to s3://${options.bucket}/${revisionPrefix}`);
	} finally {
		rmSync(temporaryDir, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
