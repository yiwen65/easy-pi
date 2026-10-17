import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type * as Fs from "node:fs";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteCollaborationStorage } from "../../../subagent/src/collaboration-storage.ts";
import { CollaborationStore } from "../../../subagent/src/collaboration-store.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { inspectToolOutputStorage, sweepToolOutputStorage } from "../../src/core/tool-output-storage.ts";
import { discoverToolOutputStorage } from "../../src/core/tool-output-storage-discovery.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof Fs>();
	return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});
let root: string;
const sessions: AgentSession[] = [];
const harnesses: Harness[] = [];
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-session-lease-lifecycle-")));
});
afterEach(async () => {
	vi.mocked(writeFileSync).mockRestore();
	for (const session of sessions.splice(0)) await session.shutdown();
	for (const harness of harnesses.splice(0)) {
		await harness.session.shutdown();
		harness.cleanup();
	}
	rmSync(root, { recursive: true, force: true });
});
async function fixture(id = "retained-child") {
	const substrate = await createHarness({ hfCompaction: { mode: "off" } });
	harnesses.push(substrate);
	const teamId = "original-team";
	const directory = join(root, "teams", teamId);
	const store = new CollaborationStore({ path: join(directory, "registry.sqlite"), cwd: root, rootSessionId: teamId });
	const childId = randomUUID();
	const manager = SessionManager.create(root, join(directory, childId), { id });
	const snapshot = store.read();
	snapshot.agents.push({
		id: childId,
		path: "/root/child",
		parent: "/root",
		model: { provider: "faux", id: "one", thinkingLevel: "off" },
		status: "completed",
		turnId: randomUUID(),
		sessionFile: basename(manager.getSessionFile()!),
	});
	store.commit(snapshot);
	store.close();
	const file = manager.getSessionFile()!;
	const logs = join(dirname(file), `${id}.logs`);
	const options = { agentDir: root, rootSessionId: teamId };
	const open = async (sessionFile = file, resourceLoader = createTestResourceLoader(), agentDir = root) =>
		createAgentSession({
			cwd: root,
			agentDir,
			sessionManager: SessionManager.open(sessionFile),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
			resourceLoader,
			modelRuntime: substrate.session.modelRuntime,
			model: substrate.getModel(),
		});
	return {
		directory,
		file,
		logs,
		options,
		open,
		substrate,
		marker: join(root, "teams", `.${teamId}.deleted.json`),
		quarantine: join(root, "teams", `.${teamId}.deleting`),
	};
}

