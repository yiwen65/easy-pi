import { describe, expect, it } from "vitest";
import { InMemorySessionStorage } from "../../../src/harness/session/memory.ts";
import { Session } from "../../../src/harness/session/session.ts";
import type { Entry, LaneRecord, NewRecord, ProvisionedEntry } from "../../../src/harness/session/types.ts";

class DelayedStorage extends InMemorySessionStorage {
	readonly gate = Promise.withResolvers<void>();

	override async appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		await this.gate.promise;
		return super.appendEntry(entry, lane);
	}

	override async appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord> {
		await this.gate.promise;
		return super.appendRecord(record);
	}
}

describe("Session input ownership", () => {
	it("hands detached entries and records to an asynchronously admitting backend", async () => {
		const storage = new DelayedStorage({ id: "snapshot", createdAt: 1 });
		const session = new Session(storage);
		const data: { value: number | undefined } = { value: 1 };
		const entry = session.appendCustomEntry("note", data);
		const args = { nested: { value: 2 } };
		const record = session.appendRecord({
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
		data.value = undefined;
		args.nested.value = Number.NaN;
		storage.gate.resolve();
		expect(await session.getEntry(await entry)).toMatchObject({ data: { value: 1 } });
		expect(await record).toMatchObject({ effectiveArgs: { nested: { value: 2 } } });
	});

	it("rejects invalid inputs at invocation even when a caller later repairs them", async () => {
		const storage = new DelayedStorage({ id: "invalid", createdAt: 1 });
		const session = new Session(storage);
		const data: { value: number | undefined } = { value: undefined };
		const result = session.appendCustomEntry("invalid", data);
		data.value = 1;
		storage.gate.resolve();
		await expect(result).rejects.toMatchObject({ code: "invalid_payload" });
		expect(await session.getLog()).toEqual([]);
	});
});
