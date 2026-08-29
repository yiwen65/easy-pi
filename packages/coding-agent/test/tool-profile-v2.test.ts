import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DirectoryReadPage,
	DirectoryReadRequest,
	EditPlan,
	FileInfo,
	MutationBackend,
	MutationCommitResult,
	ReadProvider,
	ReadV2Details,
	ResourceReader,
	ResourceReadResult,
	SearchExecutionContext,
	SearchPage,
	SearchProvider,
	SearchRequest,
	SearchV2Details,
	TextRangeReadOptions,
	TextRangeReadResult,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession, type InlineExtension } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { FffSearchProvider } from "../src/core/tools/fff-search-provider.ts";
import { createV2ToolRuntime } from "../src/core/tools/tool-profile.ts";
import { getThemeByName } from "../src/modes/interactive/theme/theme.ts";

const V2_NAMES = ["search", "read", "edit", "run"];

class TrackingSearchProvider implements SearchProvider {
	readonly id = "tracking-search";
	readonly capabilities = {
		textLiteral: false,
		textRegex: false,
		context: false,
		fuzzyFiles: false,
		glob: false,
		stableCursor: false,
		globalRanking: false,
	};
	closeCalls = 0;
	throwOnClose = false;

	async search(_request: SearchRequest, _context: SearchExecutionContext): Promise<SearchPage> {
		return { hits: [], complete: true, approximate: false, partial: false };
	}

	async close(): Promise<void> {
		this.closeCalls++;
		if (this.throwOnClose) throw new Error("search close failed");
	}
}

class TrackingReadProvider implements ReadProvider {
	readonly id = "tracking-read";
	readonly capabilities = { textRange: false, directoryPage: false, stableDirectoryCursor: false, binary: false };
	closeCalls = 0;

	async stat(_path: string): Promise<FileInfo> {
		throw new Error("not used");
	}
	async readText(_path: string, _options: TextRangeReadOptions): Promise<TextRangeReadResult> {
		throw new Error("not used");
	}
	async readDirectory(_request: DirectoryReadRequest): Promise<DirectoryReadPage> {
		throw new Error("not used");
	}
	async readBinary(_path: string): Promise<Uint8Array> {
		throw new Error("not used");
	}
	async close(): Promise<void> {
		this.closeCalls++;
	}
}

class TrackingMutationBackend implements MutationBackend {
	readonly id = "tracking-mutation";
	readonly capabilities = {
		atomicRenameSameFilesystem: false,
		fsyncFile: false,
		fsyncDirectory: false,
		preserveMode: false,
		detectCrossFilesystem: false,
		durableJournal: false,
	};
	closeCalls = 0;

	async commit(_plan: EditPlan): Promise<MutationCommitResult> {
		return { completedOperationIndexes: [], changedPaths: [], createdDirectories: [] };
	}
	async close(): Promise<void> {
		this.closeCalls++;
	}
}

class TrackingResourceReader implements ResourceReader {
	readonly id = "tracking-resource";
	closeCalls = 0;
	throwOnClose = false;

	canRead(): boolean {
		return false;
	}
	async read(): Promise<ResourceReadResult> {
		throw new Error("not used");
	}
	async close(): Promise<void> {
		this.closeCalls++;
		if (this.throwOnClose) throw new Error("resource close failed");
	}
}

