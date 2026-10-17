import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazyApi } from "../src/api/lazy.ts";
import { stream, streamSimple } from "../src/api/openai-responses.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { AuthResult, OAuthCredential } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import type { AssistantMessageEvent, Model, ProviderHeaders, ProviderStreams } from "../src/types.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const context = { messages: [] };

describe("Models request auth boundaries", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([false, true])(
		"uses an explicit Codex token without reading/refreshing stored OAuth (stored=%s)",
		async (stored) => {
			const credentials = new InMemoryCredentialStore();
			const previous: OAuthCredential = { type: "oauth", access: "old", refresh: "old-refresh", expires: 0 };
			if (stored) await credentials.modify("openai-codex", async () => previous);
			const read = vi.spyOn(credentials, "read");
			const codex = openaiCodexProvider();
			const refresh = vi.spyOn(codex.auth.oauth!, "refresh").mockRejectedValue(new Error("must not refresh"));
			const faux = fauxProvider({ provider: "openai-codex" });
			let key: string | undefined;
			faux.setResponses([
				(_context, options) => {
					key = options?.apiKey;
					return fauxAssistantMessage("ok");
				},
			]);
			const models = createModels({ credentials });
			models.setProvider({ ...faux.provider, auth: codex.auth });
			expect(
				(await models.completeSimple(faux.getModel(), context, { apiKey: "synthetic-explicit-token" })).stopReason,
			).toBe("stop");
			expect(key).toBe("synthetic-explicit-token");
			expect(read).not.toHaveBeenCalled();
			expect(refresh).not.toHaveBeenCalled();
			if (stored) expect(await credentials.read("openai-codex")).toEqual(previous);
		},
	);

	for (const method of ["stream", "streamSimple"] as const) {
		it.each(["pre-abort", "auth", "transform"] as const)(
			`${method} returns one aborted terminal event during %s setup`,
			async (phase) => {
				const faux = fauxProvider();
				faux.setResponses([fauxAssistantMessage("must not dispatch")]);
				const started = deferred<void>();
				const auth = deferred<AuthResult>();
				const transform = deferred<ProviderHeaders>();
				const controller = new AbortController();
				const models = createModels();
				const resolve = vi.fn(async () => {
					if (phase === "auth") {
						started.resolve();
						return auth.promise;
					}
					return { auth: {} };
				});
				models.setProvider({ ...faux.provider, auth: { apiKey: { name: "test", resolve } } });
				if (phase === "pre-abort") controller.abort(new Error("cancel setup"));
				const output = models[method](faux.getModel(), context, {
					signal: controller.signal,
					transformHeaders:
						phase === "transform"
							? async () => {
									started.resolve();
									return transform.promise;
								}
							: undefined,
				});
				let settled = false;
				const result = output.result().then((message) => {
					settled = true;
					return message;
				});
				if (phase !== "pre-abort") {
					await started.promise;
					controller.abort(new Error("cancel setup"));
				}
				await setImmediate();
				try {
					expect(settled).toBe(true);
					expect((await result).stopReason).toBe("aborted");
					const events: AssistantMessageEvent[] = [];
					for await (const event of output) events.push(event);
					expect(events).toHaveLength(1);
					expect(events[0]).toMatchObject({ type: "error", reason: "aborted" });
					if (phase === "pre-abort") expect(resolve).not.toHaveBeenCalled();
				} finally {
					auth.resolve({ auth: {} });
					transform.reject(new Error("late transform failure"));
					// Observe the unused promise too in phases that do not invoke the transform.
					void transform.promise.catch(() => {});
					await result;
					await setImmediate();
				}
				expect(faux.state.callCount).toBe(0);
			},
		);
	}

	it("cancels the stream promptly but persists an already-started OAuth rotation", async () => {
		const credentials = new InMemoryCredentialStore();
		const previous: OAuthCredential = { type: "oauth", access: "old", refresh: "old-refresh", expires: 0 };
		const rotated: OAuthCredential = {
			...previous,
			access: "new",
			refresh: "rotated",
			expires: Date.now() + 3_600_000,
		};
		await credentials.modify("faux", async () => previous);
		const started = deferred<void>();
		const finish = deferred<OAuthCredential>();
		let refreshSignal: AbortSignal | undefined;
		const faux = fauxProvider();
		const models = createModels({ credentials });
		models.setProvider({
			...faux.provider,
			auth: {
				oauth: {
					name: "test",
					login: async () => previous,
					refresh: async (_credential, signal) => {
						refreshSignal = signal;
						started.resolve();
						return finish.promise;
					},
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
		});
		const controller = new AbortController();
		const output = models.streamSimple(faux.getModel(), context, { signal: controller.signal });
		await started.promise;
		controller.abort();
		expect((await output.result()).stopReason).toBe("aborted");
		expect(refreshSignal?.aborted).toBe(false);
		finish.resolve(rotated);
		// A queued mutation observes the credential only after refresh persistence releases the lock.
		expect(await credentials.modify("faux", async () => undefined)).toEqual(rotated);
		expect(faux.state.callCount).toBe(0);
	});

	it("does not dispatch a module that finishes loading after cancellation", async () => {
		const loaded = deferred<ProviderStreams>();
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("late")]);
		const controller = new AbortController();
		const output = lazyApi(() => loaded.promise).streamSimple(faux.getModel(), context, {
			signal: controller.signal,
		});
		let settled = false;
		const result = output.result().then((message) => {
			settled = true;
			return message;
		});
		controller.abort();
		await setImmediate();
		try {
			expect(settled).toBe(true);
			expect((await result).stopReason).toBe("aborted");
		} finally {
			loaded.resolve(faux.provider);
			await result;
			await setImmediate();
		}
		expect(faux.state.callCount).toBe(0);
	});

	it.each(["stream", "streamSimple"] as const)(
		"%s does not resurrect model headers after transformation (fetch boundary)",
		async (method) => {
			const model: Model<"openai-responses"> = {
				...fauxProvider().getModel(),
				api: "openai-responses",
				provider: "header-test",
				baseUrl: "https://example.test/v1",
				headers: { "X-Sensitive": "synthetic-secret", "X-Keep": "original" },
			};
			const models = createModels();
			models.setProvider(
				createProvider({
					id: model.provider,
					models: [model],
					auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "synthetic-key" } }) } },
					api: { stream, streamSimple },
				}),
			);
			let received: Headers | undefined;
			const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				received = new Headers(init?.headers);
				return new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { id: "test", status: "completed" } })}\n\n`,
					{
						headers: { "Content-Type": "text/event-stream" },
					},
				);
			});
			const transformHeaders = vi.fn(() => ({ "X-Keep": "transformed" }));
			const result = await models[method](model, context, { fetch, transformHeaders, maxRetries: 0 }).result();
			expect(result.stopReason).toBe("stop");
			expect(fetch).toHaveBeenCalledOnce();
			expect(transformHeaders).toHaveBeenCalledOnce();
			expect(received?.has("x-sensitive")).toBe(false);
			expect(received?.get("x-keep")).toBe("transformed");
			expect(model.headers?.["X-Sensitive"]).toBe("synthetic-secret");
		},
	);
});
