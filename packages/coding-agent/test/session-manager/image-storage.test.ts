import type * as Fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ImageContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	appendFileSync,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { exportFromFile } from "../../src/core/export-html/index.ts";
import { listBranchImageSources, readBranchImageSource } from "../../src/core/images/attachments.ts";
import { type ImageAssetRef, ImageSourceStore, imageAssetsDirectory } from "../../src/core/images/source-store.ts";
import { getImageSourceMetadata } from "../../src/core/images/storage-codec.ts";
import {
	type CustomEntry,
	type FileEntry,
	loadEntriesFromFile,
	migrateSessionEntries,
	parseSessionEntries,
	rewriteSessionRecoveryFile,
	SessionManager,
	writePortableSessionFile,
} from "../../src/core/session-manager.ts";
import { flushSessionSummaries } from "../../src/core/session-summary-index.ts";
import type { TaskRecoveryState } from "../../src/core/task-recovery.ts";

vi.mock("fs", async (original) => {
	const fs = await original<typeof Fs>();
	return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) };
});

const image = (value = "derivative"): ImageContent => ({
	type: "image",
	mimeType: "image/png",
	data: Buffer.from(value).toString("base64"),
});
const prompt = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 1 });
const tool = (content: ToolResultMessage["content"]): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: "call",
	toolName: "read",
	content,
	isError: false,
	timestamp: 2,
	details: { evidence: "preserved" },
});
function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "opaque", thinkingSignature: "signature" },
			{ type: "toolCall", id: "call", name: "read", arguments: { image: image("opaque-argument") } },
		],
		api: "anthropic-messages",
		provider: "test",
		model: "one",
		stopReason: "toolUse",
		timestamp: 2,
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
function recovery(attached: ImageContent): TaskRecoveryState {
	return {
		version: 2,
		id: "task",
		status: "interrupted",
		sourceLeafId: null,
		prompt: [prompt([{ type: "text", text: "large field".repeat(100) }, attached])],
		promptEntryIds: ["input"],
		queued: [{ kind: "followUp", messages: [prompt([attached])], entryIds: ["queued"] }],
		retryAttempt: 0,
		step: {
			sourceLeafId: null,
			message: assistant(),
			items: assistant().content.map((block, index) => ({ index, block })),
		},
		tools: [
			{
				call: { type: "toolCall", id: "call", name: "read", arguments: { payload: image("opaque-tool-argument") } },
				safe: true,
				dispatched: true,
				result: tool([attached]),
				resultEntryId: "result",
			},
		],
		suspendedTasks: [
			{
				leafId: "anchor",
				state: {
					version: 2,
					id: "paused",
					status: "interrupted",
					sourceLeafId: null,
					prompt: [prompt([attached])],
					promptEntryIds: ["paused-input"],
					queued: [{ kind: "steer", messages: [prompt([attached])], entryIds: ["paused-queued"] }],
					retryAttempt: 0,
					tools: [
						{
							call: { type: "toolCall", id: "paused-call", name: "read", arguments: {} },
							safe: true,
							dispatched: true,
							result: tool([attached]),
						},
					],
				},
			},
		],
	};
}
function physical(file: string): FileEntry[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as FileEntry);
}

