import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Recognize the configured native layout, or a foreign --session source backed by a registry/tombstone. */
export function nativeSessionTeamPaths(
	sessionFile: string,
	agentDir?: string,
):
	| { marker: string; relocatedFile: string; relocatedLogs: (sessionId: string) => string; quarantined: boolean }
	| undefined {
	const childRoot = dirname(resolve(sessionFile));
	const teamRoot = dirname(childRoot);
	const teams = dirname(teamRoot);
	if (basename(teams) !== "teams" || !/^[A-Za-z0-9_-]+$/.test(basename(childRoot))) return undefined;
	const name = basename(teamRoot);
	const quarantined = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.deleting$/.test(name);
	const teamId = quarantined ? name.slice(1, -9) : name;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(teamId)) return undefined;
	const marker = join(teams, `.${teamId}.deleted.json`);
	let configured = agentDir ? resolve(agentDir) : undefined;
	if (configured) {
		try {
			configured = realpathSync(configured);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (dirname(teams) !== configured) {
		let known = false;
		for (const path of [join(teamRoot, "registry.sqlite"), marker]) {
			try {
				const info = lstatSync(path);
				known ||= path === marker || (info.isFile() && !info.isSymbolicLink());
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (!known) return undefined;
	}
	const relocatedChild = join(teams, `.${teamId}.deleting`, basename(childRoot));
	return {
		marker,
		quarantined,
		relocatedFile: join(relocatedChild, basename(sessionFile)),
		relocatedLogs: (sessionId) => join(relocatedChild, `${sessionId}.logs`),
	};
}

export function assertNativeSessionTeamAvailable(sessionFile: string, agentDir?: string): void {
	const team = nativeSessionTeamPaths(sessionFile, agentDir);
	if (!team) return;
	if (team.quarantined) throw new Error("Cannot start a session from quarantined team history");
	try {
		lstatSync(team.marker);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new Error("Team deletion is pending or complete; cannot start or resume this session");
}

/** Check after lease admission and again at provider preparation; a missing file is never recreated here. */
export function assertPersistentSessionAvailable(sessionFile: string, sessionId: string, agentDir?: string): void {
	assertNativeSessionTeamAvailable(sessionFile, agentDir);
	if (realpathSync(sessionFile) !== resolve(sessionFile)) throw new Error("Session path identity changed");
	const fd = openSync(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.nlink !== 1) throw new Error("Unsafe persistent session file");
		const buffer = Buffer.alloc(4096);
		let text = "";
		let bytes = 0;
		let header: unknown;
		while (bytes < 1024 * 1024 && header === undefined) {
			const count = readSync(fd, buffer, 0, buffer.length, null);
			bytes += count;
			text += buffer.subarray(0, count).toString("utf8");
			const lines = text.split("\n");
			text = count === 0 ? "" : lines.pop()!;
			for (const line of lines) {
				try {
					header = JSON.parse(line);
				} catch {
					continue;
				}
				break;
			}
			if (count === 0) break;
		}
		if (
			!header ||
			typeof header !== "object" ||
			!("type" in header) ||
			header.type !== "session" ||
			!("id" in header) ||
			header.id !== sessionId
		) {
			throw new Error(`Persistent session identity changed or cannot be verified: ${basename(sessionFile)}`);
		}
	} finally {
		closeSync(fd);
	}
	assertNativeSessionTeamAvailable(sessionFile, agentDir);
}
