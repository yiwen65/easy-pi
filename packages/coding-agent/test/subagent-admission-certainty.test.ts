import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

test.each(["nested-capability", "nested-followup", "fresh-reviewer", "fresh-explorer"] as const)(
	"known %s admission rejection cannot create uncertain root effects",
	async (kind) => {
		const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-admission-certainty-")));
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ provider: "certainty-faux", tokensPerSecond: 0 });
		modelRuntime.registerNativeProvider(faux.provider);
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime,
			model: faux.getModel(),
			thinkingLevel: "off",
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			sessionManager: SessionManager.create(cwd, join(cwd, "root")),
		});
		await session.bindExtensions({ mode: "rpc" });
		const tool = (name: string) => session.agent.state.tools.find((candidate) => candidate.name === name)!;
		try {
			if (kind !== "nested-capability") {
				faux.setResponses([fauxAssistantMessage("original result")]);
				await tool("spawn_agent").execute("setup", {
					task_name: "worker",
					task: { objective: "initial task" },
					relationship: "continue",
					context: "isolated",
					tools: kind === "nested-followup" ? "inherit" : [],
				});
				await tool("wait_agent").execute("wait-setup", { target: "worker" });
			}
			const name = kind !== "nested-capability" ? "followup_task" : "spawn_agent";
			const args =
				kind === "nested-followup"
					? { target: "worker", task: { objective: "nested delegation" }, tools: ["spawn_agent"] }
					: kind !== "nested-capability"
						? {
								target: "worker",
								task: { objective: "independent review" },
								relationship: kind === "fresh-explorer" ? "explore" : "verify",
								tools: [],
							}
						: {
								task_name: "invalid",
								task: { objective: "nested delegation" },
								relationship: "verify",
								context: "isolated",
								tools: ["spawn_agent"],
							};
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
				fauxAssistantMessage("known rejection, continuing normally"),
			]);
			await session.prompt("Exercise the negative admission probe");
			expect(
				session.suspendedTaskRecovery.filter((task) => task.state.status === "needs_reconciliation"),
			).toHaveLength(0);
			expect(
				session.sessionManager
					.getBranch()
					.some((entry) => entry.type === "custom_message" && entry.customType === "task-interruption-recovery"),
			).toBe(false);
			const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === name);
			expect(result).toMatchObject({ role: "toolResult", isError: true });
			const list = await tool("list_agents").execute("readback", {});
			expect((list.details as { agents: unknown[] }).agents).toHaveLength(kind !== "nested-capability" ? 1 : 0);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await session.shutdown();
			await rm(cwd, { recursive: true, force: true });
		}
	},
);