describe("v4 session-local image storage", () => {
	let dir: string;
	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-image-storage-")));
		vi.stubEnv(ENV_AGENT_DIR, join(dir, "agent"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		flushSessionSummaries();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes explicit v4 refs, hydrates every public read and keeps opaque payloads unchanged", () => {
		const manager = SessionManager.create(dir, dir);
		const attached = manager.attachImageSource(image(), image("original"), {
			originalWidth: 20,
			originalHeight: 10,
			width: 2,
			height: 1,
		});
		expect(getImageSourceMetadata(attached)).toMatchObject({ version: 1, dimensions: { width: 2 } });
		manager.appendMessage(prompt([attached]));
		manager.appendMessage(assistant());
		manager.appendMessage(tool([attached]));
		manager.appendCustomMessageEntry("custom", [attached], true, { opaque: image("opaque-details") });
		manager.appendCompactionCheckpoint([prompt([attached])], 1);
		manager.appendCustomEntry("opaque", { image: image("opaque-custom") });
		const file = manager.getSessionFile()!;
		expect(physical(file)[0]).toMatchObject({ version: 4, imageEncoding: "assets-v1" });
		expect(readFileSync(file, "utf8")).toContain('"imageAsset"');
		for (const entries of [
			manager.getEntries(),
			SessionManager.open(file).getEntries(),
			loadEntriesFromFile(file).slice(1),
			parseSessionEntries(readFileSync(file, "utf8"), file).slice(1),
		]) {
			expect(entries).toEqual(manager.getEntries());
			expect(JSON.stringify(entries)).not.toContain("imageAsset");
		}
		expect(manager.getEntries()[1]).toMatchObject({ message: assistant() });
		expect(manager.readImageSource(getImageSourceMetadata(attached)!.asset)).toEqual(Buffer.from("original"));
		expect(manager.auditImageAssets()).toMatchObject({ missing: [], orphan: [] });
		expect(manager.auditImageAssets().reachable).toHaveLength(2);
	});

	it("canonicalizes symbolic session aliases and checks the owning header during lazy recovery reads", () => {
		const manager = SessionManager.create(dir, dir);
		const attached = manager.attachImageSource(image(), image("original"));
		manager.appendMessage(prompt([attached]));
		const id = manager.appendCustomEntry("pi-task-recovery", recovery(attached));
		const file = manager.getSessionFile()!;
		const alias = join(dir, "alias.jsonl");
		symlinkSync(file, alias);
		expect(loadEntriesFromFile(alias)).toEqual(loadEntriesFromFile(file));
		expect(SessionManager.forkFrom(alias, dir, join(dir, "fork-alias")).buildSessionContext().messages).toEqual([
			prompt([attached]),
		]);
		const opened = SessionManager.open(file);
		const before = readFileSync(file, "utf8");
		writeFileSync(file, before.replace(manager.getSessionId(), "f".repeat(manager.getSessionId().length)));
		const entry = opened.getEntry(id) as CustomEntry<TaskRecoveryState>;
		expect(entry.data?.prompt[0]).toMatchObject({
			content: [
				{ type: "text", text: expect.any(String) },
				{ type: "text", text: expect.stringContaining("Image omitted locally") },
			],
		});
	});

	it("encodes recovery before field dedup and hydrates queued, step and suspended message fields across JSON cloning", () => {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage(prompt("anchor"), "anchor");
		const attached = manager.attachImageSource(image(), image("original"));
		const state = recovery(attached);
		manager.appendCustomEntry("pi-task-recovery", state);
		const second = manager.appendCustomEntry("pi-task-recovery", state);
		manager.appendCustomEntry("pi-tool-interruption", {
			message: tool([attached]),
			args: image("opaque-interruption"),
		});
		const file = manager.getSessionFile()!;
		expect(readFileSync(file, "utf8")).toContain('"recoveryStorage"');
		for (const selected of [manager, SessionManager.open(file)]) {
			const entry = selected.getEntry(second) as CustomEntry<TaskRecoveryState>;
			expect(JSON.parse(JSON.stringify(entry.data))).toEqual(state);
			const copy = entry.data!;
			copy.prompt.length = 0;
			expect(entry.data).toEqual(state);
		}
		expect(manager.auditImageAssets().reachable).toHaveLength(2);
	});

	it.each([1, 2, 3])("does not opt existing v%s files into sidecars or rewrite the source on open", (version) => {
		const file = join(dir, "legacy.jsonl");
		const header = { type: "session", version, id: "legacy", cwd: dir, timestamp: "2025-01-01T00:00:00Z" };
		const bytes = `${JSON.stringify(header)}\n`;
		writeFileSync(file, bytes);
		const manager = SessionManager.open(file);
		expect(readFileSync(file, "utf8")).toBe(bytes);
		expect(manager.getHeader()?.version).toBe(3);
		expect(manager.attachImageSource(image(), image("original"))).toEqual(image());
		manager.appendMessage(prompt([image()]));
		expect(physical(file)[0]).toMatchObject({ version: 3 });
		expect(readFileSync(file, "utf8")).not.toContain("imageAsset");
		expect(existsSync(imageAssetsDirectory(file))).toBe(false);
		const detached = [header] as FileEntry[];
		migrateSessionEntries(detached);
		expect(detached[0]).toMatchObject({ version: 3 });
	});

	it.each(["missing", "corrupt", "symlink"])(
		"omits a %s derivative locally, preserving tool facts and subsequent turns",
		(kind) => {
			const manager = SessionManager.create(dir, dir);
			manager.appendMessage(tool([{ type: "text", text: "executed exactly once" }, image()]));
			const file = manager.getSessionFile()!;
			const record = physical(file)[1] as unknown as { message: { content: Array<{ imageAsset?: ImageAssetRef }> } };
			const ref = record.message.content[1].imageAsset!;
			const path = join(imageAssetsDirectory(file), ref.sha256);
			if (kind === "corrupt") writeFileSync(path, Buffer.alloc(ref.byteLength));
			else {
				unlinkSync(path);
				if (kind === "symlink") {
					const target = join(dir, "foreign");
					writeFileSync(target, "derivative");
					symlinkSync(target, path);
				}
			}
			const opened = SessionManager.open(file);
			expect(opened.buildSessionContext().messages[0]).toMatchObject({
				...tool([]),
				content: [
					{ type: "text", text: "executed exactly once" },
					{ type: "text", text: expect.stringContaining("Image omitted locally: storage_") },
				],
			});
			opened.appendMessage(prompt("normal next turn"));
			expect(SessionManager.open(file).buildSessionContext().messages).toHaveLength(2);
			expect(opened.auditImageAssets().missing).toEqual([ref.sha256]);
		},
	);

	it("persists bounded malformed tool evidence inline in canonical and recovery history", () => {
		const manager = SessionManager.create(dir, dir);
		const bad: ImageContent = { type: "image", mimeType: "image/png", data: "%%%invalid_base64%%%" };
		manager.appendMessage(tool([{ type: "text", text: "effect committed" }, bad]));
		const state = recovery(bad);
		manager.appendCustomEntry("pi-task-recovery", state);
		const second = manager.appendCustomEntry("pi-task-recovery", state);
		manager.appendMessage(prompt("next"));
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(reopened.getEntries()[0]).toMatchObject({
			message: tool([{ type: "text", text: "effect committed" }, bad]),
		});
		expect((reopened.getEntry(second) as CustomEntry).data).toEqual(state);
		expect(reopened.buildSessionContext().messages).toHaveLength(2);
	});

	it.each(["missing", "corrupt"])("recovers a healthy original when only its %s derivative is unavailable", (kind) => {
		const manager = SessionManager.create(dir, dir);
		const dimensions = { originalWidth: 20, originalHeight: 10, width: 2, height: 1 };
		const attached = manager.attachImageSource(image(), image("original"), dimensions);
		manager.appendMessage(tool([{ type: "text", text: "effect committed" }, attached]));
		const file = manager.getSessionFile()!;
		const record = physical(file)[1] as unknown as { message: { content: Array<{ imageAsset?: ImageAssetRef }> } };
		const derivative = record.message.content[1].imageAsset!;
		const path = join(imageAssetsDirectory(file), derivative.sha256);
		if (kind === "missing") unlinkSync(path);
		else writeFileSync(path, Buffer.alloc(derivative.byteLength));
		const reopened = SessionManager.open(file);
		const result = reopened.buildSessionContext().messages[0];
		if (result.role !== "toolResult") throw new Error("Expected tool result content blocks");
		const recovered = result.content[1];
		const metadata = getImageSourceMetadata(recovered)!;
		expect(recovered).toMatchObject(image("original"));
		expect(metadata.dimensions).toEqual({ ...dimensions, width: 20, height: 10 });
		expect(reopened.readImageSource(metadata.asset)).toEqual(Buffer.from("original"));
		expect(listBranchImageSources(reopened).map((source) => source.sourceId)).toEqual([metadata.asset.sha256]);
		expect(readBranchImageSource(reopened, metadata.asset.sha256).data).toBe(image("original").data);
		expect(result).toMatchObject({ toolCallId: "call", isError: false, details: { evidence: "preserved" } });
		expect(result.content[2]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Recovered verified original"),
		});
		const fork = SessionManager.forkFrom(file, dir, join(dir, "recovered-fork"));
		rmSync(imageAssetsDirectory(file), { recursive: true });
		rmSync(file);
		expect(fork.readImageSource(metadata.asset)).toEqual(Buffer.from("original"));
		expect(readBranchImageSource(fork, metadata.asset.sha256).data).toBe(image("original").data);
		expect(SessionManager.open(fork.getSessionFile()!).buildSessionContext().messages).toEqual([result]);
	});

	it("copies original and derivative independently for branches, forks and recovery rewrites", () => {
		const manager = SessionManager.create(dir, dir);
		const attached = manager.attachImageSource(image(), image("original"));
		const id = manager.appendMessage(prompt([attached]));
		const source = manager.getSessionFile()!;
		const fork = SessionManager.forkFrom(source, dir, join(dir, "fork"));
		const rewrite = join(dir, "rewrite.jsonl");
		rewriteSessionRecoveryFile(source, rewrite);
		manager.createBranchedSession(id);
		const ref = getImageSourceMetadata(attached)!.asset;
		const originalInode = lstatSync(join(imageAssetsDirectory(source), ref.sha256)).ino;
		for (const copy of [manager, fork, SessionManager.open(rewrite)]) {
			const path = copy.getImageSourcePath(ref)!;
			expect(lstatSync(path).ino).not.toBe(originalInode);
			expect(lstatSync(path).nlink).toBe(1);
		}
		rmSync(imageAssetsDirectory(source), { recursive: true });
		rmSync(source);
		for (const copy of [manager, fork, SessionManager.open(rewrite)]) {
			expect(copy.readImageSource(ref)).toEqual(Buffer.from("original"));
			expect(SessionManager.open(copy.getSessionFile()!).buildSessionContext().messages).toEqual([
				prompt([attached]),
			]);
		}
	});

	it("makes a standalone inline portable export/import without source bundles", async () => {
		const manager = SessionManager.create(dir, dir);
		const attached = manager.attachImageSource(image(), image("original"));
		manager.appendMessage(prompt([attached]));
		manager.appendCustomEntry("pi-task-recovery", recovery(attached));
		const file = manager.getSessionFile()!;
		const exported = join(dir, "portable.jsonl");
		writePortableSessionFile(exported, [manager.getHeader()!, ...manager.getEntries()]);
		const bytes = readFileSync(exported, "utf8");
		expect(bytes).not.toMatch(/imageAsset|imageSource|assets-v1/);
		expect(existsSync(imageAssetsDirectory(exported))).toBe(false);
		const html = join(dir, "export.html");
		await exportFromFile(file, { outputPath: html });
		const rendered = readFileSync(html, "utf8");
		expect(rendered).toContain("<!DOCTYPE html>");
		const payload = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(rendered)![1];
		const inline = Buffer.from(payload, "base64").toString("utf8");
		expect(inline).not.toMatch(/imageAsset|imageSource/);
		expect(inline).toContain(image().data);
		rmSync(imageAssetsDirectory(file), { recursive: true });
		rmSync(file);
		const imported = SessionManager.open(exported);
		expect(imported.buildSessionContext().messages).toEqual([prompt([image()])]);
		expect((imported.getLeafEntry() as CustomEntry<TaskRecoveryState>).data?.queued[0].messages).toEqual([
			prompt([image()]),
		]);
	});

	it("does not publish a ref when asset persistence fails and only leaves harmless orphans on record failure", () => {
		const manager = SessionManager.create(dir, dir);
		const file = manager.getSessionFile()!;
		const before = readFileSync(file, "utf8");
		const put = vi.spyOn(ImageSourceStore.prototype, "put").mockImplementationOnce(() => {
			throw new Error("asset failpoint");
		});
		expect(() => manager.appendMessage(prompt([image()]))).toThrow(/asset failpoint/);
		expect(readFileSync(file, "utf8")).toBe(before);
		put.mockRestore();
		const ino = lstatSync(file).ino;
		const sync = vi.mocked(fsyncSync).getMockImplementation()!;
		let failed = false;
		vi.mocked(fsyncSync).mockImplementation((fd) => {
			if (!failed && fstatSync(fd).ino === ino) {
				failed = true;
				throw new Error("record failpoint");
			}
			sync(fd);
		});
		expect(() => manager.appendMessage(prompt([image()]))).toThrow(/record failpoint/);
		expect(manager.getEntries()).toHaveLength(0);
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(manager.auditImageAssets().orphan).toHaveLength(1);
		manager.appendMessage(prompt([image()]));
		expect(manager.auditImageAssets()).toMatchObject({ missing: [], orphan: [] });
	});

	it("repairs a torn append and rebinds recovery offsets without dangling refs", () => {
		const manager = SessionManager.create(dir, dir);
		const attached = manager.attachImageSource(image(), image("original"));
		const state = recovery(attached);
		manager.appendCustomEntry("pi-task-recovery", state);
		manager.appendCustomEntry("pi-task-recovery", state);
		const file = manager.getSessionFile()!;
		appendFileSync(file, '{"torn":');
		const reopened = SessionManager.open(file);
		reopened.appendCustomEntry("pi-task-recovery", state);
		expect((SessionManager.open(file).getLeafEntry() as CustomEntry).data).toEqual(state);
		expect(reopened.auditImageAssets()).toMatchObject({ missing: [], orphan: [] });
	});

	it("keeps a usable derivative and explicit local source-loss notice without poisoning recovery or repair", () => {
		const manager = SessionManager.create(dir, dir);
		const attached = manager.attachImageSource(image(), image("original"));
		manager.appendMessage(prompt([attached]));
		manager.appendCustomEntry("pi-task-recovery", recovery(attached));
		const file = manager.getSessionFile()!;
		unlinkSync(manager.getImageSourcePath(getImageSourceMetadata(attached)!.asset)!);
		appendFileSync(file, '{"torn":');
		const reopened = SessionManager.open(file);
		const expected: UserMessage["content"] = [
			image(),
			{ type: "text", text: "[Original image source unavailable locally: storage_missing.]" },
		];
		expect(reopened.buildSessionContext().messages[0]).toEqual(prompt(expected));
		const state = (reopened.getLeafEntry() as CustomEntry<TaskRecoveryState>).data!;
		reopened.appendCustomEntry("pi-task-recovery", state);
		reopened.appendMessage(prompt("normal next turn"));
		expect(SessionManager.open(file).buildSessionContext().messages).toEqual([
			prompt(expected),
			prompt("normal next turn"),
		]);
		expect(reopened.auditImageAssets().missing).toEqual([]);
	});

	it("verifies published assets before the referring record fsync", () => {
		const manager = SessionManager.create(dir, dir);
		const file = manager.getSessionFile()!;
		const identity = lstatSync(file);
		const original = vi.mocked(fsyncSync).getMockImplementation()!;
		let checked = false;
		vi.mocked(fsyncSync).mockImplementation((fd) => {
			const stat = fstatSync(fd);
			if (stat.ino === identity.ino && stat.dev === identity.dev) {
				const stored = physical(file)[1] as unknown as { message: { content: [{ imageAsset: ImageAssetRef }] } };
				expect(new ImageSourceStore(imageAssetsDirectory(file)).read(stored.message.content[0].imageAsset)).toEqual(
					Buffer.from("derivative"),
				);
				checked = true;
			}
			original(fd);
		});
		manager.appendMessage(prompt([image()]));
		expect(checked).toBe(true);
	});

	it("rejects owner replacement before reading or writing sources", () => {
		const manager = SessionManager.create(dir, dir);
		const attached = manager.attachImageSource(image(), image("original"));
		const file = manager.getSessionFile()!;
		writeFileSync(file, `${JSON.stringify({ ...manager.getHeader(), id: "foreign" })}\n`);
		expect(() => manager.readImageSource(getImageSourceMetadata(attached)!.asset)).toThrow(/owner/);
		expect(() => manager.attachImageSource(image(), image("other"))).toThrow(/owner/);
	});

	it("retains ephemeral originals through JSON clones with strict bounded capacity and reset", () => {
		const manager = SessionManager.inMemory(dir);
		const attached = manager.attachImageSource(image(), image("original"));
		const clone: unknown = JSON.parse(JSON.stringify(attached));
		const ref = getImageSourceMetadata(clone)!.asset;
		expect(manager.readImageSource(ref)).toEqual(Buffer.from("original"));
		expect(manager.getImageSourcePath(ref)).toBeUndefined();
		for (let i = 1; i < 32; i++) manager.attachImageSource(image(), image(`source-${i}`));
		expect(() => manager.attachImageSource(image(), image("overflow"))).toThrow(/capacity/);
		expect(manager.readImageSource(ref)).toEqual(Buffer.from("original"));
		manager.newSession();
		expect(() => manager.readImageSource(ref)).toThrow(/not retained/);
		const large = { ...image(), data: Buffer.alloc(17 * 1024 * 1024, 1).toString("base64") };
		manager.attachImageSource(image(), large);
		expect(() =>
			manager.attachImageSource(image(), { ...large, data: Buffer.alloc(16 * 1024 * 1024, 2).toString("base64") }),
		).toThrow(/capacity/);
	});
});
