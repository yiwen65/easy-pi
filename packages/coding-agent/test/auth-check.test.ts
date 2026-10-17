import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore, ModelsError } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { checkProviderAuth, createAuthCheckModelRuntime, getProviderCredential } from "../src/cli/auth-check.ts";
import { parseAuthCommand } from "../src/cli/auth-command.ts";
import { AuthStorage, ReadOnlyAuthStorage, StoredApiKeyUnavailableError } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { clearConfigValueCache } from "../src/core/resolve-config-value.ts";

const tempDir = join(tmpdir(), `pi-test-auth-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function createRuntime(credentials: AuthStorage | ReadOnlyAuthStorage): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

describe("auth check command", () => {
	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearConfigValueCache();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	test("reports a configured provider as ready", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } }));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
		});
	});

	test("resolves the provider from --model", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } }));

		await expect(checkProviderAuth(parseArgs(["--model", "openai/gpt-5.5"]), runtime)).resolves.toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
		});
		await expect(
			checkProviderAuth(parseArgs(["--provider", "openai", "--model", "gpt-5.5"]), runtime),
		).resolves.toMatchObject({ status: "ready", provider: "openai" });
	});

	test("reads credentials without refreshing OAuth when requested", async () => {
		const apiCredentials = AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } });
		const apiRuntime = await createRuntime(apiCredentials);
		await expect(getProviderCredential("openai", apiRuntime, apiCredentials, { refresh: false })).resolves.toBe(
			"test-key",
		);

		const credentials = AuthStorage.inMemory({
			"openai-codex": { type: "oauth", access: "old-token", refresh: "refresh-token", expires: 0 },
		});
		const oauthRuntime = await createRuntime(credentials);
		const oauth = oauthRuntime.getProvider("openai-codex")?.auth.oauth;
		if (!oauth) throw new Error("OpenAI Codex OAuth provider is not registered");
		const refresh = vi.fn(oauth.refresh);
		oauth.refresh = refresh;

		await expect(getProviderCredential("openai-codex", oauthRuntime, credentials, { refresh: false })).resolves.toBe(
			"old-token",
		);
		expect(refresh).not.toHaveBeenCalled();
	});

	test("refreshes OAuth by default", async () => {
		const credentials = AuthStorage.inMemory({
			"openai-codex": { type: "oauth", access: "old-token", refresh: "refresh-token", expires: 0 },
		});
		const runtime = await createRuntime(credentials);
		const oauth = runtime.getProvider("openai-codex")?.auth.oauth;
		if (!oauth) throw new Error("OpenAI Codex OAuth provider is not registered");
		const refresh = vi.fn(async () => ({
			type: "oauth" as const,
			access: "fresh-token",
			refresh: "refresh-token",
			expires: Date.now() + 60 * 60 * 1000,
		}));
		oauth.refresh = refresh;

		await expect(
			checkProviderAuth(parseArgs(["--provider", "openai-codex"]), runtime, { refresh: true }),
		).resolves.toMatchObject({
			status: "ready",
		});
		expect(refresh).toHaveBeenCalledOnce();
	});

	test("reports an unknown provider as not ready", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory());

		await expect(checkProviderAuth(parseArgs(["--provider", "not-installed"]), runtime)).resolves.toEqual({
			status: "not_ready",
			provider: "not-installed",
			reason: "provider_not_found",
		});
	});

	test("does not treat an unresolved stored environment reference as configured", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "$MISSING_AUTH_CHECK_KEY" } }), "utf-8");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toEqual({
			status: "not_ready",
			provider: "openai",
			reason: "credentials_not_configured",
		});
	});

	for (const readOnly of [false, true]) {
		for (const refresh of [false, true]) {
			// Read-only storage deliberately does not execute command-backed keys.
			const keys = ["$T162_MISSING_AUTH_KEY", "$T162_EMPTY_AUTH_KEY", ""];
			if (!readOnly) keys.push("!exit 7", "!printf ''");
			test.each(keys)(
				`reports unresolved stored keys as not ready without ambient fallback: %s (readOnly=${readOnly}, refresh=${refresh})`,
				async (key) => {
					vi.stubEnv("T162_MISSING_AUTH_KEY", undefined);
					vi.stubEnv("T162_EMPTY_AUTH_KEY", "");
					vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-ambient-key");
					const authPath = join(tempDir, "auth.json");
					writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key } }));
					const credentials = readOnly ? new ReadOnlyAuthStorage(authPath) : AuthStorage.create(authPath);
					const runtime = await createRuntime(credentials);
					const provider = runtime.getProvider("anthropic")!;
					const resolve = vi.spyOn(provider.auth.apiKey!, "resolve");
					const oauthRefresh = vi
						.spyOn(provider.auth.oauth!, "refresh")
						.mockRejectedValue(new Error("must not refresh"));
					const dispatch = vi.spyOn(provider, "streamSimple").mockImplementation(() => {
						throw new Error("must not dispatch");
					});
					const status = await checkProviderAuth(parseArgs(["--provider", "anthropic"]), runtime, { refresh });
					const message = await runtime.completeSimple(provider.getModels()[0], { messages: [] });
					expect(message.stopReason).toBe("error");
					expect(message.errorMessage).toContain("Failed to resolve stored API key");
					expect(resolve).not.toHaveBeenCalled();
					expect(oauthRefresh).not.toHaveBeenCalled();
					expect(dispatch).not.toHaveBeenCalled();
					expect(status).toEqual({
						status: "not_ready",
						provider: "anthropic",
						reason: "credentials_not_configured",
					});
				},
			);
		}

		test(`keeps intentionally omitted keys eligible for ambient auth (readOnly=${readOnly})`, async () => {
			vi.stubEnv("OPENAI_API_KEY", "synthetic-ambient-key");
			const authPath = join(tempDir, "auth.json");
			writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key" } }));
			const runtime = await createRuntime(
				readOnly ? new ReadOnlyAuthStorage(authPath) : AuthStorage.create(authPath),
			);
			for (const refresh of [false, true]) {
				expect(await checkProviderAuth(parseArgs(["--provider", "openai"]), runtime, { refresh })).toEqual({
					status: "ready",
					provider: "openai",
					authType: "api_key",
				});
			}
			expect((await runtime.getAuth("openai"))?.auth.apiKey).toBe("synthetic-ambient-key");
		});
	}

	test("classifies an unavailable key encountered only during refresh-time auth resolution", async () => {
		vi.stubEnv("T162_MISSING_AUTH_KEY", undefined);
		vi.stubEnv("OPENAI_API_KEY", "synthetic-ambient-key");
		const credentials = AuthStorage.inMemory({ openai: { type: "api_key", key: "$T162_MISSING_AUTH_KEY" } });
		const read = vi.spyOn(credentials, "read");
		const runtime = await createRuntime(credentials);
		vi.spyOn(runtime, "checkAuth").mockResolvedValue({ type: "api_key" });
		const getAuth = vi.spyOn(runtime, "getAuth");
		expect(await checkProviderAuth(parseArgs(["--provider", "openai"]), runtime, { refresh: true })).toEqual({
			status: "not_ready",
			provider: "openai",
			reason: "credentials_not_configured",
		});
		expect(read).toHaveBeenCalledOnce();
		expect(getAuth).toHaveBeenCalledOnce();
	});

	test.each([
		[
			"untyped cause",
			new ModelsError("auth", "read failed", {
				cause: new Error('Failed to resolve stored API key for provider "openai"'),
			}),
		],
		[
			"other provider",
			new ModelsError("auth", "read failed", { cause: new StoredApiKeyUnavailableError("anthropic") }),
		],
		[
			"non-auth failure",
			new ModelsError("oauth", "refresh failed", { cause: new StoredApiKeyUnavailableError("openai") }),
		],
		["arbitrary wrapper", new Error("read failed", { cause: new StoredApiKeyUnavailableError("openai") })],
	])("keeps unrelated errors invalid: %s", async (_name, error) => {
		const runtime = await createRuntime(AuthStorage.inMemory());
		vi.spyOn(runtime, "checkAuth").mockRejectedValue(error);
		expect(await checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).toEqual({
			status: "invalid",
			provider: "openai",
			reason: "invalid_state",
		});
	});

	test.each([false, true])("reports malformed auth state as invalid (readOnly=%s)", async (readOnly) => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, "{invalid-json", "utf-8");
		const runtime = await createRuntime(readOnly ? new ReadOnlyAuthStorage(authPath) : AuthStorage.create(authPath));

		for (const refresh of [false, true]) {
			await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime, { refresh })).resolves.toEqual({
				status: "invalid",
				provider: "openai",
				reason: "invalid_state",
			});
		}
	});

	test("does not create an auth file or its parent directory", async () => {
		const authPath = join(tempDir, "agent", "auth.json");
		const runtime = await createRuntime(new ReadOnlyAuthStorage(authPath));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toMatchObject({
			status: "not_ready",
			reason: "credentials_not_configured",
		});
		expect(existsSync(authPath)).toBe(false);
		expect(existsSync(join(tempDir, "agent"))).toBe(false);
	});

	test("accepts optional JSON output, credential output, and --no-refresh", () => {
		expect(parseAuthCommand(["auth", "check", "--provider", "openai"])).toEqual({
			kind: "check",
			args: ["--provider", "openai"],
			json: false,
			credentials: false,
			noRefresh: false,
		});
		expect(
			parseAuthCommand(["auth", "check", "--json", "--credentials", "--no-refresh", "--provider", "openai"]),
		).toEqual({
			kind: "check",
			args: ["--provider", "openai"],
			json: true,
			credentials: true,
			noRefresh: true,
		});
	});

	test("creates an auth-check runtime without catalog storage", async () => {
		const runtime = await createAuthCheckModelRuntime(AuthStorage.inMemory());
		expect(runtime.getProvider("openai")).toBeDefined();
	});
});
