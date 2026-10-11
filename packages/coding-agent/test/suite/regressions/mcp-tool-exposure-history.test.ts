import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../../../src/core/extensions/index.ts";
import type { ResourceLoader } from "../../../src/core/resource-loader.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

function tool(name: string, exposure?: ToolDefinition["exposure"]): ToolDefinition {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: Type.Object({}),
		exposure,
		execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
	};
}

function discoveryReceipt(manager: SessionManager, names: string[]): string {
	return manager.appendMessage({
		role: "toolResult",
		toolCallId: `discovery-${manager.getEntries().length}`,
		toolName: "search_tools",
		content: [{ type: "text", text: "Loaded tools" }],
		isError: false,
		addedToolNames: names,
		timestamp: Date.now(),
	});
}

async function reloadingLoader(factory: ExtensionFactory): Promise<ResourceLoader> {
	let result = await createTestExtensionsResult([factory]);
	return {
		...createTestResourceLoader({ extensionsResult: result }),
		getExtensions: () => result,
		reload: async () => {
			result = await createTestExtensionsResult([factory]);
		},
	};
}

describe("MCP migration: tool exposure, access, and branch-visible discoveries", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0).reverse()) {
			await harness.session.shutdown();
			harness.cleanup();
		}
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function harness(options: HarnessOptions = {}): Promise<Harness> {
		const result = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false } },
			...options,
		});
		harnesses.push(result);
		return result;
	}

	it("declares only direct/model-only tools and persists discovery additions before the next faux turn", async () => {
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.registerTool(tool("normal"));
					pi.registerTool(tool("orchestrate", "model-only"));
					pi.registerTool({
						...tool("mcp__demo__read", "deferred"),
						namespace: { name: "mcp__demo", description: "Demo server", instructions: "Read carefully" },
						annotations: {
							readOnlyHint: true,
							destructiveHint: false,
							idempotentHint: true,
							openWorldHint: false,
						},
					});
					pi.registerTool(tool("secret", "hidden"));
					pi.registerTool({
						...tool("search_tools"),
						execute: async () => {
							const discovered = pi
								.getAllTools()
								.filter((entry) => entry.exposure === "deferred")
								.map((entry) => entry.name);
							pi.setActiveTools([...pi.getActiveTools(), ...discovered, "secret"]);
							return { content: [{ type: "text", text: "Loaded fake tools" }], details: {} };
						},
					});
				},
			],
		});
		expect(h.session.getActiveToolNames()).toEqual(["normal", "orchestrate", "search_tools"]);
		expect(h.session.getAllTools().find((entry) => entry.name === "normal")?.exposure).toBe("direct");
		expect(h.session.getAllTools().find((entry) => entry.name === "mcp__demo__read")).toMatchObject({
			exposure: "deferred",
			namespace: { name: "mcp__demo", description: "Demo server", instructions: "Read carefully" },
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		});
		expect(h.session.systemPrompt).not.toContain("mcp__demo__read");
		expect(h.session.getDelegatableToolNames()).toEqual(["normal", "orchestrate", "search_tools", "mcp__demo__read"]);
		h.setResponses([
			(context) => {
				expect(context.tools?.map((entry) => entry.name)).toEqual(["normal", "orchestrate", "search_tools"]);
				return fauxAssistantMessage(fauxToolCall("search_tools", {}), { stopReason: "toolUse" });
			},
			(context) => {
				expect(context.tools?.map((entry) => entry.name)).toContain("mcp__demo__read");
				expect(context.tools?.map((entry) => entry.name)).not.toContain("secret");
				return fauxAssistantMessage(fauxToolCall("mcp__demo__read", {}), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("Discover and read");
		const receipt = h.sessionManager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "search_tools",
			);
		expect(receipt).toMatchObject({ message: { addedToolNames: ["mcp__demo__read"] } });
		expect(h.faux.state.callCount).toBe(3);
	});

	it("keeps a strict explicit allowlist for registration, search, activation, and historical restoration", async () => {
		const manager = SessionManager.inMemory();
		discoveryReceipt(manager, [
			"mcp__safe__read",
			"mcp__safe__delete",
			"mcp__other__read",
			"forbidden_direct",
			"mcp__future__*",
		]);
		let api: ExtensionAPI | undefined;
		let searchable: string[] = [];
		const h = await harness({
			sessionManager: manager,
			allowedToolNames: ["search_tools", "mcp__safe__read", "mcp__safe__delete"],
			excludedToolNames: ["mcp__safe__delete"],
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerTool(tool("mcp__safe__read", "deferred"));
					pi.registerTool(tool("mcp__safe__delete", "deferred"));
					pi.registerTool(tool("mcp__other__read", "deferred"));
					pi.registerTool(tool("forbidden_direct"));
					pi.registerTool({
						...tool("search_tools"),
						execute: async () => {
							searchable = pi
								.getAllTools()
								.filter((entry) => entry.exposure === "deferred")
								.map((entry) => entry.name);
							pi.setActiveTools([
								...pi.getActiveTools(),
								...searchable,
								"mcp__safe__delete",
								"mcp__other__read",
								"forbidden_direct",
							]);
							return { content: [{ type: "text", text: "searched" }], details: {} };
						},
					});
				},
			],
		});
		expect(h.session.getAllTools().map((entry) => entry.name)).toEqual(["mcp__safe__read", "search_tools"]);
		expect(h.session.getActiveToolNames()).toEqual(["search_tools", "mcp__safe__read"]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("search_tools", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("search");
		expect(searchable).toEqual(["mcp__safe__read"]);
		api?.registerTool(tool("mcp__future__read", "deferred"));
		api?.registerTool(tool("mcp__other__late"));
		expect(h.session.getDelegatableToolNames()).toEqual(["search_tools", "mcp__safe__read"]);
		expect(h.session.getAllTools().map((entry) => entry.name)).toEqual(["mcp__safe__read", "search_tools"]);
	});

	it("applies wildcard allow/exclude filters without turning patterns into capabilities", async () => {
		let api: ExtensionAPI | undefined;
		const h = await harness({
			allowedToolNames: ["loader", "mcp__demo.v1__*"],
			excludedToolNames: ["*__delete", "*__secret*"],
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerTool(tool("loader"));
					pi.registerTool(tool("mcp__demo.v1__read", "deferred"));
					pi.registerTool(tool("mcp__demo.v1__delete", "deferred"));
					pi.registerTool(tool("mcp__demo.v1__secret_read", "deferred"));
					pi.registerTool(tool("mcp__demoXv1__read", "deferred"));
				},
			],
		});
		expect(h.session.getActiveToolNames()).toEqual(["loader"]);
		expect(h.session.getAllTools().map((entry) => entry.name)).toEqual(["loader", "mcp__demo.v1__read"]);
		api?.registerTool(tool("mcp__demo.v1__status"));
		api?.registerTool(tool("mcp__demo.v1__late_read", "deferred"));
		expect(h.session.getActiveToolNames()).toEqual(["loader", "mcp__demo.v1__status"]);
		expect(h.session.getDelegatableToolNames()).toEqual([
			"loader",
			"mcp__demo.v1__status",
			"mcp__demo.v1__read",
			"mcp__demo.v1__late_read",
		]);
		expect(h.session.getDelegatableToolNames().some((name) => name.includes("*"))).toBe(false);
	});

	it("returns detached initial access filters, also to extension contexts", async () => {
		const allowed = ["allowed"];
		const excluded = ["denied"];
		const h = await harness({ allowedToolNames: allowed, excludedToolNames: excluded });
		allowed.push("later");
		excluded.push("allowed");
		const access = h.session.getToolAccess();
		(access.allowlist as string[]).push("mutated");
		(access.excluded as string[]).push("allowed");
		expect(h.session.getToolAccess()).toEqual({ allowlist: ["allowed"], excluded: ["denied"] });
		const context = h.session.extensionRunner.createContext();
		expect(context.getToolAccess).toBeTypeOf("function");
		expect(context.getToolAccess?.()).toEqual({
			allowlist: ["allowed"],
			excluded: ["denied"],
		});
	});

	it("refreshes host allowlist revocations without weakening the denylist or activating deferred grants", async () => {
		const h = await harness({
			allowedToolNames: ["loader", "mcp__demo__read"],
			excludedToolNames: ["*__delete"],
			extensionFactories: [
				(pi) => {
					pi.registerTool(tool("loader"));
					pi.registerTool(tool("mcp__demo__read", "deferred"));
					pi.registerTool(tool("mcp__demo__other", "deferred"));
					pi.registerTool(tool("mcp__demo__delete", "deferred"));
				},
			],
		});
		h.session.setActiveToolsByName(["loader", "mcp__demo__read"]);
		const updated = ["loader", "mcp__demo__other", "mcp__demo__delete"];
		h.session.setToolAccessByName(updated);
		updated.push("mcp__demo__read");
		expect(h.session.getActiveToolNames()).toEqual(["loader"]);
		expect(h.session.getAllTools().map((entry) => entry.name)).toEqual(["loader", "mcp__demo__other"]);
		expect(h.session.getToolAccess()).toEqual({
			allowlist: ["loader", "mcp__demo__other", "mcp__demo__delete"],
			excluded: ["*__delete"],
		});
		h.session.setActiveToolsByName(["loader", "mcp__demo__read", "mcp__demo__other", "mcp__demo__delete"]);
		expect(h.session.getActiveToolNames()).toEqual(["loader", "mcp__demo__other"]);
		h.session.setToolAccessByName([]);
		expect(h.session.getDelegatableToolNames()).toEqual([]);
	});

	it("treats an empty allowlist as no capability even for late discoveries", async () => {
		const manager = SessionManager.inMemory();
		discoveryReceipt(manager, ["deferred"]);
		const h = await harness({
			allowedToolNames: [],
			sessionManager: manager,
			extensionFactories: [
				(pi) => {
					pi.registerTool(tool("direct"));
					pi.on("session_start", () => pi.registerTool(tool("deferred", "deferred")));
				},
			],
		});
		await h.session.bindExtensions({});
		h.session.setActiveToolsByName(["direct", "deferred"]);
		expect(h.session.getToolAccess().allowlist).toEqual([]);
		expect(h.session.getAllTools()).toEqual([]);
		expect(h.session.getActiveToolNames()).toEqual([]);
		expect(h.session.getDelegatableToolNames()).toEqual([]);
	});

	it("restores late-registered concrete discoveries but not new deferred tools or historical patterns", async () => {
		const manager = SessionManager.inMemory();
		discoveryReceipt(manager, ["mcp__demo__read", "mcp__demo__hidden", "mcp__other__read", "mcp__demo__*"]);
		let api: ExtensionAPI | undefined;
		const h = await harness({
			sessionManager: manager,
			allowedToolNames: ["loader", "mcp__demo__*"],
			excludedToolNames: ["mcp__demo__denied"],
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerTool(tool("loader"));
					pi.on("session_start", () => {
						pi.registerTool(tool("mcp__demo__read", "deferred"));
						pi.registerTool(tool("mcp__demo__new", "deferred"));
						pi.registerTool(tool("mcp__demo__hidden", "hidden"));
						pi.registerTool(tool("mcp__demo__denied", "deferred"));
						pi.registerTool(tool("mcp__other__read", "deferred"));
					});
				},
			],
		});
		expect(h.session.getActiveToolNames()).toEqual(["loader"]);
		await h.session.bindExtensions({});
		expect(h.session.getActiveToolNames()).toEqual(["loader", "mcp__demo__read"]);
		api?.registerTool(tool("mcp__demo__hidden", "deferred"));
		expect(h.session.getActiveToolNames()).toEqual(["loader", "mcp__demo__read"]);
	});

	it("removes hidden/deleted active tools and does not regrant them during later registrations", async () => {
		let api: ExtensionAPI | undefined;
		const manager = SessionManager.inMemory();
		discoveryReceipt(manager, ["deferred"]);
		const factory: ExtensionFactory = (pi) => {
			api = pi;
			pi.registerTool(tool("loader"));
			pi.registerTool(tool("deferred", "deferred"));
		};
		const h = await harness({ sessionManager: manager, resourceLoader: await reloadingLoader(factory) });
		expect(h.session.getActiveToolNames()).toEqual(["loader", "deferred"]);
		api?.registerTool(tool("deferred", "hidden"));
		h.session.setActiveToolsByName(["loader", "deferred"]);
		expect(h.session.getActiveToolNames()).toEqual(["loader"]);
		api?.registerTool(tool("deferred", "deferred"));
		expect(h.session.getActiveToolNames()).toEqual(["loader"]);
		h.session.setActiveToolsByName(["loader", "deferred"]);
		const extension = h.session.resourceLoader.getExtensions().extensions[0];
		extension.tools.delete("deferred");
		h.session.resourceLoader.getExtensions().runtime.refreshTools();
		expect(h.session.getActiveToolNames()).toEqual(["loader"]);
		api?.registerTool(tool("deferred", "deferred"));
		await h.session.reload();
		expect(h.session.getActiveToolNames()).toEqual(["loader"]);
	});

	it.each(["deferred", "hidden"] as const)(
		"autoactivates a permitted %s-to-direct transition and direct re-enable",
		async (exposure) => {
			let api: ExtensionAPI | undefined;
			const h = await harness({
				extensionFactories: [
					(pi) => {
						api = pi;
						pi.registerTool(tool("changed", exposure));
					},
				],
			});
			expect(h.session.getActiveToolNames()).toEqual([]);
			api?.registerTool(tool("changed", "direct"));
			expect(h.session.getActiveToolNames()).toEqual(["changed"]);
			api?.registerTool(tool("changed", "hidden"));
			expect(h.session.getActiveToolNames()).toEqual([]);
			api?.registerTool(tool("changed", "direct"));
			expect(h.session.getActiveToolNames()).toEqual(["changed"]);
		},
	);

	it("preserves explicit direct/deferred deactivation across exposure changes and reload", async () => {
		let api: ExtensionAPI | undefined;
		const manager = SessionManager.inMemory();
		discoveryReceipt(manager, ["deferred"]);
		const factory: ExtensionFactory = (pi) => {
			api = pi;
			pi.registerTool(tool("direct", "direct"));
			pi.registerTool(tool("deferred", "deferred"));
		};
		const h = await harness({ sessionManager: manager, resourceLoader: await reloadingLoader(factory) });
		h.session.setActiveToolsByName([]);
		api?.registerTool(tool("direct", "hidden"));
		api?.registerTool(tool("direct", "direct"));
		api?.registerTool(tool("deferred", "direct"));
		expect(h.session.getActiveToolNames()).toEqual([]);
		await h.session.reload();
		expect(h.session.getActiveToolNames()).toEqual([]);
		h.session.setActiveToolsByName(["direct", "deferred"]);
		expect(h.session.getActiveToolNames()).toEqual(["direct", "deferred"]);
	});

	it("never autoactivates denied exposure transitions", async () => {
		let api: ExtensionAPI | undefined;
		const h = await harness({
			allowedToolNames: ["excluded"],
			excludedToolNames: ["excluded"],
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerTool(tool("excluded", "hidden"));
					pi.registerTool(tool("not_allowed", "deferred"));
				},
			],
		});
		api?.registerTool(tool("excluded", "direct"));
		api?.registerTool(tool("not_allowed", "direct"));
		expect(h.session.getAllTools()).toEqual([]);
		expect(h.session.getActiveToolNames()).toEqual([]);
	});

	it("reports unconnected MCP registrations after installing the error listener", async () => {
		const errors: string[] = [];
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.registerMcpServer("unconnected", { command: "unused" });
				},
			],
		});
		await h.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		await h.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(
			'MCP server "unconnected" is registered, but no loaded extension connects MCP servers',
		);
	});

	it("preserves explicit deferred deactivation through registry refresh and reload", async () => {
		let api: ExtensionAPI | undefined;
		const manager = SessionManager.inMemory();
		discoveryReceipt(manager, ["deferred"]);
		const factory: ExtensionFactory = (pi) => {
			api = pi;
			pi.registerTool(tool("loader"));
			pi.registerTool(tool("deferred", "deferred"));
		};
		const h = await harness({
			allowedToolNames: ["loader", "deferred", "unrelated"],
			sessionManager: manager,
			resourceLoader: await reloadingLoader(factory),
		});
		h.session.setActiveToolsByName(["loader"]);
		api?.registerTool(tool("unrelated"));
		expect(h.session.getActiveToolNames()).toEqual(["loader", "unrelated"]);
		await h.session.reload();
		expect(h.session.getActiveToolNames()).not.toContain("deferred");
		expect(h.session.getDelegatableToolNames()).toContain("deferred");
	});

	it("reconstructs discoveries during reload when tools register only in session_start", async () => {
		const manager = SessionManager.inMemory();
		discoveryReceipt(manager, ["late"]);
		const factory: ExtensionFactory = (pi) => {
			pi.registerTool(tool("loader"));
			pi.on("session_start", () => pi.registerTool(tool("late", "deferred")));
		};
		const h = await harness({ sessionManager: manager, resourceLoader: await reloadingLoader(factory) });
		await h.session.bindExtensions({
			onError: (error) => {
				throw new Error(error.error);
			},
		});
		expect(h.session.getActiveToolNames()).toEqual(["loader", "late"]);
		await h.session.reload();
		expect(h.session.getActiveToolNames()).toEqual(["loader", "late"]);
	});

	it("isolates discoveries and pending late registrations between tree branches", async () => {
		const manager = SessionManager.inMemory();
		const root = manager.appendMessage(fauxAssistantMessage("common root"));
		const left = discoveryReceipt(manager, ["left", "left_late"]);
		manager.branch(root);
		const right = discoveryReceipt(manager, ["right", "right_late"]);
		let api: ExtensionAPI | undefined;
		const h = await harness({
			sessionManager: manager,
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.registerTool(tool("loader"));
					pi.registerTool(tool("left", "deferred"));
					pi.registerTool(tool("right", "deferred"));
				},
			],
		});
		expect(h.session.getActiveToolNames()).toEqual(["loader", "right"]);
		await h.session.navigateTree(left);
		expect(h.session.getActiveToolNames()).toEqual(["loader", "left"]);
		api?.registerTool(tool("right_late", "deferred"));
		api?.registerTool(tool("left_late", "deferred"));
		expect(h.session.getActiveToolNames()).toEqual(["loader", "left", "left_late"]);
		await h.session.navigateTree(right);
		expect(h.session.getActiveToolNames()).toEqual(["loader", "right", "right_late"]);
		await h.session.navigateTree(root);
		expect(h.session.getActiveToolNames()).toEqual(["loader"]);
		await h.session.navigateTree(left);
		expect(h.session.getActiveToolNames()).toEqual(["loader", "left", "left_late"]);
	});

	it("restores only the forked path when constructing fork and resumed sessions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-tool-fork-"));
		tempDirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		const root = manager.appendMessage(fauxAssistantMessage("common root"));
		const left = discoveryReceipt(manager, ["left"]);
		manager.branch(root);
		discoveryReceipt(manager, ["right"]);
		const originalFile = manager.getSessionFile()!;
		const forkedFile = manager.createBranchedSession(left)!;
		const factory: ExtensionFactory = (pi) => {
			pi.registerTool(tool("loader"));
			pi.registerTool(tool("left", "deferred"));
			pi.registerTool(tool("right", "deferred"));
		};
		const forked = await harness({ sessionManager: SessionManager.open(forkedFile), extensionFactories: [factory] });
		expect(forked.session.getActiveToolNames()).toEqual(["loader", "left"]);
		const resumed = await harness({
			sessionManager: SessionManager.open(originalFile),
			extensionFactories: [factory],
		});
		expect(resumed.session.getActiveToolNames()).toEqual(["loader", "right"]);
		const hidden = await harness({
			sessionManager: SessionManager.open(originalFile),
			extensionFactories: [
				(pi) => {
					pi.registerTool(tool("loader"));
					pi.registerTool(tool("right", "hidden"));
				},
			],
		});
		expect(hidden.session.getActiveToolNames()).toEqual(["loader"]);
	});

	it("restores compacted discoveries from raw receipts after a real faux compaction, reload, and resume", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-tool-compact-"));
		tempDirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		const factory: ExtensionFactory = (pi) => {
			pi.registerTool(tool("deferred", "deferred"));
			pi.registerTool({
				...tool("loader"),
				execute: async () => {
					pi.setActiveTools([...pi.getActiveTools(), "deferred"]);
					return { content: [{ type: "text", text: "loaded" }], details: {} };
				},
			});
		};
		const h = await harness({
			sessionManager: manager,
			resourceLoader: await reloadingLoader(factory),
			settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 } },
			hfCompaction: { mode: "full_pipeline" },
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("loader", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished"),
			fauxAssistantMessage("Historical discovery completed."),
		]);
		await h.session.prompt("Discover the fake deferred capability");
		await h.session.compact();
		expect(
			h.session.messages.some(
				(message) => message.role === "toolResult" && message.addedToolNames?.includes("deferred"),
			),
		).toBe(false);
		expect(
			h.sessionManager
				.getBranch()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.addedToolNames?.includes("deferred"),
				),
		).toBe(true);
		await h.session.reload();
		expect(h.session.getActiveToolNames()).toContain("deferred");
		const resumed = await harness({
			sessionManager: SessionManager.open(manager.getSessionFile()!),
			extensionFactories: [factory],
		});
		expect(resumed.session.getActiveToolNames()).toEqual(["loader", "deferred"]);
		expect(resumed.session.messages.some((message) => message.role === "toolResult")).toBe(false);
	});
});
