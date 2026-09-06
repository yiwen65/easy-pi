import { createHash, randomUUID } from "node:crypto";
import {
	constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync,
	mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function directory(path, create = false) {
	const parent = dirname(path);
	if (parent !== path) directory(parent, create);
	if (!existsSync(path) && create) mkdirSync(path, { mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Directory is not a plain directory");
}

function snapshot(path) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.size > MAX_SESSION_BYTES) throw new Error("Not a regular session file within the size limit");
		const bytes = readFileSync(fd);
		const after = fstatSync(fd);
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== before.size) {
			throw new Error("Source changed while being read; retry after closing the session");
		}
		return bytes;
	} finally {
		closeSync(fd);
	}
}

/** Validate without transforming entries, dropping unknown fields, or printing conversation text. */
export function validateSession(bytes) {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const lines = text.split("\n").filter((line) => line.trim());
	if (!lines.length) throw new Error("Empty session");
	let header;
	for (let index = 0; index < lines.length; index++) {
		let entry;
		try { entry = JSON.parse(lines[index]); } catch { throw new Error(`Invalid JSON at line ${index + 1}`); }
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.type !== "string") {
			throw new Error(`Invalid entry at line ${index + 1}`);
		}
		if (index === 0) {
			header = entry;
			if (header.type !== "session" || typeof header.id !== "string" || !header.id ||
				typeof header.cwd !== "string" || typeof header.timestamp !== "string" ||
				![1, 2, 3].includes(header.version ?? 1)) throw new Error("Unsupported session header/version");
		} else if (entry.type === "session") {
			throw new Error("Multiple session headers");
		}
	}
	return { version: header.version ?? 1, entries: lines.length - 1 };
}

/** Copy root/project session JSONL and nested session support files without rewriting any bytes. */
export function migrateSessions(source, destination, { dryRun = true } = {}) {
	source = resolve(source);
	destination = resolve(destination);
	const overlap = (a, b) => { const path = relative(a, b); return !path || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)); };
	if (overlap(source, destination) || overlap(destination, source)) throw new Error("Source and destination must not overlap");
	directory(source);
	if (existsSync(destination)) directory(destination);
	const report = { schemaVersion: 1, dryRun, source, destination, copied: 0, identical: 0, planned: 0, bytes: 0, skipped: 0, errors: [], files: [] };
	function walk(path) {
		for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const input = join(path, entry.name);
			const name = relative(source, input);
			if (entry.isSymbolicLink()) { report.errors.push({ path: name, reason: "Symlink skipped" }); continue; }
			if (entry.isDirectory()) { walk(input); continue; }
			const supportFile = name.split(sep).length > 2;
			if (!entry.isFile() || (!supportFile && !entry.name.endsWith(".jsonl"))) { report.skipped++; continue; }
			try {
				const bytes = snapshot(input);
				const metadata = supportFile ? { kind: "support" } : { kind: "session", ...validateSession(bytes) };
				const sha256 = digest(bytes);
				const output = join(destination, name);
				if (existsSync(output)) {
					directory(dirname(output));
					if (digest(snapshot(output)) !== sha256) throw new Error("Destination conflict; not overwritten");
					report.identical++;
				} else if (dryRun) {
					report.planned++;
				} else {
					directory(dirname(output), true);
					const temporary = join(dirname(output), `.session-migration-${randomUUID()}.tmp`);
					try {
						const fd = openSync(temporary, "wx", 0o600);
						try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
						linkSync(temporary, output); // Atomic publication; fails if another writer created output.
						if (digest(snapshot(output)) !== sha256) throw new Error("Destination verification failed");
						report.copied++;
					} finally { if (existsSync(temporary)) unlinkSync(temporary); }
				}
				report.bytes += bytes.length;
				report.files.push({ path: name, bytes: bytes.length, sha256, ...metadata });
			} catch (error) {
				report.errors.push({ path: name, reason: error instanceof Error ? error.message : "Migration failed" });
			}
		}
	}
	walk(source);
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length < 2 || args.length > 3 || (args[2] && args[2] !== "--apply")) {
		console.error("Usage: node scripts/migrate-session-data.mjs <source-sessions> <destination-sessions> [--apply]");
		process.exitCode = 2;
	} else {
		try {
			const report = migrateSessions(args[0], args[1], { dryRun: args[2] !== "--apply" });
			console.log(JSON.stringify(report, null, 2));
			if (report.errors.length) process.exitCode = 1;
		} catch (error) {
			console.error(error instanceof Error ? error.message : "Migration failed");
			process.exitCode = 1;
		}
	}
}
