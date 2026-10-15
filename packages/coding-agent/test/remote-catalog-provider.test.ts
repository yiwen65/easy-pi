import {
	createModels,
	createProvider,
	type ImageModel,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

const neverAbortedSignal = new AbortController().signal;

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function image(id: string): ImageModel<"test-images"> {
	const { reasoning: _reasoning, contextWindow: _contextWindow, maxTokens: _maxTokens, ...base } = model(id);
	return { ...base, type: "image", api: "test-images", output: ["image"] };
}

function testProvider(localGeneratedAt?: number) {
	return withRemoteCatalog(
		createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model("static")],
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		}),
		"https://pi.dev",
		localGeneratedAt,
	);
}

async function refreshProvider(
	provider: Provider,
	store: InMemoryModelsStore,
	overrides: Partial<Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal">> = {},
): Promise<void> {
	const publish = async (publication: ModelsPublication): Promise<boolean> => {
		if (publication.persist === null) await store.delete(provider.id);
		else if (publication.persist !== undefined) await store.write(provider.id, publication.persist);
		publication.update?.();
		return true;
	};
	await provider.refreshModels?.({
		credential: { type: "api_key" },
		stored: await store.read(provider.id),
		publish,
		allowNetwork: overrides.allowNetwork ?? true,
		force: overrides.force,
		signal: overrides.signal ?? neverAbortedSignal,
	});
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog provider", () => {
	it.each([undefined, false, true] as const)(
		"retains bundled Codex Fast capability when a newer remote declaration is %s",
		async (remoteFast) => {
			const local: Model<"openai-codex-responses"> = {
				...model("gpt-6.1-sol"),
				api: "openai-codex-responses",
				provider: "openai-codex",
				compat: { supportsFastMode: true },
			};
			const remote = {
				...local,
				name: "New remote name",
				contextWindow: 2000,
				compat: { supportsToolSearch: true, ...(remoteFast === undefined ? {} : { supportsFastMode: remoteFast }) },
			};
			const make = () =>
				withRemoteCatalog(
					createProvider({
						id: "openai-codex",
						auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
						models: [local],
						api: {
							stream: () => {
								throw new Error("not used");
							},
							streamSimple: () => {
								throw new Error("not used");
							},
						},
					}),
					"https://catalog.test",
					1000,
				);
			const provider = make();
			const store = new InMemoryModelsStore();
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify([remote, { ...remote, id: "unknown-model" }]), {
					headers: { "last-modified": new Date(2000).toUTCString() },
				}),
			);
			await refreshProvider(provider, store);
			for (const current of [provider, make()]) {
				if (current !== provider) await refreshProvider(current, store, { allowNetwork: false });
				const known = current.getModels().find((entry) => entry.id === local.id);
				expect(known).toMatchObject({
					name: "New remote name",
					contextWindow: 2000,
					compat: { supportsToolSearch: true, supportsFastMode: remoteFast ?? true },
				});
				expect(current.getAllModels?.().find((entry) => entry.id === local.id)).toEqual(known);
				const unknown = current.getModels().find((entry) => entry.id === "unknown-model");
				if (remoteFast === undefined) expect(unknown?.compat ?? {}).not.toHaveProperty("supportsFastMode");
				else expect(unknown?.compat).toMatchObject({ supportsFastMode: remoteFast });
			}
			expect(fetchSpy).toHaveBeenCalledOnce();
		},
	);

	it("does not inherit Codex Fast capability across a remote API change", async () => {
		const local: Model<"openai-codex-responses"> = {
			...model("shared"),
			provider: "openai-codex",
			api: "openai-codex-responses",
			compat: { supportsFastMode: true },
		};
		const provider = withRemoteCatalog(
			createProvider({
				id: "openai-codex",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [local],
				api: {
					stream: () => {
						throw new Error("not used");
					},
					streamSimple: () => {
						throw new Error("not used");
					},
				},
			}),
		);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify([{ ...local, api: "openai-responses", compat: {} }])),
		);
		await refreshProvider(provider, new InMemoryModelsStore());
		expect(provider.getModels()[0].api).toBe("openai-responses");
		expect(provider.getModels()[0].compat ?? {}).not.toHaveProperty("supportsFastMode");
	});
	it("parses keyed catalogs, sends version headers, observes the refresh TTL, and supports forced refreshes", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ dynamic: model("dynamic") }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"User-Agent": expect.stringContaining(`pi/${VERSION}`),
		});
	});

	it("prefers the newer of the generated and remote catalogs", async () => {
		const localGeneratedAt = Date.parse("2026-07-23T10:00:00.000Z");
		const newerHeader = new Date(localGeneratedAt + 60_000).toUTCString();
		const responses = [
			new Response(
				// The stale snapshot renames "static" and adds "old": bundled must win
				// the collision while "old" still surfaces.
				JSON.stringify({
					static: { ...model("static"), name: "stale static" },
					old: model("old"),
				}),
				{
					headers: { "last-modified": new Date(localGeneratedAt - 60_000).toUTCString() },
				},
			),
			new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "last-modified": newerHeader },
			}),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider(localGeneratedAt);
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "old"]);
		expect(provider.getModels().find((entry) => entry.id === "static")?.name).toBe("static");

		await refreshProvider(provider, store, { force: true });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect(await store.read(provider.id)).toMatchObject({ lastModified: Date.parse(newerHeader) });
	});

	it("restores snapshot-only models from a stale stored catalog without network", async () => {
		// Regression: a generated catalog regenerated *after* the stored snapshot
		// must not hide models only the snapshot knows (gpt-6-astra vanishing from
		// openai-codex). A stale overlay may not override bundled definitions, but
		// snapshot-only ids stay visible even when no network is available.
		const provider = testProvider(Date.parse("2026-09-12T20:37:00.000Z"));
		const store = new InMemoryModelsStore();
		const storedAt = Date.parse("2026-09-10T20:33:00.000Z");
		await store.write(provider.id, {
			models: [model("gpt-6-astra")],
			checkedAt: storedAt,
			lastModified: storedAt,
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await refreshProvider(provider, store, { allowNetwork: false });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "gpt-6-astra"]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("revalidates a stored catalog with its etag and keeps the overlay on 304", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
		expect(await store.read(provider.id)).toMatchObject({ etag: '"catalog-1"' });

		const checkedAt = (await store.read(provider.id))?.checkedAt;
		await refreshProvider(provider, store, { force: true });

		expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.checkedAt).toBeGreaterThanOrEqual(checkedAt ?? 0);
	});

	it("drops a stale etag when the overlay becomes unavailable", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("not implemented", { status: 501 }),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect((await store.read(provider.id))?.etag).toBeUndefined();
	});

	it("keeps the etag and overlay after a transient failure", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await expect(refreshProvider(provider, store, { force: true })).rejects.toThrow(/429/);

		const stored = await store.read(provider.id);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);

		await refreshProvider(provider, store, { force: true });
		expect(fetchSpy.mock.calls[4]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
	});

	it("lets a newer catalog request bypass a stalled older request without stale publication", async () => {
		let calls = 0;
		let markFirstStarted: (() => void) | undefined;
		let finishFirst: ((response: Response) => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstResponse = new Promise<Response>((resolve) => {
			finishFirst = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				markFirstStarted?.();
				return firstResponse;
			}
			return new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "content-type": "application/json" },
			});
		});
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);

		const first = models.refresh({ providers: [provider.id], force: true });
		await firstStarted;
		const second = models.refresh({ providers: [provider.id], force: true });
		await second;
		await first;
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);

		finishFirst?.(
			new Response(JSON.stringify({ older: model("older") }), {
				headers: { "content-type": "application/json" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["newer"]);
	});

	it("requests all operations, publishes mixed catalogs, and keeps legacy queries chat-only", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify([model("shared"), image("shared"), { ...model("unknown"), type: "video" }]), {
				headers: { etag: '"all-1"' },
			}),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.get("type")).toBe("all");
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "shared"]);
		expect(provider.getAllModels?.().map((entry) => [entry.type ?? "chat", entry.id])).toEqual([
			["chat", "static"],
			["chat", "shared"],
			["image", "shared"],
		]);
		expect((await store.read(provider.id))?.models).toHaveLength(2);
	});

	it("does not reuse a legacy chat validator or freshness window for the all-operation request", async () => {
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await store.write(provider.id, {
			models: [model("legacy")],
			etag: '"chat-1"',
			checkedAt: Date.now(),
			lastModified: Date.now(),
		});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify([model("legacy"), image("legacy")]), { headers: { etag: '"all-1"' } }),
			);
		await refreshProvider(provider, store);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
		expect(await store.read(provider.id)).toMatchObject({ catalogType: "all", etag: '"all-1"' });
		expect(provider.getAllModels?.()).toHaveLength(3);
	});

	it("rejects an unsolicited 304 rather than treating an old chat body as an all-operation body", async () => {
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await store.write(provider.id, { models: [model("legacy")], etag: '"chat-1"' });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 304 }));
		await expect(refreshProvider(provider, store)).rejects.toThrow("without an all-operation cached body");
		expect(await store.read(provider.id)).not.toHaveProperty("catalogType");
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "legacy"]);
	});

	it("preserves mixed bodies and image overlays across all-operation revalidation and 304", async () => {
		const responses = [
			new Response(JSON.stringify([model("shared"), image("shared")]), { headers: { etag: '"all-1"' } }),
			new Response(null, { status: 304 }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift()!);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });
		expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"all-1"' });
		expect(provider.getAllModels?.()).toHaveLength(3);
		expect((await store.read(provider.id))?.models).toHaveLength(2);
	});

	it("restores mixed stale snapshots with type-aware collisions and skips unknown operations", async () => {
		const provider = testProvider(1000);
		const store = new InMemoryModelsStore();
		await store.write(provider.id, {
			models: [
				{ ...model("static"), name: "Stale" },
				image("static"),
				{ ...model("unknown"), type: "video" } as unknown as Model<"openai-completions">,
			],
			lastModified: 500,
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await refreshProvider(provider, store, { allowNetwork: false });
		expect(provider.getModels()).toEqual([model("static")]);
		expect(provider.getAllModels?.().map((entry) => [entry.type ?? "chat", entry.id])).toEqual([
			["chat", "static"],
			["image", "static"],
		]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("retains bundled image models when a legacy chat-only response overlays their ID", async () => {
		const base = testProvider();
		const provider = withRemoteCatalog(
			{ ...base, getAllModels: () => [model("static"), image("shared")] },
			"https://catalog.test",
		);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ shared: model("shared") })));
		await refreshProvider(provider, new InMemoryModelsStore());
		expect(provider.getAllModels?.().map((entry) => [entry.type ?? "chat", entry.id])).toEqual([
			["chat", "static"],
			["image", "shared"],
			["chat", "shared"],
		]);
	});

	it("does not publish mixed responses after caller cancellation", async () => {
		const controller = new AbortController();
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			controller.abort();
			return new Response(JSON.stringify([image("cancelled")]));
		});
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await expect(refreshProvider(provider, store, { signal: controller.signal })).resolves.toBeUndefined();
		expect(await store.read(provider.id)).toBeUndefined();
		expect(provider.getAllModels?.()).toEqual([model("static")]);
	});

	it("treats unimplemented pi.dev catalog routes as an unavailable overlay", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not implemented", { status: 501 }));
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await expect(refreshProvider(provider, store)).resolves.toBeUndefined();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(await store.read(provider.id)).toMatchObject({ models: [], checkedAt: expect.any(Number) });
	});
});
