import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as McpOAuth from "@earendil-works/pi-mcp/oauth";
import { type McpOAuthProvider, MemoryOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import {
	createMcpAuthProvider,
	McpOAuthCredentialStore,
	McpSignInCancelledError,
	signInMcpServer,
} from "../src/extensions/mcp/oauth.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "../src/extensions/mcp/oauth-page.ts";

const mock = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@earendil-works/pi-mcp/oauth", async (importOriginal) => ({
	...(await importOriginal<typeof McpOAuth>()),
	authorizeMcp: mock.authorize,
}));

const dirs: string[] = [];
afterEach(() => {
	mock.authorize.mockReset();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryStore() {
	const agentDir = mkdtempSync(join(tmpdir(), "mcp-adapter-oauth-"));
	dirs.push(agentDir);
	return { agentDir, credentials: new McpOAuthCredentialStore(agentDir) };
}

describe("instance-owned MCP credentials", () => {
	it("isolates name, URL, agent directory, private permissions, and removal", async () => {
		const a = temporaryStore();
		const b = temporaryStore();
		const url = "https://example.test/mcp";
		const state = { serverUrl: url, tokens: { access_token: "fake", token_type: "Bearer" } };
		await a.credentials.forServer("first", url).save(state);
		expect(await a.credentials.forServer("other", url).load()).toBeUndefined();
		expect(await a.credentials.forServer("first", `${url}2`).load()).toBeUndefined();
		expect(await b.credentials.forServer("first", url).load()).toBeUndefined();
		expect(statSync(join(a.agentDir, "mcp-auth.json")).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(a.agentDir, "mcp-auth.json"), "utf8")).toContain("mcp__first|");
		expect(a.credentials.remove("first", url)).toBe(true);
		expect(a.credentials.remove("first", url)).toBe(false);
	});

	it("serializes independent providers' refreshes and drains rotated tokens", async () => {
		const credentials = new McpOAuthCredentialStore("/unused", new InMemoryAuthStorageBackend());
		const url = "https://example.test/mcp";
		const store = credentials.forServer("docs", url);
		await store.save({
			serverUrl: url,
			tokens: { access_token: "expired-fake", refresh_token: "refresh-fake", token_type: "Bearer" },
			tokensExpireAt: 0,
		});
		let resolveRefresh!: () => void;
		const pending = new Promise<void>((resolve) => {
			resolveRefresh = resolve;
		});
		mock.authorize.mockImplementation(async (provider: McpOAuthProvider) => {
			await pending;
			await provider.saveTokens({
				access_token: "rotated-fake",
				refresh_token: "rotated-refresh-fake",
				token_type: "Bearer",
				expires_in: 3600,
			});
			return "AUTHORIZED";
		});
		const first = createMcpAuthProvider({ serverUrl: url, store, settings: () => ({}), onChallenge: () => {} });
		const second = createMcpAuthProvider({ serverUrl: url, store, settings: () => ({}), onChallenge: () => {} });
		const a = first.token();
		const b = second.token();
		await vi.waitFor(() => expect(mock.authorize).toHaveBeenCalledTimes(1));
		let settled = false;
		const drain = first.settled().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		resolveRefresh();
		expect(await Promise.all([a, b])).toEqual(["rotated-fake", "rotated-fake"]);
		await drain;
		expect(settled).toBe(true);
		expect(mock.authorize).toHaveBeenCalledTimes(1);
	});
});

describe("MCP OAuth sign-in cancellation", () => {
	it("cancels the paste prompt and closes the loopback listener", async () => {
		let redirectUrl = "";
		mock.authorize.mockImplementation(async (provider: McpOAuthProvider) => {
			redirectUrl = provider.redirectUrl;
			const state = await provider.state();
			await provider.redirectToAuthorization(
				new URL(
					`https://auth.example.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUrl)}`,
				),
			);
			return "REDIRECT";
		});
		const cancel = new AbortController();
		let promptSignal: AbortSignal | undefined;
		const work = signInMcpServer({
			serverUrl: "https://example.test/mcp",
			store: new MemoryOAuthStateStore(),
			settings: {},
			signal: cancel.signal,
			prompt: {
				showAuthorizationUrl: () => {},
				promptForRedirectUrl: async (signal) => {
					promptSignal = signal;
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
					return undefined;
				},
			},
		});
		const assertion = expect(work).rejects.toBeInstanceOf(McpSignInCancelledError);
		await vi.waitFor(() => expect(promptSignal).toBeDefined());
		cancel.abort();
		await assertion;
		expect(promptSignal?.aborted).toBe(true);
		await expect(fetch(redirectUrl)).rejects.toThrow();
	});
	it("rejects pasted redirects with a different origin/path/state before exchanging the code", async () => {
		mock.authorize.mockImplementation(async (provider: McpOAuthProvider) => {
			await provider.state();
			await provider.redirectToAuthorization(
				new URL(`https://auth.example.test/authorize?redirect_uri=${encodeURIComponent(provider.redirectUrl)}`),
			);
			return "REDIRECT";
		});
		await expect(
			signInMcpServer({
				serverUrl: "https://example.test/mcp",
				store: new MemoryOAuthStateStore(),
				settings: {},
				prompt: {
					showAuthorizationUrl: () => {},
					promptForRedirectUrl: async () => "http://127.0.0.1:1/not-callback?code=fake&state=wrong",
				},
			}),
		).rejects.toThrow("does not match");
		expect(mock.authorize).toHaveBeenCalledTimes(1);
	});
	it("escapes browser messages without hosted identity or active content", () => {
		expect(oauthErrorHtml("<script>bad</script>", "<&\"'")).not.toContain("<script>");
		expect(oauthErrorHtml("<script>bad</script>")).toContain("&lt;script&gt;");
		expect(oauthSuccessHtml("Done")).not.toMatch(/https?:|pi\.dev/);
	});
});
