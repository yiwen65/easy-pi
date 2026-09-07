import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import {
	CHILD_HARNESS_CONTEXT_ENV,
	type ChildHarnessContext,
	canonicalizeProspectivePath,
	createChildHarnessContext,
	decidePermission,
	type PermissionMode,
	validateChildHarnessContext,
} from "@easy-pi/permissions";
import { ExternalMutationJournalWriter } from "@easy-pi/permissions/journal";
import { registerChildProtocol } from "@easy-pi/subagent/child-protocol-extension";
import { createSubagentExtension, type SubagentExtensionOptions } from "@easy-pi/subagent/extension";
import { runChildTask } from "@easy-pi/subagent/process-runner";
import type { ChildSessionPermissions } from "@easy-pi/subagent/session-host";
import { resolveWorkspaceRoot } from "@easy-pi/subagent/workspace-router";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "../core/extensions/types.ts";
import { resolveEasyPiInvocation } from "./product-launcher.ts";
import { registerRequestUserInput } from "./questionnaire.ts";

const AUDIT_ENTRY = "wj-harness-audit";
const PERMISSION_TARGET_CAP = 240;
const MODE_OPTIONS: Array<{ mode: PermissionMode; label: string }> = [
	{ mode: "auto", label: "Auto — low-risk writes automatic; other tools allowed" },
	{ mode: "full-access", label: "Full Access — no permission prompts" },
	{ mode: "manual-allow", label: "Manual Allow — write/edit ask; other tools allowed" },
];

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

