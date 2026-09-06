import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [scenario, expectedCwd, ...piArgs] = process.argv.slice(2);

function die(message) {
	process.stderr.write(message);
	process.exit(2);
}

function optionValue(name) {
	const index = piArgs.indexOf(name);
	return index === -1 ? undefined : piArgs[index + 1];
}

function verifyTaskPrompt(prompt, writer, external = false, reviewer = false) {
	const prefix = "Execute this controller-issued task contract:\n\n";
	if (typeof prompt !== "string" || !prompt.startsWith(prefix)) die("user prompt is missing the task contract");
	let contract;
	try {
		contract = JSON.parse(prompt.slice(prefix.length));
	} catch {
		die("user prompt task contract is not JSON");
	}
	for (const controllerField of [
		"role",
		"taskId",
		"controllerValidationCommandIds",
		"handoff",
		"parentObjective",
		"focusPaths",
		"focusPathGuidance",
		"nonGoals",
		"acceptanceCriteria",
	]) {
		if (Object.hasOwn(contract, controllerField)) die(`user prompt exposes Controller field: ${controllerField}`);
	}
	const required = external
		? ["Publish external file", process.env.WJ_EXPECTED_EXTERNAL_WRITE, "dependency-artifact"]
		: writer
			? ["Update the owned file", "owned/file.ts", "dependency-artifact"]
			: ["Inspect the example"];
	for (const value of required) {
		if (!prompt.includes(value)) die(`user prompt is missing dynamic task data: ${value}`);
	}
	if (prompt.includes(realpathSync(expectedCwd))) die("user prompt exposes the physical snapshot cwd");
	if (process.env.WJ_FORBIDDEN_PROMPT_PATH && prompt.includes(realpathSync(process.env.WJ_FORBIDDEN_PROMPT_PATH))) {
		die("user prompt exposes the live workspace path");
	}
	if (scenario === "retry-feedback" && !prompt.includes("Repair invalid_handoff: missing outcome")) {
		die("user prompt is missing retry feedback");
	}
	if (process.env.WJ_EXPECT_DEPENDENCY_VIEW) {
		for (const value of [process.env.WJ_EXPECT_DEPENDENCY_VIEW, '"version": 2', '"status": "passed"']) {
			if (!prompt.includes(value)) die(`user prompt is missing dependency provenance: ${value}`);
		}
	}
}

