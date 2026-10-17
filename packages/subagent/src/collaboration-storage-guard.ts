import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CollaborationError } from "./collaboration-contract.ts";

export function collaborationDeletionMarker(directory: string): string {
	return join(dirname(directory), `.${basename(directory)}.deleted.json`);
}

/** A retained marker is authoritative even after the database has been removed. */
export function assertCollaborationNotDeleted(directory: string): void {
	try {
		lstatSync(collaborationDeletionMarker(directory));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new CollaborationError(
		"forbidden",
		"Team deletion is pending or complete; choose a new root session",
		"team_deleted",
	);
}

/** Refuse symlinks in every existing path component, not just the final directory. */
export function assertCollaborationPathSafe(path: string): void {
	for (let current = path; ; current = dirname(current)) {
		try {
			if (lstatSync(current).isSymbolicLink()) throw new CollaborationError("forbidden", "Unsafe team storage path");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (dirname(current) === current) return;
	}
}

/** Matches store acquisition: unknown probes remain live (fail closed), including EPERM. */
export function collaborationOwnerAlive(row: { owner: unknown; pid: unknown; owner_started_at?: unknown }): boolean {
	if (row.owner === null) {
		if (row.pid !== null || (row.owner_started_at !== null && row.owner_started_at !== undefined))
			throw new CollaborationError("storage_error", "Invalid team owner");
		return false;
	}
	if (typeof row.owner !== "string" || !row.owner || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 0)
		throw new CollaborationError("storage_error", "Invalid team owner");
	const pid = Number(row.pid);
	if (
		row.owner_started_at !== null &&
		row.owner_started_at !== undefined &&
		(typeof row.owner_started_at !== "number" ||
			!Number.isSafeInteger(row.owner_started_at) ||
			row.owner_started_at < 0)
	)
		throw new CollaborationError("storage_error", "Invalid team owner start time");
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	if (process.platform !== "win32" && typeof row.owner_started_at === "number") {
		try {
			const out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1000,
			}).trim();
			const match = out.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
			if (match) {
				const seconds =
					Number(match[1] ?? 0) * 86_400 +
					Number(match[2] ?? 0) * 3_600 +
					Number(match[3]) * 60 +
					Number(match[4]);
				if (Math.abs(Date.now() - seconds * 1000 - row.owner_started_at) > 10_000) return false;
			}
		} catch {
			/* No trustworthy start-time answer: retain the live-owner protection. */
		}
	}
	return true;
}
