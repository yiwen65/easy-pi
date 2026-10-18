import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntry,
	SessionManager,
} from "../../../src/core/session-manager.ts";
import { TaskRecoveryJournal, type TaskRecoveryState } from "../../../src/core/task-recovery.ts";
import { createHarness, type Harness } from "../harness.ts";

const recoveryType = "pi-task-recovery";
const fields = ["prompt", "systemPrompt", "suspendedTasks"] as const;
type StoredEntry = FileEntry & {
	recoveryStorage?: {
		version: 1;
		refs: Partial<Record<(typeof fields)[number], { entryId: string; sha256: string }>>;
	};
};

function readPhysical(path: string): StoredEntry[] {
	return readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as StoredEntry);
}

function assertLocalReferences(entries: StoredEntry[]): void {
	const previous = new Map<string, StoredEntry>();
	const referenced = new Set<string>();
	for (const entry of entries) {
		if (entry.recoveryStorage) {
			expect(entry.recoveryStorage.version).toBe(1);
			if (entry.type !== "custom") throw new Error("Reference on a non-custom entry");
			for (const [field, ref] of Object.entries(entry.recoveryStorage.refs)) {
				const source = previous.get(ref.entryId);
				if (source?.type !== "custom") throw new Error(`Missing earlier source ${ref.entryId}`);
				expect(source.customType).toBe(recoveryType);
				expect(source.recoveryStorage?.refs ?? {}).not.toHaveProperty(field);
				const inline = source.data as Record<string, unknown>;
				expect(Object.hasOwn(inline, field)).toBe(true);
				expect(entry.data).not.toHaveProperty(field);
				expect(createHash("sha256").update(JSON.stringify(inline[field])).digest("hex")).toBe(ref.sha256);
				referenced.add(field);
			}
		}
		previous.set(entry.id, entry);
	}
	// Exercise each supported field, not merely the presence of some compression.
	expect([...referenced].sort()).toEqual([...fields].sort());
}

