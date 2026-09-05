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
	SearchCapabilities,
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
	readonly capabilities: SearchCapabilities = {
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
	requests: SearchRequest[] = [];

	async search(request: SearchRequest, _context: SearchExecutionContext): Promise<SearchPage> {
		this.requests.push(request);
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
		const semantics: TrackingSearchProvider[] = [];
		const reads: TrackingReadProvider[] = [];
		const backends: TrackingMutationBackend[] = [];
		const readers: TrackingResourceReader[] = [];
		const runtime = createV2ToolRuntime(cwd, {
			searchProvider: () => {
				const provider = new TrackingSearchProvider();
				searches.push(provider);
				return provider;
			},
			semanticSearchProvider: () => {
				const provider = new TrackingSearchProvider();
				semantics.push(provider);
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
		expect([searches.length, semantics.length, reads.length, backends.length, readers.length]).toEqual([
			1, 1, 1, 1, 1,
		]);

		await runtime.reload();
		expect([searches.length, semantics.length, reads.length, backends.length, readers.length]).toEqual([
			2, 2, 2, 2, 2,
		]);
		expect([
			searches[0].closeCalls,
			semantics[0].closeCalls,
			reads[0].closeCalls,
			backends[0].closeCalls,
			readers[0].closeCalls,
		]).toEqual([1, 1, 1, 1, 1]);
		await runtime.close();
		await runtime.close();
		expect([
			searches[1].closeCalls,
			semantics[1].closeCalls,
			reads[1].closeCalls,
			backends[1].closeCalls,
			readers[1].closeCalls,
		]).toEqual([1, 1, 1, 1, 1]);

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
		expect(v2.getToolDefinition("search")?.parameters).toMatchObject({
			required: ["query"],
			properties: {
				ranking: { const: "fast" },
				preferredPaths: expect.any(Object),
			},
		});
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
		expect(v2.systemPrompt).toContain("update the freshly read source before moving it in the same batch");
		expect(v2.systemPrompt).not.toContain("move first and update on the destination second");
		expect(v2.systemPrompt).toContain("Never infer absence from partial");
		expect(v2.systemPrompt).toContain("concept/semantic candidates");
		expect(v2.systemPrompt).toContain("verify candidates with structured/literal Search and Read before Edit");
		expect(v2.systemPrompt).toContain("Prefer mode and maxResultsGlobal over their aliases");
		expect(v2.systemPrompt).toContain("Compare previews to select locators");
		expect(v2.systemPrompt).toContain("Structured/semantic Search requires kind=text and context=0");
		expect(v2.systemPrompt).toContain("partial or indeterminate commit");
		expect(v2.systemPrompt).toContain("a fresh viewId supplies the file hash and permitted range");
		expect(v2.systemPrompt).toContain("Apply ordinary changes in one edit call");
		expect(v2.systemPrompt).toContain("host approval and preimage checks still run");
		expect(v2.systemPrompt).toContain("Use action=prepare when a separate pre-commit review is needed");
		expect(v2.systemPrompt).toContain("not independent post-edit verification");
		expect(v2.systemPrompt).not.toContain("then read the changed range and run");
		v2.dispose();
	});

	it("advertises exact path-only capabilities for generic execution environments", async () => {
		const session = await createSession({
			toolProfile: "v2",
			toolsV2: { executionEnv: () => new NodeExecutionEnv({ cwd }) },
		});
		expect(session.systemPrompt).toContain("This session supports path Search only");
		expect(session.systemPrompt).toContain("Do not use literal, regex, structured, or semantic Search");
		expect(session.systemPrompt).toContain("Symbol and AST reads are unavailable in this session");
		const search = session.getToolDefinition("search");
		const schema = search?.parameters as unknown as {
			properties: { kind: { anyOf: Array<{ const: string }> }; mode?: unknown };
		};
		expect(schema.properties.kind.anyOf.map((entry) => entry.const)).toEqual(["files", "glob"]);
		expect(schema.properties).not.toHaveProperty("mode");
		session.dispose();
	});

	it("keeps local text Search while explicitly disabling structured and semantic providers", async () => {
		writeFileSync(join(cwd, "text-only.ts"), "export const TEXT_ONLY_MARKER = true;\n");
		const session = await createSession({
			toolProfile: "v2",
			toolsV2: { search: { codeIndexProvider: false } },
		});
		expect(session.systemPrompt).toContain("This session supports literal/regex text and path Search");
		expect(session.systemPrompt).toContain("Symbol and AST reads are unavailable in this session");
		const search = session.getToolDefinition("search");
		if (!search) throw new Error("v2 search definition is missing");
		const schema = search.parameters as unknown as {
			properties: {
				mode?: { anyOf?: Array<{ const?: string }> };
				queryTemplate?: unknown;
				targetKind?: unknown;
			};
		};
		expect(schema.properties.mode?.anyOf?.map((entry) => entry.const)).toEqual(["literal", "regex"]);
		expect(schema.properties).not.toHaveProperty("queryTemplate");
		expect(
			(schema.properties.targetKind as { anyOf: Array<{ const: string }> }).anyOf.map((entry) => entry.const),
		).toEqual(["exact_line", "path"]);
		const result = await search.execute(
			"text-only-search",
			{ query: "TEXT_ONLY_MARKER", mode: "literal", path: "." },
			undefined,
			undefined,
			{} as Parameters<typeof search.execute>[4],
		);
		expect(result.details).toMatchObject({ returnedCount: 1, mode: "literal" });
		session.dispose();
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

	it("uses the default JS/TS index for structured Search and AST-bounded Read", async () => {
		writeFileSync(join(cwd, "service.ts"), "export class Service {\n  configure() {\n    return 42;\n  }\n}\n");
		const session = await createSession({ toolProfile: "v2" });
		const search = session.getToolDefinition("search");
		const read = session.getToolDefinition("read");
		if (!search || !read) throw new Error("v2 definitions are missing");
		const found = await search.execute(
			"structured-search",
			{ query: "Service.configure", mode: "symbol_definition", targetKind: "definition" },
			undefined,
			undefined,
			{} as Parameters<typeof search.execute>[4],
		);
		expect(found.details).toMatchObject({
			mode: "symbol_definition",
			returnedCount: 1,
			locators: [
				expect.objectContaining({
					startLine: 2,
					endLine: 4,
					matchKind: "definition",
					nodeKind: "MethodDeclaration",
				}),
			],
		});
		const details = found.details as SearchV2Details;
		const locatorView = await read.execute(
			"structured-locator-read",
			{ locatorId: details.locators[0].locatorId, beforeLines: 0, afterLines: 0 },
			undefined,
			undefined,
			{} as Parameters<typeof read.execute>[4],
		);
		expect(locatorView.details).toMatchObject({ range: [2, 4], lines: ["  configure() {", "    return 42;", "  }"] });
		const symbolView = await read.execute(
			"structured-symbol-read",
			{ path: "service.ts", mode: "symbol_body", symbol: "Service.configure" },
			undefined,
			undefined,
			{} as Parameters<typeof read.execute>[4],
		);
		expect(symbolView.details).toMatchObject({
			range: [2, 4],
			symbol: "Service.configure",
			nodeKind: "MethodDeclaration",
		});
		await expect(
			search.execute(
				"implicit-semantic",
				{ query: "service setup", queryTemplate: "concept" },
				undefined,
				undefined,
				{} as Parameters<typeof search.execute>[4],
			),
		).rejects.toMatchObject({ code: "SYMBOL_INDEX_UNAVAILABLE" });
		session.dispose();
	});

	it("routes concept templates only through an explicitly configured semantic provider", async () => {
		const semantic = new TrackingSearchProvider();
		Object.assign(semantic.capabilities, {
			stableCursor: true,
			taskRanking: true,
			scopeFilters: true,
			structuredModes: ["semantic_candidate"],
		});
		const session = await createSession({
			toolProfile: "v2",
			toolsV2: { search: { semanticProvider: semantic } },
		});
		const search = session.getToolDefinition("search");
		if (!search) throw new Error("v2 search definition is missing");
		const result = await search.execute(
			"semantic-search",
			{ query: "payment reconciliation", queryTemplate: "concept", preferredPaths: ["src/billing/**"] },
			undefined,
			undefined,
			{} as Parameters<typeof search.execute>[4],
		);
		expect(result.details).toMatchObject({
			mode: "semantic_candidate",
			queryTemplate: "concept",
			effectiveScope: { preferredPaths: ["src/billing/**"] },
		});
		expect(semantic.requests).toEqual([
			expect.objectContaining({
				mode: "semantic_candidate",
				queryTemplate: "concept",
				ranking: "task",
				preferredPaths: ["src/billing/**"],
			}),
		]);
		session.dispose();
		expect(semantic.closeCalls).toBe(0);
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

	it("projects bounded handle-only evidence and retires it after commit", async () => {
		writeFileSync(join(cwd, "sample.txt"), "old source payload\n");
		const runtime = createV2ToolRuntime(cwd);
		const { search, read, edit } = runtime.definitions;
		const found = await search.execute(
			"evidence-search",
			{ query: "old source payload", path: "sample.txt" },
			undefined,
			undefined,
			{} as Parameters<typeof search.execute>[4],
		);
		const searchDetails = found.details as SearchV2Details;
		const viewed = await read.execute(
			"evidence-read",
			{ locatorId: searchDetails.locators[0].locatorId, beforeLines: 0, afterLines: 0 },
			undefined,
			undefined,
			{} as Parameters<typeof read.execute>[4],
		);
		const readDetails = viewed.details as ReadV2Details;
		const prepared = await edit.execute(
			"evidence-prepare",
			{
				action: "prepare",
				operations: [
					{
						kind: "update",
						path: "sample.txt",
						oldText: "old source payload",
						newText: "new source payload",
						viewId: readDetails.viewId,
						range: { startLine: 1, endLine: 1 },
					},
				],
			},
			undefined,
			undefined,
			{} as Parameters<typeof edit.execute>[4],
		);
		const evidence = runtime.toolEvidenceSummary();
		expect(evidence).toContain(searchDetails.locators[0].locatorId);
		expect(evidence).toContain(readDetails.viewId);
		expect(evidence).toContain(prepared.details.patchId);
		expect(evidence).not.toContain("old source payload");
		expect(evidence).not.toContain("new source payload");
		expect(Buffer.byteLength(evidence ?? "")).toBeLessThanOrEqual(4_096);

		await edit.execute(
			"evidence-commit",
			{ action: "commit", patchId: prepared.details.patchId },
			undefined,
			undefined,
			{} as Parameters<typeof edit.execute>[4],
		);
		expect(runtime.toolEvidenceSummary()).toBeUndefined();
		await runtime.close();
	});

	it("uses preview-guided discovery and one viewId-only apply through the host approval hook", async () => {
		const before = "export const alpha = 'TARGET old';\nexport const beta = 'TARGET keep';\n";
		writeFileSync(join(cwd, "handlers.ts"), before);
		let approvals = 0;
		const runtime = createV2ToolRuntime(cwd, {
			mutationHooks: {
				beforeCommit: async (plan) => {
					approvals++;
					expect(plan.operations).toHaveLength(1);
					expect(readFileSync(join(cwd, "handlers.ts"), "utf8")).toBe(before);
				},
			},
		});
		try {
			const { search, read, edit } = runtime.definitions;
			const extensionContext = {} as Parameters<typeof search.execute>[4];
			const found = await search.execute(
				"discover",
				{ query: "TARGET", path: "handlers.ts", mode: "literal", maxResultsGlobal: 2 },
				undefined,
				undefined,
				extensionContext,
			);
			expect(found.content[0]).toMatchObject({ text: expect.stringContaining('preview="export const alpha') });
			expect(found.content[0]).toMatchObject({ text: expect.stringContaining('preview="export const beta') });
			const locators = (found.details as SearchV2Details).locators;
			const selected = locators.find((locator) => locator.startLine === 1);
			if (!selected) throw new Error("Expected the alpha locator");
			const viewed = await read.execute(
				"inspect",
				{ locatorId: selected.locatorId, beforeLines: 0, afterLines: 0 },
				undefined,
				undefined,
				extensionContext,
			);
			const update = {
				operations: [
					{
						kind: "update",
						path: "handlers.ts",
						oldText: "TARGET old",
						newText: "TARGET new",
						viewId: (viewed.details as ReadV2Details).viewId,
					},
				],
			};
			const applied = await edit.execute("apply", update, undefined, undefined, extensionContext);
			expect(applied.details).toMatchObject({ status: "applied" });
			expect(applied.content[0]).toMatchObject({
				text: expect.stringContaining("-1 export const alpha = 'TARGET old';"),
			});
			expect(applied.content[0]).toMatchObject({
				text: expect.stringContaining("+1 export const alpha = 'TARGET new';"),
			});
			expect(applied.content[0]).toMatchObject({ text: expect.stringContaining("not an independent post-edit") });
			expect(readFileSync(join(cwd, "handlers.ts"), "utf8")).toBe(before.replace("TARGET old", "TARGET new"));
			expect(runtime.toolEvidenceSummary()).toBeUndefined();
			await expect(edit.execute("stale", update, undefined, undefined, extensionContext)).rejects.toMatchObject({
				code: "STALE_VIEW",
			});
			expect(approvals).toBe(1);
		} finally {
			await runtime.close();
		}
	});

	it("does not bypass host denial when action is omitted", async () => {
		writeFileSync(join(cwd, "denied.txt"), "old\n");
		let approvals = 0;
		let notifications = 0;
		const runtime = createV2ToolRuntime(cwd, {
			mutationHooks: {
				beforeCommit: async () => {
					approvals++;
					throw new Error("Denied by host");
				},
				afterCommit: async () => {
					notifications++;
				},
			},
		});
		try {
			const { read, edit } = runtime.definitions;
			const extensionContext = {} as Parameters<typeof read.execute>[4];
			const viewed = await read.execute("read", { path: "denied.txt" }, undefined, undefined, extensionContext);
			await expect(
				edit.execute(
					"denied",
					{
						operations: [
							{
								kind: "update",
								path: "denied.txt",
								oldText: "old",
								newText: "new",
								viewId: viewed.details.viewId,
							},
						],
					},
					undefined,
					undefined,
					extensionContext,
				),
			).rejects.toMatchObject({
				code: "EDIT_ROLLED_BACK",
				message: expect.stringContaining("Mutation approval failed before commit. No files were changed."),
				cause: expect.objectContaining({ message: "Denied by host" }),
			});
			expect(readFileSync(join(cwd, "denied.txt"), "utf8")).toBe("old\n");
			expect(approvals).toBe(1);
			expect(notifications).toBe(0);
		} finally {
			await runtime.close();
		}
	});

	it.each(["apply", "commit"] as const)("preserves pending acceptance in production %s feedback", async (action) => {
		writeFileSync(join(cwd, "overlay.txt"), "old\n");
		const backend = new TrackingMutationBackend();
		let commits = 0;
		backend.commit = async () => {
			commits++;
			return {
				completedOperationIndexes: [0],
				changedPaths: [join(cwd, "overlay.txt")],
				createdDirectories: [],
				pendingAcceptance: { id: "overlay_1", workspacePath: "/overlay/workspace" },
			};
		};
		const runtime = createV2ToolRuntime(cwd, { mutationBackend: backend });
		try {
			const { read, edit } = runtime.definitions;
			const extensionContext = {} as Parameters<typeof read.execute>[4];
			const viewed = await read.execute("read", { path: "overlay.txt" }, undefined, undefined, extensionContext);
			const input = {
				operations: [
					{ kind: "update", path: "overlay.txt", oldText: "old", newText: "new", viewId: viewed.details.viewId },
				],
			};
			const prepared =
				action === "commit"
					? await edit.execute("prepare", { ...input, action: "prepare" }, undefined, undefined, extensionContext)
					: undefined;
			const result = await edit.execute(
				action,
				prepared ? { action: "commit", patchId: prepared.details.patchId } : input,
				undefined,
				undefined,
				extensionContext,
			);
			expect(result.details).toMatchObject({ status: "pending_acceptance", pendingAcceptance: { id: "overlay_1" } });
			expect(result.content[0]).toMatchObject({
				text: expect.stringContaining("base workspace is unchanged until host acceptance"),
			});
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("-1 old\n+1 new") });
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("not an independent post-edit") });
			expect(commits).toBe(1);
			expect(readFileSync(join(cwd, "overlay.txt"), "utf8")).toBe("old\n");
			expect(runtime.toolEvidenceSummary()).toContain(viewed.details.viewId);
		} finally {
			await runtime.close();
		}
	});

	it("updates a freshly viewed source before moving it in one batch", async () => {
		writeFileSync(join(cwd, "source.txt"), "old\n");
		const runtime = createV2ToolRuntime(cwd);
		try {
			const { read, edit } = runtime.definitions;
			const extensionContext = {} as Parameters<typeof read.execute>[4];
			const viewed = await read.execute("read", { path: "source.txt" }, undefined, undefined, extensionContext);
			const result = await edit.execute(
				"update-move",
				{
					operations: [
						{ kind: "update", path: "source.txt", oldText: "old", newText: "new", viewId: viewed.details.viewId },
						{ kind: "move", path: "source.txt", to: "destination.txt" },
					],
				},
				undefined,
				undefined,
				extensionContext,
			);
			expect(result.details).toMatchObject({ status: "applied" });
			expect(readFileSync(join(cwd, "destination.txt"), "utf8")).toBe("new\n");
			expect(() => readFileSync(join(cwd, "source.txt"))).toThrow();
		} finally {
			await runtime.close();
		}
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
