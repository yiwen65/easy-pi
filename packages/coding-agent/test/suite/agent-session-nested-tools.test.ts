import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentToolCallOutcome,
	AgentToolError,
	type AgentToolResult,
	ResourceScheduler,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { TaskRecoveryState } from "../../src/core/task-recovery.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const parameters = Type.Object({ value: Type.Optional(Type.Number()) });
const output = (text: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text }], details: {} });
function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function target(
	name: string,
	execute: ToolDefinition<typeof parameters>["execute"],
	extras: Partial<ToolDefinition<typeof parameters>> = {},
): ToolDefinition<typeof parameters> {
	return { name, label: name, description: name, parameters, execute, ...extras };
}
function records(harness: Harness): TaskRecoveryState[] {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "pi-task-recovery" ? [entry.data as TaskRecoveryState] : [],
		);
}

describe("session nested tool pipeline and durable ownership", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});
	async function setup(
		run: (ctx: ExtensionToolContext) => Promise<AgentToolResult<unknown>>,
		definitions: ToolDefinition<typeof parameters>[] = [],
		options: {
			allow?: string[];
			exclude?: string[];
			extra?: ExtensionFactory;
			manager?: SessionManager;
			prepareLoadout?: ToolDefinition["prepareLoadout"];
		} = {},
	) {
		const harness = await createHarness({
			tools: [],
			initialActiveToolNames: [],
			allowedToolNames: options.allow,
			excludedToolNames: options.exclude,
			sessionManager: options.manager,
			hfCompaction: { mode: "off" },
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						target("parent", async (_id, _params, _signal, _update, ctx) => run(ctx), {
							exposure: "model-only",
							contract: { sideEffects: "external" },
							orchestratesTools: true,
							prepareLoadout: options.prepareLoadout,
						}),
					);
					for (const definition of definitions) pi.registerTool(definition);
				},
				...(options.extra ? [options.extra] : []),
			],
		});
		harnesses.push(harness);
		return harness;
	}
	function respond(harness: Harness, firstName = "parent", firstId = "root") {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(firstName, {}, { id: firstId })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
	}

	it("shares validation, mutable hooks, result hooks, host admission and a one-slot scheduler", async () => {
		const calls: number[] = [];
		const hooks: string[] = [];
		let outcome: AgentToolCallOutcome | undefined;
		const harness = await setup(
			async (ctx) => {
				outcome = await ctx.executeTool("effect", { value: 1 });
				return output(JSON.stringify(outcome.result.structuredContent));
			},
			[
				target(
					"effect",
					async (_id, params) => {
						calls.push(params.value ?? 0);
						return { ...output("display"), structuredContent: { value: params.value } };
					},
					{
						outputSchema: Type.Object({ value: Type.Number() }),
						executionResource: { key: "file" },
						contract: { sideEffects: "external" },
					},
				),
			],
			{
				extra: (pi) => {
					pi.on("tool_call", (event) => {
						if (event.parentToolCallId) {
							hooks.push(event.parentToolCallId);
							(event.input as Record<string, unknown>).value = 7;
						}
					});
					pi.on("tool_result", (event) => {
						if (event.parentToolCallId) return { structuredContent: { value: 8 } };
					});
				},
			},
		);
		harness.session.agent.executionScheduler = new ResourceScheduler(1);
		const admissions: string[] = [];
		harness.session.agent.admitToolCall = async (context) => {
			admissions.push(`${context.parentToolCallId ?? "model"}:${context.tool.name}`);
			return undefined;
		};
		respond(harness);
		await harness.session.prompt("run");
		expect(calls).toEqual([7]);
		expect(hooks).toEqual(["root"]);
		expect(admissions).toEqual(["model:parent", "root:effect"]);
		expect(outcome).toMatchObject({ executionOutcome: "confirmed", result: { structuredContent: { value: 8 } } });
		expect(
			harness.session.messages.filter((message) => message.role === "toolResult").map((message) => message.toolName),
		).toEqual(["parent"]);
		expect(
			records(harness).some((state) =>
				state.tools.some(
					(tool) => tool.parentToolCallId === "root" && tool.args && (tool.args as { value: number }).value === 7,
				),
			),
		).toBe(true);
		expect(
			harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "effect")?.parentToolCallId,
		).toBe("root");
	});

	it.each([false, true])(
		"preserves valid bindings across no-op authority gates and unrelated revocation (%s)",
		async (revokeUnrelated) => {
			let executions = 0;
			let outcome: AgentToolCallOutcome | undefined;
			const allow = ["parent", "effect", "unrelated"];
			const harness = await setup(
				async (ctx) => {
					outcome = await ctx.executeTool("effect", {});
					return output("ok");
				},
				[
					target("effect", async () => {
						executions++;
						return output("effect");
					}),
					target("unrelated", async () => output("unrelated")),
				],
				{ allow },
			);
			const dispatch = harness.session.agent.beforeToolDispatch;
			harness.session.agent.beforeToolDispatch = async (context) => {
				if (context.parentToolCallId)
					harness.session.setToolAccessByName(revokeUnrelated ? ["parent", "effect"] : allow);
				await dispatch?.(context);
			};
			respond(harness);
			await harness.session.prompt("run");
			expect(executions).toBe(1);
			expect(outcome).toMatchObject({ isError: false, executionOutcome: "confirmed" });
		},
	);

	it("rejects a genuine in-place registration replacement after preparation", async () => {
		let oldExecutions = 0;
		let newExecutions = 0;
		let outcome: AgentToolCallOutcome | undefined;
		const definition = target("effect", async () => {
			oldExecutions++;
			return output("old");
		});
		const harness = await setup(
			async (ctx) => {
				outcome = await ctx.executeTool("effect", {});
				return output("handled");
			},
			[definition],
			{
				extra: (pi) => {
					pi.on("tool_call", (event) => {
						if (event.parentToolCallId && event.toolName === "effect") {
							definition.execute = async () => {
								newExecutions++;
								return output("new");
							};
							pi.registerTool(definition);
						}
					});
				},
			},
		);
		respond(harness);
		await harness.session.prompt("run");
		expect(oldExecutions).toBe(0);
		expect(newExecutions).toBe(0);
		expect(outcome).toMatchObject({ isError: true, executionOutcome: "not_started" });
	});

	it("re-validates hook mutations and rejects invalid nested arguments before dispatch", async () => {
		let executions = 0;
		let outcome: AgentToolCallOutcome | undefined;
		const harness = await setup(
			async (ctx) => {
				outcome = await ctx.executeTool("effect", { value: 1 });
				return output("handled");
			},
			[
				target("effect", async () => {
					executions++;
					return output("ok");
				}),
			],
			{
				extra: (pi) => {
					pi.on("tool_call", (event) => {
						if (event.parentToolCallId) (event.input as Record<string, unknown>).value = "invalid";
					});
				},
			},
		);
		respond(harness);
		await harness.session.prompt("run");
		expect(executions).toBe(0);
		expect(outcome).toMatchObject({ isError: true, executionOutcome: "not_started" });
		expect(harness.session.taskRecovery?.status).toBe("completed");
	});

	it("exposes only granted direct/codemode/deferred tools and rejects model-only, hidden and self", async () => {
		const offered: string[] = [];
		const outcomes: AgentToolCallOutcome[] = [];
		let executions = 0;
		const harness = await setup(
			async (ctx) => {
				offered.push(...ctx.tools.map((tool) => tool.name));
				for (const name of ["direct", "script", "deferred", "hidden", "model", "parent", "excluded", "ungranted"])
					outcomes.push(await ctx.executeTool(name, {}));
				return output("done");
			},
			[
				target("direct", async () => {
					executions++;
					return output("ok");
				}),
				target(
					"script",
					async () => {
						executions++;
						return output("ok");
					},
					{ exposure: "codemode" },
				),
				target(
					"deferred",
					async () => {
						executions++;
						return output("ok");
					},
					{ exposure: "deferred" },
				),
				target(
					"hidden",
					async () => {
						executions++;
						return output("bad");
					},
					{ exposure: "hidden" },
				),
				target(
					"model",
					async () => {
						executions++;
						return output("bad");
					},
					{ exposure: "model-only" },
				),
				target("excluded", async () => {
					executions++;
					return output("bad");
				}),
				target("ungranted", async () => {
					executions++;
					return output("bad");
				}),
			],
			{ allow: ["parent", "direct", "script", "deferred", "hidden", "model", "excluded"], exclude: ["excluded"] },
		);
		respond(harness);
		await harness.session.prompt("run");
		expect(offered).toEqual(["direct", "script", "deferred"]);
		expect(executions).toBe(3);
		expect(outcomes.slice(3).every((outcome) => outcome.executionOutcome === "not_started" && outcome.isError)).toBe(
			true,
		);
		expect(harness.session.getActiveToolNames()).toEqual(["parent", "direct", "model"]);
		expect(harness.session.getDelegatableToolNames()).toContain("script");
	});

	it("does not let historical discovery metadata grant ordinary or codemode tools or reactivate explicit choices", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(
			fauxAssistantMessage(fauxToolCall("historical-search", {}, { id: "historical" }), { stopReason: "toolUse" }),
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "historical",
			toolName: "historical-search",
			content: [{ type: "text", text: "historical discovery" }],
			addedToolNames: ["ordinary-secret", "script-secret", "inactive-direct", "allowed-script"],
			isError: false,
			timestamp: Date.now(),
		});
		const offered: string[][] = [];
		const outcomes: AgentToolCallOutcome[] = [];
		let deniedExecutions = 0;
		const denied = async () => {
			deniedExecutions++;
			return output("must not execute");
		};
		const harness = await setup(
			async (ctx) => {
				offered.push(ctx.tools.map((tool) => tool.name));
				for (const name of ["ordinary-secret", "script-secret", "inactive-direct"])
					outcomes.push(await ctx.executeTool(name, {}));
				return output("done");
			},
			[
				target("ordinary-secret", denied),
				target("script-secret", denied, { exposure: "codemode" }),
				target("inactive-direct", denied),
				target("allowed-direct", async () => output("allowed")),
				target("allowed-script", async () => output("allowed"), { exposure: "codemode" }),
			],
			{ manager, allow: ["parent", "inactive-direct", "allowed-direct", "allowed-script"] },
		);
		harness.session.setActiveToolsByName(["parent", "allowed-direct"]);
		const declared: string[][] = [];
		harness.setResponses([
			(context) => {
				declared.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage(fauxToolCall("parent", {}, { id: "root" }), { stopReason: "toolUse" });
			},
			(context) => {
				declared.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Scoped capabilities, not historical discovery, are authoritative");
		expect(declared).toEqual([
			["parent", "allowed-direct"],
			["parent", "allowed-direct"],
		]);
		expect(offered).toEqual([["allowed-direct", "allowed-script"]]);
		expect(outcomes.every((outcome) => outcome.isError && outcome.executionOutcome === "not_started")).toBe(true);
		expect(outcomes).toHaveLength(3);
		expect(deniedExecutions).toBe(0);
	});

	it("rechecks live host authority after scheduler wait without leaking revoked metadata", async () => {
		let allowed = true;
		let executions = 0;
		let outcome: AgentToolCallOutcome | undefined;
		let visibleAfter = true;
		const harness = await setup(
			async (ctx) => {
				outcome = await ctx.executeTool("effect", {});
				visibleAfter = ctx.tools.some((tool) => tool.name === "effect");
				return output("handled");
			},
			[
				target(
					"effect",
					async () => {
						executions++;
						return output("ok");
					},
					{ executionResource: { key: "effect" } },
				),
			],
			{ allow: ["parent", "effect"] },
		);
		harness.session.setLiveToolAccessCheck((name) => name !== "effect" || allowed);
		const scheduler = new ResourceScheduler(1);
		harness.session.agent.executionScheduler = scheduler;
		const lease = await scheduler.acquire({ key: "effect" });
		respond(harness);
		const prompting = harness.session.prompt("run");
		await vi.waitFor(() => expect(scheduler.pendingCount).toBe(1));
		allowed = false;
		lease?.release();
		await prompting;
		expect(executions).toBe(0);
		expect(visibleAfter).toBe(false);
		expect(outcome).toMatchObject({ executionOutcome: "not_started", isError: true });
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("effect");
	});

	it("keeps only-mode hiding separate from activation, grants and explicit deactivation", async () => {
		let hidden = true;
		const offered: string[][] = [];
		const harness = await setup(
			async (ctx) => {
				offered.push(ctx.tools.map((tool) => tool.name));
				return output("ok");
			},
			[target("effect", async () => output("ok"))],
			{
				prepareLoadout: (loadout) => ({
					descriptions: { parent: `catalog:${loadout.callable.map((tool) => tool.name).join(",")}` },
					hiddenDeclarations: hidden ? ["effect"] : [],
				}),
			},
		);
		expect(harness.session.getActiveToolNames()).toEqual(["parent", "effect"]);
		expect(harness.session.agent.state.tools.map((tool) => tool.name)).toEqual(["parent"]);
		respond(harness);
		await harness.session.prompt("first");
		expect(offered[0]).toEqual(["effect"]);
		harness.session.setActiveToolsByName(["parent"]);
		hidden = false;
		harness.session.setActiveToolsByName(["parent"]);
		respond(harness);
		await harness.session.prompt("second");
		expect(offered[1]).toEqual([]);
		harness.session.setActiveToolsByName(["parent", "effect"]);
		expect(harness.session.agent.state.tools.find((tool) => tool.name === "parent")?.description).toContain("effect");
	});

	it("cannot hide unknown nested effects with a caught result or a result hook", async () => {
		let executions = 0;
		let originalId: string | undefined;
		const harness = await setup(
			async (ctx) => {
				await ctx.executeTool("effect", { value: 1 });
				return output("caught and claimed success");
			},
			[
				target(
					"effect",
					async () => {
						executions++;
						throw new Error("reply lost");
					},
					{ contract: { sideEffects: "external" } },
				),
			],
			{
				extra: (pi) => {
					pi.on("tool_result", (event) =>
						event.parentToolCallId
							? { isError: false, content: [{ type: "text", text: "fake success" }] }
							: undefined,
					);
				},
			},
		);
		const previous = harness.session.agent.beforeToolDispatch;
		harness.session.agent.beforeToolDispatch = async (context) => {
			if (!context.parentToolCallId && context.tool.name === "parent") originalId = harness.session.taskRecovery?.id;
			await previous?.(context);
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("parent", {}, { id: "root" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("effect", { value: 1 }, { id: "repeat" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("inspection required"),
		]);
		await harness.session.prompt("run");
		expect(executions).toBe(1);
		const paused = harness.session.taskRecovery?.suspendedTasks?.find((task) => task.state.id === originalId)?.state;
		expect(paused?.status).toBe("needs_reconciliation");
		expect(paused?.tools.find((tool) => tool.call.id === "root")).toMatchObject({ safe: false, dispatched: true });
		expect(paused?.tools.find((tool) => tool.call.id === "root")?.result).toBeUndefined();
		expect(paused?.tools.find((tool) => tool.call.name === "effect")).toMatchObject({
			parentToolCallId: "root",
			safe: false,
			dispatched: true,
		});
		expect(paused?.tools.find((tool) => tool.call.name === "effect")?.result).toBeUndefined();
		expect(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && message.toolName === "parent" && !message.isError,
			),
		).toBe(false);
	});

	it("does not let a confirmed outer Bash exit establish unresolved nested effects", async () => {
		let originalId: string | undefined;
		const harness = await setup(
			async () => output("unused"),
			[
				target(
					"effect",
					async () => {
						throw new Error("external reply lost");
					},
					{ contract: { sideEffects: "external" } },
				),
			],
			{
				extra: (pi) => {
					pi.registerTool({
						name: "bash",
						label: "bash",
						description: "composed bash",
						parameters: Type.Object({ command: Type.String() }),
						orchestratesTools: true,
						contract: { sideEffects: "process" },
						async execute(_id, params, _signal, _update, ctx) {
							await ctx.executeTool("effect", {});
							return {
								content: [{ type: "text", text: "outer process exited" }],
								details: {
									command: params.command,
									cwd: "/tmp",
									exitCode: 0,
									signal: null,
									terminationReason: "exit",
									terminationRequested: false,
									timedOut: false,
									durationMs: 1,
								},
							};
						},
					});
				},
			},
		);
		const dispatch = harness.session.agent.beforeToolDispatch;
		harness.session.agent.beforeToolDispatch = async (context) => {
			if (!context.parentToolCallId && context.tool.name === "bash") originalId = harness.session.taskRecovery?.id;
			await dispatch?.(context);
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "true" }, { id: "root" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("inspect external state"),
		]);
		await harness.session.prompt("run");
		const paused = harness.session.suspendedTaskRecovery.find((task) => task.state.id === originalId)?.state;
		expect(paused?.tools.find((tool) => tool.call.name === "bash")?.result).toBeUndefined();
		expect(paused?.status).toBe("needs_reconciliation");
		const diagnostic = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom" && entry.customType === "pi-tool-interruption");
		expect(
			diagnostic?.type === "custom" &&
				(diagnostic.data as { message?: { nestedExecutionOutcome?: string } }).message?.nestedExecutionOutcome,
		).toBe("unknown");
	});

	it("drains unawaited dispatched host calls before the parent and preserves uncertain cancellation", async () => {
		const started = gate();
		const finish = gate();
		let aborted = false;
		let done = false;
		const harness = await setup(
			async (ctx) => {
				void ctx.executeTool("effect", {});
				await started.promise;
				return output("early");
			},
			[
				target(
					"effect",
					async (_id, _params, signal) => {
						started.resolve();
						signal?.addEventListener("abort", () => {
							aborted = true;
						});
						await finish.promise;
						throw new AgentToolError("external effect unresolved", {});
					},
					{ contract: { sideEffects: "external" } },
				),
			],
		);
		respond(harness);
		const prompting = harness.session.prompt("run").then(() => {
			done = true;
		});
		await started.promise;
		await vi.waitFor(() => expect(aborted).toBe(true));
		expect(done).toBe(false);
		finish.resolve();
		await prompting;
		expect(
			harness.session.suspendedTaskRecovery.some((task) =>
				task.state.tools.some((tool) => tool.parentToolCallId === "root" && !tool.result),
			),
		).toBe(true);
	});

	it("does not cancel receipt-producing work merely because a standalone tool invocation returned", async () => {
		let passedSignal: AbortSignal | undefined;
		const harness = await setup(
			async () => output("unused"),
			[
				target("launch", async (_id, _args, signal) => {
					passedSignal = signal;
					return output("background receipt");
				}),
			],
		);
		const controller = new AbortController();
		const launch = harness.session.agent.state.tools.find((tool) => tool.name === "launch")!;
		await launch.execute("manual-launch", {}, controller.signal);
		expect(passedSignal).toBe(controller.signal);
		expect(passedSignal?.aborted).toBe(false);
	});

	it("does not collide nested IDs with model-issued slash IDs", async () => {
		const harness = await setup(
			async (ctx) => {
				const outcome = await ctx.executeTool("effect", {});
				return output(outcome.toolCall.id);
			},
			[target("effect", async () => output("nested")), target("sibling", async () => output("direct"))],
		);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("parent", {}, { id: "root" }), fauxToolCall("sibling", {}, { id: "root/1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run");
		expect(
			harness.eventsOfType("tool_execution_start").find((event) => event.toolName === "effect")?.toolCallId,
		).toBe("root/2");
		expect(
			records(harness).some(
				(state) =>
					state.tools.some((tool) => tool.call.id === "root/1" && tool.call.name === "sibling") &&
					state.tools.some((tool) => tool.call.id === "root/2" && tool.parentToolCallId === "root"),
			),
		).toBe(true);
	});

	it("keeps unknown nested effects blocked after reopening and never publishes orphan nested receipts", async () => {
		const directory = mkdtempSync(join(tmpdir(), "epi-nested-unknown-reopen-"));
		directories.push(directory);
		const manager = SessionManager.create(directory, directory);
		let executions = 0;
		const effect = target(
			"effect",
			async () => {
				executions++;
				throw new Error("reply lost");
			},
			{ contract: { sideEffects: "external" } },
		);
		const run = async (ctx: ExtensionToolContext) => {
			await ctx.executeTool("effect", { value: 1 });
			return output("handled");
		};
		const harness = await setup(run, [effect], { manager });
		respond(harness);
		await harness.session.prompt("run");
		await harness.session.shutdown();
		const pausedId = harness.session.suspendedTaskRecovery[0]?.state.id;
		const reopened = await setup(run, [effect], { manager: SessionManager.open(manager.getSessionFile()!) });
		await expect(reopened.session.resumeTask(pausedId)).rejects.toThrow(/Unknown tool effects/);
		respond(reopened);
		await reopened.session.prompt("new script attempting same effect");
		respond(reopened);
		await reopened.session.prompt("another prompt");
		expect(executions).toBe(1);
		expect(
			reopened.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => message.toolName),
		).not.toContain("effect");
		expect(
			reopened.session.suspendedTaskRecovery
				.find((task) => task.state.id === pausedId)
				?.state.tools.some((tool) => tool.parentToolCallId === "root" && !tool.result),
		).toBe(true);
	});

	it("keeps nested receipts out of recovery transcript publication after reopening", async () => {
		const directory = mkdtempSync(join(tmpdir(), "epi-nested-reopen-"));
		directories.push(directory);
		const manager = SessionManager.create(directory, directory);
		const harness = await setup(
			async (ctx) => {
				await ctx.executeTool("effect", {});
				return output("parent receipt");
			},
			[target("effect", async () => output("nested receipt"), { contract: { sideEffects: "external" } })],
			{ manager },
		);
		respond(harness);
		await harness.session.prompt("run");
		await harness.session.shutdown();
		const reopened = await setup(
			async () => output("should not replay"),
			[target("effect", async () => output("should not replay"))],
			{ manager: SessionManager.open(manager.getSessionFile()!) },
		);
		respond(reopened);
		await reopened.session.prompt("new prompt");
		expect(
			reopened.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => message.toolName),
		).not.toContain("effect");
		expect(reopened.session.messages.some((message) => getMessageText(message).includes("nested receipt"))).toBe(
			false,
		);
	});
});
