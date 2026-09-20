import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceScheduler, type ToolContract } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerService } from "../../src/core/computer/service.ts";
import { createComputerTool } from "../../src/core/computer/tool.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { FakeComputerBackend } from "./fake-backend.ts";

describe("Computer through the real SDK and Agent loop", () => {
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});

	function fixture() {
		const backend = new FakeComputerBackend();
		const factory = vi.fn(() => backend);
		const service = new ComputerService({ desktopId: "integration-fixture", backendFactory: factory });
		cleanups.push(() => service.close());
		return { backend, factory, tool: createComputerTool(service) };
	}

	async function createSession(
		options: {
			tool?: ReturnType<typeof createComputerTool>;
			registration?: "custom" | "extension";
			noTools?: "all";
		} = {},
	) {
		const cwd = mkdtempSync(join(tmpdir(), "pi-computer-integration-"));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const faux = fauxProvider();
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });
		const extensionsResult = await createTestExtensionsResult(
			options.registration === "extension" && options.tool ? [(pi) => pi.registerTool(options.tool!)] : [],
			cwd,
		);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model: faux.getModel(),
			modelRuntime,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			customTools: options.registration !== "extension" && options.tool ? [options.tool] : [],
			noTools: options.noTools,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		});
		cleanups.push(async () => {
			await session.abort();
			session.dispose();
		});
		await session.bindExtensions({});
		return { session, faux };
	}

	it.each(["custom", "extension"] as const)(
		"runs observe -> execute -> result via %s registration",
		async (registration) => {
			const { backend, factory, tool } = fixture();
			const { session, faux } = await createSession({ tool, registration });
			const admitted: ToolContract[] = [];
			session.agent.executionScheduler = new ResourceScheduler(2);
			session.agent.admitToolCall = ({ tool: planned }) => {
				expect(Object.isFrozen(planned.contract)).toBe(true);
				expect(planned.executionResource).toEqual({ key: "desktop:integration-fixture", mode: "exclusive" });
				if (planned.contract) admitted.push(planned.contract);
				return { allow: planned.contract?.sideEffects === "external" };
			};
			faux.setResponses([
				(context) => {
					expect(context.tools?.filter((candidate) => candidate.name === "computer")).toHaveLength(1);
					expect(factory).not.toHaveBeenCalled();
					return fauxAssistantMessage(fauxToolCall("computer", { request: { op: "observe" } }), {
						stopReason: "toolUse",
					});
				},
				(context) => {
					const observation = context.messages.find((message) => message.role === "toolResult");
					const text =
						observation?.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n") ?? "";
					const ref = /Observation ref: (\S+)/.exec(text)?.[1];
					if (!ref) throw new Error("Expected a model-visible observation ref");
					return fauxAssistantMessage(
						fauxToolCall("computer", {
							request: {
								op: "execute",
								ref,
								steps: [
									{ op: "fill", target: "field-1", text: "Ada" },
									{ op: "assert_value", target: "field-1", value: "Ada" },
								],
							},
						}),
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage("Fixture verified."),
			]);
			await session.prompt("Fill the fixture and verify its value.");
			expect(faux.state.callCount).toBe(3);
			expect(factory).toHaveBeenCalledTimes(1);
			expect(backend.observeCalls).toBe(1);
			expect(backend.executeCalls).toBe(1);
			expect(backend.values.get("field-1")).toBe("Ada");
			expect(admitted).toHaveLength(2);
			const results = session.messages.filter((message) => message.role === "toolResult");
			expect(results.map((result) => result.isError)).toEqual([false, false]);
			expect(results[1].details).toEqual({ status: "completed", completedSteps: 2 });
			expect(session.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
				"toolResult",
				"assistant",
			]);
		},
	);

	it.each(["ordinary", "noTools"] as const)(
		"keeps %s coding free of Computer schema and initialization",
		async (mode) => {
			const { factory, tool } = fixture();
			const { session, faux } = await createSession(mode === "ordinary" ? {} : { tool, noTools: "all" });
			faux.setResponses([
				(context) => {
					expect(context.tools?.some((candidate) => candidate.name === "computer")).not.toBe(true);
					return fauxAssistantMessage("Ordinary coding reply.");
				},
			]);
			await session.prompt("No computer work requested.");
			expect(session.getActiveToolNames()).not.toContain("computer");
			if (mode === "ordinary")
				expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
			expect(factory).not.toHaveBeenCalled();
			expect(faux.state.callCount).toBe(1);
		},
	);

	it("uses the request snapshot's contract for a real host denial, not mutated registry metadata", async () => {
		const { factory, tool } = fixture();
		const contract = { ...tool.contract };
		tool.contract = contract;
		const { session, faux } = await createSession({ tool, registration: "extension" });
		const seen: ToolContract[] = [];
		session.agent.admitToolCall = ({ tool: planned }) => {
			if (planned.contract) seen.push(planned.contract);
			return {
				allow: planned.contract?.sideEffects !== "external",
				reason: "External effects refused by test host",
			};
		};
		faux.setResponses([
			() => {
				contract.sideEffects = "none";
				return fauxAssistantMessage(fauxToolCall("computer", { request: { op: "observe" } }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("Host denied the call."),
		]);
		await session.prompt("Attempt observation.");
		expect(seen).toHaveLength(1);
		expect(seen[0].sideEffects).toBe("external");
		expect(Object.isFrozen(seen[0])).toBe(true);
		expect(factory).not.toHaveBeenCalled();
		const result = session.messages.find((message) => message.role === "toolResult");
		expect(result?.isError).toBe(true);
		expect(result?.content).toEqual([{ type: "text", text: "External effects refused by test host" }]);
	});

	it("holds execution behind the snapshot's exclusive resource until the existing scheduler releases it", async () => {
		const { backend, factory, tool } = fixture();
		const resource = { key: "desktop:integration-fixture", mode: "exclusive" as const };
		tool.executionResource = resource;
		const { session, faux } = await createSession({ tool });
		const scheduler = new ResourceScheduler(2);
		session.agent.executionScheduler = scheduler;
		const held = await scheduler.acquire({ ...resource });
		let queued!: () => void;
		const waiting = new Promise<void>((resolve) => {
			queued = resolve;
		});
		session.agent.onExecutionEvent = (event) => {
			if (event.phase === "scheduler_wait" && event.outcome === "started") queued();
		};
		faux.setResponses([
			() => {
				resource.key = "desktop:changed-after-snapshot";
				return fauxAssistantMessage(fauxToolCall("computer", { request: { op: "observe" } }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("Observation completed."),
		]);
		const prompt = session.prompt("Observe when the desktop lease is available.");
		try {
			await waiting;
			expect(scheduler.pendingCount).toBe(1);
			expect(factory).not.toHaveBeenCalled();
			expect(backend.observeCalls).toBe(0);
		} finally {
			held?.release();
			await prompt;
		}
		expect(backend.observeCalls).toBe(1);
		expect(scheduler.runningCount).toBe(0);
		expect(scheduler.pendingCount).toBe(0);
	});

	it("maps unknown effects to error results without retrying or exposing backend exception text", async () => {
		const { backend, tool } = fixture();
		const execute = vi.spyOn(backend, "execute").mockRejectedValue(new Error("PRIVATE-BACKEND-DETAIL"));
		const { session, faux } = await createSession({ tool });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("computer", {
					request: {
						op: "execute",
						ref: "snapshot-1",
						steps: [{ op: "fill", target: "field-1", text: "Ada" }],
					},
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The effect is unknown; do not replay."),
		]);
		await session.prompt("Execute the fixture step.");
		const result = session.messages.find((message) => message.role === "toolResult");
		expect(result?.isError).toBe(true);
		expect(result?.details).toMatchObject({ status: "outcome_unknown", completedSteps: 0, error: "outcome_unknown" });
		expect(JSON.stringify(result)).not.toContain("PRIVATE-BACKEND-DETAIL");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(faux.state.callCount).toBe(2);
	});

	it("rejects private/unknown input before backend initialization without echoing input in the error", async () => {
		const { factory, tool } = fixture();
		const { session, faux } = await createSession({ tool });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("computer", {
					request: {
						op: "execute",
						ref: "snapshot-1",
						permission: "unrestricted",
						steps: [{ op: "fill", target: "field-1", text: "PRIVATE-INPUT" }],
					},
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Invalid request refused."),
		]);
		await session.prompt("Attempt an invalid request.");
		const result = session.messages.find((message) => message.role === "toolResult");
		expect(result?.isError).toBe(true);
		expect(JSON.stringify(result)).not.toContain("PRIVATE-INPUT");
		expect(factory).not.toHaveBeenCalled();
	});
});
