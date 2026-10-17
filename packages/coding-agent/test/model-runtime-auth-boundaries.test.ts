import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
	type AssistantMessageEvent,
	type AuthResult,
	createModels,
	createProvider,
	envApiKeyAuth,
	fauxAssistantMessage,
	fauxProvider,
	type Model,
	type OAuthCredential,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../../ai/src/api/openai-responses.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { clearConfigValueCache } from "../src/core/resolve-config-value.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const directories: string[] = [];
function tempFile(name: string, data: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-model-auth-boundaries-"));
	directories.push(dir);
	const path = join(dir, name);
	writeFileSync(path, JSON.stringify(data));
	return path;
}

describe("ModelRuntime credential and request boundaries", () => {
	afterEach(() => {
		for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
		clearConfigValueCache();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it.each(["$PI_TEST_MISSING_STORED_KEY", "!exit 7", "!printf ''", ""])(
		"does not fall back to ambient credentials when a stored key fails: %s",
		async (key) => {
			vi.stubEnv("PI_TEST_MISSING_STORED_KEY", undefined);
			vi.stubEnv("PI_TEST_AMBIENT_KEY", "synthetic-ambient");
			const credentials = AuthStorage.inMemory({ faux: { type: "api_key", key } });
			const faux = fauxProvider();
			faux.setResponses([fauxAssistantMessage("wrong account")]);
			const models = createModels({ credentials });
			models.setProvider({ ...faux.provider, auth: { apiKey: envApiKeyAuth("test", ["PI_TEST_AMBIENT_KEY"]) } });
			const result = await models.completeSimple(faux.getModel(), { messages: [] });
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Failed to resolve stored API key");
			expect(faux.state.callCount).toBe(0);
		},
	);

	it("preserves key-absent ambient resolution and credential env interpolation", async () => {
		vi.stubEnv("PI_TEST_AMBIENT_KEY", "synthetic-ambient");
		const credentials = AuthStorage.inMemory({ faux: { type: "api_key", env: { REGION: "local" } } });
		const faux = fauxProvider();
		const models = createModels({ credentials });
		models.setProvider({ ...faux.provider, auth: { apiKey: envApiKeyAuth("test", ["PI_TEST_AMBIENT_KEY"]) } });
		expect((await models.getAuth("faux"))?.auth.apiKey).toBe("synthetic-ambient");
		await credentials.modify("faux", async () => ({
			type: "api_key",
			key: "$PI_TEST_AMBIENT_KEY",
			env: { PI_TEST_AMBIENT_KEY: "synthetic-scoped" },
		}));
		expect((await models.getAuth("faux"))?.auth.apiKey).toBe("synthetic-scoped");
	});

	it("fails closed for unresolved read-only stored keys without executing commands", async () => {
		vi.stubEnv("PI_TEST_MISSING_STORED_KEY", undefined);
		const path = tempFile("auth.json", {
			missing: { type: "api_key", key: "$PI_TEST_MISSING_STORED_KEY" },
			command: { type: "api_key", key: "!printf synthetic-key" },
		});
		const credentials = new ReadOnlyAuthStorage(path);
		await expect(credentials.read("missing")).rejects.toThrow("Failed to resolve stored API key");
		expect(await credentials.read("command")).toEqual({ type: "api_key", key: "!printf synthetic-key" });
	});

	it("uses explicit Codex tokens without a stored credential or OAuth refresh", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const provider = runtime.getProvider("openai-codex")!;
		const refresh = vi.spyOn(provider.auth.oauth!, "refresh").mockRejectedValue(new Error("must not refresh"));
		const faux = fauxProvider();
		faux.setResponses([
			(_context, options) => {
				expect(options?.apiKey).toBe("synthetic-explicit");
				return fauxAssistantMessage("ok");
			},
		]);
		vi.spyOn(provider, "streamSimple").mockImplementation(faux.provider.streamSimple);
		const result = await runtime.completeSimple(
			provider.getModels()[0],
			{ messages: [] },
			{ apiKey: "synthetic-explicit" },
		);
		expect(result.stopReason).toBe("stop");
		expect(faux.state.callCount).toBe(1);
		expect(refresh).not.toHaveBeenCalled();
	});

	for (const stored of ["absent", "valid", "expired"] as const) {
		it.each(["configured", "request override", "request deletion", "transform omission"] as const)(
			`preserves configured OAuth-only Codex headers with explicit tokens: %s (stored=${stored})`,
			async (mode) => {
				const credential: OAuthCredential = {
					type: "oauth",
					access: "synthetic-stored-token",
					refresh: "synthetic-refresh-token",
					expires: stored === "valid" ? Date.now() + 3_600_000 : 0,
				};
				const credentials = AuthStorage.inMemory(stored === "absent" ? {} : { "openai-codex": credential });
				const read = vi.spyOn(credentials, "read");
				const modify = vi.spyOn(credentials, "modify");
				const runtime = await ModelRuntime.create({
					credentials,
					modelsPath: tempFile("models.json", {
						providers: {
							"openai-codex": {
								baseUrl: "https://codex.example.test/backend-api",
								headers: { "X-Tenant": "tenant-a", "X-Configured": "retained" },
							},
						},
					}),
					refreshOnCreate: false,
				});
				const provider = runtime.getProvider("openai-codex")!;
				const refresh = vi.spyOn(provider.auth.oauth!, "refresh").mockRejectedValue(new Error("must not refresh"));
				const toAuth = vi
					.spyOn(provider.auth.oauth!, "toAuth")
					.mockRejectedValue(new Error("must not derive OAuth"));
				const token = `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }))}.signature`;
				const headers =
					mode === "request override"
						? { "x-tenant": "request-tenant" }
						: mode === "request deletion"
							? { "x-tenant": null }
							: undefined;
				const transformHeaders = vi.fn((assembled: ProviderHeaders) =>
					mode === "transform omission"
						? Object.fromEntries(Object.entries(assembled).filter(([name]) => name.toLowerCase() !== "x-tenant"))
						: assembled,
				);
				let received: Headers | undefined;
				const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
					received = new Headers(init?.headers);
					return new Response(
						`data: ${JSON.stringify({ type: "response.completed", response: { id: "test", status: "completed" } })}\n\n`,
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				});
				const result = await runtime.completeSimple(
					provider.getModels()[0],
					{ messages: [] },
					{
						apiKey: token,
						transport: "sse",
						fetch,
						headers,
						transformHeaders,
						maxRetries: 0,
					},
				);
				expect(result.stopReason).toBe("stop");
				expect(provider.auth.apiKey).toBeUndefined();
				expect(read).not.toHaveBeenCalled();
				expect(modify).not.toHaveBeenCalled();
				expect(refresh).not.toHaveBeenCalled();
				expect(toAuth).not.toHaveBeenCalled();
				expect(fetch).toHaveBeenCalledOnce();
				expect(received?.get("authorization")).toBe(`Bearer ${token}`);
				expect(received?.get("chatgpt-account-id")).toBe("synthetic-account");
				expect(transformHeaders).toHaveBeenCalledOnce();
				expect(transformHeaders.mock.calls[0][0]).toEqual({
					"X-Configured": "retained",
					...(headers ?? { "X-Tenant": "tenant-a" }),
				});
				expect(received?.get("x-configured")).toBe("retained");
				expect(received?.get("x-tenant")).toBe(
					mode === "configured" ? "tenant-a" : mode === "request override" ? "request-tenant" : null,
				);
			},
		);
	}

	it("preserves OAuth-only provider/model header precedence and request env with explicit tokens", async () => {
		vi.stubEnv("PI_TEST_OAUTH_TENANT", "ambient-tenant");
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: tempFile("models.json", {
				providers: {
					"openai-codex": {
						headers: { "X-Tenant": "$PI_TEST_OAUTH_TENANT", "X-Layer": "provider" },
						authHeader: true,
						modelOverrides: { "configured-codex": { headers: { "x-layer": "configured-model" } } },
						models: [{ id: "configured-codex" }],
					},
				},
			}),
			refreshOnCreate: false,
		});
		const overrides = { apiKey: "synthetic-explicit", env: { PI_TEST_OAUTH_TENANT: "request-tenant" } };
		expect((await runtime.getAuth("openai-codex", overrides))?.auth).toEqual({
			apiKey: overrides.apiKey,
			headers: { "X-Tenant": "request-tenant", "X-Layer": "provider", Authorization: "Bearer synthetic-explicit" },
		});
		const model = runtime.getModel("openai-codex", "configured-codex")!;
		expect(model).toBeDefined();
		expect(
			(
				await runtime.getAuth(
					{ ...model, headers: { "x-tenant": "static-model", "X-Layer": "static-model" } },
					overrides,
				)
			)?.auth.headers,
		).toEqual({
			Authorization: "Bearer synthetic-explicit",
			"x-tenant": "static-model",
			"x-layer": "configured-model",
		});
		expect(runtime.getProvider("openai-codex")?.auth.apiKey).toBeUndefined();
	});

	it("does not dispatch configured explicit OAuth tokens after cancellation during header transformation", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: tempFile("models.json", {
				providers: { "openai-codex": { headers: { "X-Tenant": "tenant-a" } } },
			}),
			refreshOnCreate: false,
		});
		const started = deferred<void>();
		const transformed = deferred<ProviderHeaders>();
		let assembled: ProviderHeaders | undefined;
		const controller = new AbortController();
		const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("must not dispatch"));
		const output = runtime.streamSimple(
			runtime.getModels("openai-codex")[0],
			{ messages: [] },
			{
				apiKey: "synthetic-explicit",
				transport: "sse",
				signal: controller.signal,
				fetch,
				transformHeaders: (headers) => {
					assembled = headers;
					started.resolve();
					return transformed.promise;
				},
			},
		);
		await started.promise;
		controller.abort();
		try {
			expect(assembled).toEqual({ "X-Tenant": "tenant-a" });
			expect((await output.result()).stopReason).toBe("aborted");
			const events: AssistantMessageEvent[] = [];
			for await (const event of output) events.push(event);
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ type: "error", reason: "aborted" });
		} finally {
			transformed.resolve({ "X-Tenant": "late-tenant" });
			await setImmediate();
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	for (const method of ["stream", "streamSimple"] as const) {
		it.each(["pre-abort", "auth", "transform"] as const)(
			`${method} cancels %s setup with one aborted terminal event`,
			async (phase) => {
				const runtime = await ModelRuntime.create({
					credentials: AuthStorage.inMemory(),
					modelsPath: null,
					refreshOnCreate: false,
				});
				const faux = fauxProvider();
				faux.setResponses([fauxAssistantMessage("late dispatch")]);
				const started = deferred<void>();
				const auth = deferred<AuthResult>();
				const transform = deferred<ProviderHeaders>();
				runtime.registerNativeProvider(faux.provider);
				await runtime.refresh({ allowNetwork: false });
				const getAuth = vi.spyOn(runtime, "getAuth").mockImplementation(async () => {
					if (phase === "auth") {
						started.resolve();
						return auth.promise;
					}
					return { auth: {} };
				});
				const controller = new AbortController();
				if (phase === "pre-abort") controller.abort();
				const output = runtime[method](
					faux.getModel(),
					{ messages: [] },
					{
						signal: controller.signal,
						transformHeaders:
							phase === "transform"
								? async () => {
										started.resolve();
										return transform.promise;
									}
								: undefined,
					},
				);
				let settled = false;
				const result = output.result().then((message) => {
					settled = true;
					return message;
				});
				if (phase !== "pre-abort") {
					await started.promise;
					controller.abort();
				}
				await setImmediate();
				try {
					expect(settled).toBe(true);
					expect((await result).stopReason).toBe("aborted");
					const events: AssistantMessageEvent[] = [];
					for await (const event of output) events.push(event);
					expect(events).toHaveLength(1);
					expect(events[0]).toMatchObject({ type: "error", reason: "aborted" });
					if (phase === "pre-abort") expect(getAuth).not.toHaveBeenCalled();
				} finally {
					auth.resolve({ auth: {} });
					transform.resolve({});
					await result;
					await setImmediate();
				}
				expect(faux.state.callCount).toBe(0);
			},
		);
	}

	it.each(["stream", "streamSimple"] as const)(
		"%s removes raw model headers before fetch after transformation",
		async (method) => {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				refreshOnCreate: false,
			});
			const model: Model<"openai-responses"> = {
				...fauxProvider().getModel(),
				provider: "headers",
				api: "openai-responses",
				baseUrl: "https://example.test/v1",
				headers: { "X-Sensitive": "synthetic-secret" },
			};
			runtime.registerNativeProvider(
				createProvider({
					id: model.provider,
					models: [model],
					api: { stream, streamSimple },
					auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "synthetic-key" } }) } },
				}),
			);
			let received: Headers | undefined;
			const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				received = new Headers(init?.headers);
				return new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { id: "test", status: "completed" } })}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			});
			const transformHeaders = vi.fn(() => ({}));
			const result = await runtime[method](
				model,
				{ messages: [] },
				{ fetch, transformHeaders, maxRetries: 0 },
			).result();
			expect(result.stopReason).toBe("stop");
			expect(fetch).toHaveBeenCalledOnce();
			expect(transformHeaders).toHaveBeenCalledOnce();
			expect(received?.has("x-sensitive")).toBe(false);
		},
	);

	it.each([false, true])(
		"applies modelOverrides headers after definitions and extensions case-insensitively (extension=%s)",
		async (extension) => {
			const faux = fauxProvider({ provider: "override-headers" });
			const model = faux.getModel();
			const modelsPath = tempFile("models.json", {
				providers: {
					[model.provider]: {
						baseUrl: "https://example.test/v1",
						api: model.api,
						apiKey: "synthetic-key",
						models: [
							{
								id: model.id,
								headers: { "X-Tenant": "definition", "x-same-case": "definition", "x-unchanged": "retained" },
							},
						],
						modelOverrides: {
							[model.id]: { headers: { "x-tenant": "final-user-value", "x-same-case": "final-user-value" } },
						},
					},
				},
			});
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath,
				refreshOnCreate: false,
			});
			let received: ProviderHeaders | undefined;
			faux.setResponses([
				(_context, options) => {
					received = options?.headers;
					return fauxAssistantMessage("ok");
				},
			]);
			runtime.registerProvider(model.provider, {
				api: model.api,
				streamSimple: faux.provider.streamSimple,
				...(extension
					? { models: [{ ...model, headers: { "X-TENANT": "extension", "x-same-case": "extension" } }] }
					: {}),
			});
			const effective = runtime.getModel(model.provider, model.id)!;
			const auth = await runtime.getAuth(effective);
			expect(auth?.auth.headers).toEqual({
				"x-unchanged": "retained",
				"x-tenant": "final-user-value",
				"x-same-case": "final-user-value",
			});
			expect((await runtime.completeSimple(effective, { messages: [] })).stopReason).toBe("stop");
			expect(received).toEqual(auth?.auth.headers);
		},
	);
});
