import { type AssistantMessage, createAssistantMessageEventStream, createModels } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHarness, type AgentHarnessOptions, type HarnessTool } from "../../src/harness/agent-harness.ts";
import { InMemorySessionStorage, type RecordQuery, Session } from "../../src/harness/session/index.ts";
import type { AgentToolCall, StreamFn } from "../../src/types.ts";

const model = getModel("google", "gemini-2.5-flash");
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function barrier() {
	const entered = deferred();
	const release = deferred();
	return {
		entered: entered.promise,
		release: release.resolve,
		wait: async () => {
			entered.resolve();
			await release.promise;
		},
	};
}
function observe<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ value, error: undefined }),
		(error: unknown) => ({ value: undefined, error }),
	);
}
function message(text = "done"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function response(value = message()) {
	const stream = createAssistantMessageEventStream();
	stream.end(value);
	return stream;
}
function session() {
	return new Session(new InMemorySessionStorage({ id: "runtime-races", createdAt: 1 }));
}
function create(session: Session, options: Partial<AgentHarnessOptions> = {}) {
	return AgentHarness.create({ session, model, models: createModels(), streamFn: () => response(), ...options });
}
async function validLog(session: Session) {
	// A fresh harness independently re-reduces every record, including closed operations.
	const recovered = await create(session);
	await recovered.harness.watch();
}
async function seedRun(session: Session) {
	await session.appendRecord({
		type: "operation_started",
		id: "seeded-run",
		lane: "main",
		sourceLeafId: null,
		intent: { kind: "run", originalPrompt: [], initialMessages: [] },
	});
}
const call: AgentToolCall = { type: "toolCall", id: "call-1", name: "effect", arguments: {} };
function tool(execute: HarnessTool["execute"], contract?: HarnessTool["contract"]): HarnessTool {
	return {
		name: "effect",
		label: "Effect",
		description: "offline",
		parameters: Type.Object({}),
		execute,
		...(contract ? { contract } : {}),
	};
}
function toolResponse(calls = [call]) {
	return response({ ...message(), content: calls, stopReason: "toolUse" });
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("durable runtime audit regressions", () => {
	it("T-131 reserves navigation before target lookup, excluding concurrent prompt", async () => {
		for (let iteration = 0; iteration < 3; iteration++) {
			const storage = session();
			const target = await storage.appendMessage({ role: "user", content: "anchor", timestamp: 1 });
			const { harness } = await create(storage);
			const gate = barrier();
			const original = storage.getEntry.bind(storage);
			let first = true;
			vi.spyOn(storage, "getEntry").mockImplementation(async (id) => {
				if (id === target && first) {
					first = false;
					await gate.wait();
				}
				return original(id);
			});
			const navigation = observe(harness.navigateTree(target));
			await gate.entered;
			const prompt = observe(harness.prompt("competing"));
			gate.release();
			const [navigated, prompted] = await Promise.all([navigation, prompt]);
			expect(prompted.value).toMatchObject({ ok: false, error: { _tag: "LaneBusy" } });
			expect(navigated.value).toMatchObject({ ok: true, value: { kind: "completed" } });
			await validLog(storage);
		}
	});

	it("T-131 reserves resume before reduction, excluding another resume", async () => {
		for (let iteration = 0; iteration < 3; iteration++) {
			const storage = session();
			await seedRun(storage);
			const { harness } = await create(storage);
			const gate = barrier();
			const original = storage.findOpenOperations.bind(storage);
			let first = true;
			vi.spyOn(storage, "findOpenOperations").mockImplementation(async (...args) => {
				const records = await original(...args);
				if (first) {
					first = false;
					await gate.wait();
				}
				return records;
			});
			const firstResume = observe(harness.resume());
			await gate.entered;
			const secondResume = observe(harness.resume());
			gate.release();
			const [firstResult, secondResult] = await Promise.all([firstResume, secondResume]);
			expect(secondResult.value).toMatchObject({ ok: false, error: { _tag: "LaneBusy" } });
			expect(firstResult.value).toMatchObject({ ok: true, value: { kind: "completed" } });
			await validLog(storage);
		}
	});

	it.each(["prompt", "abort"] as const)("T-132 retains paused ownership for %s", async (control) => {
		const storage = session();
		const entered = deferred();
		const pending = createAssistantMessageEventStream();
		const { harness } = await create(storage, {
			streamFn: () => {
				entered.resolve();
				return pending;
			},
		});
		const running = harness.prompt("start");
		await entered.promise;
		await harness.pause();
		pending.end(message());
		expect(await running).toMatchObject({ ok: true, value: { kind: "paused" } });
		if (control === "prompt") {
			const competing = await observe(harness.prompt("second"));
			expect(competing.value).toMatchObject({ ok: false, error: { _tag: "LaneBusy" } });
		} else {
			expect(await harness.abort()).toMatchObject({ ok: true });
			expect(await storage.findOpenOperations("main")).toHaveLength(0);
		}
		await validLog(storage);
	});

	it.each([0, 1, 2])("T-132 honors a pause accepted before the terminal control lock (%i)", async () => {
		const storage = session();
		const streamFn = vi.fn(() => response());
		const { harness } = await create(storage, { streamFn });
		const gate = barrier();
		const original = storage.getEntry.bind(storage);
		let first = true;
		vi.spyOn(storage, "getEntry").mockImplementation(async (id) => {
			const entry = await original(id);
			if (first && entry?.type === "message" && entry.message.role === "assistant") {
				first = false;
				await gate.wait();
			}
			return entry;
		});
		const running = harness.prompt("finish");
		await gate.entered;
		expect(await harness.pause()).toMatchObject({ ok: true });
		gate.release();
		expect(await running).toMatchObject({ ok: true, value: { kind: "paused" } });
		expect(await storage.findOpenOperations("main")).toHaveLength(1);
		expect(await storage.findRecords({ type: "operation_finished" })).toHaveLength(0);
		expect(await harness.resume()).toMatchObject({ ok: true, value: { kind: "completed" } });
		expect(streamFn).toHaveBeenCalledTimes(1);
		expect(await storage.findOpenOperations("main")).toHaveLength(0);
		expect(await storage.findRecords({ type: "operation_finished" })).toHaveLength(1);
		await validLog(storage);
	});

	it("T-133 rejects queue admission after abort while the provider is still pending", async () => {
		const storage = session();
		const entered = deferred();
		const pending = createAssistantMessageEventStream();
		const { harness } = await create(storage, {
			streamFn: () => {
				entered.resolve();
				return pending;
			},
		});
		const running = observe(harness.prompt("start"));
		await entered.promise;
		await harness.abort();
		const queued = await harness.steer("too late");
		pending.end(message());
		const result = await running;
		expect(queued).toMatchObject({ ok: false, error: { _tag: "NoActiveRun" } });
		expect(result.value).toMatchObject({ ok: true, value: { kind: "aborted" } });
		await validLog(storage);
	});

	it("T-133 serializes finish against queue, abort and pause admission", async () => {
		for (const control of ["steer", "abort", "pause"] as const) {
			const storage = session();
			const gate = barrier();
			const original = storage.appendRecord.bind(storage);
			vi.spyOn(storage, "appendRecord").mockImplementation((async (record) => {
				const result = await original(record);
				if (record.type === "operation_finished") await gate.wait();
				return result;
			}) as Session["appendRecord"]);
			const { harness } = await create(storage);
			const running = observe(harness.prompt("finish"));
			await gate.entered;
			const admitted =
				control === "steer"
					? observe(harness.steer("late"))
					: control === "abort"
						? observe(harness.abort())
						: observe(harness.pause());
			gate.release();
			const [result, admission] = await Promise.all([running, admitted]);
			expect(result.value).toMatchObject({ ok: true, value: { kind: "completed" } });
			expect(admission.value).toMatchObject({ ok: false });
			await validLog(storage);
		}
	});

	it("T-134 revalidates a captured steering item after cancellation wins", async () => {
		const storage = session();
		const entered = deferred();
		const pending = createAssistantMessageEventStream();
		let requests = 0;
		const { harness } = await create(storage, {
			streamFn: () => {
				if (++requests === 1) {
					entered.resolve();
					return pending;
				}
				return response();
			},
		});
		const running = observe(harness.prompt("start"));
		await entered.promise;
		const queued = await harness.steer("cancel me");
		if (!queued.ok) throw new Error("enqueue failed");
		const gate = barrier();
		const original = storage.findRecords.bind(storage);
		let first = true;
		vi.spyOn(storage, "findRecords").mockImplementation((async (query?: RecordQuery) => {
			const records = await original(query);
			if (!query?.type && first) {
				first = false;
				await gate.wait();
			}
			return records;
		}) as Session["findRecords"]);
		pending.end(message());
		await gate.entered;
		expect(await harness.cancelQueued(queued.value.entryId)).toMatchObject({
			ok: true,
			value: { outcome: "cancelled" },
		});
		gate.release();
		const result = await running;
		expect(result.error).toBeUndefined();
		expect(await storage.getEntry(queued.value.entryId)).toBeUndefined();
		expect(requests).toBe(1);
		await validLog(storage);
	});

	it("T-134 never applies cancelled nextRun input captured by an interrupted acceptance", async () => {
		const storage = session();
		const first = await create(storage);
		const queued = await first.harness.nextRun("cancelled initial input");
		if (!queued.ok) throw new Error("enqueue failed");
		const [enqueue] = await storage.findRecords({ type: "queue_enqueued" });
		await storage.appendRecord({
			type: "operation_started",
			id: "interrupted-acceptance",
			lane: "main",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [], initialMessages: [enqueue!.target] },
		});
		const { harness } = await create(storage);
		expect(await harness.cancelQueued(queued.value.entryId)).toMatchObject({
			ok: true,
			value: { outcome: "cancelled" },
		});
		const resumed = await observe(harness.resume());
		expect(resumed.error).toBeUndefined();
		expect(await storage.getEntry(queued.value.entryId)).toBeUndefined();
		await validLog(storage);
	});

	it.each(["revoke", "replace", "approval"] as const)(
		"T-135 blocks a validated tool after %s at the intent barrier",
		async (change) => {
			const storage = session();
			const gate = barrier();
			const original = storage.appendRecord.bind(storage);
			vi.spyOn(storage, "appendRecord").mockImplementation((async (record) => {
				const result = await original(record);
				if (record.type === "tool_started") await gate.wait();
				return result;
			}) as Session["appendRecord"]);
			const execute = vi.fn(async () => ({ content: [], details: {} }));
			const replacement = vi.fn(async () => ({ content: [], details: {} }));
			const initialTool = tool(execute, { readOnly: true });
			let requests = 0;
			const { harness } = await create(storage, {
				tools: [initialTool],
				streamFn: () => (++requests === 1 ? toolResponse() : response()),
			});
			const running = observe(harness.prompt("start"));
			await gate.entered;
			if (change === "revoke") await harness.setActiveTools([]);
			else if (change === "replace") await harness.setTools([tool(replacement, { approval: "required" })]);
			else initialTool.contract = { readOnly: true, approval: "required" };
			gate.release();
			const result = await running;
			expect(result.error).toBeUndefined();
			expect(execute).not.toHaveBeenCalled();
			expect(replacement).not.toHaveBeenCalled();
			await validLog(storage);
		},
	);

	it("T-136 keeps a live timed-out idempotent mutation owned and blocks conflicting work", async () => {
		vi.useFakeTimers();
		const storage = session();
		const entered = deferred();
		const release = deferred();
		let active = 0;
		let peak = 0;
		let mutations = 0;
		const effect = tool(
			async () => {
				mutations++;
				active++;
				peak = Math.max(peak, active);
				entered.resolve();
				await release.promise;
				active--;
				return { content: [], details: {} };
			},
			{ idempotent: true, sideEffects: "filesystem", timeoutMs: 10 },
		);
		let requests = 0;
		const { harness } = await create(storage, {
			tools: [effect],
			streamFn: () => {
				requests++;
				return requests === 1 ? toolResponse([call, { ...call, id: "conflicting-write" }]) : response();
			},
		});
		const running = harness.prompt("write");
		await entered.promise;
		await vi.advanceTimersByTimeAsync(30);
		const result = await running;
		const counts = { active, peak, mutations, requests };
		const reconciliation = await observe(harness.reconcileTool(call.id, { kind: "retry" }));
		const closing = await observe(harness.close());
		release.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await harness.close();
		expect(counts).toEqual({ active: 1, peak: 1, mutations: 1, requests: 1 });
		expect(result).toMatchObject({ ok: true, value: { kind: "needs_reconciliation" } });
		expect(reconciliation.error).toBeInstanceOf(Error);
		expect(closing.error).toBeInstanceOf(Error);
		expect(active).toBe(0);
	});

	it.each([0, 1, 2])("T-136 retains live execution when reconciliation persistence fails (%i)", async () => {
		vi.useFakeTimers();
		const storage = session();
		const entered = deferred();
		const release = deferred();
		let active = 0;
		let peak = 0;
		let mutations = 0;
		const effect = tool(
			async () => {
				mutations++;
				active++;
				peak = Math.max(peak, active);
				if (mutations === 1) {
					entered.resolve();
					await release.promise;
				}
				active--;
				return { content: [], details: {}, terminate: true };
			},
			{ idempotent: true, sideEffects: "filesystem", timeoutMs: 10 },
		);
		const original = storage.appendRecord.bind(storage);
		let failed = false;
		vi.spyOn(storage, "appendRecord").mockImplementation((async (record) => {
			if (record.type === "tool_reconciliation" && !failed) {
				failed = true;
				throw new Error("reconciliation append failed");
			}
			return original(record);
		}) as Session["appendRecord"]);
		const released = vi.spyOn(storage, "release");
		const { harness } = await create(storage, { tools: [effect], streamFn: () => toolResponse() });
		const running = observe(harness.prompt("write"));
		await entered.promise;
		await vi.advanceTimersByTimeAsync(10);
		const failedRun = await running;
		const resumed = await observe(harness.resume());
		const closing = await observe(harness.close());
		const whileLive = { active, peak, mutations, releases: released.mock.calls.length };
		release.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await harness.close();
		expect(failedRun.error).toEqual(new Error("reconciliation append failed"));
		expect(whileLive).toEqual({ active: 1, peak: 1, mutations: 1, releases: 0 });
		expect(resumed.value).toMatchObject({ ok: true, value: { kind: "needs_reconciliation", toolCallId: call.id } });
		expect(closing.error).toBeInstanceOf(Error);
		expect(active).toBe(0);
		expect(released).toHaveBeenCalledTimes(1);
		expect(await storage.findRecords({ type: "operation_finished" })).toHaveLength(0);
		expect(await storage.findRecords({ type: "tool_started" })).toHaveLength(1);
		expect(await storage.findRecords({ type: "tool_reconciliation" })).toHaveLength(0);
		await validLog(storage);
	});

	it.each(["conversion", "systemPrompt", "close"] as const)(
		"T-137 prevents provider dispatch after cancellation during %s",
		async (preparation) => {
			const storage = session();
			const gate = barrier();
			const streamFn = vi.fn(() => response());
			const { harness } = await create(storage, {
				streamFn,
				...(preparation === "conversion"
					? {
							toProviderMessages: async () => {
								await gate.wait();
								return [];
							},
						}
					: {
							systemPrompt: async () => {
								await gate.wait();
								return "system";
							},
						}),
			});
			const running = observe(harness.prompt("start"));
			await gate.entered;
			let closing: Promise<void> | undefined;
			if (preparation === "close") {
				const paused = deferred();
				const original = storage.appendRecord.bind(storage);
				vi.spyOn(storage, "appendRecord").mockImplementation((async (record) => {
					const result = await original(record);
					if (record.type === "pause_requested") paused.resolve();
					return result;
				}) as Session["appendRecord"]);
				closing = harness.close();
				await paused.promise;
			} else await harness.abort();
			gate.release();
			await closing;
			const result = await running;
			expect(result.error).toBeUndefined();
			expect(streamFn).not.toHaveBeenCalled();
			await validLog(storage);
		},
	);

	it("T-138 idle waiters include intent preparation and the whole driver", async () => {
		const storage = session();
		const gate = barrier();
		const original = storage.appendRecord.bind(storage);
		vi.spyOn(storage, "appendRecord").mockImplementation((async (record) => {
			if (record.type === "operation_started") await gate.wait();
			return original(record);
		}) as Session["appendRecord"]);
		const { harness } = await create(storage);
		const running = harness.prompt("start");
		await gate.entered;
		let idle = false;
		const waiting = harness.runWhenIdle(() => {
			idle = true;
		});
		// Drain the known waitForIdle -> runWhenIdle microtask chain, not a wall-clock race.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		const duringPreparation = idle;
		gate.release();
		await running;
		await waiting;
		expect(duringPreparation).toBe(false);
		expect(idle).toBe(true);
	});

	it("T-139 independent identical requests never trip the progress guard", async () => {
		const storage = session();
		const { harness } = await create(storage);
		const outcomes = [];
		for (let i = 0; i < 5; i++) outcomes.push(await harness.prompt("same request"));
		expect(outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true })]));
		for (const result of outcomes) expect(result).toMatchObject({ ok: true, value: { kind: "completed" } });
		await validLog(storage);
	});

	it("T-139 new steering input resets repeated tool continuation fingerprints", async () => {
		const storage = session();
		let harness: AgentHarness;
		let requests = 0;
		const effect = tool(
			async () => {
				await harness.steer("observe again");
				return { content: [{ type: "text", text: "unchanged" }], details: {} };
			},
			{ readOnly: true },
		);
		({ harness } = await create(storage, {
			tools: [effect],
			streamFn: () => {
				requests++;
				return requests <= 5 ? toolResponse([{ ...call, id: `call-${requests}` }]) : response();
			},
		}));
		expect(await harness.prompt("observe")).toMatchObject({ ok: true, value: { kind: "completed" } });
		expect(requests).toBe(6);
		await validLog(storage);
	});

	it.each([false, true])("T-141 accounts each settled provider attempt once (checkpoint=%s)", async (checkpoint) => {
		const storage = session();
		let requests = 0;
		const streamFn: StreamFn = () => {
			if (++requests > 1) return response();
			const failure = { ...message(), stopReason: "error" as const, errorMessage: "529 overloaded" };
			const stream = createAssistantMessageEventStream();
			if (checkpoint)
				stream.push({ type: "text_end", contentIndex: 0, content: "done", partial: failure, itemComplete: true });
			stream.end(failure);
			return stream;
		};
		const { harness } = await create(storage, { streamFn, retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
		expect(await harness.prompt("start")).toMatchObject({ ok: true, value: { kind: "completed" } });
		const ledger = await storage.findRecords({ type: "usage" });
		expect(ledger).toHaveLength(2);
		expect(ledger.reduce((sum, row) => sum + row.usage.totalTokens, 0)).toBe(4);
		expect((await storage.getStats()).totalTokens).toBe(4);
		await validLog(storage);
	});

	it.each(["steer", "followUp"] as const)(
		"T-133 %s accepted before finish is consumed, not stranded",
		async (queue) => {
			for (let iteration = 0; iteration < 3; iteration++) {
				const storage = session();
				let requests = 0;
				const { harness } = await create(storage, {
					streamFn: () => {
						requests++;
						return response();
					},
				});
				const gate = barrier();
				const original = storage.getEntry.bind(storage);
				let first = true;
				vi.spyOn(storage, "getEntry").mockImplementation(async (id) => {
					const entry = await original(id);
					if (first && entry?.type === "message" && entry.message.role === "assistant") {
						first = false;
						await gate.wait();
					}
					return entry;
				});
				const running = harness.prompt("start");
				await gate.entered;
				const queued = await harness[queue]("arrived at finish");
				gate.release();
				expect(await running).toMatchObject({ ok: true, value: { kind: "completed" } });
				if (!queued.ok) throw new Error("enqueue failed");
				expect(await storage.getEntry(queued.value.entryId)).toBeDefined();
				expect(requests).toBe(2);
				await validLog(storage);
			}
		},
	);

	it("T-134 nextRun acceptance and cancellation have only consumed-or-cancelled outcomes", async () => {
		for (const cancellationFirst of [false, true]) {
			const storage = session();
			const { harness } = await create(storage);
			const queued = await harness.nextRun("first input");
			if (!queued.ok) throw new Error("enqueue failed");
			if (cancellationFirst) {
				expect(await harness.cancelQueued(queued.value.entryId)).toMatchObject({
					ok: true,
					value: { outcome: "cancelled" },
				});
				await harness.prompt("go");
				expect(await storage.getEntry(queued.value.entryId)).toBeUndefined();
			} else {
				const gate = barrier();
				const original = storage.appendRecord.bind(storage);
				vi.spyOn(storage, "appendRecord").mockImplementation((async (record) => {
					const result = await original(record);
					if (record.type === "operation_started") await gate.wait();
					return result;
				}) as Session["appendRecord"]);
				const running = observe(harness.prompt("go"));
				await gate.entered;
				const cancelling = harness.cancelQueued(queued.value.entryId);
				gate.release();
				const cancelled = await cancelling;
				const result = await running;
				expect(result.error).toBeUndefined();
				expect(cancelled).toMatchObject({ ok: true, value: { outcome: "already_consumed" } });
				expect(await storage.getEntry(queued.value.entryId)).toBeDefined();
			}
			await validLog(storage);
		}
	});

	it("T-134 consumption wins cancellation while placement owns the control line", async () => {
		const storage = session();
		const entered = deferred();
		const pending = createAssistantMessageEventStream();
		let requests = 0;
		const { harness } = await create(storage, {
			streamFn: () => {
				if (++requests === 1) {
					entered.resolve();
					return pending;
				}
				return response();
			},
		});
		const running = harness.prompt("start");
		await entered.promise;
		const queued = await harness.steer("consume me");
		if (!queued.ok) throw new Error("enqueue failed");
		const gate = barrier();
		const original = storage.appendEntry.bind(storage);
		vi.spyOn(storage, "appendEntry").mockImplementation((async (entry, lane) => {
			if (entry.id === queued.value.entryId) await gate.wait();
			return original(entry, lane);
		}) as Session["appendEntry"]);
		pending.end(message());
		await gate.entered;
		const cancelling = harness.cancelQueued(queued.value.entryId);
		gate.release();
		expect(await cancelling).toMatchObject({ ok: true, value: { outcome: "already_consumed" } });
		expect(await running).toMatchObject({ ok: true, value: { kind: "completed" } });
		expect(requests).toBe(2);
		await validLog(storage);
	});

	it("T-131 releases an unsuccessful navigation reservation", async () => {
		const storage = session();
		const { harness } = await create(storage);
		expect(await harness.navigateTree("unknown")).toMatchObject({ ok: false, error: { _tag: "UnknownTarget" } });
		expect(await harness.prompt("after rejection")).toMatchObject({ ok: true, value: { kind: "completed" } });
		await validLog(storage);
	});

	it("T-138 releases idle waiters after preparation rejects", async () => {
		const storage = session();
		const gate = barrier();
		const original = storage.appendRecord.bind(storage);
		vi.spyOn(storage, "appendRecord").mockImplementation((async (record) => {
			if (record.type === "operation_started") {
				await gate.wait();
				throw new Error("intent write failed");
			}
			return original(record);
		}) as Session["appendRecord"]);
		const { harness } = await create(storage);
		const running = observe(harness.prompt("start"));
		await gate.entered;
		const idle = harness.waitForIdle();
		gate.release();
		expect((await running).error).toBeInstanceOf(Error);
		await idle;
	});

	it("T-136 abort cannot settle a still-running idempotent mutation", async () => {
		const storage = session();
		const entered = deferred();
		const release = deferred();
		const effect = tool(
			async () => {
				entered.resolve();
				await release.promise;
				return { content: [], details: {} };
			},
			{ idempotent: true, sideEffects: "filesystem" },
		);
		const { harness } = await create(storage, { tools: [effect], streamFn: () => toolResponse() });
		const running = harness.prompt("write");
		await entered.promise;
		await harness.abort();
		const result = await running;
		release.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await harness.close();
		expect(result).toMatchObject({ ok: true, value: { kind: "needs_reconciliation" } });
		expect(await storage.findRecords({ type: "operation_finished" })).toHaveLength(0);
		await validLog(storage);
	});

	it("T-141 applies maxTokens to failed attempts before dispatching a retry", async () => {
		const storage = session();
		const streamFn = vi.fn(() => response({ ...message(), stopReason: "error", errorMessage: "529 overloaded" }));
		const { harness } = await create(storage, {
			streamFn,
			budgets: { maxTokens: 2 },
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
		});
		expect(await harness.prompt("start")).toMatchObject({
			ok: true,
			value: { kind: "failed", error: { code: "budget_exceeded" } },
		});
		expect(streamFn).toHaveBeenCalledTimes(1);
		expect(await storage.findRecords({ type: "usage" })).toHaveLength(1);
		await validLog(storage);
	});
});
