import type * as Fs from "node:fs";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, test, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { TaskRecoveryJournal } from "../../../src/core/task-recovery.ts";
import { createHarness, getMessageText } from "../harness.ts";

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof Fs>();
	return { ...fs, copyFileSync: vi.fn(fs.copyFileSync) };
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	vi.mocked(copyFileSync).mockRestore();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(persist = true) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-history-boundary-")));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	let requests = 0;
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager }) => {
		const harness = await createHarness({
			sessionManager,
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			hfCompaction: { mode: "off" },
			tools: [],
		});
		cleanups.push(harness.cleanup);
		harness.setResponses(
			Array.from({ length: 8 }, () => () => {
				requests++;
				return fauxAssistantMessage("ack");
			}),
		);
		return {
			session: harness.session,
			extensionsResult: harness.session.resourceLoader.getExtensions(),
			services: {
				cwd,
				agentDir: cwd,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			},
			diagnostics: [],
		};
	};
	const sessionManager = persist ? SessionManager.create(cwd, join(cwd, "sessions")) : SessionManager.inMemory(cwd);
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir: cwd, sessionManager });
	cleanups.push(() => runtime.dispose());
	runtime.setRebindSession((session) => session.bindExtensions({ mode: "print" }));
	await runtime.session.bindExtensions({ mode: "print" });
	return { cwd, runtime, requests: () => requests };
}

test.each([
	{ persist: true, middle: false },
	{ persist: true, middle: true },
	{ persist: false, middle: false },
	{ persist: false, middle: true },
])(
	"fork before a user leaves inherited intent and queues historical ($persist/$middle)",
	async ({ persist, middle }) => {
		const f = await fixture(persist);
		if (middle) await f.runtime.session.prompt("earlier request");
		const manager = f.runtime.session.sessionManager;
		const journal = new TaskRecoveryJournal(manager);
		journal.queue("nextTurn", [
			{ role: "custom", customType: "queued", content: "inherited queue", display: false, timestamp: 1 },
		]);
		await f.runtime.session.prompt("selected request for editing");
		const target = manager
			.getBranch()
			.find(
				(entry) => entry.type === "message" && getMessageText(entry.message) === "selected request for editing",
			)!;
		const beforeRequests = f.requests();
		const result = await f.runtime.fork(target.id);
		expect(result.selectedText).toBe("selected request for editing");
		expect(f.requests()).toBe(beforeRequests);
		expect(f.runtime.session.messages.map(getMessageText)).not.toContain("selected request for editing");
		expect(f.runtime.session.taskRecovery).toBeUndefined();
		expect(f.runtime.session.pendingMessageCount).toBe(0);
		expect(
			f.runtime.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "pi-task-recovery"),
		).toBe(true);
		if (persist) {
			await f.runtime.switchSession(f.runtime.session.sessionFile!);
			expect(f.requests()).toBe(beforeRequests);
			expect(f.runtime.session.taskRecovery).toBeUndefined();
			expect(f.runtime.session.pendingMessageCount).toBe(0);
		}
		await f.runtime.session.prompt("edited request");
		expect(f.requests()).toBe(beforeRequests + 1);
		expect(f.runtime.session.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
			...(middle ? ["earlier request"] : []),
			"edited request",
		]);
	},
);

test.each(["active", "retained"] as const)(
	"import never overwrites a %s session on a basename collision",
	async (kind) => {
		const f = await fixture();
		await f.runtime.session.prompt("keep original");
		const session = f.runtime.session;
		const dir = session.sessionManager.getSessionDir();
		const victim = kind === "active" ? session.sessionFile! : SessionManager.create(f.cwd, dir).getSessionFile()!;
		const original = readFileSync(victim);
		const importDir = join(f.cwd, "external");
		mkdirSync(importDir);
		const source = join(importDir, basename(victim));
		const valid = SessionManager.create(f.cwd, importDir);
		const validBytes = readFileSync(valid.getSessionFile()!);
		for (const bytes of [Buffer.from('{"not":"a session"}\n'), validBytes]) {
			writeFileSync(source, bytes);
			await expect(f.runtime.importFromJsonl(source)).rejects.toThrow();
			expect(readFileSync(victim).equals(original)).toBe(true);
			expect(f.runtime.session).toBe(session);
			expect(readFileSync(source)).toEqual(bytes);
		}
		await session.prompt("still writable");
	},
);

test.each(["invalid", "missing-cwd"] as const)("rejected %s import does not publish a destination", async (kind) => {
	const f = await fixture();
	const session = f.runtime.session;
	const directory = session.sessionManager.getSessionDir();
	const before = readdirSync(directory);
	const source = join(f.cwd, "external.jsonl");
	const bytes =
		kind === "invalid"
			? '{"not":"a session"}\n'
			: `${JSON.stringify({ type: "session", version: 3, id: "external", timestamp: new Date().toISOString(), cwd: join(f.cwd, "missing") })}\n`;
	writeFileSync(source, bytes);
	await expect(f.runtime.importFromJsonl(source)).rejects.toThrow();
	expect(f.runtime.session).toBe(session);
	expect(readdirSync(directory)).toEqual(before);
	expect(readFileSync(source, "utf8")).toBe(bytes);
});

test.each(["collision", "invalidated-source", "emptied-source"] as const)(
	"import remains atomic when publication encounters %s",
	async (kind) => {
		const f = await fixture();
		const session = f.runtime.session;
		const directory = session.sessionManager.getSessionDir();
		const before = readdirSync(directory);
		const external = SessionManager.create(f.cwd, join(f.cwd, "external"));
		const source = external.getSessionFile()!;
		const destination = join(directory, basename(source));
		const copy = vi.mocked(copyFileSync).getMockImplementation()!;
		vi.mocked(copyFileSync).mockImplementationOnce((from, to, flags) => {
			if (kind === "collision") writeFileSync(to, "racing publisher");
			else writeFileSync(from, kind === "emptied-source" ? "" : "not a session\n");
			copy(from, to, flags);
		});
		await expect(f.runtime.importFromJsonl(source)).rejects.toThrow();
		expect(f.runtime.session).toBe(session);
		if (kind === "collision") expect(readFileSync(destination, "utf8")).toBe("racing publisher");
		else expect(readdirSync(directory)).toEqual(before);
		await session.prompt("old session still works");
	},
);

test("import copies validated bytes and keeps an existing same-file import usable", async () => {
	const f = await fixture();
	const externalDir = join(f.cwd, "external");
	const external = SessionManager.create(f.cwd, externalDir);
	external.appendMessage({ role: "user", content: "imported history", timestamp: 1 });
	const source = external.getSessionFile()!;
	const sourceBytes = readFileSync(source);
	await f.runtime.importFromJsonl(source);
	expect(f.runtime.session.sessionId).toBe(external.getSessionId());
	expect(f.runtime.session.messages.map(getMessageText)).toContain("imported history");
	expect(readFileSync(source)).toEqual(sourceBytes);
	await f.runtime.importFromJsonl(f.runtime.session.sessionFile!);
	expect(f.runtime.session.sessionId).toBe(external.getSessionId());
});