describe("v2 tool profile", () => {
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-v2-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	async function createSession(
		options: {
			toolProfile?: "legacy" | "v2";
			tools?: string[];
			excludeTools?: string[];
			extensions?: InlineExtension[];
			sessionManager?: SessionManager;
			settingsManager?: SettingsManager;
			toolsV2?: CreateAgentSessionOptions["toolsV2"];
		} = {},
	) {
		const settingsManager = options.settingsManager ?? SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: options.extensions,
		});
		await resourceLoader.reload();
		return (
			await createAgentSession({
				cwd,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				resourceLoader,
				sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
				toolProfile: options.toolProfile,
				tools: options.tools,
				excludeTools: options.excludeTools,
				toolsV2: options.toolsV2,
			})
		).session;
	}

	it("rejects unknown SDK profiles instead of falling back", async () => {
		await expect(createAgentSession({ toolProfile: "future" as "v2" })).rejects.toThrow(
			"Unknown tool profile: future",
		);
	});

	it("owns factory resources across reload and keeps direct instances host-owned", async () => {
		const searches: TrackingSearchProvider[] = [];
		const reads: TrackingReadProvider[] = [];
		const backends: TrackingMutationBackend[] = [];
		const readers: TrackingResourceReader[] = [];
		const runtime = createV2ToolRuntime(cwd, {
			searchProvider: () => {
				const provider = new TrackingSearchProvider();
				searches.push(provider);
				return provider;
			},
			readProvider: () => {
				const provider = new TrackingReadProvider();
				reads.push(provider);
				return provider;
			},
			mutationBackend: () => {
				const backend = new TrackingMutationBackend();
				backends.push(backend);
				return backend;
			},
			resourceReaders: [
				() => {
					const reader = new TrackingResourceReader();
					readers.push(reader);
					return reader;
				},
			],
		});
		expect([searches.length, reads.length, backends.length, readers.length]).toEqual([1, 1, 1, 1]);

		await runtime.reload();
		expect([searches.length, reads.length, backends.length, readers.length]).toEqual([2, 2, 2, 2]);
		expect([searches[0].closeCalls, reads[0].closeCalls, backends[0].closeCalls, readers[0].closeCalls]).toEqual([
			1, 1, 1, 1,
		]);
		await runtime.close();
		await runtime.close();
		expect([searches[1].closeCalls, reads[1].closeCalls, backends[1].closeCalls, readers[1].closeCalls]).toEqual([
			1, 1, 1, 1,
		]);

		const hostSearch = new TrackingSearchProvider();
		const hostRead = new TrackingReadProvider();
		const hostBackend = new TrackingMutationBackend();
		const hostReader = new TrackingResourceReader();
		const hostRuntime = createV2ToolRuntime(cwd, {
			searchProvider: hostSearch,
			readProvider: hostRead,
			mutationBackend: hostBackend,
			resourceReaders: [hostReader],
		});
		await hostRuntime.reload();
		await hostRuntime.close();
		expect([hostSearch.closeCalls, hostRead.closeCalls, hostBackend.closeCalls, hostReader.closeCalls]).toEqual([
			0, 0, 0, 0,
		]);
	});

	it("continues lifecycle cleanup after close failures", async () => {
		const search = new TrackingSearchProvider();
		search.throwOnClose = true;
		const read = new TrackingReadProvider();
		const runtime = createV2ToolRuntime(cwd, {
			searchProvider: () => search,
			readProvider: () => read,
		});

		await runtime.close();
		expect(search.closeCalls).toBe(1);
		expect(read.closeCalls).toBe(1);
		expect(runtime.lifecycleErrors).toHaveLength(1);
		expect(runtime.lifecycleErrors[0].message).toBe("search close failed");
	});

	it("rebuilds session-owned v2 resources on session reload and closes them on dispose", async () => {
		const readers: TrackingResourceReader[] = [];
		const session = await createSession({
			toolProfile: "v2",
			toolsV2: {
				read: {
					resourceReaders: [
						() => {
							const reader = new TrackingResourceReader();
							readers.push(reader);
							return reader;
						},
					],
				},
			},
		});
		expect(readers).toHaveLength(1);
		const firstReadDefinition = session.getToolDefinition("read");

		await session.reload();
		expect(readers).toHaveLength(2);
		expect(readers[0].closeCalls).toBe(1);
		expect(session.getToolDefinition("read")).not.toBe(firstReadDefinition);
		session.dispose();
		session.dispose();
		await expect.poll(() => readers[1].closeCalls).toBe(1);
		expect(session.v2ToolLifecycleErrors).toEqual([]);
	});

	it("records session disposal failures without skipping later cleanup", async () => {
		const failing = new TrackingResourceReader();
		failing.throwOnClose = true;
		const following = new TrackingResourceReader();
		const session = await createSession({
			toolProfile: "v2",
			toolsV2: { read: { resourceReaders: [() => failing, () => following] } },
		});

		session.dispose();
		await expect.poll(() => session.v2ToolLifecycleErrors.length).toBe(1);
		expect(failing.closeCalls).toBe(1);
		expect(following.closeCalls).toBe(1);
		expect(session.v2ToolLifecycleErrors[0].message).toBe("resource close failed");
	});

	it("keeps legacy as the default and selects exactly four v2 built-ins", async () => {
		const legacy = await createSession();
		expect(legacy.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		legacy.dispose();

		const v2 = await createSession({ toolProfile: "v2" });
		expect(v2.getActiveToolNames()).toEqual(V2_NAMES);
		expect(v2.getAllTools().map((tool) => tool.name)).toEqual(V2_NAMES);
		expect(v2.systemPrompt).toContain("- search:");
		expect(v2.systemPrompt).toContain("- run:");
		expect(v2.systemPrompt).not.toContain("- bash:");
		expect(v2.getToolDefinition("search")?.parameters).toMatchObject({ required: ["query"] });
		expect(v2.getToolDefinition("read")?.parameters).toMatchObject({
			anyOf: expect.arrayContaining([
				expect.objectContaining({ required: ["path"] }),
				expect.objectContaining({ required: ["locatorId"] }),
			]),
		});
		expect(v2.getToolDefinition("edit")?.parameters).toMatchObject({
			anyOf: expect.arrayContaining([
				expect.objectContaining({ required: ["operations"] }),
				expect.objectContaining({ required: ["action", "patchId"] }),
			]),
		});
		expect(v2.getToolDefinition("run")?.parameters).toMatchObject({ required: ["command"] });
		expect(v2.getToolDefinition("run")?.renderCall).toBeTypeOf("function");
		expect(v2.systemPrompt).toContain("use one edit batch with move first");
		expect(v2.systemPrompt).toContain("Never infer absence from partial");
		expect(v2.systemPrompt).toContain("view_id/file_hash");
		expect(v2.systemPrompt).toContain("action=prepare");
		v2.dispose();
	});

	it("uses FFF as the default local v2 Search backend", async () => {
		writeFileSync(join(cwd, "AuthenticationService.ts"), "export const DEFAULT_FFF_MARKER = true;\n");
		const session = await createSession({ toolProfile: "v2" });
		const search = session.getToolDefinition("search");
		if (!search) throw new Error("v2 search definition is missing");

		const result = await search.execute(
			"default-fff-search",
			{ query: "DEFAULT_FFF_MARKER", kind: "text" },
			undefined,
			undefined,
			{} as Parameters<typeof search.execute>[4],
		);

		expect(result.details).toMatchObject({
			kind: "text",
			returnedCount: 1,
			generation: expect.stringMatching(/^fff-/),
		});
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("AuthenticationService.ts") });
		session.dispose();
	});

	it("renders compact locator, view, and prepared-patch evidence", async () => {
		writeFileSync(join(cwd, "sample.txt"), "old\n");
		const session = await createSession({ toolProfile: "v2" });
		const search = session.getToolDefinition("search");
		const read = session.getToolDefinition("read");
		const edit = session.getToolDefinition("edit");
		const renderTheme = getThemeByName("dark");
		if (!search?.renderResult || !read?.renderResult || !edit?.renderResult || !renderTheme) {
			throw new Error("v2 renderers are unavailable");
		}
		const renderContext = {
			args: {},
			toolCallId: "render",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
		};
		const searchResult = await search.execute(
			"search",
			{ query: "old", path: "sample.txt" },
			undefined,
			undefined,
			{} as Parameters<typeof search.execute>[4],
		);
		const searchDetails = searchResult.details as SearchV2Details;
		searchDetails.locators[0].match = "\x1b[?1049h old";
		const searchComponent = search.renderResult(
			searchResult,
			{ expanded: false, isPartial: false },
			renderTheme,
			renderContext as Parameters<typeof search.renderResult>[3],
		);
		const renderedSearch = searchComponent.render(120).join("\n");
		expect(renderedSearch).toContain("loc_");
		expect(renderedSearch).not.toContain("\x1b[?1049h");

		const readResult = await read.execute(
			"read",
			{ locatorId: searchDetails.locators[0].locatorId, maxLines: 1 },
			undefined,
			undefined,
			{} as Parameters<typeof read.execute>[4],
		);
		const readDetails = readResult.details as ReadV2Details;
		if (readDetails.lines) readDetails.lines[0] = "\x1b[?1049h old";
		const readComponent = read.renderResult(
			readResult,
			{ expanded: false, isPartial: false },
			renderTheme,
			renderContext as Parameters<typeof read.renderResult>[3],
		);
		const renderedRead = readComponent.render(120).join("\n");
		expect(renderedRead).toContain("view_");
		expect(renderedRead).not.toContain("\x1b[?1049h");

		const prepared = await edit.execute(
			"prepare",
			{
				action: "prepare",
				operations: [
					{
						kind: "update",
						path: "sample.txt",
						oldText: "old",
						newText: "new",
						viewId: readDetails.viewId,
						expectedFileHash: readDetails.fileHash,
						range: { startLine: 1, endLine: 1 },
					},
				],
			},
			undefined,
			undefined,
			{} as Parameters<typeof edit.execute>[4],
		);
		const editComponent = edit.renderResult(
			prepared,
			{ expanded: false, isPartial: false },
			renderTheme,
			renderContext as Parameters<typeof edit.renderResult>[3],
		);
		const renderedEdit = editComponent.render(120).join("\n");
		expect(renderedEdit).toContain("prepared patch_");
		expect(renderedEdit).toContain("workspace unchanged");
		expect(readFileSync(join(cwd, "sample.txt"), "utf8")).toBe("old\n");
		session.dispose();
	});

	it("advertises exactly one explicitly selected edit dialect", async () => {
		const replacement = await createSession({
			toolProfile: "v2",
			toolsV2: { edit: { dialect: "replacement" } },
		});
		expect(replacement.getToolDefinition("edit")?.parameters).toMatchObject({
			anyOf: expect.arrayContaining([
				expect.objectContaining({ required: ["path", "edits"] }),
				expect.objectContaining({ required: ["action", "patchId"] }),
			]),
		});
		replacement.dispose();

		const patch = await createSession({ toolProfile: "v2", toolsV2: { edit: { dialect: "patch" } } });
		expect(patch.getToolDefinition("edit")?.parameters).toMatchObject({
			anyOf: expect.arrayContaining([
				expect.objectContaining({ required: ["patch"] }),
				expect.objectContaining({ required: ["action", "patchId"] }),
			]),
		});
		patch.dispose();
	});

	it("accepts a host-owned opt-in FFF provider without changing the default profile", async () => {
		writeFileSync(join(cwd, "AuthenticationService.ts"), "export const auth = true;\n");
		const provider = new FffSearchProvider(new NodeExecutionEnv({ cwd }));
		let session: Awaited<ReturnType<typeof createSession>> | undefined;
		try {
			session = await createSession({ toolProfile: "v2", toolsV2: { search: { provider } } });
			const search = session.getToolDefinition("search");
			if (!search) throw new Error("v2 search definition is missing");
			const result = await search.execute(
				"fff-search",
				{ query: "authentcationservice", kind: "files" },
				undefined,
				undefined,
				{} as Parameters<typeof search.execute>[4],
			);
			expect(result.details).toMatchObject({ kind: "files", returnedCount: 1 });
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("AuthenticationService.ts") });
		} finally {
			session?.dispose();
			await provider.close();
		}
	});

	it("executes v2 bounded reads against the workspace source Node environment", async () => {
		writeFileSync(join(cwd, "sample.txt"), "first\nsecond\nthird\n");
		const session = await createSession({ toolProfile: "v2" });
		const read = session.getToolDefinition("read");
		if (!read) throw new Error("v2 read definition is missing");

		const result = await read.execute(
			"read-source-env",
			{ path: "sample.txt", offset: 2, limit: 1 },
			undefined,
			undefined,
			{} as Parameters<typeof read.execute>[4],
		);

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringMatching(
				/^\[view_id=view_[^ ]+ snapshot_id=snap_[^ ]+ file_hash=sha256:[a-f0-9]{64}\]\n2\tsecond\n\n\[Truncated: continue with startLine=3\.\]$/,
			),
		});
		expect(result.details).toMatchObject({
			viewId: expect.stringMatching(/^view_/),
			range: [2, 2],
			nextOffset: 3,
		});
		session.dispose();
	});

	it("applies the configured command prefix and current PI session environment to run", async () => {
		const staleEnvironment = {
			PI_SESSION_ID: process.env.PI_SESSION_ID,
			PI_SESSION_FILE: process.env.PI_SESSION_FILE,
			PI_PROVIDER: process.env.PI_PROVIDER,
			PI_MODEL: process.env.PI_MODEL,
			PI_REASONING_LEVEL: process.env.PI_REASONING_LEVEL,
		};
		Object.assign(process.env, {
			PI_SESSION_ID: "stale-session",
			PI_SESSION_FILE: "stale-file",
			PI_PROVIDER: "stale-provider",
			PI_MODEL: "stale-model",
			PI_REASONING_LEVEL: "stale-reasoning",
		});
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setShellCommandPrefix("export PI_PREFIX_MARKER=prefix-first");
		const sessionManager = SessionManager.inMemory(cwd);
		const session = await createSession({ toolProfile: "v2", settingsManager, sessionManager });

		try {
			const run = session.getToolDefinition("run");
			if (!run) throw new Error("v2 run definition is missing");
			const extensionContext = {
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				thinkingLevel: "high",
				sessionManager,
			} as unknown as Parameters<typeof run.execute>[4];
			const execute = (toolCallId: string) =>
				run.execute(
					toolCallId,
					{
						command: `printf "%s|%s|%s|%s|%s|%s" "$PI_PREFIX_MARKER" "$PI_SESSION_ID" "\${PI_SESSION_FILE-unset}" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"`,
					},
					undefined,
					undefined,
					extensionContext,
				);

			const first = await execute("run-session-env-first");
			const environmentSuffix = `${sessionManager.getSessionId()}|unset|anthropic|claude-sonnet-4-5|high`;
			expect(first.content[0]).toMatchObject({ text: `prefix-first|${environmentSuffix}\n\nexit 0` });

			settingsManager.setShellCommandPrefix("export PI_PREFIX_MARKER=prefix-second");
			const second = await execute("run-session-env-second");
			expect(second.content[0]).toMatchObject({ text: `prefix-second|${environmentSuffix}\n\nexit 0` });
			expect(session.systemPrompt).toContain("inspect PI_* environment variables");
		} finally {
			session.dispose();
			for (const [name, value] of Object.entries(staleEnvironment)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("applies allowlist, denylist, and extension overrides after profile selection", async () => {
		const session = await createSession({
			toolProfile: "v2",
			tools: ["search", "run"],
			excludeTools: ["run"],
			extensions: [
				(pi) =>
					pi.registerTool({
						name: "search",
						label: "override",
						description: "extension search override",
						parameters: Type.Object({ query: Type.String() }),
						execute: async () => ({ content: [{ type: "text", text: "override" }], details: {} }),
					}),
			],
		});
		expect(session.getActiveToolNames()).toEqual(["search"]);
		expect(session.getToolDefinition("search")?.description).toBe("extension search override");
		expect(session.getToolDefinition("bash")).toBeUndefined();
		session.dispose();
	});

	it("does not persist v2 across session recreation", async () => {
		const sessionManager = SessionManager.inMemory(cwd);
		const v2 = await createSession({ toolProfile: "v2", sessionManager });
		expect(v2.getActiveToolNames()).toEqual(V2_NAMES);
		v2.dispose();

		const resumedWithoutProfile = await createSession({ sessionManager });
		expect(resumedWithoutProfile.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		resumedWithoutProfile.dispose();
	});
});