function verifyInvocation() {
	const writer = scenario.startsWith("writer-") || scenario.startsWith("rpc-writer-");
	const external = scenario.startsWith("external-writer-");
	const reviewer = scenario.startsWith("reviewer-");
	const rpc = optionValue("--mode") === "rpc";
	const requiredFlags = ["--mode"];
	if (!rpc) requiredFlags.push("--json-profile", "--no-session");
	for (const flag of requiredFlags) {
		if (!piArgs.includes(flag)) die(`missing controller-owned flag ${flag}`);
	}
	if (!rpc && optionValue("--mode") !== "json") die("JSON mode not selected");
	if (
		rpc &&
		((!optionValue("--session-dir") && !optionValue("--session")) || piArgs.includes("--no-session") || piArgs.includes("--print"))
	) {
		die("RPC session isolation flags are invalid");
	}
	if (rpc && piArgs.includes("--json-profile")) die("JSON profile is invalid in RPC mode");
	if (!rpc && optionValue("--json-profile") !== "compact") die("compact JSON profile not selected");
	for (const flag of [
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-approve",
		"--tools",
		"--append-system-prompt",
	]) {
		if (piArgs.includes(flag)) die(`child runtime must inherit parent resources; unexpected flag ${flag}`);
	}
	if (piArgs.includes("--extension")) die("easy-pi must use its built-in execution extension, not an external harness");
	if (rpc && !process.env.EASY_PI_CODING_AGENT_SESSION_DIR) die("easy-pi private session directory missing");
	const policyPath = process.env.WJ_CHILD_CONTEXT_FILE;
	if (!policyPath) die("WJ Child Harness context environment missing");
	if ((statSync(policyPath).mode & 0o777) !== 0o600) die("WJ Child Harness context file is not mode 0600");
	const policy = JSON.parse(readFileSync(policyPath, "utf8"));
	const canonicalCwd = realpathSync(expectedCwd);
	if (policy.schemaVersion !== 2) die("inherited WJ context schema is not version 2");
	for (const legacyField of ["role", "readablePaths", "writablePaths", "externalWritablePaths"]) {
		if (legacyField in policy) die(`inherited WJ context contains legacy permission field: ${legacyField}`);
	}
	if (policy.cwd !== canonicalCwd) die("Child Harness context cwd is not canonical cwd");
	const expectedProtectedRoot = realpathSync(process.env.WJ_EXPECTED_PROTECTED_ROOT);
	if (!Array.isArray(policy.protectedRoots) || !policy.protectedRoots.includes(expectedProtectedRoot)) {
		die("inherited WJ context is missing the source protected root");
	}
	if (!Array.isArray(policy.sessionGrants) || policy.sessionGrants.length !== 0) {
		die("unexpected inherited WJ session grants");
	}
	const expectedInheritedWriteRoots = process.env.WJ_EXPECTED_EXTERNAL_WRITE
		? [realpathSync(process.env.WJ_EXPECTED_EXTERNAL_WRITE)]
		: [];
	if (JSON.stringify(policy.inheritedWriteRoots) !== JSON.stringify(expectedInheritedWriteRoots)) {
		die("unexpected inherited WJ write roots");
	}
	if (external) {
		if (
			policy.mutationJournal?.version !== 1 ||
			policy.mutationJournal?.runId !== "process-runner-test" ||
			policy.mutationJournal?.taskId !== "external-1" ||
			policy.mutationJournal?.attemptId !== "process-runner-attempt" ||
			policy.mutationJournal?.attemptNumber !== 1 ||
			(statSync(policy.mutationJournal.path).mode & 0o777) !== 0o600
		) {
			die("external mutation journal policy missing");
		}
	} else if (policy.mutationJournal !== undefined) {
		die("non-external task received a mutation journal");
	}
	const expectedPermissionMode = scenario === "permission-mode" ? "full-access" : "auto";
	if (policy.permissionMode !== expectedPermissionMode) die("parent permission mode was not propagated");
	const expectedTaskId = external ? "external-1" : writer ? "writer-1" : "task-1";
	if (policy.handoff?.protocolVersion !== 2 || policy.handoff?.taskId !== expectedTaskId) {
		die("v2 handoff policy missing");
	}
	if (!policy.handoff?.path || !policy.handoff.path.endsWith("handoff-v2.json")) die("v2 handoff path missing");
	if (scenario === "model-selection") {
		if (optionValue("--provider") !== "openai-codex") die("explicit child provider missing");
		if (optionValue("--model") !== "gpt-5.4-mini") die("explicit child model missing");
		if (optionValue("--thinking") !== "low") die("explicit child thinking level missing");
	}
	if (realpathSync(process.cwd()) !== realpathSync(expectedCwd)) die(`unexpected cwd: ${process.cwd()}`);
	if (scenario === "runtime-parity") {
		if (process.env.WJ_PARENT_RUNTIME_SENTINEL !== "inherited") {
			die("parent session environment was not inherited");
		}
		if (!/^wj-subagent-v1-[a-f0-9]{40}$/.test(process.env.WJ_SUBAGENT_PROMPT_CACHE_KEY ?? "")) {
			die("controller-derived Subagent prompt cache key missing");
		}
	}
	if (!rpc) verifyTaskPrompt(piArgs.at(-1), writer, external, reviewer);
}

function usage(input, output, totalTokens, totalCost) {
	return {
		input,
		output,
		cacheRead: 1,
		cacheWrite: 2,
		totalTokens,
		cost: {
			input: totalCost / 5,
			output: totalCost / 5,
			cacheRead: totalCost / 5,
			cacheWrite: (totalCost * 2) / 5,
			total: totalCost,
		},
	};
}

