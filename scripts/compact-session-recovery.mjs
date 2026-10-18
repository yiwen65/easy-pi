import { randomUUID } from "node:crypto";
import {
	closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, statSync, unlinkSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	loadEntriesFromFile,
	rewriteSessionRecoveryFile,
} from "../packages/coding-agent/src/core/session-manager.ts";

function sameFile(left, right) {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
		left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function removeOwnedFile(path, identity) {
	try {
		const current = lstatSync(path, { bigint: true });
		if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isFile()) {
			throw new Error("Recovery copy identity changed during cleanup; file retained");
		}
		unlinkSync(path);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

/** Preserve the source and publish a same-identity copy only after full logical comparison. */
export function compactSessionRecovery(sourcePath, outputPath) {
	const source = resolve(sourcePath);
	const output = resolve(outputPath);
	if (source === output) throw new Error("Source and output must be different; in-place compaction is not supported");
	try {
		lstatSync(output);
		throw new Error("Output already exists; refusing to overwrite");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const before = statSync(source, { bigint: true });
	if (!before.isFile()) throw new Error("Source must be a session file");
	mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
	const staging = resolve(dirname(output), `.${basename(output)}.${randomUUID()}.recovery-copy`);
	let identity;
	let published = false;
	try {
		rewriteSessionRecoveryFile(source, staging);
		identity = lstatSync(staging, { bigint: true });
		const originalEntries = loadEntriesFromFile(source);
		const copiedEntries = loadEntriesFromFile(staging);
		if (originalEntries.length !== copiedEntries.length) throw new Error("Recovery copy entry count differs");
		for (let index = 0; index < originalEntries.length; index++) {
			// Key insertion order can change when referenced fields are restored; compare values, not JSON strings.
			if (!isDeepStrictEqual(originalEntries[index], copiedEntries[index])) {
				throw new Error(`Recovery copy differs at entry ${index}; output not published`);
			}
		}
		if (!sameFile(before, statSync(source, { bigint: true }))) {
			throw new Error("Source changed while verifying; close the session and retry");
		}
		if (!sameFile(identity, lstatSync(staging, { bigint: true }))) {
			throw new Error("Recovery copy changed while verifying; output not published");
		}
		linkSync(staging, output); // Exclusive atomic publication; never replace an existing output.
		published = true;
		// Sync the final one-link state, not an intermediate state that cannot be resumed.
		removeOwnedFile(staging, identity);
		const directory = openSync(dirname(output), "r");
		try { fsyncSync(directory); } finally { closeSync(directory); }
		return {
			source,
			output,
			entries: originalEntries.length - 1,
			sourceBytes: Number(before.size),
			outputBytes: Number(identity.size),
			verified: true,
		};
	} catch (error) {
		if (published && identity) removeOwnedFile(output, identity);
		throw error;
	} finally {
		if (identity) removeOwnedFile(staging, identity);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const usage = "Usage: node --import ./scripts/source-resolver.mjs scripts/compact-session-recovery.mjs <source.jsonl> <new-output.jsonl>";
	if (args.length === 1 && args[0] === "--help") {
		console.log(`${usage}\nCreates and verifies a copy; never replaces the source. Stop the old driver before using the copy.`);
	} else if (args.length !== 2 || args.some((arg) => arg.startsWith("--"))) {
		console.error(usage);
		process.exitCode = 2;
	} else {
		try {
			console.log(JSON.stringify(compactSessionRecovery(args[0], args[1]), null, 2));
		} catch (error) {
			console.error(error instanceof Error ? error.message : "Recovery copy failed");
			process.exitCode = 1;
		}
	}
}
