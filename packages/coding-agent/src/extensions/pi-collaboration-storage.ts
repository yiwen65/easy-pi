import {
	checkCollaborationStorageAdmission,
	deleteCollaborationStorage,
	inspectCollaborationStorage,
	listCollaborationStorage,
	sweepCollaborationStorage,
} from "@easy-pi/subagent/collaboration-storage";
import type { ExtensionContext } from "../core/extensions/types.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { storageDaysToMs } from "../core/subagent-storage-policy.ts";
import { sweepToolOutputStorage } from "../core/tool-output-storage.ts";
import { discoverToolOutputStorage } from "../core/tool-output-storage-discovery.ts";

interface StorageContext {
	agentDir: string;
	rootSessionId: string;
	sessionFile?: string;
	settings: SettingsManager;
}

function logPlan(options: StorageContext, dryRun: boolean) {
	const policy = options.settings.getSubagentStoragePolicy();
	const discovery = discoverToolOutputStorage({ agentDir: options.agentDir, sessionFile: options.sessionFile });
	const directories = discovery.directories;
	// Discovery already has a shared entry/time bound. An extra fixed prefix would starve
	// later directories forever because swept directories retain their ownership markers.
	const incomplete = discovery.incomplete;
	const result = sweepToolOutputStorage(directories, {
		dryRun,
		maxAgeMs: storageDaysToMs(policy.logMaxAgeDays),
		// Incomplete discovery is not evidence of the global byte total.
		maxTotalBytes: incomplete ? 0 : policy.logMaxTotalBytes,
	});
	return { ...result, incomplete };
}

/** New-task admission only: completion, inspection and resource teardown stay available. */
export function checkNativeTeamStorageAdmission(options: StorageContext): void {
	const policy = options.settings.getSubagentStoragePolicy();
	checkCollaborationStorageAdmission({
		agentDir: options.agentDir,
		rootSessionId: options.rootSessionId,
		maxTeamBytes: policy.maxTeamBytes,
		maxTotalBytes: policy.maxTotalBytes,
	});
}

/** Explicit global opt-in; run after acquiring the current team's live owner. */
export function runNativeStorageGc(options: StorageContext, dryRun: boolean) {
	const policy = options.settings.getSubagentStoragePolicy();
	const teams = sweepCollaborationStorage({
		agentDir: options.agentDir,
		enabled: true,
		dryRun,
		maxAgeMs: storageDaysToMs(policy.maxAgeDays),
		maxTotalBytes: policy.maxTotalBytes,
	});
	const logs = logPlan(options, dryRun);
	return { teams, logs };
}

function gcSummary(result: ReturnType<typeof runNativeStorageGc>): string {
	const deleted = result.teams.results.filter((entry) => entry.status === "deleted").length;
	return `Teams: ${result.teams.candidates.length} candidates, ${deleted} deleted; logs: ${result.logs.candidates.length} candidates, ${result.logs.deleted.length} deleted. ${result.teams.inventory.incomplete || result.logs.incomplete ? "Inventory incomplete; totals are lower bounds and incomplete-scope capacity cleanup is disabled. " : ""}${result.logs.errors.length ? `${result.logs.errors.length} log cleanup errors; inspect /agents storage.` : ""}`;
}

export function runAutomaticNativeStorageGc(
	options: StorageContext,
	ctx: { ui: Pick<ExtensionContext["ui"], "notify"> },
): void {
	if (!options.settings.getSubagentStoragePolicy().autoGc) return;
	try {
		const result = runNativeStorageGc(options, false);
		if (result.teams.results.length || result.logs.deleted.length || result.logs.errors.length) {
			ctx.ui.notify(gcSummary(result), result.logs.errors.length ? "warning" : "info");
		}
	} catch {
		ctx.ui.notify(
			"Storage cleanup did not complete; retained data is protected. Inspect /agents storage and retry explicitly.",
			"warning",
		);
	}
}

