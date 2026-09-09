import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_HARNESS_CONTEXT_ENV } from "@easy-pi/permissions";
import type { ChildSessionPermissions } from "@easy-pi/subagent/session-host";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import easyPiHarness, { createEasyPiHarness, type EasyPiHarnessOptions } from "../src/extensions/easy-pi.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;
const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options?: EasyPiHarnessOptions, useDefault = false) {
	const root = mkdtempSync(join(tmpdir(), "epi-harness-native-"));
	roots.push(root);
	const handlers = new Map<string, Handler[]>();
	const tools: string[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const appendEntry = vi.fn();
	const select = vi.fn(async (_title: string, _options: string[]): Promise<string | undefined> => undefined);
	const api = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
			commands.set(name, command),
		registerEntryRenderer: vi.fn(),
		appendEntry,
	} as unknown as ExtensionAPI;
	(useDefault ? easyPiHarness : createEasyPiHarness({ agentDir: root, ...options }))(api);
	const ctx = {
		cwd: root,
		hasUI: false,
		mode: "print",
		ui: { select, notify: vi.fn(), setStatus: vi.fn() },
	} as unknown as ExtensionContext;
	const call = (input = { path: "a.txt", content: "secret body" }) =>
		handlers.get("tool_call")![0]!({ type: "tool_call", toolCallId: "write-1", toolName: "write", input }, ctx);
	return { root, handlers, tools, commands, ctx, select, appendEntry, call };
}

test("direct default factory exposes native operator entry, not the retired DAG", () => {
	const f = fixture(undefined, true);
	expect([...f.commands.keys()].sort()).toEqual(["agents", "permissions"]);
	// Six collaboration tools are session-bound, never registered at discovery.
	expect(f.tools).toEqual(["request_user_input"]);
	expect(existsSync(join(f.root, "subagent"))).toBe(false);
});

test("root permission mode, audit, noninteractive denial and exact session grants survive cutover", async () => {
	const f = fixture();
	expect(await f.call()).toBeUndefined();
	await f.commands.get("permissions")!.handler("manual-allow", f.ctx);
	expect(await f.call()).toMatchObject({
		block: true,
		reason: expect.stringContaining("non-interactive mode defaults to deny"),
	});
	f.ctx.hasUI = true;
	f.select.mockResolvedValue("Allow for this session");
	expect(await f.call()).toBeUndefined();
	expect(await f.call()).toBeUndefined();
	expect(f.select).toHaveBeenCalledTimes(1);
	expect(f.select.mock.calls[0]![0]).not.toContain("secret body");
	await f.commands.get("permissions")!.handler("manual-allow", f.ctx);
	f.select.mockResolvedValue("Deny");
	expect(await f.call()).toMatchObject({ block: true });
	expect(f.appendEntry).toHaveBeenCalledWith(
		"wj-harness-audit",
		expect.objectContaining({ action: "permission", decision: "deny" }),
	);
	const prompt = await f.handlers.get("before_agent_start")![0]!({ systemPrompt: "base" }, f.ctx);
	expect(prompt).toMatchObject({ systemPrompt: expect.stringContaining("smallest task-relevant verification") });
});

test("does not display permission status on session start or mode changes", async () => {
	for (const native of [false, true]) {
		const f = fixture(
			native
				? {
						nativeSession: {
							getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
							registerTools: vi.fn(),
						},
					}
				: undefined,
		);
		await f.handlers.get("session_start")![0]!({}, f.ctx);
		await f.commands.get("permissions")!.handler("manual-allow", f.ctx);
		expect(f.ctx.ui.setStatus).not.toHaveBeenCalled();
	}
});

test("full access still denies catastrophic deletion", async () => {
	const f = fixture();
	const result = await f.handlers.get("tool_call")![0]!(
		{ type: "tool_call", toolCallId: "bash-1", toolName: "bash", input: { command: "rm -rf /" } },
		f.ctx,
	);
	expect(result).toMatchObject({ block: true });
});

test("retired process child env fails closed even with direct default export, without reading context", async () => {
	vi.stubEnv(CHILD_HARNESS_CONTEXT_ENV, "/nonexistent/private-context.json");
	const f = fixture(undefined, true);
	expect(f.tools).toEqual([]);
	expect(f.commands.size).toBe(0);
	expect(await f.call()).toMatchObject({ block: true, terminate: true, reason: expect.stringContaining("retired") });
});

test("explicit native children ignore legacy env but inherit live permissions without headless autoapproval", async () => {
	vi.stubEnv(CHILD_HARNESS_CONTEXT_ENV, "/nonexistent/private-context.json");
	let permissions: ChildSessionPermissions = { mode: "manual-allow", sessionGrants: [], protectedRoots: [] };
	const registerTools = vi.fn();
	const f = fixture({ nativeSession: { getPermissions: () => permissions, registerTools } });
	expect(registerTools).toHaveBeenCalledTimes(1);
	expect(f.commands.has("agents")).toBe(false);
	expect(await f.call()).toMatchObject({ block: true, reason: expect.stringContaining("explicit parent approval") });
	permissions = { ...permissions, mode: "full-access" };
	expect(await f.call()).toBeUndefined();
	permissions = { ...permissions, protectedRoots: ["relative-invalid"] };
	expect(await f.call()).toMatchObject({ block: true, reason: "Native parent authority is unavailable" });
});
