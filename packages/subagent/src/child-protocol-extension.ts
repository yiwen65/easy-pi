import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_HARNESS_CONTEXT_ENV, validateChildHarnessContext } from "@easy-pi/permissions";
import {
	applySubagentPromptCacheKey,
	normalizeSubagentSystemPrompt,
	readSubagentPromptCacheKey,
} from "./cache-affinity.ts";
import {
	createHandoffEnvelope,
	createSubmitHandoffSchema,
	decodeHandoffSubmission,
	outcomeGuidanceForRole,
} from "./handoff.ts";
import {
	EXTERNAL_WRITER_ROLE,
	HANDOFF_PROTOCOL_VERSION,
	READ_ONLY_ROLES,
	SUBAGENT_TASK_ID_MAX_CHARS,
	SUBAGENT_TASK_ID_PATTERN,
	type SubagentRole,
	WRITER_ROLE,
} from "./types.ts";

interface ChildProtocolPolicy {
	handoff?: HandoffPolicy;
}

interface HandoffPolicy {
	protocolVersion: 2;
	path: string;
	taskId: string;
	role: SubagentRole;
}

const SUBAGENT_ROLES = [...READ_ONLY_ROLES, WRITER_ROLE, EXTERNAL_WRITER_ROLE] as const;

function reject(message: string): never {
	throw new Error(message);
}

function loadPolicy(): ChildProtocolPolicy {
	const contextPath = process.env[CHILD_HARNESS_CONTEXT_ENV];
	if (!contextPath || !isAbsolute(contextPath) || contextPath.includes("\0")) {
		reject(`${CHILD_HARNESS_CONTEXT_ENV} must name an absolute context file`);
	}
	const metadata = lstatSync(contextPath);
	if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
		reject("Child Harness context must be a private regular file");
	}
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(contextPath, "utf8"));
	} catch (error) {
		reject(`Child Harness context is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	validateChildHarnessContext(value);
	const record = value as Record<string, unknown>;
	if (record.handoff === undefined) return {};
	if (!record.handoff || typeof record.handoff !== "object" || Array.isArray(record.handoff)) {
		reject("Child Harness handoff configuration must be an object");
	}
	const handoff = record.handoff as Record<string, unknown>;
	if (handoff.protocolVersion !== HANDOFF_PROTOCOL_VERSION) reject("Handoff protocolVersion must be 2");
	if (
		typeof handoff.taskId !== "string" ||
		handoff.taskId.length < 1 ||
		handoff.taskId.length > SUBAGENT_TASK_ID_MAX_CHARS ||
		!new RegExp(SUBAGENT_TASK_ID_PATTERN).test(handoff.taskId)
	) {
		reject("Handoff taskId is invalid");
	}
	if (!SUBAGENT_ROLES.includes(handoff.role as SubagentRole)) reject("Handoff role is invalid");
	if (
		typeof handoff.path !== "string" ||
		!isAbsolute(handoff.path) ||
		handoff.path.includes("\0") ||
		resolve(handoff.path) !== handoff.path
	) {
		reject("Handoff path must be a normalized absolute path");
	}
	const parent = dirname(handoff.path);
	const parentMetadata = lstatSync(parent);
	if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || (parentMetadata.mode & 0o077) !== 0) {
		reject("Handoff parent must be a private real directory");
	}
	return {
		handoff: {
			protocolVersion: 2,
			path: join(realpathSync(parent), basename(handoff.path)),
			taskId: handoff.taskId,
			role: handoff.role as SubagentRole,
		},
	};
}

async function publishHandoff(path: string, value: unknown): Promise<void> {
	const parent = dirname(path);
	const metadata = await lstat(parent);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
		reject("Handoff parent must remain a private real directory");
	}
	if ((await realpath(parent)) !== parent) reject("Handoff parent path changed after context validation");
	const temporaryPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	const file = await open(temporaryPath, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await link(temporaryPath, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") reject("Handoff was already submitted");
		throw error;
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

async function submitHandoff(policy: HandoffPolicy, params: Record<string, unknown>): Promise<void> {
	const submission = decodeHandoffSubmission(params, policy.taskId, policy.role);
	await publishHandoff(policy.path, createHandoffEnvelope(submission));
}

/** Register child transport protocol only. Permission decisions remain owned by the enclosing WJ Harness. */
export function registerChildProtocol(pi: ExtensionAPI): void {
	const policy = loadPolicy();
	const promptCacheKey = readSubagentPromptCacheKey();
	pi.on("before_agent_start", (event, ctx) => ({
		systemPrompt: normalizeSubagentSystemPrompt(event.systemPrompt, ctx.cwd),
	}));
	if (promptCacheKey) {
		pi.on("before_provider_request", (event) => applySubagentPromptCacheKey(event.payload, promptCacheKey));
	}
	if (!policy.handoff) return;
	pi.registerTool({
		name: "submit_handoff",
		label: "Submit Handoff",
		description:
			"Submit the one final structured task result to the parent controller. This must be your final action.",
		promptSnippet: "Submit the final bounded task handoff",
		promptGuidelines: [
			"Call submit_handoff exactly once as the final action after completing the task.",
			"Report only summary, outcome, and optional evidence. Put checks, assumptions, risks, and next steps in summary.",
			"The Controller supplies task identity, protocol version, audited changed paths, and normalized internal fields.",
			`Outcome semantics for ${policy.handoff.role}: ${outcomeGuidanceForRole(policy.handoff.role)}`,
		],
		parameters: createSubmitHandoffSchema(),
		async execute(_toolCallId, params) {
			await submitHandoff(policy.handoff!, params as Record<string, unknown>);
			return {
				content: [{ type: "text", text: "Structured handoff submitted" }],
				details: { protocolVersion: 2, taskId: policy.handoff?.taskId },
				terminate: true,
			};
		},
	});
}