function loadChildHarnessContextFromEnvironment(): ChildHarnessContext | undefined {
	const path = process.env[CHILD_HARNESS_CONTEXT_ENV];
	if (!path) return undefined;
	if (!isAbsolute(path) || path.includes("\0")) {
		throw new Error(`${CHILD_HARNESS_CONTEXT_ENV} must name an absolute context file`);
	}
	try {
		const metadata = lstatSync(path);
		if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
			throw new Error("context file must be a private regular file");
		}
		return validateChildHarnessContext(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot load WJ Child Harness context ${path}: ${message}`);
	}
}

function sanitizeUiText(value: string, preserveNewlines = false): string {
	const safe = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
	return preserveNewlines ? safe : safe.replace(/[\t\n]+/g, " ");
}

function redactPermissionText(value: string): string {
	const redacted = sanitizeUiText(value)
		.replace(/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[redacted]")
		.replace(/((?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)\s*=\s*)\S+/gi, "$1[redacted]")
		.replace(/(--(?:token|secret|password|api-key)\s+)\S+/gi, "$1[redacted]")
		.replace(/:\/\/([^\s/:]+):([^\s@]+)@/g, "://$1:[redacted]@");
	return redacted.length <= PERMISSION_TARGET_CAP ? redacted : `${redacted.slice(0, PERMISSION_TARGET_CAP - 1)}…`;
}

function permissionPreview(value: unknown, key = "", depth = 0): unknown {
	if (/(?:authorization|credential|password|passwd|private.?key|secret|token|content)/i.test(key)) return "[redacted]";
	if (typeof value === "string") return redactPermissionText(value);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (depth >= 2) return "[nested]";
	if (Array.isArray(value)) return value.slice(0, 5).map((item) => permissionPreview(item, key, depth + 1));
	if (!value || typeof value !== "object") return String(value);
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.slice(0, 8)
			.map(([entryKey, item]) => [entryKey, permissionPreview(item, entryKey, depth + 1)]),
	);
}

function permissionTarget(event: ToolCallEvent): string {
	const input = inputRecord(event);
	if (event.toolName === "bash" && typeof input.command === "string") return redactPermissionText(input.command);
	if (typeof input.path === "string") return redactPermissionText(input.path);
	return redactPermissionText(JSON.stringify(permissionPreview(input)));
}

export interface EasyPiHarnessOptions {
	/** Product root composition retains its own permission controls; no legacy DAG registration. */
	nativeRoot?: (pi: ExtensionAPI, getPermissions: () => ChildSessionPermissions) => void;
	subagent?: Omit<SubagentExtensionOptions, "agentDir"> & { agentDir?: string };
	/** Explicit native-session capability; bypasses legacy process env and DAG registration. */
	nativeSession?: {
		getPermissions: () => ChildSessionPermissions;
		registerTools: (pi: ExtensionAPI) => void;
	};
}

export function createEasyPiHarness(options: EasyPiHarnessOptions = {}): (pi: ExtensionAPI) => void {
	return function easyPiHarness(pi: ExtensionAPI): void {
		if (options.nativeRoot && process.env[CHILD_HARNESS_CONTEXT_ENV]) {
			const reason =
				"Legacy DAG child launch is retired in this build. Drain old runs using their original build; no automatic conversion or replay.";
			pi.on("tool_call", () => ({ block: true, terminate: true, reason }));
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.notify(reason, "error");
			});
			return;
		}
		const childContext =
			options.nativeSession || options.nativeRoot ? undefined : loadChildHarnessContextFromEnvironment();
		const readNativePermissions = (): ChildSessionPermissions | undefined => {
			if (!options.nativeSession) return undefined;
			const permissions = options.nativeSession.getPermissions();
			if (
				!MODE_OPTIONS.some((option) => option.mode === permissions.mode) ||
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
		const mutationJournal = childContext?.mutationJournal
			? new ExternalMutationJournalWriter(childContext.mutationJournal)
			: undefined;
		const inheritedSessionGrants = childContext?.sessionGrants ?? [];
		const sessionGrants = new Set<string>(inheritedSessionGrants);
		let permissionMode: PermissionMode = childContext?.permissionMode ?? "full-access";
		let permissionPromptQueue = Promise.resolve();

		const audit = (record: Omit<AuditRecord, "timestamp" | "mode">) => {
			pi.appendEntry<AuditRecord>(AUDIT_ENTRY, {
				timestamp: new Date().toISOString(),
				mode: permissionMode,
				...record,
			});
		};

		const updateStatus = (ctx: ExtensionContext) => {
			ctx.ui.setStatus("wj-harness", `perm:${readNativePermissions()?.mode ?? permissionMode}`);
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
			description: "Show or change the easy-pi permission mode",
			async handler(args, ctx) {
				if (options.nativeSession) {
					ctx.ui.notify("This agent inherits live parent permissions; change them in the root session.", "info");
					return;
				}
				const requested = args.trim();
				let nextMode: PermissionMode | undefined;
				if (requested) nextMode = MODE_OPTIONS.find((option) => option.mode === requested)?.mode;
				if (requested && !nextMode) {
					ctx.ui.notify(`Unknown permission mode: ${redactPermissionText(requested)}`, "error");
					return;
				}
				if (!nextMode) {
					const selected = await ctx.ui.select(
						`Permission mode: ${permissionMode}`,
						MODE_OPTIONS.map((option) => option.label),
					);
					if (!selected) return;
					nextMode = MODE_OPTIONS.find((option) => option.label === selected)?.mode;
				}
				if (!nextMode) return;
				permissionMode = nextMode;
				sessionGrants.clear();
				audit({ action: "mode", reason: `Mode changed to ${nextMode}` });
				updateStatus(ctx);
				if (nextMode === "manual-allow") {
					ctx.ui.notify("Manual Allow prompts for write/edit; other tools are allowed.", "info");
				}
			},
		});

		registerRequestUserInput(pi);

		pi.on("session_start", (_event, ctx) => {
			permissionMode = childContext?.permissionMode ?? "full-access";
			sessionGrants.clear();
			for (const grant of inheritedSessionGrants) sessionGrants.add(grant);
			updateStatus(ctx);
		});

		if (childContext) registerChildProtocol(pi);

		pi.on("before_agent_start", (event) => {
			const contract = [
				"easy-pi execution contract:",
				`- Permission mode is ${readNativePermissions()?.mode ?? permissionMode}. Pi tools run with the permissions of the Pi process.`,
				"- Full Access allows credential reads and suppresses permission prompts, but retains best-effort catastrophic-deletion checks. This is not an OS sandbox.",
				"- Run the smallest task-relevant verification justified by the change risk; avoid meaningless checks for simple tasks. If verification is unavailable, state why and report the remaining risk honestly.",
			].join("\n");
			return { systemPrompt: `${event.systemPrompt}\n\n${contract}` };
		});

		async function requestPermission(ctx: ExtensionContext, event: ToolCallEvent, reason: string, grantKey?: string) {
			let release: () => void = () => undefined;
			const previous = permissionPromptQueue;
			permissionPromptQueue = new Promise<void>((done) => {
				release = done;
			});
			await previous;
			try {
				const scope = "Session scope: this exact displayed operation/contract in this working directory";
				const selected = await ctx.ui.select(
					sanitizeUiText(
						`${event.toolName} requires permission\n${reason}\nTarget: ${permissionTarget(event)}\n${scope}`,
						true,
					),
					["Allow once", "Allow for this session", "Deny"],
				);
				if (selected === "Allow for this session" && grantKey) sessionGrants.add(grantKey);
				return selected === "Allow once" || selected === "Allow for this session";
			} finally {
				release();
			}
		}

		if (options.nativeSession) {
			options.nativeSession.registerTools(pi);
		} else if (options.nativeRoot) {
			options.nativeRoot(pi, () => ({
				mode: permissionMode,
				sessionGrants: [...sessionGrants],
				protectedRoots: [],
			}));
		} else {
			const subagentRepositoryRootResolver = options.subagent?.resolveRepositoryRoot ?? resolveWorkspaceRoot;
			createSubagentExtension({
				agentDir: getAgentDir(),
				...(options.subagent ?? {}),
				runTask:
					options.subagent?.runTask ??
					((request) =>
						runChildTask({
							...request,
							invocation: resolveEasyPiInvocation(),
							controllerEnvironment: {
								...request.controllerEnvironment,
								EASY_PI_CODING_AGENT_DIR: options.subagent?.agentDir ?? getAgentDir(),
							},
						})),
				resolveRepositoryRoot: subagentRepositoryRootResolver,
				createChildHarnessContext: (request) =>
					createChildHarnessContext({
						...request,
						permissionMode,
						sessionGrants: [...sessionGrants],
						protectedRoots: [...new Set([...(childContext?.protectedRoots ?? []), ...request.protectedRoots])],
					}),
				authorizeOperatorRead: async () => true,
				authorizeOperator: async (request, ctx) => {
					const repositoryRoot = await subagentRepositoryRootResolver(ctx.cwd);
					if (repositoryRoot !== request.details.baseline.repositoryRoot) {
						const reason = `Subagent run belongs to a different repository: ${repositoryRoot}`;
						audit({ action: "permission", decision: "deny", tool: "subagent", reason });
						return false;
					}
					const input = { operation: request.operation, runId: request.runId, repositoryRoot };
					const outcome = decidePermission({
						mode: permissionMode,
						toolName: "subagent",
						input,
						cwd: repositoryRoot,
						sessionGrants,
						...(childContext
							? {
									protectedRoots: childContext.protectedRoots,
									inheritedWriteRoots: childContext.inheritedWriteRoots,
								}
							: {}),
					});
					if (outcome.decision === "deny") {
						audit({ action: "permission", decision: "deny", tool: "subagent", reason: outcome.reason });
						return false;
					}
					if (outcome.decision === "allow") return true;
					if (!ctx.hasUI || ctx.mode !== "tui") {
						const reason = `${outcome.reason}; non-interactive mode defaults to deny`;
						audit({ action: "permission", decision: "deny", tool: "subagent", reason });
						return false;
					}
					const event = {
						type: "tool_call",
						toolCallId: `subagent-operator-${request.operation}-${request.runId}`,
						toolName: "subagent",
						input,
					} as ToolCallEvent;
					const allowed = await requestPermission(ctx, event, outcome.reason, outcome.grantKey);
					audit({
						action: "permission",
						decision: allowed ? "allow" : "deny",
						tool: "subagent",
						reason: outcome.reason,
					});
					return allowed;
				},
			})(pi);
		}

		pi.on("tool_call", async (event, ctx) => {
			let nativePermissions: ChildSessionPermissions | undefined;
			try {
				nativePermissions = readNativePermissions();
			} catch {
				return { block: true, reason: "Native parent authority is unavailable" };
			}
			if (nativePermissions) permissionMode = nativePermissions.mode;
			const outcome = decidePermission({
				mode: permissionMode,
				toolName: event.toolName,
				input: inputRecord(event),
				cwd: ctx.cwd,
				sessionGrants: nativePermissions ? new Set(nativePermissions.sessionGrants) : sessionGrants,
				...(nativePermissions ? { protectedRoots: nativePermissions.protectedRoots } : {}),
				...(childContext
					? {
							protectedRoots: childContext.protectedRoots,
							inheritedWriteRoots: childContext.inheritedWriteRoots,
						}
					: {}),
			});

			if (outcome.decision === "deny") {
				audit({ action: "permission", decision: "deny", tool: event.toolName, reason: outcome.reason });
				return { block: true, reason: outcome.reason };
			}
			if (outcome.decision === "ask") {
				if (options.nativeSession) {
					const reason = `${outcome.reason}; explicit parent approval is required`;
					audit({ action: "permission", decision: "deny", tool: event.toolName, reason });
					return { block: true, reason };
				}
				if (childContext && ctx.mode !== "tui") {
					if (outcome.grantKey) sessionGrants.add(outcome.grantKey);
					audit({
						action: "permission",
						decision: "allow",
						tool: event.toolName,
						reason: `${outcome.reason}; headless Child allowed for this session`,
					});
				} else {
					if (!ctx.hasUI) {
						const reason = `${outcome.reason}; non-interactive mode defaults to deny`;
						audit({ action: "permission", decision: "deny", tool: event.toolName, reason });
						return { block: true, reason };
					}
					const allowed = await requestPermission(ctx, event, outcome.reason, outcome.grantKey);
					audit({
						action: "permission",
						decision: allowed ? "allow" : "deny",
						tool: event.toolName,
						reason: outcome.reason,
					});
					if (!allowed) return { block: true, reason: "Blocked by user" };
				}
			}
			if (mutationJournal && (event.toolName === "write" || event.toolName === "edit")) {
				const rawPath = inputRecord(event).path;
				if (typeof rawPath !== "string") {
					const reason = "External mutation path is missing after WJ permission approval";
					audit({ action: "permission", decision: "deny", tool: event.toolName, reason });
					return { block: true, reason };
				}
				try {
					mutationJournal.authorize(
						event.toolCallId,
						event.toolName,
						canonicalizeProspectivePath(rawPath, ctx.cwd),
					);
				} catch (error) {
					const reason = `Allowed external mutation was blocked because its journal could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
					audit({ action: "permission", decision: "deny", tool: event.toolName, reason });
					return { block: true, reason };
				}
				// Pi permits later extension handlers to mutate arguments without
				// re-validation. Freeze the exact target after permission and journal approval.
				Object.freeze(inputRecord(event));
			}

			return undefined;
		});

		pi.on("tool_result", async (event) => {
			if (!mutationJournal || (event.toolName !== "write" && event.toolName !== "edit")) return undefined;
			try {
				await mutationJournal.observe(event.toolCallId, event.isError ? "failed" : "succeeded");
				return undefined;
			} catch (error) {
				const reason = `External mutation post-state journal failed: ${error instanceof Error ? error.message : String(error)}`;
				audit({ action: "permission", decision: "deny", tool: event.toolName, reason });
				return {
					content: [{ type: "text" as const, text: reason }],
					isError: true,
				};
			}
		});
	};
}

export default createEasyPiHarness();
