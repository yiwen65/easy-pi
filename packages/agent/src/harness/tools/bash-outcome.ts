import type { BashToolDetails } from "./bash.ts";

/** A captured foreground exit is a known result, including a nonzero exit. */
export function hasConfirmedBashExit(toolName: string, details: unknown): details is BashToolDetails {
	if (toolName !== "bash" || !details || typeof details !== "object") return false;
	const status = details as Partial<BashToolDetails>;
	return (
		typeof status.command === "string" &&
		typeof status.cwd === "string" &&
		status.terminationReason === "exit" &&
		typeof status.exitCode === "number" &&
		Number.isSafeInteger(status.exitCode) &&
		status.exitCode >= 0 &&
		status.signal === null &&
		status.terminationRequested === false &&
		status.timedOut === false &&
		status.backgroundTaskId === undefined &&
		typeof status.durationMs === "number" &&
		Number.isFinite(status.durationMs) &&
		status.durationMs >= 0
	);
}
