import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../../../src/core/session-manager.ts";
import { TaskRecoveryJournal } from "../../../src/core/task-recovery.ts";

const recoveryType = "pi-task-recovery";

describe("large task recovery session retention", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-large-recovery-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("loads and traverses recovery history without retaining every decoded snapshot", () => {
		const manager = SessionManager.create(dir, dir);
		const file = manager.getSessionFile()!;
		const payload = "x".repeat(1024 * 1024);
		for (let i = 0; i < 180; i++) {
			appendFileSync(
				file,
				`${JSON.stringify({ type: "custom", customType: recoveryType, id: `r${i}`, parentId: i ? `r${i - 1}` : null, timestamp: "2026-01-01", data: { index: i, payload } })}\n`,
			);
		}
		const script = join(dir, "load.mts");
		const source = new URL("../../../src/core/session-manager.ts", import.meta.url).href;
		writeFileSync(
			script,
			[
				`import { SessionManager } from ${JSON.stringify(source)};`,
				`const manager = SessionManager.open(${JSON.stringify(file)});`,
				`if (manager.getEntries().length !== 180 || manager.getBranch().length !== 180) throw new Error("History lost");`,
				`const first = manager.getEntry("r0"); const last = manager.getEntry("r179");`,
				`if (first.data.index !== 0 || last.data.index !== 179 || first.data.payload.length !== 1048576) throw new Error("Payload lost");`,
				`if (manager.getTree().length !== 1) throw new Error("Tree lost");`,
				`const clone = manager.createBranchedSession("r179");`,
				`const fork = SessionManager.forkFrom(clone, ${JSON.stringify(dir)}, ${JSON.stringify(dir)});`,
				`if (fork.getEntries().length !== 180 || fork.getEntry("r0").data.index !== 0) throw new Error("Fork lost");`,
				`for (let i = 0; i < 180; i++) fork.appendCustomEntry("pi-task-recovery", { index: i, payload: "z".repeat(1048576) + i });`,
				`if (fork.getLeafEntry().data.index !== 179) throw new Error("Append lost");`,
				`console.log("history preserved");`,
			].join("\n"),
		);
		const result = spawnSync(process.execPath, ["--max-old-space-size=96", script], {
			encoding: "utf8",
			timeout: 60000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("history preserved");
	}, 90000);

	it("keeps historical branch data available after repair, cloning, switching and source unlink", () => {
		const manager = SessionManager.create(dir, dir);
		const file = manager.getSessionFile()!;
		const journal = new TaskRecoveryJournal(manager);
		journal.start([{ role: "user", content: "你好 🧭".repeat(3000), timestamp: 1 }]);
		const sourceSessionId = manager.getSessionId();
		const first = manager.getLeafId()!;
		const firstState = journal.state;
		journal.update((state) => {
			state.status = "interrupted";
		});
		const second = manager.getLeafId()!;
		const secondState = journal.state;
		appendFileSync(file, '{"torn":');
		const reopened = SessionManager.open(file);
		const entries = loadEntriesFromFile(file);
		reopened.appendSessionInfo("repaired");
		expect(new TaskRecoveryJournal(reopened).state?.status).toBe("interrupted");
		reopened.branch(first);
		expect(new TaskRecoveryJournal(reopened).state?.status).toBe("running");
		const clone = reopened.createBranchedSession(second)!;
		expect(new TaskRecoveryJournal(reopened).state).toBeUndefined();
		expect(reopened.getHeader()?.parentSession).toBe(file);
		const fork = SessionManager.forkFrom(clone, dir, dir);
		expect(fork.getHeader()?.parentSession).toBe(clone);
		reopened.newSession();
		renameSync(file, `${file}.old`);
		rmSync(`${file}.old`);
		rmSync(clone);
		for (const retained of [fork, SessionManager.open(fork.getSessionFile()!)]) {
			expect(retained.getBranch().map((entry) => entry.id)).toEqual([first, second]);
			// Copied journals retain their payload and original provenance, not an executable task.
			expect(new TaskRecoveryJournal(retained).state).toBeUndefined();
			for (const [id, data] of [
				[first, firstState],
				[second, secondState],
			] as const) {
				const entry = retained.getEntry(id);
				expect(entry).toMatchObject({ type: "custom", customType: recoveryType, sourceSessionId });
				expect(entry?.type === "custom" && entry.data).toEqual(data);
			}
		}
		const historical = entries.find((entry) => entry.type === "custom" && entry.id === first);
		expect(historical?.type === "custom" && historical.data).toEqual(firstState);
		expect(readFileSync(fork.getSessionFile()!, "utf8")).toContain("你好");
	});

	it("looks up canonical result ownership without decoding historical recovery payloads", () => {
		const manager = SessionManager.create(dir, dir);
		const call = { type: "toolCall" as const, id: "call", name: "read", arguments: {} };
		const assistantId = manager.appendMessage({
			role: "assistant",
			content: [call],
			api: "anthropic-messages",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		});
		const resultId = manager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "observed" }],
			isError: false,
			timestamp: 2,
		});
		for (let i = 0; i < 20; i++) {
			manager.appendCustomEntry(recoveryType, {
				step: { assistantEntryId: assistantId },
				tools: [{ call, resultEntryId: resultId }],
				payload: "large".repeat(10000),
			});
		}
		const reopened = SessionManager.open(manager.getSessionFile()!);
		manager.createBranchedSession(manager.getLeafId()!);
		for (const selected of [manager, reopened]) {
			for (const entry of selected.getEntries()) {
				if (entry.type !== "custom" || entry.customType !== recoveryType) continue;
				Object.defineProperty(entry, "data", {
					get: () => {
						throw new Error("Historical snapshot decoded");
					},
				});
			}
			const journal = new TaskRecoveryJournal(selected);
			for (let i = 0; i < 3; i++) {
				expect(journal.resultEntrySources.get(resultId)).toBe(assistantId);
				expect(journal.findResultEntry(assistantId, call.id)).toBe(resultId);
			}
		}
	});

	it("preserves byte offsets across CRLF, blank rows, split UTF-8 and an unterminated tail", () => {
		const manager = SessionManager.create(dir, dir);
		const file = manager.getSessionFile()!;
		const header = readFileSync(file, "utf8").trimEnd();
		const first = {
			type: "custom",
			customType: recoveryType,
			id: "first",
			parentId: null,
			timestamp: "2026-01-01",
			data: { payload: "" },
		};
		const beforePayload = `${header}\r\n \r\n${JSON.stringify(first).slice(0, -3)}`;
		const padding = 1024 * 1024 - 1 - Buffer.byteLength(beforePayload);
		first.data.payload = `${"x".repeat(padding)}🧭你好`;
		const second = { ...first, id: "second", parentId: "first", data: { payload: "末尾" } };
		writeFileSync(file, `${header}\r\n \r\n${JSON.stringify(first)}\r\n${JSON.stringify(second)}`);
		const reopened = SessionManager.open(file);
		const historical = reopened.getEntry("first");
		expect(historical?.type === "custom" && historical.data).toEqual(first.data);
		const leaf = reopened.getLeafEntry();
		expect(leaf?.type === "custom" && leaf.data).toEqual(second.data);
		reopened.appendSessionInfo("repair final newline");
		const appended = reopened.appendCustomEntry(recoveryType, { payload: "新记录" });
		expect(historical?.type === "custom" && historical.data).toEqual(first.data);
		const newest = reopened.getEntry(appended);
		expect(newest?.type === "custom" && newest.data).toEqual({ payload: "新记录" });
		expect(SessionManager.open(file).getEntry("second")).toMatchObject({ data: second.data });
	});

	it("does not retain caller-owned recovery snapshots after durable append", () => {
		const manager = SessionManager.create(dir, dir);
		const data = { payload: "large".repeat(10000), value: 1 };
		const id = manager.appendCustomEntry(recoveryType, data);
		const entry = manager.getEntry(id)!;
		expect(entry.type === "custom" && entry.data).toEqual(data);
		data.value = 2;
		expect(entry.type === "custom" && entry.data).toMatchObject({ value: 1 });
	});
});
