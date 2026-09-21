import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "../../../../packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../../../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../../packages/coding-agent/src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../../../packages/coding-agent/test/utilities.ts";
import { createDesktopBinding } from "../binding.ts";
import { createDesktopTool } from "../tool.ts";
import { candidateSdk } from "./sdk.ts";
import { fixture } from "./segment-fixture.ts";

const enabled = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
for (const blocked of [false, true])
	test(`existing AgentSession consumes segment evidence with blockImages=${blocked}`, { skip: !enabled }, async () => {
		const f = fixture();
		const cwd = mkdtempSync(join(tmpdir(), "segment-agent-"));
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ provider: "segment-agent-faux", tokensPerSecond: 0 });
		runtime.registerNativeProvider(faux.provider);
		const binding = createDesktopBinding(f.session, candidateSdk);
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRuntime: runtime,
			model: { ...faux.getModel(), input: ["text", "image"] },
			computer: binding,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({
				images: { blockImages: blocked },
				compaction: { enabled: false },
				retry: { enabled: false },
			}),
			resourceLoader: createTestResourceLoader(),
		});
		try {
			await session.bindExtensions({});
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("computer", { request: { op: "discover" } }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("computer", { request: { op: "select", ref: "window" } }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("computer", { request: { op: "observe" } }), { stopReason: "toolUse" }),
				fauxAssistantMessage(
					fauxToolCall("computer", {
						request: {
							op: "segment",
							ref: "snapshot-1",
							actions: [{ op: "fill", target: { ref: "field" }, text: "你好" }],
							expected: { kind: "visual", description: "Text appeared" },
						},
					}),
					{ stopReason: "toolUse" },
				),
				(context) => {
					const result = context.messages.filter((message) => message.role === "toolResult").at(-1);
					assert.equal(result?.content.filter((item) => item.type === "image").length, blocked ? 0 : 1);
					assert.match(JSON.stringify(result), /needs_observation/);
					return fauxAssistantMessage(
						fauxToolCall("computer", {
							request: {
								op: "segment",
								ref: "image-2",
								actions: [{ op: "key", key: "Tab" }],
								expected: { kind: "visual", description: "Focus moved" },
							},
						}),
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage("done"),
			]);
			await session.prompt("Use the synthetic fixture. No real application.");
			assert.equal(faux.state.callCount, 6);
			assert.equal(f.segments.length, blocked ? 1 : 2);
			assert.equal(session.agent.executionScheduler, f.host.scheduler);
			assert.equal(session.messages.filter((message) => message.role === "toolResult").at(-1)?.isError, blocked);
			const renewedSession = f.session.renew();
			const renewed = createDesktopTool(renewedSession, candidateSdk);
			renewed.observeContext?.(
				true,
				session.messages.filter((message) => message.role === "toolResult"),
			);
			await assert.rejects(
				renewed.tool.execute("old", {
					request: {
						op: "segment",
						ref: "image-2",
						actions: [{ op: "key", key: "Tab" }],
						expected: { kind: "visual", description: "Focus" },
					},
				}),
				/stale_observation/,
			);
			await renewedSession.close();
		} finally {
			await session.shutdown();
			await f.host.close();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