/** Operator commands only; never registered as model-callable deletion tools. */
export async function handleNativeStorageCommand(
	args: string,
	ctx: { hasUI: boolean; ui: Pick<ExtensionContext["ui"], "notify" | "confirm"> },
	options: StorageContext,
): Promise<boolean> {
	const parts = args.trim().split(/\s+/);
	if (!["storage", "delete", "gc"].includes(parts[0])) return false;
	try {
		const [command, target, extra] = parts;
		if (command === "storage" && parts.length <= 2) {
			if (target) {
				ctx.ui.notify(
					JSON.stringify(inspectCollaborationStorage({ agentDir: options.agentDir, rootSessionId: target })),
					"info",
				);
			} else {
				const inventory = listCollaborationStorage({ agentDir: options.agentDir, maxTeams: 100 });
				const logs = logPlan(options, true);
				ctx.ui.notify(
					JSON.stringify({
						teams: inventory,
						logs: {
							bytes: logs.inspections.reduce((sum, entry) => sum + entry.bytes, 0),
							directories: logs.inspections.length,
							protected: logs.inspections.filter((entry) => entry.protectedReason).length,
							candidates: logs.candidates.length,
							incomplete:
								logs.incomplete ||
								logs.inspections.some(
									(entry) => entry.protectedReason && !entry.protectedReason.startsWith("Active tool log"),
								),
							errors: logs.errors.slice(0, 10),
						},
					}),
					"info",
				);
			}
			return true;
		}
		if (command === "delete" && target && parts.length <= 3 && (!extra || extra === "--confirm")) {
			if (target === options.rootSessionId)
				throw new Error("Cannot delete the active root team; close this session and manage it from another root");
			const preview = deleteCollaborationStorage({ agentDir: options.agentDir, rootSessionId: target });
			if (preview.status !== "planned") {
				ctx.ui.notify(JSON.stringify(preview), preview.status === "protected" ? "warning" : "info");
				return true;
			}
			ctx.ui.notify(
				`Delete team ${target}: ${preview.stats.agentCount ?? "unknown"} children, ${preview.stats.bytes} known bytes, ${preview.stats.pendingMessages ?? "unknown"} pending messages, ${preview.stats.unfinishedTurns ?? "unknown"} unfinished and ${preview.stats.interruptedTurns ?? "unknown"} interrupted turns. Root session and workspace files are retained.`,
				"warning",
			);
			const confirmed =
				extra === "--confirm" ||
				(ctx.hasUI &&
					(await ctx.ui.confirm(
						"Permanently delete team history?",
						"Unread results and interrupted history may be lost. This cannot be undone.",
					)));
			if (!confirmed) {
				ctx.ui.notify(
					"No data deleted. Confirm in the UI or repeat the explicit operator command with --confirm.",
					"info",
				);
				return true;
			}
			const result = deleteCollaborationStorage({
				agentDir: options.agentDir,
				rootSessionId: target,
				dryRun: false,
			});
			ctx.ui.notify(JSON.stringify(result), result.status === "protected" ? "warning" : "info");
			return true;
		}
		if (command === "gc" && parts.length <= 2 && (!target || target === "--confirm")) {
			const preview = runNativeStorageGc(options, true);
			ctx.ui.notify(`${gcSummary(preview)} Dry run; policy is global subagentStorage.`, "info");
			if (target === "--confirm") ctx.ui.notify(gcSummary(runNativeStorageGc(options, false)), "info");
			return true;
		}
		ctx.ui.notify(
			"Usage: /agents storage [root-id] | /agents delete <root-id> [--confirm] | /agents gc [--confirm]",
			"warning",
		);
	} catch (error) {
		ctx.ui.notify(
			`Storage operation refused or incomplete: ${error instanceof Error ? error.message : "inspect retained storage"}. Retry after inspection; never delete an active team's directory manually.`,
			"error",
		);
	}
	return true;
}
