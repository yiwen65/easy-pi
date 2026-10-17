import { randomUUID } from "node:crypto";
import type * as Fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteCollaborationStorage } from "../../subagent/src/collaboration-storage.ts";
import { CollaborationStore } from "../../subagent/src/collaboration-store.ts";
import { SessionManager } from "../src/core/session-manager.ts";

vi.mock("fs", async (original) => {
	const fs = await original<typeof Fs>();
	return { ...fs, openSync: vi.fn(fs.openSync), mkdirSync: vi.fn(fs.mkdirSync) };
});
let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-session-open-deleted-team-")));
});
afterEach(() => {
	vi.mocked(openSync).mockRestore();
	vi.mocked(mkdirSync).mockRestore();
	rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const rootSessionId = "retained-team";
	const directory = join(root, "teams", rootSessionId);
	const store = new CollaborationStore({ path: join(directory, "registry.sqlite"), cwd: root, rootSessionId });
	const childId = randomUUID();
	const childDirectory = join(directory, childId);
	const manager = SessionManager.create(root, childDirectory, { id: "retained.child" });
	const file = manager.getSessionFile()!;
	const snapshot = store.read();
	snapshot.agents.push({
		id: childId,
		path: "/root/child",
		parent: "/root",
		model: { provider: "faux", id: "one", thinkingLevel: "off" },
		status: "completed",
		turnId: randomUUID(),
		sessionFile: basename(file),
	});
	store.commit(snapshot);
	store.close();
	const options = { agentDir: root, rootSessionId, dryRun: false };
	return {
		directory,
		childDirectory,
		manager,
		file,
		options,
		marker: join(root, "teams", `.${rootSessionId}.deleted.json`),
		quarantine: join(root, "teams", `.${rootSessionId}.deleting`),
	};
}

describe("SessionManager native team deletion intent", () => {
	it("does not recreate a deleted native child when directly opened, preserving the compact tombstone retry", () => {
		const f = fixture();
		expect(deleteCollaborationStorage(f.options).status).toBe("deleted");
		expect(JSON.parse(readFileSync(f.marker, "utf8")).entries).toEqual([]);
		expect(() => SessionManager.open(f.file)).toThrow(/deletion/);
		expect(existsSync(f.directory)).toBe(false);
		expect(deleteCollaborationStorage(f.options).status).toBe("already_deleted");
	});

	it("refuses create and newSession in deleted native history before mkdir or writing", () => {
		const f = fixture();
		deleteCollaborationStorage(f.options);
		vi.mocked(mkdirSync).mockClear();
		vi.mocked(openSync).mockClear();
		expect(() => SessionManager.create(root, f.childDirectory)).toThrow(/deletion/);
		expect(() => f.manager.newSession()).toThrow(/deletion/);
		expect(vi.mocked(mkdirSync)).not.toHaveBeenCalled();
		expect(vi.mocked(openSync)).not.toHaveBeenCalled();
		expect(existsSync(f.directory)).toBe(false);
	});

	it.each(["missing", "empty", "invalid"])(
		"never initializes a %s native file while the registry remains",
		(state) => {
			const f = fixture();
			if (state === "missing") unlinkSync(f.file);
			else writeFileSync(f.file, state === "empty" ? "" : "not a session\n");
			const before = existsSync(f.file) ? readFileSync(f.file, "utf8") : undefined;
			expect(() => SessionManager.open(f.file)).toThrow(/missing|valid|corrupt/i);
			expect(existsSync(f.file) ? readFileSync(f.file, "utf8") : undefined).toBe(before);
		},
	);

	it("preserves ordinary missing-path initialization", () => {
		const file = join(root, "ordinary", "new.jsonl");
		const manager = SessionManager.open(file);
		expect(manager.getHeader()).toMatchObject({ type: "session", id: expect.any(String) });
		expect(existsSync(file)).toBe(true);
	});

	it("does not recreate a native child if deletion happens while its header fd is being read", () => {
		const f = fixture();
		const original = vi.mocked(openSync).getMockImplementation()!;
		let deleted = false;
		vi.mocked(openSync).mockImplementation((path, flags, mode) => {
			const fd = original(path, flags, mode);
			if (!deleted && String(path) === f.file && flags === "r") {
				deleted = true;
				expect(deleteCollaborationStorage(f.options).status).toBe("deleted");
			}
			return fd;
		});
		expect(() => SessionManager.open(f.file)).toThrow(/deletion|ENOENT/);
		expect(deleted).toBe(true);
		expect(existsSync(f.directory)).toBe(false);
	});

	it("refuses quarantined source history before reading its JSONL", () => {
		const f = fixture();
		writeFileSync(f.marker, "{}\n");
		renameSync(f.directory, f.quarantine);
		vi.mocked(openSync).mockClear();
		const file = join(f.quarantine, basename(f.childDirectory), basename(f.file));
		expect(() => SessionManager.open(file)).toThrow(/quarantined/);
		expect(vi.mocked(openSync)).not.toHaveBeenCalled();
		expect(readdirSync(dirname(file))).toEqual([basename(file)]);
	});

	it("checks deletion intent before creating an append lock for an already-open manager", () => {
		const f = fixture();
		writeFileSync(f.marker, "{}\n");
		const original = readFileSync(f.file, "utf8");
		vi.mocked(openSync).mockClear();
		expect(() => f.manager.appendCustomEntry("must-not-commit")).toThrow(/deletion/);
		expect(vi.mocked(openSync)).not.toHaveBeenCalled();
		expect(readFileSync(f.file, "utf8")).toBe(original);
	});

	it("checks deletion intent again inside the append lock before writing", () => {
		const f = fixture();
		const before = readFileSync(f.file, "utf8");
		const original = vi.mocked(openSync).getMockImplementation()!;
		vi.mocked(openSync).mockImplementation((path, flags, mode) => {
			const fd = original(path, flags, mode);
			if (String(path) === `${f.file}.append.lock`) writeFileSync(f.marker, "{}\n");
			return fd;
		});
		expect(() => f.manager.appendCustomEntry("must-not-commit")).toThrow(/deletion/);
		expect(readFileSync(f.file, "utf8")).toBe(before);
		expect(existsSync(`${f.file}.append.lock`)).toBe(false);
	});

	it("does not recursively recreate a native team moved between directory admission and mkdir", () => {
		const f = fixture();
		const nextChild = join(f.directory, randomUUID());
		const original = vi.mocked(mkdirSync).getMockImplementation()!;
		let moved = false;
		vi.mocked(mkdirSync).mockImplementation((path, options) => {
			if (String(path) === nextChild && !moved) {
				moved = true;
				writeFileSync(f.marker, "{}\n");
				renameSync(f.directory, f.quarantine);
			}
			return original(path, options);
		});
		expect(() => SessionManager.create(root, nextChild)).toThrow();
		expect(moved).toBe(true);
		expect(existsSync(f.directory)).toBe(false);
	});

	it.each([false, true])(
		"cleans only its still-empty child moved after mkdir succeeds (populated=%s)",
		(populated) => {
			const f = fixture();
			const manifest: Array<{ path: string; kind: "directory" | "file"; dev: number; ino: number }> = [];
			const capture = (path: string) => {
				const info = lstatSync(path);
				manifest.push({
					path: relative(f.directory, path),
					kind: info.isDirectory() ? "directory" : "file",
					dev: info.dev,
					ino: info.ino,
				});
				if (info.isDirectory()) for (const name of readdirSync(path)) capture(join(path, name));
			};
			capture(f.directory);
			const nextChild = join(f.directory, randomUUID());
			const movedChild = join(f.quarantine, basename(nextChild));
			const original = vi.mocked(mkdirSync).getMockImplementation()!;
			vi.mocked(mkdirSync).mockImplementation((path, options) => {
				const result = original(path, options);
				if (String(path) === nextChild) {
					if (populated) writeFileSync(join(nextChild, "preserve.txt"), "unrelated user data");
					// Equivalent to intent captured just before this mkdir, followed by isolation.
					writeFileSync(
						f.marker,
						JSON.stringify({
							kind: "pi-team-deletion",
							version: 1,
							rootSessionId: f.options.rootSessionId,
							directory: f.directory,
							state: "deleting",
							entries: manifest,
						}),
					);
					renameSync(f.directory, f.quarantine);
				}
				return result;
			});
			expect(() => SessionManager.create(root, nextChild)).toThrow(/deletion/);
			expect(existsSync(f.directory)).toBe(false);
			if (populated) {
				expect(readFileSync(join(movedChild, "preserve.txt"), "utf8")).toBe("unrelated user data");
				expect(() => deleteCollaborationStorage(f.options)).toThrow(/proof/);
			} else {
				expect(existsSync(movedChild)).toBe(false);
				expect(deleteCollaborationStorage(f.options).status).toBe("deleted");
			}
		},
	);

	it("does not publish or retain its temporary file when the team is isolated after write admission", () => {
		const f = fixture();
		const original = vi.mocked(openSync).getMockImplementation()!;
		let moved = false;
		vi.mocked(openSync).mockImplementation((path, flags, mode) => {
			const fd = original(path, flags, mode);
			if (!moved && String(path).startsWith(f.childDirectory) && String(path).endsWith(".tmp")) {
				moved = true;
				writeFileSync(f.marker, "{}\n");
				renameSync(f.directory, f.quarantine);
			}
			return fd;
		});
		expect(() => f.manager.newSession()).toThrow(/deletion/);
		expect(moved).toBe(true);
		expect(existsSync(f.directory)).toBe(false);
		expect(readdirSync(join(f.quarantine, basename(f.childDirectory)))).toEqual([basename(f.file)]);
	});

	it("does not retain an append lock when isolation happens during lock admission", () => {
		const f = fixture();
		const original = vi.mocked(openSync).getMockImplementation()!;
		vi.mocked(openSync).mockImplementation((path, flags, mode) => {
			const fd = original(path, flags, mode);
			if (String(path) === `${f.file}.append.lock`) {
				writeFileSync(f.marker, "{}\n");
				renameSync(f.directory, f.quarantine);
			}
			return fd;
		});
		expect(() => f.manager.appendCustomEntry("must-not-commit")).toThrow(/deletion/);
		expect(existsSync(f.directory)).toBe(false);
		expect(readdirSync(join(f.quarantine, basename(f.childDirectory)))).toEqual([basename(f.file)]);
	});

	it("allows legitimate new child creation while its native team store is active", () => {
		const f = fixture();
		const store = new CollaborationStore({
			path: join(f.directory, "registry.sqlite"),
			cwd: root,
			rootSessionId: f.options.rootSessionId,
		});
		try {
			const manager = SessionManager.create(root, join(f.directory, randomUUID()));
			expect(existsSync(manager.getSessionFile()!)).toBe(true);
		} finally {
			store.close();
		}
	});
});
