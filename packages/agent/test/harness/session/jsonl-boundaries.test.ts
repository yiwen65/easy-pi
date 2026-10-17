import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../../src/harness/session/jsonl/repo.ts";
import type { JsonlSessionStorage } from "../../../src/harness/session/jsonl/storage.ts";
import type { DurableFileWriter } from "../../../src/harness/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-jsonl-boundaries-"));
	roots.push(root);
	return { root, repository: new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root }) };
}

describe("JSONL storage boundaries", () => {
	it("captures direct storage append inputs before queue admission", async () => {
		const { root, repository } = fixture();
		const session = await repository.create({ cwd: root, id: "snapshot" });
		const storage = (session as unknown as { storage: JsonlSessionStorage }).storage;
		const data = { nested: { value: 1 } };
		const entry = storage.appendEntry({ id: "entry", type: "custom", customType: "note", data }, "main");
		data.nested.value = Number.NaN;
		const args: { nested: { value: number | undefined } } = { nested: { value: 2 } };
		const record = storage.appendRecord({
			type: "tool_started",
			id: "tool",
			lane: "main",
			runId: "run",
			assistantEntryId: "assistant",
			toolIndex: 0,
			toolCallId: "call",
			toolName: "example",
			effectiveArgs: args,
			resultEntryId: "result",
			replay: "safe",
		});
		args.nested.value = undefined;
		expect(await entry).toMatchObject({ data: { nested: { value: 1 } } });
		expect(await record).toMatchObject({ effectiveArgs: { nested: { value: 2 } } });
		const log = await session.getLog();
		const metadata = await session.getMetadata();
		await session.release();
		const reopened = await repository.open(metadata);
		expect(await reopened.getLog()).toEqual(log);
		await reopened.release();
	});

	it("evicts released storages without evicting an active replacement", async () => {
		const { root, repository } = fixture();
		const active = (repository as unknown as { activeStorages: Map<string, JsonlSessionStorage> }).activeStorages;
		const retainedCounts: number[] = [];
		for (let index = 0; index < 6; index++) {
			const session = await repository.create({ cwd: root, id: `session-${index}` });
			await session.appendCustomEntry("payload", { text: "x".repeat(4096) });
			expect(active.size).toBe(1);
			const metadata = await session.getMetadata();
			await session.release();
			retainedCounts.push(active.size);
			const replacement = await repository.open(metadata);
			const replacementStorage = active.get(metadata.path);
			await session.release();
			expect(active.get(metadata.path)).toBe(replacementStorage);
			const fork = await repository.fork(metadata, { cwd: root, id: `fork-${index}`, scope: "tree" });
			expect(await fork.findEntries()).toHaveLength(1);
			await fork.release();
			await replacement.release();
		}
		expect(retainedCounts).toEqual([0, 0, 0, 0, 0, 0]);
		expect(active.size).toBe(0);
	});

	it("does not evict a replacement registered before an old release completes", async () => {
		const { root, repository } = fixture();
		const session = await repository.create({ cwd: root, id: "replaced" });
		const metadata = await session.getMetadata();
		const storage = (session as unknown as { storage: JsonlSessionStorage }).storage;
		const writer = (storage as unknown as { writer: DurableFileWriter }).writer;
		const unlocked = Promise.withResolvers<void>();
		const completion = Promise.withResolvers<void>();
		const releaseWriter = writer.release.bind(writer);
		vi.spyOn(writer, "release").mockImplementationOnce(async () => {
			const result = await releaseWriter();
			unlocked.resolve();
			await completion.promise;
			return result;
		});
		const release = session.release();
		await unlocked.promise;
		const replacement = await repository.open(metadata);
		const active = (repository as unknown as { activeStorages: Map<string, JsonlSessionStorage> }).activeStorages;
		const replacementStorage = active.get(metadata.path);
		completion.resolve();
		await release;
		expect(active.size).toBe(1);
		expect(active.get(metadata.path)).toBe(replacementStorage);
		await replacement.release();
		expect(active.size).toBe(0);
	});

	it.each(["not-json\n", '{"kind":"entry"\n', "not-json\r\n"])(
		"rejects newline-terminated syntax corruption unchanged: %j",
		async (tail) => {
			const { root, repository } = fixture();
			const session = await repository.create({ cwd: root, id: "corrupt" });
			await session.appendCustomEntry("kept");
			const metadata = await session.getMetadata();
			await session.release();
			appendFileSync(metadata.path, tail);
			const before = readFileSync(metadata.path);
			await expect(repository.open(metadata)).rejects.toMatchObject({ code: "invalid_entry" });
			expect(readFileSync(metadata.path)).toEqual(before);
		},
	);

	const invalidPayloads: Record<string, unknown>[] = [
		{ kind: "entry", type: "message", message: null },
		{ kind: "entry", type: "message", message: { role: "user", timestamp: 1, content: null } },
		{ kind: "entry", type: "model_change", provider: 1, modelId: "model" },
		{ kind: "entry", type: "thinking_level_change", thinkingLevel: null },
		{ kind: "entry", type: "active_tools_change", activeToolNames: [null] },
		{ kind: "entry", type: "compaction", summary: "summary", retainedTail: null, tokensBefore: 1 },
		{ kind: "entry", type: "compaction", summary: "summary", retainedTail: [null], tokensBefore: 1 },
		{ kind: "entry", type: "branch_summary", summary: "summary", fromId: null },
		{ kind: "entry", type: "custom", customType: null },
		{
			kind: "record",
			type: "operation_started",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [], initialMessages: null },
		},
		{ kind: "record", type: "operation_started", sourceLeafId: null, intent: { kind: "compaction" } },
		{
			kind: "record",
			type: "operation_started",
			sourceLeafId: null,
			intent: { kind: "navigation", targetId: null, summarize: "yes" },
		},
		{ kind: "record", type: "abort_requested" },
		{ kind: "record", type: "pause_requested" },
		{ kind: "record", type: "pause_cleared" },
		{ kind: "record", type: "operation_finished", runId: "run", outcome: "unknown" },
		{ kind: "record", type: "step_attempt", runId: "run", step: "unknown", attempt: 1, resultEntryId: "result" },
		{
			kind: "record",
			type: "tool_started",
			runId: "run",
			assistantEntryId: "assistant",
			toolIndex: 0,
			toolCallId: "call",
			toolName: "tool",
			effectiveArgs: null,
			resultEntryId: "result",
			replay: "never",
		},
		{ kind: "record", type: "queue_enqueued", queue: "nextRun", target: null },
		{ kind: "record", type: "queue_cancelled", entryId: null },
		{ kind: "record", type: "write_deferred", runId: "run", target: [] },
		{ kind: "record", type: "usage", cause: "adjustment", usage: null },
	];
	it.each(
		invalidPayloads.flatMap((payload) => ["first", "middle", "final"].map((position) => ({ payload, position }))),
	)("rejects malformed $payload.type at $position without rewriting", async ({ payload, position }) => {
		const { root, repository } = fixture();
		const session = await repository.create({ cwd: root, id: "schema" });
		const metadata = await session.getMetadata();
		await session.release();
		const lines = [payload];
		if (position !== "first") lines.unshift({ kind: "fact", fact: "name", name: "before" });
		if (position !== "final") lines.push({ kind: "fact", fact: "name", name: "after" });
		const encoded = lines
			.map((line, index) =>
				JSON.stringify({
					id: `item-${index}`,
					lane: "main",
					parentId: null,
					timestamp: 1,
					seq: index + 1,
					...line,
				}),
			)
			.join("\n");
		appendFileSync(metadata.path, `${encoded}\n`);
		const before = readFileSync(metadata.path);
		await expect(repository.open(metadata)).rejects.toMatchObject({ code: "invalid_entry" });
		expect(readFileSync(metadata.path)).toEqual(before);
	});

	it("keeps application-defined custom entry data opaque", async () => {
		const { root, repository } = fixture();
		const session = await repository.create({ cwd: root, id: "opaque" });
		const data = { type: "compaction", retainedTail: null, nested: [null, { role: "user", content: null }] };
		const id = await session.appendCustomEntry("application", data);
		const metadata = await session.getMetadata();
		await session.release();
		const reopened = await repository.open(metadata);
		expect(await reopened.getEntry(id)).toMatchObject({ data });
		await reopened.release();
	});
});