describe("recovery-aware JSONL branch export", () => {
	let dir: string;
	const harnesses: Harness[] = [];
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-recovery-export-"));
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.shutdown();
			harness.cleanup();
		}
		rmSync(dir, { recursive: true, force: true });
	});

	async function fixture(manager = SessionManager.create(dir, join(dir, "sessions"))): Promise<Harness> {
		const harness = await createHarness({ sessionManager: manager, tools: [], hfCompaction: { mode: "off" } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Ready to export.")]);
		await harness.session.prompt("Export this branch.");
		return harness;
	}

	it("re-encodes sibling-owned fields locally without multiplying large snapshots", async () => {
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		const sourceFile = manager.getSessionFile()!;
		const journal = new TaskRecoveryJournal(manager);
		const oldUser = { role: "user" as const, content: "paused task evidence 🧭 ".repeat(2048), timestamp: 1 };
		journal.start([oldUser], "Original task policy.");
		manager.appendMessage(oldUser, journal.state!.promptEntryIds[0]);
		const unsafeCall = {
			type: "toolCall" as const,
			id: "pending-effect",
			name: "write",
			arguments: { path: "never-executed" },
		};
		const oldAssistant = fauxAssistantMessage([unsafeCall], { stopReason: "toolUse", timestamp: 2 });
		journal.beginStep(oldAssistant);
		journal.commitAssistant(oldAssistant, manager.appendMessage(oldAssistant));
		// Record a crash window; no tool implementation is invoked.
		journal.dispatch(unsafeCall, unsafeCall.arguments, false);
		const commonAncestor = manager.getLeafId()!;
		const commonIds = new Set(manager.getBranch().map((entry) => entry.id));
		const systemPrompt = "Fixed independent task policy. ".repeat(2048);
		const harness = await createHarness({
			sessionManager: manager,
			tools: [],
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({ systemPrompt }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				Array.from({ length: 6 }, (_, index) => ({ type: "text" as const, text: `A item ${index}` })),
			),
		]);
		await harness.session.prompt("Current independent task payload. ".repeat(2048));
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
		const stateA = journal.state!;
		expect(stateA.status).toBe("completed");
		expect(stateA.systemPrompt).toBe(systemPrompt);
		expect(stateA.step?.message?.content).toHaveLength(6);
		expect(
			harness.eventsOfType("message_update").filter((event) => event.assistantMessageEvent.type === "text_end"),
		).toHaveLength(6);
		expect(stateA.suspendedTasks).toHaveLength(1);
		expect(stateA.suspendedTasks![0]).toMatchObject({
			leafId: commonAncestor,
			state: { prompt: [oldUser], status: "needs_reconciliation", tools: [{ dispatched: true, safe: false }] },
		});
		expect(stateA.suspendedTasks![0].state.tools[0].result).toBeUndefined();
		const branchA = manager.getBranch().filter((entry) => !commonIds.has(entry.id));
		const branchAIds = new Set(branchA.map((entry) => entry.id));
		// Faux streams text blocks without itemComplete; the real lifecycle still saves
		// start, beginStep, commitAssistant and completion snapshots.
		expect(
			branchA.filter((entry) => entry.type === "custom" && entry.customType === recoveryType).length,
		).toBeGreaterThanOrEqual(4);

		manager.branch(commonAncestor);
		const promptEntryIds = stateA.prompt.map((message) => {
			if (message.role !== "user") throw new Error("Expected a single user prompt");
			return manager.appendMessage(message);
		});
		const stateB: TaskRecoveryState = {
			...stateA,
			id: randomUUID(),
			status: "interrupted",
			sourceLeafId: commonAncestor,
			promptEntryIds,
		};
		delete stateB.step;
		const branchBIds = [manager.appendCustomEntry(recoveryType, stateB)];
		const output = join(dir, "export.jsonl");
		writeFileSync(output, "ordinary existing output");
		expect(harness.session.exportToJsonl(output)).toBe(output);
		const initialBytes = statSync(output).size;
		for (let index = 0; index < 12; index++) {
			journal.update((state) => {
				state.retryAttempt++;
			});
			branchBIds.push(manager.getLeafId()!);
		}

		const branch = manager.getBranch();
		const branchIds = new Set(branch.map((entry) => entry.id));
		const physicalSource = readPhysical(sourceFile);
		for (const id of branchBIds) {
			const entry = physicalSource.find((entry) => entry.id === id)!;
			expect(Object.keys(entry.recoveryStorage!.refs).sort()).toEqual([...fields].sort());
			for (const field of fields) {
				const ref = entry.recoveryStorage!.refs[field]!;
				expect(branchAIds.has(ref.entryId)).toBe(true);
				expect(branchIds.has(ref.entryId)).toBe(false);
			}
		}
		const expectedEntries = JSON.parse(JSON.stringify(branch)) as SessionEntry[];
		const expectedContext = structuredClone(manager.buildSessionContext());
		const expectedState = journal.state;
		const fullCopyIncrement = expectedEntries
			.filter((entry) => branchBIds.slice(1).includes(entry.id))
			.reduce((bytes, entry) => bytes + Buffer.byteLength(`${JSON.stringify(entry)}\n`), 0);
		const beforeExport = Date.now();
		expect(harness.session.exportToJsonl(output)).toBe(output);
		const afterExport = Date.now();
		expect(statSync(output).size - initialBytes).toBeLessThan(fullCopyIncrement / 10);
		const exported = readPhysical(output);
		assertLocalReferences(exported);
		expect(exported[0]).toEqual({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: manager.getSessionId(),
			timestamp: expect.any(String),
			cwd: manager.getCwd(),
		});
		expect(Date.parse(exported[0].timestamp)).toBeGreaterThanOrEqual(beforeExport);
		expect(Date.parse(exported[0].timestamp)).toBeLessThanOrEqual(afterExport);
		expect(exported[0].timestamp).not.toBe(manager.getHeader()!.timestamp);
		for (const [index, entry] of exported.slice(1).entries()) {
			expect(entry).toMatchObject({
				id: expectedEntries[index].id,
				parentId: index ? expectedEntries[index - 1].id : null,
			});
			expect(entry).not.toHaveProperty("sourceSessionId");
		}
		expect(readFileSync(output, "utf8").endsWith("\n")).toBe(true);

		await harness.session.shutdown();
		rmSync(sourceFile);
		expect(existsSync(sourceFile)).toBe(false);
		// First logical open is after source removal; no cached export reader can hide external refs.
		const reopened = SessionManager.open(output);
		expect(reopened.getEntries()).toEqual(expectedEntries);
		expect(reopened.getBranch()).toEqual(expectedEntries);
		expect(reopened.buildSessionContext()).toEqual(expectedContext);
		expect(new TaskRecoveryJournal(reopened).state).toEqual(expectedState);
		expect(new TaskRecoveryJournal(reopened).suspendedTasks).toEqual(expectedState!.suspendedTasks);
	});

	it("preserves existing recovery provenance without tagging new native records", async () => {
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		const originalSessionId = manager.getSessionId();
		const journal = new TaskRecoveryJournal(manager);
		const user = { role: "user" as const, content: "Original accepted request.", timestamp: 1 };
		journal.start([user]);
		manager.appendMessage(user, journal.state!.promptEntryIds[0]);
		manager.createBranchedSession(manager.getLeafId()!);
		const harness = await fixture(manager);
		const branch = JSON.parse(JSON.stringify(manager.getBranch())) as SessionEntry[];
		const imported = branch.filter((entry) => entry.type === "custom" && entry.sourceSessionId === originalSessionId);
		expect(imported).toHaveLength(1);
		const expectedState = journal.state;
		expect(expectedState).toBeDefined();
		const output = harness.session.exportToJsonl(join(dir, "provenance.jsonl"));
		const exported = SessionManager.open(output);
		expect(exported.getEntries()).toEqual(branch);
		expect(new TaskRecoveryJournal(exported).state).toEqual(expectedState);
		for (const entry of exported.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== recoveryType) continue;
			expect(entry.sourceSessionId).toBe(
				imported.some((historical) => historical.id === entry.id) ? originalSessionId : undefined,
			);
		}
	});

	it("keeps timestamped cwd defaults and creates missing output directories", async () => {
		const harness = await fixture();
		const previousCwd = process.cwd();
		try {
			process.chdir(dir);
			const output = harness.session.exportToJsonl();
			expect(dirname(output)).toBe(process.cwd());
			expect(basename(output)).toMatch(/^session-\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/);
			expect(SessionManager.open(output).getEntries()).toEqual(harness.sessionManager.getBranch());
		} finally {
			process.chdir(previousCwd);
		}
		const nested = join(dir, "new", "nested", "export.jsonl");
		expect(harness.session.exportToJsonl(nested)).toBe(nested);
		expect(SessionManager.open(nested).getEntries()).toEqual(harness.sessionManager.getBranch());
	});

	it("updates a symbolic link's target while retaining the link and returned path", async () => {
		const harness = await fixture();
		const target = join(dir, "target.jsonl");
		const output = join(dir, "link.jsonl");
		writeFileSync(target, "previous target contents");
		symlinkSync("target.jsonl", output);
		expect(harness.session.exportToJsonl(output)).toBe(output);
		expect(lstatSync(output).isSymbolicLink()).toBe(true);
		expect(readlinkSync(output)).toBe("target.jsonl");
		expect(SessionManager.open(target).getEntries()).toEqual(harness.sessionManager.getBranch());
		expect(readFileSync(output, "utf8")).toBe(readFileSync(target, "utf8"));
	});

	it("rejects a dangling symbolic link without creating its target or replacing the link", async () => {
		const harness = await fixture();
		const target = join(dir, "missing.jsonl");
		const output = join(dir, "dangling.jsonl");
		symlinkSync("missing.jsonl", output);
		expect(() => harness.session.exportToJsonl(output)).toThrow(/ENOENT/);
		expect(existsSync(target)).toBe(false);
		expect(lstatSync(output).isSymbolicLink()).toBe(true);
		expect(readlinkSync(output)).toBe("missing.jsonl");
	});

	it("rejects multiply hard-linked outputs, including through a symbolic link", async () => {
		const harness = await fixture();
		const target = join(dir, "target.jsonl");
		const hardlink = join(dir, "hardlink.jsonl");
		const symlink = join(dir, "symlink.jsonl");
		writeFileSync(target, "must remain unchanged");
		linkSync(target, hardlink);
		symlinkSync("target.jsonl", symlink);
		for (const output of [hardlink, symlink]) {
			expect(() => harness.session.exportToJsonl(output)).toThrow(/multiple hard links/);
			expect(readFileSync(output, "utf8")).toBe("must remain unchanged");
		}
		expect(readFileSync(target, "utf8")).toBe("must remain unchanged");
		expect(statSync(target).ino).toBe(statSync(hardlink).ino);
		expect(statSync(target).nlink).toBe(2);
		expect(lstatSync(symlink).isSymbolicLink()).toBe(true);
	});
});
