import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reclaimSessionAppendLock, SessionManager } from "../../src/core/session-manager.ts";

describe("durable session storage", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-durable-storage-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("persists the header, configuration and accepted prompt before any assistant", () => {
		const session = SessionManager.create(dir, dir);
		const file = session.getSessionFile()!;
		expect(existsSync(file)).toBe(true);
		session.appendModelChange("openai", "test");
		session.appendThinkingLevelChange("high");
		session.appendMessage({ role: "user", content: "accepted request", timestamp: 1 });
		const reopened = SessionManager.open(file);
		expect(reopened.buildSessionContext()).toEqual(session.buildSessionContext());
	});

	it("persists provisioned message IDs unchanged across reloads", () => {
		const session = SessionManager.create(dir, dir);
		expect(session.appendMessage({ role: "user", content: "request", timestamp: 1 }, "accepted-request")).toBe(
			"accepted-request",
		);
		expect(
			session.appendCustomMessageEntry("extension", "injected", false, { source: "queue" }, "accepted-custom"),
		).toBe("accepted-custom");
		const restored = SessionManager.open(session.getSessionFile()!);
		expect(restored.getEntries().map((entry) => ({ id: entry.id, parentId: entry.parentId }))).toEqual([
			{ id: "accepted-request", parentId: null },
			{ id: "accepted-custom", parentId: "accepted-request" },
		]);
	});

	it.each(["", " ", "accepted-request"])(
		"rejects an invalid or duplicate provisioned ID %j before committing",
		(id) => {
			const session = SessionManager.create(dir, dir);
			session.appendMessage({ role: "user", content: "request", timestamp: 1 }, "accepted-request");
			const file = session.getSessionFile()!;
			const committed = readFileSync(file, "utf8");
			expect(() => session.appendMessage({ role: "user", content: "duplicate", timestamp: 2 }, id)).toThrow();
			expect(() => session.appendCustomMessageEntry("extension", "duplicate", false, undefined, id)).toThrow();
			expect(session.getLeafId()).toBe("accepted-request");
			expect(session.getEntries()).toHaveLength(1);
			expect(readFileSync(file, "utf8")).toBe(committed);
		},
	);

	it.each(['{"type":"message"', '{"type":"message"\n'])("repairs a torn final record %j before appending", (tail) => {
		const session = SessionManager.create(dir, dir);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const file = session.getSessionFile()!;
		appendFileSync(file, tail);
		const reopened = SessionManager.open(file);
		reopened.appendMessage({ role: "user", content: "next", timestamp: 2 });
		expect(SessionManager.open(file).buildSessionContext().messages).toHaveLength(2);
		expect(
			readFileSync(file, "utf8")
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toHaveLength(3);
	});

	it("separates a valid final record without a newline from the next append", () => {
		const session = SessionManager.create(dir, dir);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const file = session.getSessionFile()!;
		writeFileSync(file, readFileSync(file, "utf8").trimEnd());
		const reopened = SessionManager.open(file);
		reopened.appendCustomEntry("next", { value: 2 });
		expect(SessionManager.open(file).getEntries()).toHaveLength(2);
	});

	it("rejects corruption between committed records without changing the file", () => {
		const session = SessionManager.create(dir, dir);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const file = session.getSessionFile()!;
		const lines = readFileSync(file, "utf8").split("\n");
		lines.splice(1, 0, "{broken");
		const corrupted = lines.join("\n");
		writeFileSync(file, corrupted);
		expect(() => SessionManager.open(file)).toThrow(/corrupt/i);
		expect(readFileSync(file, "utf8")).toBe(corrupted);
	});

	it("does not advance entries, labels or the leaf when persistence fails", () => {
		const session = SessionManager.create(dir, dir);
		const first = session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const file = session.getSessionFile()!;
		rmSync(file);
		mkdirSync(file);
		expect(() => session.appendLabelChange(first, "uncommitted")).toThrow();
		expect(session.getEntries()).toHaveLength(1);
		expect(session.getLeafId()).toBe(first);
		expect(session.getLabel(first)).toBeUndefined();
		expect(() => session.branchWithSummary(null, "uncommitted")).toThrow();
		expect(session.getLeafId()).toBe(first);
	});

	it("rejects stale session writers after another manager commits", () => {
		const first = SessionManager.create(dir, dir);
		const file = first.getSessionFile()!;
		const second = SessionManager.open(file);
		first.appendCustomEntry("committed", { value: 1 });
		expect(() => second.appendCustomEntry("stale", { value: 2 })).toThrow(/reopen/);
		expect(second.getEntries()).toHaveLength(0);
		expect(SessionManager.open(file).getEntries()).toHaveLength(1);
	});

	it("canonicalizes symbolic aliases to one session and recovery lock path", () => {
		const session = SessionManager.create(dir, dir);
		const file = session.getSessionFile()!;
		const alias = join(dir, "alias.jsonl");
		symlinkSync(file, alias);
		expect(SessionManager.open(alias).getSessionFile()).toBe(file);
	});

	it("rejects multiply linked session files on open and append", () => {
		const session = SessionManager.create(dir, dir);
		const file = session.getSessionFile()!;
		const prefix = readFileSync(file, "utf8");
		const alias = join(dir, "hardlink.jsonl");
		linkSync(file, alias);
		expect(() => SessionManager.open(alias)).toThrow(/multiple hard links/i);
		expect(() => SessionManager.open(file)).toThrow(/multiple hard links/i);
		expect(() => session.appendCustomEntry("must-not-write")).toThrow(/multiple hard links/i);
		expect(session.getEntries()).toHaveLength(0);
		expect(readFileSync(file, "utf8")).toBe(prefix);
	});

	it("rejects a live append lock and leaves memory unchanged", () => {
		const session = SessionManager.create(dir, dir);
		const lock = `${session.getSessionFile()!}.append.lock`;
		writeFileSync(lock, JSON.stringify(process.pid));
		expect(() => session.appendCustomEntry("blocked")).toThrow();
		expect(() => reclaimSessionAppendLock(session.getSessionFile()!)).toThrow(/still running/);
		expect(session.getEntries()).toHaveLength(0);
		expect(existsSync(lock)).toBe(true);
	});

	it("keeps recovery facts in the durable branch but outside the visible transcript", () => {
		const session = SessionManager.create(dir, dir);
		const prompt = session.appendMessage({ role: "user", content: "request", timestamp: 1 });
		session.appendCustomEntry("pi-task-recovery", { status: "running" });
		session.appendCustomEntry("pi-tool-interruption", { pending: true });
		const visible = session.appendCustomEntry("extension-visible", { note: true });
		expect(session.getBranch()).toHaveLength(4);
		expect(session.buildTranscriptEntries().map((entry) => entry.id)).toEqual([prompt, visible]);
		expect(SessionManager.open(session.getSessionFile()!).getEntries()).toHaveLength(4);
	});

	it("recovers a committed prompt after the writer process is killed", () => {
		const script = join(dir, "writer.mts");
		const source = new URL("../../src/core/session-manager.ts", import.meta.url).href;
		writeFileSync(
			script,
			[
				`import { SessionManager } from ${JSON.stringify(source)};`,
				`const session = SessionManager.create(${JSON.stringify(dir)}, ${JSON.stringify(dir)});`,
				'session.appendMessage({ role: "user", content: "accepted before crash", timestamp: 1 });',
				'process.kill(process.pid, "SIGKILL");',
			].join("\n"),
		);
		const child = spawnSync(process.execPath, [script], { encoding: "utf8" });
		expect(child.stderr).toBe("");
		expect(child.signal).toBe("SIGKILL");
		const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
		expect(file).toBeDefined();
		const reopened = SessionManager.open(join(dir, file!));
		expect(reopened.buildSessionContext().messages).toEqual([
			{ role: "user", content: "accepted before crash", timestamp: 1 },
		]);
	});

	it("reclaims a dead writer lock while retaining the persisted history", () => {
		const session = SessionManager.create(dir, dir);
		const file = session.getSessionFile()!;
		const script = join(dir, "dead-writer.mts");
		writeFileSync(
			script,
			[
				'import { writeFileSync } from "node:fs";',
				`writeFileSync(${JSON.stringify(`${file}.append.lock`)}, JSON.stringify(process.pid));`,
			].join("\n"),
		);
		const child = spawnSync(process.execPath, [script], { encoding: "utf8" });
		expect(child.status).toBe(0);
		reclaimSessionAppendLock(file);
		session.appendCustomEntry("recovered");
		expect(SessionManager.open(file).getEntries()).toHaveLength(1);
	});
});
