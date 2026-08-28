import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { HarnessFault, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessPiServerService } from "../src/server/harness-service.ts";

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
		const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
		const stream = createAssistantMessageEventStream();
		stream.end(handler());
		return stream;
	};
}

function createService(streamFn: StreamFn) {
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
	});
}

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("HarnessPiServerService (T-007)", () => {
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
			const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
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
			const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
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
