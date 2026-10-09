import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { HarnessFault, InMemorySessionRepo, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessPiServerService, type HarnessPiServerServiceOptions } from "../src/server/harness-service.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api" as AssistantMessage["api"],
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function scripted(...handlers: (() => AssistantMessage)[]): StreamFn {
	let index = 0;
	return async () => {
		const handler = handlers[Math.min(index, handlers.length - 1)]!;
		index += 1;
		const stream = createAssistantMessageEventStream();
		stream.end(handler());
		return stream;
	};
}

function createService(streamFn: StreamFn, options: Partial<HarnessPiServerServiceOptions> = {}) {
	const faux = fauxProvider({
		provider: "faux-service",
		models: [{ id: "faux-model", reasoning: false, contextWindow: 200000, maxTokens: 8192 }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	return new HarnessPiServerService({
		repo: new InMemorySessionRepo(),
		models,
		defaultModel: faux.getModel(),
		streamFn,
		defaultCwd: process.cwd(),
		...options,
	});
}

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("HarnessPiServerService (T-007)", () => {
	it("lists a live JSONL session without acquiring another writer", async () => {
		const root = mkdtempSync(join(tmpdir(), "svc-jsonl-"));
		dirs.push(root);
		const repository = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		const service = createService(
			scripted(() => assistantMessage("offline")),
			{ repo: repository, defaultCwd: root },
		);
		const runtime = await service.createSession({ id: "live-jsonl", name: "live name" });
		try {
			expect(await service.listSessions()).toMatchObject([{ id: "live-jsonl", sessionName: "live name" }]);
			expect(await service.openSession("live-jsonl")).toBe(runtime);
			await runtime.prompt({ text: "go" });
			expect((await runtime.snapshot()).transcript).toHaveLength(2);
		} finally {
			await runtime.dispose();
		}
		expect(await service.listSessions()).toMatchObject([{ id: "live-jsonl", sessionName: "live name" }]);
	});

	it("releases the JSONL writer when runtime creation fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "svc-jsonl-error-"));
		dirs.push(root);
		const repository = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		const service = createService(
			scripted(() => assistantMessage("unused")),
			{ repo: repository, defaultCwd: root },
		);
		await expect(
			service.createSession({ id: "invalid-model", model: { provider: "missing", id: "missing" } }),
		).rejects.toThrow("Unknown model");
		const [metadata] = await repository.list();
		const session = await repository.open(metadata!);
		await session.release();
	});

	it("lists another service's active JSONL session through read-only inspection", async () => {
		const root = mkdtempSync(join(tmpdir(), "svc-jsonl-inspect-"));
		dirs.push(root);
		const repository = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		const options = { repo: repository, defaultCwd: root };
		const owner = createService(
			scripted(() => assistantMessage("offline")),
			options,
		);
		const observer = createService(
			scripted(() => assistantMessage("unused")),
			options,
		);
		const runtime = await owner.createSession({ id: "active-writer", name: "read without ownership" });
		try {
			expect(await observer.listSessions()).toMatchObject([
				{ id: "active-writer", sessionName: "read without ownership" },
			]);
			await runtime.prompt({ text: "go" });
			expect((await runtime.snapshot()).transcript).toHaveLength(2);
		} finally {
			await runtime.dispose();
		}
	});

	it("broadcasts a reopened unknown effect pause and accepts explicit verified-result recovery", async () => {
		let effects = 0;
		let requests = 0;
		const repo = new InMemorySessionRepo();
		const tool = {
			name: "effect",
			label: "Effect",
			description: "offline",
			parameters: Type.Object({}),
			contract: { sideEffects: "external" as const },
			async execute() {
				effects++;
				throw new Error("response lost after effect");
			},
		};
		const streamFn: StreamFn = () => {
			requests++;
			const stream = createAssistantMessageEventStream();
			stream.end(
				requests === 1
					? {
							...assistantMessage(""),
							content: [{ type: "toolCall", id: "effect-call", name: "effect", arguments: {} }],
							stopReason: "toolUse",
						}
					: assistantMessage("verified completion"),
			);
			return stream;
		};
		const service = createService(streamFn, { repo, harness: { tools: [tool] } });
		const first = await service.createSession({ id: "unknown" });
		let pausedNotifications = 0;
		first.subscribe(() => {
			pausedNotifications++;
		});
		await first.prompt({ text: "go" });
		expect(pausedNotifications).toBe(1);
		expect(effects).toBe(1);
		expect(requests).toBe(1);
		await first.dispose();
		const reopened = await service.openSession("unknown");
		let snapshots = 0;
		reopened.subscribe(() => {
			snapshots++;
		});
		try {
			await vi.waitFor(() => expect(snapshots).toBeGreaterThan(0));
			expect((await reopened.snapshot()).revision).toBeGreaterThan(0);
			expect(effects).toBe(1);
			await expect(reopened.prompt({ text: "/reconcile-task wrong retry" })).rejects.toThrow("No unresolved tool");
			await reopened.prompt({ text: "/reconcile-task effect-call result verified external success" });
			expect(requests).toBe(1);
			await reopened.prompt({ text: "/resume-task" });
			expect(effects).toBe(1);
			expect(requests).toBe(2);
			const snapshot = await reopened.snapshot();
			expect(snapshot.transcript.filter((item) => item.role === "user")).toHaveLength(1);
			expect(snapshot.transcript.filter((item) => item.role === "tool")).toHaveLength(1);
			expect(snapshot.transcript.at(-1)?.role).toBe("assistant");
		} finally {
			await reopened.dispose();
		}
	});

	it("executes an unknown effect again only after explicit retry authorization", async () => {
		let effects = 0;
		const service = createService(
			scripted(
				() => ({
					...assistantMessage(""),
					content: [{ type: "toolCall", id: "retry-call", name: "effect", arguments: {} }],
					stopReason: "toolUse",
				}),
				() => assistantMessage("done"),
			),
			{
				harness: {
					tools: [
						{
							name: "effect",
							label: "Effect",
							description: "offline",
							parameters: Type.Object({}),
							async execute() {
								effects++;
								if (effects === 1) throw new Error("uncertain");
								return { content: [{ type: "text", text: "success" }], details: {} };
							},
						},
					],
				},
			},
		);
		const runtime = await service.createSession({ id: "retry-unknown" });
		try {
			await runtime.prompt({ text: "go" });
			await runtime.prompt({ text: "/resume-task" });
			expect(effects).toBe(1);
			await runtime.prompt({ text: "/reconcile-task retry-call retry" });
			expect(effects).toBe(1);
			await runtime.prompt({ text: "/resume-task" });
			expect(effects).toBe(2);
		} finally {
			await runtime.dispose();
		}
	});

	it("rejects remote reconciliation while the physical timed-out tool remains unsettled", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let effects = 0;
		const service = createService(
			scripted(() => ({
				...assistantMessage(""),
				content: [{ type: "toolCall", id: "timeout-call", name: "effect", arguments: {} }],
				stopReason: "toolUse",
			})),
			{
				harness: {
					tools: [
						{
							name: "effect",
							label: "Effect",
							description: "offline",
							parameters: Type.Object({}),
							contract: { timeoutMs: 1 },
							async execute() {
								effects++;
								await gate;
								return { content: [], details: {} };
							},
						},
					],
				},
			},
		);
		const runtime = await service.createSession({ id: "unsettled" });
		try {
			await runtime.prompt({ text: "go" });
			await expect(runtime.prompt({ text: "/reconcile-task timeout-call retry" })).rejects.toThrow(
				"has not stopped",
			);
			expect(effects).toBe(1);
		} finally {
			release();
			await runtime.dispose();
		}
	});

	it("creates a session, runs a prompt, and projects an authoritative snapshot", async () => {
		const service = createService(scripted(() => assistantMessage("remote answer")));
		const runtime = await service.createSession({ id: "s-1", name: "remote test" });
		await runtime.prompt({ text: "hello remote" });

		const snapshot = await runtime.snapshot();
		expect(snapshot.id).toBe("s-1");
		expect(snapshot.name).toBe("remote test");
		expect(snapshot.phase).toBe("idle");
		expect(snapshot.transcript.map((item) => item.role)).toEqual(["user", "assistant"]);
		expect(snapshot.revision).toBe(1);

		const listed = await service.listSessions();
		expect(listed.map((meta) => meta.id)).toEqual(["s-1"]);
		expect(listed[0]?.sessionName).toBe("remote test");
		await runtime.dispose();
	});

	it("reopens a session with its transcript intact", async () => {
		const service = createService(scripted(() => assistantMessage("kept")));
		const first = await service.createSession({ id: "s-2" });
		await first.prompt({ text: "remember" });
		await first.dispose();

		const reopened = await service.openSession("s-2");
		const snapshot = await reopened.snapshot();
		expect(snapshot.transcript.map((item) => item.role)).toEqual(["user", "assistant"]);
		await reopened.dispose();
	});

	it("resumes a crashed run on open and does not replay a replay-never tool", async () => {
		const dir = mkdtempSync(join(tmpdir(), "svc-"));
		dirs.push(dir);
		writeFileSync(join(dir, "data.txt"), "file-content", "utf8");
		let step = 0;
		const streamFn: StreamFn = async () => {
			step += 1;
			if (step === 2) {
				// Crash after the read result committed, before the continuation.
				throw new HarnessFault("simulated crash", undefined);
			}
			const stream = createAssistantMessageEventStream();
			stream.end(
				step === 1
					? {
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "call-1",
									name: "read",
									arguments: { path: join(dir, "data.txt") },
								},
							],
							api: "test-api" as AssistantMessage["api"],
							provider: "test-provider",
							model: "test-model",
							usage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: assistantMessage("resumed answer"),
			);
			return stream;
		};
		const service = createService(streamFn);
		const runtime = await service.createSession({ id: "s-3", cwd: dir });
		await expect(runtime.prompt({ text: "read it" })).rejects.toBeInstanceOf(HarnessFault);
		await runtime.dispose();

		// Reopen: the service auto-resumes the suspended operation.
		const reopened = await service.openSession("s-3");
		// Wait for the auto-resume to settle (run_end bumps the revision).
		for (let i = 0; i < 200; i++) {
			const current = await reopened.snapshot();
			if (current.phase === "idle" && current.transcript.at(-1)?.role === "assistant") break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const snapshot = await reopened.snapshot();
		const toolResults = snapshot.transcript.filter((item) => item.role === "tool");
		expect(toolResults).toHaveLength(1);
		expect(snapshot.transcript.at(-1)?.role).toBe("assistant");
		await reopened.dispose();
	});

	it("queues steer during a run and exposes it in the snapshot", async () => {
		let entered = false;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const streamFn: StreamFn = async () => {
			entered = true;
			await gate;
			const stream = createAssistantMessageEventStream();
			stream.end(assistantMessage("after steer"));
			return stream;
		};
		const service = createService(streamFn);
		const runtime = await service.createSession({ id: "s-4" });
		const running = runtime.prompt({ text: "start" });
		while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));
		await runtime.steer({ text: "adjust" });
		const mid = await runtime.snapshot();
		expect(mid.phase).toBe("turn");
		expect(mid.queuedSteerCount).toBe(1);
		release();
		await running;
		const after = await runtime.snapshot();
		expect(after.queuedSteerCount).toBe(0);
		expect(after.transcript.filter((item) => item.role === "user")).toHaveLength(2);
		await runtime.dispose();
	});
});