function emit(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function handoffPayload(writer = false, external = false, reviewer = false) {
	const externalPath = process.env.WJ_EXPECTED_EXTERNAL_WRITE
		? join(realpathSync(process.env.WJ_EXPECTED_EXTERNAL_WRITE), "published.txt")
		: undefined;
	return {
		taskId: external ? "external-1" : writer ? "writer-1" : "task-1",
		role: external ? "external-writer" : writer ? "writer" : reviewer ? "reviewer" : "scout",
		summary: external
			? "Published the external file; static inspection passed"
			: writer
				? "Updated the owned file; static inspection passed"
				: "Inspected the requested snapshot; static inspection passed",
		outcome: "accepted",
		evidence: [
			{
				path: external ? externalPath : writer ? "owned/file.ts" : "src/example.ts",
				lineRange: "1-4",
				claim: "Example evidence",
			},
		],
		verification: [],
		assumptions: [],
		risks: [],
		nextActions: [],
		...(writer ? { artifactVersion: 2, changedPaths: [] } : {}),
		...(external ? { artifactVersion: 2, externalChangedPaths: [] } : {}),
	};
}

function handoff(writer = false, external = false, reviewer = false) {
	return JSON.stringify(handoffPayload(writer, external, reviewer));
}

function publishPayload(payload) {
	const policy = JSON.parse(readFileSync(process.env.WJ_CHILD_CONTEXT_FILE, "utf8"));
	writeFileSync(policy.handoff.path, `${JSON.stringify({ protocolVersion: 2, payload })}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
}

function publishHandoff(writer = false, external = false, reviewer = false) {
	publishPayload(handoffPayload(writer, external, reviewer));
}

function publishExternalMutation() {
	const policy = JSON.parse(readFileSync(process.env.WJ_CHILD_CONTEXT_FILE, "utf8"));
	const journal = policy.mutationJournal;
	if (!journal) die("external mutation journal missing");
	const path = join(realpathSync(process.env.WJ_EXPECTED_EXTERNAL_WRITE), "published.txt");
	const authorizedAt = Date.now();
	appendFileSync(
		journal.path,
		`${JSON.stringify({
			journalVersion: 1,
			journalSequence: 1,
			type: "authorized",
			mutation: {
				mutationId: `${journal.attemptId}:1`,
				runId: journal.runId,
				taskId: journal.taskId,
				attemptId: journal.attemptId,
				attemptNumber: journal.attemptNumber,
				authorizationSequence: 1,
				toolCallId: "external-write-1",
				operation: "write",
				path,
				authorizationStatus: "authorized",
				authorizedAt,
			},
		})}\n`,
	);
	writeFileSync(path, "published\n");
	const metadata = statSync(path);
	appendFileSync(
		journal.path,
		`${JSON.stringify({
			journalVersion: 1,
			journalSequence: 2,
			type: "observed",
			mutationId: `${journal.attemptId}:1`,
			toolResult: "succeeded",
			observedAt: Date.now(),
			postState: {
				status: "confirmed",
				fileType: "regular",
				size: metadata.size,
				mode: metadata.mode & 0o7777,
				modifiedAtMs: metadata.mtimeMs,
				sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
			},
		})}\n`,
	);
	emit({ type: "tool_execution_start", toolCallId: "external-write-1", toolName: "write", argsHash: "f".repeat(64) });
	emit({ type: "tool_execution_end", toolCallId: "external-write-1", toolName: "write", isError: false });
}

function assistant(text, messageUsage, stopReason = "stop", errorMessage) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "fake/model",
			usage: messageUsage,
			stopReason,
			...(errorMessage ? { errorMessage } : {}),
			timestamp: Date.now(),
		},
	};
}

verifyInvocation();

function startRpcFixture() {
	const writer = scenario.startsWith("rpc-writer-");
	let softBudgetSteers = 0;
	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			const command = JSON.parse(line);
			if (command.type === "get_state") {
				emit({
					id: command.id,
					type: "response",
					command: "get_state",
					success: true,
					data: {
						model: { provider: "fake", id: "fake/model" },
						thinkingLevel: "medium",
						isStreaming: false,
						isCompacting: false,
						steeringMode: "all",
						followUpMode: "one-at-a-time",
						sessionFile: optionValue("--session") ?? `${optionValue("--session-dir")}/fake-session.jsonl`,
						sessionId: "fake-rpc-session",
						autoCompactionEnabled: true,
						messageCount: 1,
						pendingMessageCount: 0,
					},
				});
			} else if (command.type === "prompt") {
				verifyTaskPrompt(command.message, writer);
				if (scenario === "rpc-crash") {
					process.stderr.write("simulated child uncaught exception\n");
					process.exit(7);
				}
				emit({ id: command.id, type: "response", command: "prompt", success: true });
				if (scenario === "rpc-hang") {
					emit({ type: "message_update", usage: usage(1, 1, 2, 0.02) });
				} else if (scenario === "rpc-extension-dialog") {
					emit({
						type: "extension_ui_request",
						id: "permission-dialog",
						method: "select",
						title: "Permission required",
						options: ["Allow", "Deny"],
					});
				} else if (scenario.startsWith("rpc-budget-")) {
					if (scenario === "rpc-budget-partial") publishHandoff(writer);
					if (scenario === "rpc-budget-invalid-partial") {
						const invalid = handoffPayload(writer);
						delete invalid.outcome;
						publishPayload(invalid);
					}
					if (scenario === "rpc-budget-partial") {
						emit(assistant("handoff submitted", usage(8, 3, 11, 0.11)));
					} else {
						emit({ type: "message_update", usage: usage(8, 3, 11, 0.11) });
					}
				} else if (scenario === "rpc-soft-budget") {
					emit({ type: "message_update", usage: usage(6, 3, 9, 0.09) });
				} else if (scenario === "rpc-unlimited-retry-zero-progress") {
					for (let attempt = 1; attempt <= 8; attempt++) {
						emit({
							type: "auto_retry_start",
							attempt,
							delayMs: attempt * 500,
							unlimited: true,
							errorMessage: "provider-secret-sentinel",
						});
					}
				} else if (scenario === "rpc-unlimited-retry-with-usage") {
					emit({ type: "message_update", usage: usage(1, 2, 3, 0.03) });
					emit({
						type: "auto_retry_start",
						attempt: 1,
						delayMs: 3_000,
						unlimited: true,
						errorMessage: "provider-secret-sentinel",
					});
				} else if (scenario === "rpc-unlimited-retry-reset") {
					for (let attempt = 1; attempt <= 7; attempt++) {
						emit({ type: "auto_retry_start", attempt, delayMs: 1, unlimited: true });
					}
					emit({ type: "auto_retry_end", success: true, attempt: 7 });
					emit({ type: "auto_retry_start", attempt: 1, delayMs: 1, unlimited: true });
					emit({ type: "auto_retry_end", success: true, attempt: 1 });
					emit({ type: "message_update", usage: usage(2, 1, 3, 0.03) });
					publishHandoff(writer);
					emit(assistant("diagnostic only", usage(2, 1, 3, 0.03)));
					emit({ type: "agent_settled" });
				} else if (scenario === "rpc-bounded-retry") {
					emit({
						type: "auto_retry_start",
						attempt: 1,
						delayMs: 25,
						unlimited: false,
						errorMessage: "provider-secret-sentinel",
					});
					emit({ type: "auto_retry_end", success: true, attempt: 1 });
					emit({ type: "message_update", usage: usage(2, 1, 3, 0.03) });
					publishHandoff(writer);
					emit({
						type: "tool_execution_start",
						toolCallId: "handoff-1",
						toolName: "submit_handoff",
						argsHash: "e".repeat(64),
					});
					emit({
						type: "tool_execution_end",
						toolCallId: "handoff-1",
						toolName: "submit_handoff",
						isError: false,
					});
					emit(assistant("diagnostic only", usage(2, 1, 3, 0.03)));
					emit({ type: "agent_settled" });
				} else {
					emit({ type: "message_update", usage: usage(2, 1, 3, 0.03) });
					if (scenario === "rpc-model-error") {
						emit(assistant("", usage(2, 1, 3, 0.03), "error", `provider overloaded\u0007 ${"x".repeat(3_000)}`));
					} else if (scenario !== "rpc-missing-handoff") {
						publishHandoff(writer);
						emit({
							type: "tool_execution_start",
							toolCallId: "handoff-1",
							toolName: "submit_handoff",
							argsHash: "e".repeat(64),
						});
						emit({
							type: "tool_execution_end",
							toolCallId: "handoff-1",
							toolName: "submit_handoff",
							isError: false,
						});
					}
					if (scenario !== "rpc-model-error") emit(assistant("diagnostic only", usage(2, 1, 3, 0.03)));
					emit({ type: "agent_settled" });
				}
			} else if (command.type === "extension_ui_response") {
				if (
					scenario !== "rpc-extension-dialog" ||
					command.id !== "permission-dialog" ||
					command.cancelled !== true
				) {
					die("unexpected extension UI response");
				}
				publishHandoff(writer);
				emit({
					type: "tool_execution_start",
					toolCallId: "handoff-1",
					toolName: "submit_handoff",
					argsHash: "e".repeat(64),
				});
				emit({
					type: "tool_execution_end",
					toolCallId: "handoff-1",
					toolName: "submit_handoff",
					isError: false,
				});
				emit(assistant("dialog cancelled; handoff submitted", usage(2, 1, 3, 0.03)));
				emit({ type: "agent_settled" });
			} else if (command.type === "steer") {
				if (scenario !== "rpc-soft-budget") die("unexpected RPC steering command");
				softBudgetSteers++;
				if (softBudgetSteers > 1) die("soft budget steering repeated");
				if (!command.message.includes("Stop expanding scope") || !command.message.includes("inconclusive")) {
					die("soft budget steering message is missing wrap-up guidance");
				}
				emit({ id: command.id, type: "response", command: "steer", success: true });
				// A second threshold-level update proves the Controller does not repeat
				// the steer while this attempt remains active.
				emit({ type: "message_update", usage: usage(6, 3, 9, 0.09) });
				setTimeout(() => {
					publishHandoff(writer);
					emit({
						type: "tool_execution_start",
						toolCallId: "handoff-1",
						toolName: "submit_handoff",
						argsHash: "e".repeat(64),
					});
					emit({
						type: "tool_execution_end",
						toolCallId: "handoff-1",
						toolName: "submit_handoff",
						isError: false,
					});
					emit(assistant("diagnostic only", usage(6, 3, 9, 0.09)));
					emit({ type: "agent_settled" });
				}, 20);
			} else if (command.type === "abort") {
				emit({ id: command.id, type: "response", command: "abort", success: true });
				if (scenario !== "rpc-idle-abort-no-settle") emit({ type: "agent_settled" });
			}
			newline = buffer.indexOf("\n");
		}
	});
}

if (scenario.startsWith("rpc-")) startRpcFixture();
else switch (scenario) {
	case "success":
	case "retry-feedback":
	case "full-json-success":
	case "model-selection":
	case "permission-mode":
	case "runtime-parity":
	case "external-writer-success":
	case "reviewer-success":
	case "nonzero": {
		emit({ type: "session", version: 3, id: "fake", timestamp: new Date().toISOString(), cwd: process.cwd() });
		const fullJson = scenario === "full-json-success";
		emit({
			type: "message_update",
			usage: usage(1, 2, 3, 0.03),
			...(fullJson ? { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" } } : {}),
		});
		emit(assistant("", usage(1, 2, 3, 0.03), "toolUse"));
		emit({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			...(fullJson ? { args: { path: "src/example.ts" } } : { argsHash: "a".repeat(64) }),
		});
		if (fullJson) {
			emit({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "read",
				args: { path: "src/example.ts" },
				partialResult: { content: [] },
			});
		}
		emit({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			...(fullJson ? { result: { content: [{ type: "text", text: "example" }] } } : {}),
			isError: false,
		});
		if (fullJson) {
			emit({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [],
					isError: false,
					timestamp: Date.now(),
				},
			});
		}
		emit({
			type: "message_update",
			usage: usage(4, 5, 9, 0.09),
			...(fullJson ? { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "{" } } : {}),
		});
		if (scenario === "external-writer-success") publishExternalMutation();
		publishHandoff(false, scenario === "external-writer-success", scenario === "reviewer-success");
		emit(
			assistant(
				handoff(false, scenario === "external-writer-success", scenario === "reviewer-success"),
				usage(4, 5, 9, 0.09),
			),
		);
		if (scenario === "nonzero") process.exitCode = 7;
		break;
	}
	case "loop": {
		emit({ type: "session", version: 3, id: "fake", timestamp: new Date().toISOString(), cwd: process.cwd() });
		for (let i = 1; i <= 3; i++) {
			emit(assistant("", usage(1, 1, 2, 0.01), "toolUse"));
			emit({
				type: "tool_execution_start",
				toolCallId: `call-${i}`,
				toolName: "read",
				argsHash: "b".repeat(64),
			});
			emit({
				type: "tool_execution_end",
				toolCallId: `call-${i}`,
				toolName: "read",
				isError: false,
			});
		}
		publishHandoff();
		emit(assistant(handoff(), usage(1, 1, 2, 0.01)));
		break;
	}
	case "malformed-json":
		process.stdout.write("not-json\n");
		break;
	case "invalid-handoff":
		emit(assistant("I finished the task", usage(1, 1, 2, 0.01)));
		break;
	case "external-writer-invalid-handoff":
		publishExternalMutation();
		emit(assistant("External write completed but handoff is missing", usage(1, 1, 2, 0.01)));
		break;
	case "tolerant-handoff":
		publishPayload({
			taskId: "task-1",
			role: "scout",
			summary: "Inspected the requested snapshot",
			outcome: "accepted",
			evidence: [],
			verification: { check: "static inspection", status: "ok" },
			assumptions: [],
			risks: [],
			nextActions: [],
		});
		emit(assistant("diagnostic only", usage(1, 1, 2, 0.01)));
		break;
	case "oversized-optional-handoff":
		publishPayload({
			...handoffPayload(),
			evidence: Array.from({ length: 13 }, (_, index) => ({
				path: `src/file-${index}.ts`,
				claim: `Evidence ${index}`,
			})),
		});
		emit(assistant("diagnostic only", usage(1, 1, 2, 0.01)));
		break;
	case "model-error":
		emit(assistant("", usage(1, 1, 2, 0.01), "error", "provider failed"));
		break;
	case "budget-partial":
		publishHandoff();
		emit({ type: "message_update", usage: usage(8, 3, 11, 0.11) });
		break;
	case "budget-missing-partial":
		emit({ type: "message_update", usage: usage(8, 3, 11, 0.11) });
		break;
	case "budget-invalid-partial": {
		const invalid = handoffPayload();
		delete invalid.outcome;
		publishPayload(invalid);
		emit({ type: "message_update", usage: usage(8, 3, 11, 0.11) });
		break;
	}
	case "streaming-budget":
		emit({ type: "message_update", usage: usage(20, 20, 40, 0.4), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "still running" } });
		setInterval(() => {}, 1000);
		break;
	case "invalid-args-hash":
		emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", argsHash: "not-a-sha256" });
		break;
	case "forbidden-tool":
		emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", argsHash: "d".repeat(64) });
		emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", isError: true });
		publishHandoff();
		emit(assistant(handoff(), usage(1, 1, 2, 0.01)));
		break;
	case "read-only-edit":
		emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "edit", args: {} });
		emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", isError: true });
		publishHandoff();
		emit(assistant(handoff(), usage(1, 1, 2, 0.01)));
		break;
	case "writer-forbidden-tool":
		emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } });
		emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", isError: true });
		publishHandoff(true);
		emit(assistant(handoff(true), usage(1, 1, 2, 0.01)));
		break;
	case "writer-success":
		emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "edit", argsHash: "c".repeat(64) });
		emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "edit", isError: false });
		publishHandoff(true);
		emit(assistant(handoff(true), usage(2, 3, 5, 0.05)));
		break;
	case "long-valid-stream":
		for (let index = 0; index < 80; index++) emit({ type: "progress", index, payload: "x".repeat(1024) });
		publishHandoff();
		emit(assistant(handoff(), usage(4, 5, 9, 0.09)));
		break;
	case "active-before-success": {
		let step = 0;
		const heartbeat = setInterval(() => emit({ type: "progress", step: ++step }), 50);
		setTimeout(() => {
			clearInterval(heartbeat);
			publishHandoff();
			emit(assistant(handoff(), usage(4, 5, 9, 0.09)));
		}, 450);
		break;
	}
	case "oversized-event":
		emit({ type: "progress", payload: "x".repeat(300_000) });
		publishHandoff();
		emit(assistant(handoff(), usage(4, 5, 9, 0.09)));
		break;
	case "large-output":
		process.stdout.write("x".repeat(4096));
		break;
	case "large-stderr":
		process.stderr.write("x".repeat(4096));
		setInterval(() => {}, 1000);
		break;
	case "hang":
		setInterval(() => {}, 1000);
		break;
	case "descendant-hang":
		spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
		setInterval(() => {}, 1000);
		break;
	default:
		die(`unknown fake scenario: ${scenario}`);
}
