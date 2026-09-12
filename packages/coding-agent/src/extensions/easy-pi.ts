import { isAbsolute } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { CHILD_HARNESS_CONTEXT_ENV, decidePermission, type PermissionMode } from "@easy-pi/permissions";
import type { ChildSessionPermissions } from "@easy-pi/subagent/session-host";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ToolCallEvent } from "../core/extensions/types.ts";
import { registerPiCollaborationRoot } from "./pi-collaboration-root.ts";
import { registerRequestUserInput } from "./questionnaire.ts";

const AUDIT_ENTRY = "wj-harness-audit";
interface AuditRecord {
	timestamp: string;
	action: "mode" | "permission";
	mode: PermissionMode;
	decision?: string;
	tool?: string;
	reason: string;
}

function inputRecord(event: ToolCallEvent): Record<string, unknown> {
	return event.input as Record<string, unknown>;
}

function sanitizeUiText(value: string, preserveNewlines = false): string {
	const safe = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
	return preserveNewlines ? safe : safe.replace(/[\t\n]+/g, " ");
}

export interface EasyPiHarnessOptions {
	/** Root-owned storage; defaults to the easy-pi agent directory. */
	agentDir?: string;
	/** Explicit native-session capability; bypasses legacy process env and DAG registration. */
	nativeSession?: {
		getPermissions: () => ChildSessionPermissions;
		registerTools: (pi: ExtensionAPI) => void;
	};
}

export function createEasyPiHarness(options: EasyPiHarnessOptions = {}): (pi: ExtensionAPI) => void {
	return function easyPiHarness(pi: ExtensionAPI): void {
		if (!options.nativeSession && process.env[CHILD_HARNESS_CONTEXT_ENV]) {
			const reason =
				"Legacy DAG child launch is retired in this build. Drain old runs using their original build; no automatic conversion or replay.";
			pi.on("tool_call", () => ({ block: true, terminate: true, reason }));
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.notify(reason, "error");
			});
			return;
		}
		const readNativePermissions = (): ChildSessionPermissions | undefined => {
			if (!options.nativeSession) return undefined;
			const permissions = options.nativeSession.getPermissions();
			if (
				permissions.mode !== "full-access" ||
				!Array.isArray(permissions.sessionGrants) ||
				!permissions.sessionGrants.every((grant) => typeof grant === "string") ||
				!Array.isArray(permissions.protectedRoots) ||
				!permissions.protectedRoots.every(
					(root) => typeof root === "string" && isAbsolute(root) && !root.includes("\0"),
				)
			)
				throw new Error("Invalid native session authority");
			return structuredClone(permissions);
		};
		readNativePermissions();

		const audit = (record: Omit<AuditRecord, "timestamp" | "mode">) => {
			pi.appendEntry<AuditRecord>(AUDIT_ENTRY, {
				timestamp: new Date().toISOString(),
				mode: "full-access",
				...record,
			});
		};

		pi.registerEntryRenderer<AuditRecord>(AUDIT_ENTRY, (entry, _options, theme) => {
			const data = entry.data;
			if (!data) return undefined;
			const target = data.tool ? ` ${data.tool}` : "";
			const decision = data.decision ? ` ${data.decision}` : "";
			return new Text(
				theme.fg("dim", sanitizeUiText(`[wj-harness] ${data.action}${target}${decision}: ${data.reason}`)),
				0,
				0,
			);
		});

		pi.registerCommand("permissions", {
			description: "Show the easy-pi permission mode",
			async handler(_args, ctx) {
				ctx.ui.notify("Permission mode: full-access (the only permission mode)", "info");
			},
		});

		registerRequestUserInput(pi);

		pi.on("before_agent_start", (event) => {
			const contract = [
				"easy-pi execution contract:",
				"- Permission mode is full-access (the only mode). Pi tools run with the permissions of the Pi process.",
				"- Full Access allows credential reads and suppresses permission prompts, but retains best-effort catastrophic-deletion checks. This is not an OS sandbox.",
				// Verification floor: complements the template's Working rules (which a custom SYSTEM.md replaces).
				// Keep this bullet scoped to risk calibration; the template owns timing and reporting.
				"- Scale verification effort to the change risk; skip checks that cannot catch a meaningful failure for simple tasks. If verification is unavailable, state why and report the remaining risk honestly.",
			].join("\n");
			return { systemPrompt: `${event.systemPrompt}\n\n${contract}` };
		});

		if (options.nativeSession) {
			options.nativeSession.registerTools(pi);
		} else {
			registerPiCollaborationRoot(pi, options.agentDir ?? getAgentDir(), () => ({
				mode: "full-access",
				sessionGrants: [],
				protectedRoots: [],
			}));
		}

		pi.on("tool_call", (event, ctx) => {
			let nativePermissions: ChildSessionPermissions | undefined;
			try {
				nativePermissions = readNativePermissions();
			} catch {
				return { block: true, reason: "Native parent authority is unavailable" };
			}
			const outcome = decidePermission({
				mode: "full-access",
				toolName: event.toolName,
				input: inputRecord(event),
				cwd: ctx.cwd,
				sessionGrants: nativePermissions ? new Set(nativePermissions.sessionGrants) : new Set(),
				...(nativePermissions ? { protectedRoots: nativePermissions.protectedRoots } : {}),
			});

			if (outcome.decision === "deny") {
				audit({ action: "permission", decision: "deny", tool: event.toolName, reason: outcome.reason });
				return { block: true, reason: outcome.reason };
			}
			return undefined;
		});
	};
}

export default createEasyPiHarness();