describe("persistent session admission leases", () => {
	it.each([false, true])(
		"protects an SDK-opened child JSONL before any Bash or provider call, then permits deletion after shutdown (foreign=%s)",
		async (foreign) => {
			const f = await fixture();
			const { session } = await f.open(
				f.file,
				createTestResourceLoader(),
				foreign ? join(root, "other-agent") : root,
			);
			sessions.push(session);
			expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("protected");
			expect(inspectToolOutputStorage(f.logs).protectedReason).toContain("Active");
			expect(existsSync(f.file)).toBe(true);
			await session.shutdown();
			expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("deleted");
		},
	);

	it("exposes the persistent lease to a separate deletion process before any Bash", async () => {
		const f = await fixture();
		const { session } = await f.open();
		sessions.push(session);
		const worker = join(root, "inspect-deletion.mjs");
		writeFileSync(
			worker,
			`import { deleteCollaborationStorage } from ${JSON.stringify(new URL("../../../subagent/src/collaboration-storage.ts", import.meta.url).href)}; process.stdout.write(JSON.stringify(deleteCollaborationStorage({ agentDir: process.argv[2], rootSessionId: process.argv[3], dryRun: false }).status));`,
		);
		const run = () =>
			JSON.parse(
				execFileSync(process.execPath, ["--experimental-strip-types", worker, root, f.options.rootSessionId], {
					encoding: "utf8",
					env: { ...process.env, NODE_NO_WARNINGS: "1" },
				}),
			);
		expect(run()).toBe("protected");
		await session.shutdown();
		expect(run()).toBe("deleted");
	});

	it("accepts dotted session IDs for background and large foreground output and discovers their logs", async () => {
		const f = await fixture("release.v1.2");
		const { session } = await f.open();
		sessions.push(session);
		const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		const foreground = await bash.execute("dotted-output", { command: "printf '%60000s' x" });
		expect(dirname((foreground.details as { fullOutputPath: string }).fullOutputPath)).toBe(f.logs);
		const background = await bash.execute("dotted-background", { command: "printf dotted", run_in_background: true });
		const id = (background.details as { backgroundTaskId: string }).backgroundTaskId;
		expect((await session.backgroundTasks!.wait(id, 10_000)).ok).toBe(true);
		expect(session.backgroundTasks!.get(id)?.status).toBe("succeeded");
		expect(discoverToolOutputStorage({ agentDir: root, maxDurationMs: 1000 }).directories).toContain(f.logs);
	});

	it("places SDK memory logs under the bounded managed root so retention can discover and sweep them", async () => {
		const f = await fixture();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			sessionManager: SessionManager.inMemory(root, { id: "memory.v1" }),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			modelRuntime: f.substrate.session.modelRuntime,
			model: f.substrate.getModel(),
		});
		sessions.push(session);
		expect(existsSync(join(root, "tool-output"))).toBe(false);
		const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
		const result = await bash.execute("memory-output", { command: "printf '%60000s' m" });
		const file = (result.details as { fullOutputPath: string }).fullOutputPath;
		expect(dirname(dirname(file))).toBe(join(root, "tool-output"));
		const discovery = discoverToolOutputStorage({ agentDir: root, maxDurationMs: 1000 });
		expect(discovery.incomplete).toBe(false);
		expect(discovery.directories).toContain(dirname(file));
		await session.shutdown();
		expect(
			sweepToolOutputStorage(discovery.directories, { maxAgeMs: 1, now: Date.now() + 10_000, dryRun: false })
				.deleted,
		).toContain(file);
	});

	it("does not leave a live lease when construction fails before runtime initialization completes", async () => {
		const f = await fixture();
		const loader = createTestResourceLoader();
		loader.getExtensions = () => {
			throw new Error("synthetic constructor failure");
		};
		await expect(f.open(f.file, loader)).rejects.toThrow("synthetic constructor failure");
		expect(existsSync(f.logs)).toBe(false);
	});

	it("releases the eager lease if SDK finalization fails after AgentSession construction", async () => {
		const f = await fixture();
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setCodexServiceTier = () => {
			throw new Error("synthetic SDK finalization failure");
		};
		await expect(
			createAgentSession({
				cwd: root,
				agentDir: root,
				sessionManager: SessionManager.open(f.file),
				settingsManager,
				resourceLoader: createTestResourceLoader(),
				modelRuntime: f.substrate.session.modelRuntime,
				model: f.substrate.getModel(),
				codexServiceTier: "fast",
			}),
		).rejects.toThrow("synthetic SDK finalization failure");
		expect(inspectToolOutputStorage(f.logs).protectedReason).toBeUndefined();
		expect(deleteCollaborationStorage({ ...f.options, dryRun: false }).status).toBe("deleted");
	});

	it.each([
		[false, false],
		[false, true],
		[true, false],
		[true, true],
	])("rejects a tombstone published during lease admission (rename=%s, foreign=%s)", async (move, foreign) => {
		const f = await fixture();
		const original = vi.mocked(writeFileSync).getMockImplementation()!;
		let published = false;
		vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
			original(path, data, options);
			if (!published && String(path).startsWith(join(f.logs, "lease-"))) {
				published = true;
				original(f.marker, "{}\n");
				if (move) renameSync(f.directory, f.quarantine);
			}
		});
		await expect(
			f.open(f.file, createTestResourceLoader(), foreign ? join(root, "other-agent") : root),
		).rejects.toThrow(/deletion is pending or complete/);
		const parent = move ? join(f.quarantine, basename(dirname(f.file))) : dirname(f.file);
		expect(readdirSync(parent)).toEqual([basename(f.file)]);
	});

	it.each([false, true])(
		"refuses direct runtime startup from quarantined history without creating a new log directory (foreign=%s)",
		async (foreign) => {
			const f = await fixture();
			writeFileSync(f.marker, "{}\n");
			renameSync(f.directory, f.quarantine);
			const file = join(f.quarantine, basename(dirname(f.file)), basename(f.file));
			await expect(
				f.open(file, createTestResourceLoader(), foreign ? join(root, "other-agent") : root),
			).rejects.toThrow("quarantined team history");
			expect(readdirSync(dirname(file))).toEqual([basename(file)]);
		},
	);

	it("rechecks on-disk session identity after a host prepareRequest callback and before invoking the provider", async () => {
		const manager = SessionManager.create(root, root);
		const file = manager.getSessionFile()!;
		const harness = await createHarness({
			sessionManager: manager,
			hfCompaction: { mode: "off" },
			settings: { retry: { enabled: false } },
			prepareRequest: async () => {
				writeFileSync(
					file,
					readFileSync(file, "utf8").replace(manager.getSessionId(), "x".repeat(manager.getSessionId().length)),
				);
				return undefined;
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not reach provider")]);
		await harness.session.prompt("synthetic request");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("session identity changed"),
		});
	});
});
