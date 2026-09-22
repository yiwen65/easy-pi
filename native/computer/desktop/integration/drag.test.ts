import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, it } from "vitest";
import { convertToLlm } from "../../../../packages/coding-agent/src/core/messages.ts";
import { ModelRuntime } from "../../../../packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../../../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../../packages/coding-agent/src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../../../packages/coding-agent/test/utilities.ts";
import { createDesktopBinding } from "../binding.ts";
import type { DesktopInput } from "../contracts.ts";
import { candidateSdk } from "../test/sdk.ts";
import { fixture } from "../test/segment-fixture.ts";

const enabled = process.env.ALLOW_NATIVE_LOAD_TESTS === "true";
const drag = {
	op: "drag_between",
	from: { ref: "image-1", x: 1, y: 1 },
	to: { ref: "image-2", x: 1, y: 1 },
	expected: { kind: "visual", description: "One item arrived" },
} as const;
const call = (request: DesktopInput["request"]) =>
	fauxAssistantMessage(fauxToolCall("computer", { request }), { stopReason: "toolUse" });
function selection() {
	return [
		call({ op: "discover" }),
		call({ op: "select", ref: "window" }),
		call({ op: "discover" }),
		call({ op: "select_destination", ref: "window" }),
		call({ op: "capture_pair", maxDimension: 512 }),
	];
}
async function agent(mode: string) {
	const f = fixture({ windowIds: [1n, 2n] });
	const cwd = mkdtempSync(join(tmpdir(), "drag-agent-"));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "drag-agent-faux", tokensPerSecond: 0 });
	runtime.registerNativeProvider(faux.provider);
	const manager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime: runtime,
		model: { ...faux.getModel(), input: mode === "nonvision" ? ["text"] : ["text", "image"], contextWindow: 100_000 },
		computer: createDesktopBinding(f.session, candidateSdk),
		tools: ["computer"],
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({
			images: { blockImages: mode === "blocked" },
			compaction: { enabled: mode === "compact", reserveTokens: 100, keepRecentTokens: 1 },
			retry: { enabled: false },
		}),
		resourceLoader: createTestResourceLoader(),
	});
	await session.bindExtensions({});
	return {
		f,
		faux,
		session,
		manager,
		async close() {
			try {
				await session.shutdown();
			} finally {
				await f.host.close();
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	};
}

describe.skipIf(!enabled)("two-image drag through the original AgentSession and generated SDK values", () => {
	it.each(["visible", "blocked", "nonvision", "source_filtered", "destination_filtered"])(
		"canonical pair evidence: %s",
		async (mode) => {
			const a = await agent(mode);
			try {
				const original = a.session.agent.transformContext;
				if (mode.endsWith("_filtered"))
					a.session.agent.transformContext = async (messages, signal) => {
						const transformed = original ? await original(messages, signal) : messages;
						return transformed.map((message) => {
							if (
								message.role !== "toolResult" ||
								message.content.filter((part) => part.type === "image").length !== 2
							)
								return message;
							let images = 0;
							return {
								...message,
								content: message.content.filter(
									(part) => part.type !== "image" || ++images !== (mode === "source_filtered" ? 1 : 2),
								),
							};
						});
					};
				const schemas: string[] = [];
				const observe = a.session.agent.onProviderContext;
				a.session.agent.onProviderContext = (model, context) => {
					observe?.(model, context);
					schemas.push(JSON.stringify(context.tools));
				};
				a.faux.setResponses([
					...selection(),
					(context) => {
						const result = context.messages.filter((message) => message.role === "toolResult").at(-1);
						assert.equal(
							result?.content.filter((part) => part.type === "image").length,
							mode === "blocked" ? 0 : mode.endsWith("_filtered") ? 1 : 2,
						);
						return call(drag);
					},
					fauxAssistantMessage("Done"),
				]);
				await a.session.prompt("Use only the synthetic two-window fixture.");
				assert.equal(a.faux.state.callCount, 7);
				assert.equal(a.f.dragPeers.length, mode === "visible" ? 1 : 0);
				assert.equal(
					a.session.messages.filter((message) => message.role === "toolResult").at(-1)?.isError,
					mode !== "visible",
				);
				assert.equal(new Set(schemas).size, 1);
				assert.equal(a.session.agent.executionScheduler, a.f.host.scheduler);
				if (mode.endsWith("_filtered")) {
					a.session.agent.transformContext = original;
					a.faux.setResponses([call(drag), fauxAssistantMessage("Fresh pair required")]);
					await a.session.prompt("Restoring history must not restore old image authority.");
					assert.equal(a.f.dragPeers.length, 0);
					assert.match(
						JSON.stringify(a.session.messages.filter((message) => message.role === "toolResult").at(-1)),
						/stale_image_pair/,
					);
				}
			} finally {
				await a.close();
			}
		},
	);

	it("actual compaction retires a published pair and cannot reconstruct its authority from the old history", async () => {
		const a = await agent("compact");
		try {
			a.faux.setResponses([
				...selection(),
				fauxAssistantMessage(`Both synthetic windows captured. ${"Historical explanation. ".repeat(500)}`),
			]);
			await a.session.prompt("Inspect both synthetic windows; send no input yet.");
			assert.equal(a.f.captures.length, 2);
			assert.equal(a.f.dragPeers.length, 0);
			a.faux.setResponses([
				fauxAssistantMessage(
					"## Conversation timeline\nBoth windows were captured without input.\n## Current continuation point\nPrior image refs are obsolete; capture_pair again before any drag.",
				),
			]);
			await a.session.compact();
			assert.ok(a.manager.getBranch().some((entry) => entry.type === "compaction"));
			assert.deepEqual(a.session.hfCompactionHost?.buildActiveMessages(a.manager.getBranch()), a.session.messages);
			assert.doesNotMatch(JSON.stringify(convertToLlm(a.session.messages)), /"type":"image"/);
			a.faux.setResponses([call(drag), fauxAssistantMessage("Fresh pair required")]);
			await a.session.prompt("Continue; do not resurrect compacted refs.");
			assert.equal(a.f.dragPeers.length, 0);
			assert.match(
				JSON.stringify(a.session.messages.filter((message) => message.role === "toolResult").at(-1)),
				/stale_image_pair/,
			);
		} finally {
			await a.close();
		}
	});
});
