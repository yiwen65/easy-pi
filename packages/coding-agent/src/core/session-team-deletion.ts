import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import {
	type CollaborationStorageStats,
	deleteCollaborationStorage,
	inspectCollaborationStorage,
} from "@easy-pi/subagent/collaboration-storage";

export interface SessionTeamDeletion {
	path: string;
	agentDir: string;
	rootSessionId: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	team: CollaborationStorageStats;
}

/** Read only the bounded header; never open/migrate a session merely to delete it. */
export function inspectSessionTeamDeletion(path: string, agentDir: string): SessionTeamDeletion {
	const absolute = resolve(path);
	const named = lstatSync(absolute);
	if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) throw new Error("Unsafe session file");
	const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (stat.dev !== named.dev || stat.ino !== named.ino) throw new Error("Session file changed during inspection");
		const buffer = Buffer.alloc(64 * 1024);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		const end = buffer.subarray(0, length).indexOf(10);
		if (end < 0) throw new Error("Session header is missing or exceeds the deletion inspection limit");
		const value: unknown = JSON.parse(buffer.subarray(0, end).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session header");
		const header = value as Record<string, unknown>;
		if (
			header.type !== "session" ||
			typeof header.id !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(header.id)
		) {
			throw new Error("Invalid session identity");
		}
		return {
			path: absolute,
			agentDir: resolve(agentDir),
			rootSessionId: header.id,
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			team: inspectCollaborationStorage({ agentDir: resolve(agentDir), rootSessionId: header.id }),
		};
	} finally {
		closeSync(fd);
	}
}

/** Recheck after operator interaction, including an append by another process. */
export function assertSessionTeamDeletionUnchanged(selected: SessionTeamDeletion): SessionTeamDeletion {
	const current = inspectSessionTeamDeletion(selected.path, selected.agentDir);
	if (
		current.rootSessionId !== selected.rootSessionId ||
		current.dev !== selected.dev ||
		current.ino !== selected.ino ||
		current.size !== selected.size ||
		current.mtimeMs !== selected.mtimeMs
	) {
		throw new Error("Session changed since confirmation; inspect it again before deleting");
	}
	if (current.team.owner === "live") throw new Error("Another live process owns this session's team");
	return current;
}

/** Operator-confirmed cascade only; the caller still owns deleting the selected root file. */
export function deleteAssociatedSessionTeam(selected: SessionTeamDeletion): void {
	assertSessionTeamDeletionUnchanged(selected);
	const result = deleteCollaborationStorage({
		agentDir: selected.agentDir,
		rootSessionId: selected.rootSessionId,
		dryRun: false,
	});
	if (!["deleted", "already_deleted", "missing"].includes(result.status)) {
		throw new Error(`Team deletion is protected: ${result.stats.protectedReasons.join(", ")}`);
	}
}
