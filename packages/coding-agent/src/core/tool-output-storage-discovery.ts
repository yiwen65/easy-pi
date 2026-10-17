import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { TOOL_OUTPUT_MARKER, TOOL_OUTPUT_SESSION_ID } from "./tool-output-storage.ts";

/**
 * Bounded discovery of only the standard session/team layouts and the current custom session root.
 * Includes SDK memory-session logs under agentDir/tool-output. Offline custom roots and OS
 * temporary logs are deliberately outside this discovery scope.
 */
export function discoverToolOutputStorage(options: {
	agentDir: string;
	sessionFile?: string;
	maxEntries?: number;
	maxDurationMs?: number;
}): { directories: string[]; incomplete: boolean } {
	const maxEntries = options.maxEntries ?? 10_000;
	const maxDurationMs = options.maxDurationMs ?? 100;
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
		throw new Error("Invalid tool log discovery limits");
	}
	const deadline = performance.now() + maxDurationMs;
	const directories = new Set<string>();
	let entries = 0;
	let incomplete = false;
	const safeDirectory = (directory: string): void => {
		let current = parse(directory).root;
		for (const part of directory.slice(current.length).split(/[\\/]/).filter(Boolean)) {
			current = join(current, part);
			const info = lstatSync(current);
			if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Unsafe discovery path");
		}
	};
	const scan = (directory: string, visit: (path: string, name: string) => void): void => {
		if (entries >= maxEntries || performance.now() >= deadline) {
			incomplete = true;
			return;
		}
		try {
			safeDirectory(directory);
			const handle = opendirSync(directory);
			try {
				for (;;) {
					if (entries >= maxEntries || performance.now() >= deadline) {
						incomplete = true;
						break;
					}
					const entry = handle.readSync();
					if (!entry) break;
					entries++;
					if (entry.isDirectory() && !entry.isSymbolicLink()) visit(join(directory, entry.name), entry.name);
					else if (
						entry.isSymbolicLink() &&
						(entry.name.endsWith(".logs") || entry.name.startsWith("pi-tool-logs-"))
					)
						incomplete = true;
				}
			} finally {
				handle.closeSync();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
		}
	};
	const findLogs = (parent: string, temporary = false): void => {
		scan(parent, (path, name) => {
			if (temporary ? !name.startsWith("pi-tool-logs-") : !name.endsWith(".logs")) return;
			if (
				temporary ? !/^pi-tool-logs-[A-Za-z0-9]{6}$/.test(name) : !TOOL_OUTPUT_SESSION_ID.test(name.slice(0, -5))
			) {
				incomplete = true;
				return;
			}
			let fd: number | undefined;
			try {
				safeDirectory(path);
				fd = openSync(join(path, TOOL_OUTPUT_MARKER), constants.O_RDONLY | constants.O_NOFOLLOW);
				const info = fstatSync(fd);
				if (!info.isFile() || info.nlink !== 1 || info.size > 4096) {
					incomplete = true;
					return;
				}
				const value = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown> | null;
				if (
					value &&
					Object.keys(value).sort().join(",") === "directory,kind,sessionId,version" &&
					value.kind === "pi-tool-output" &&
					value.version === 1 &&
					value.directory === path &&
					typeof value.sessionId === "string" &&
					TOOL_OUTPUT_SESSION_ID.test(value.sessionId) &&
					(temporary || `${value.sessionId}.logs` === name)
				) {
					directories.add(path);
				} else incomplete = true;
			} catch {
				// Preserve unknown ownership and never report its missing bytes as a complete total.
				incomplete = true;
			} finally {
				if (fd !== undefined) closeSync(fd);
			}
		});
	};
	const agentDir = resolve(options.agentDir);
	scan(join(agentDir, "sessions"), (cwdRoot) => findLogs(cwdRoot));
	scan(join(agentDir, "teams"), (teamRoot, name) => {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
			if (name.endsWith(".deleting")) incomplete = true;
			return;
		}
		scan(teamRoot, (childRoot, childName) => {
			if (/^[a-zA-Z0-9_-]+$/.test(childName)) findLogs(childRoot);
		});
	});
	findLogs(join(agentDir, "tool-output"), true);
	if (options.sessionFile) findLogs(resolve(dirname(options.sessionFile)));
	return { directories: [...directories], incomplete };
}
