# Chat and image model migration

`ModelRuntime` implements the unified pi-ai `Models` interface. A provider can own both chat and image generation. Model identity is `(provider, type, id)`, so a chat model and image model with the same upstream ID coexist.

## Queries and requests

```typescript
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  allowModelNetwork: false,
});

const chat = runtime.getModels();                 // chat only
const images = runtime.getModelsOfType("image"); // ImageModel[]
const all = runtime.getAllModels();               // AnyModel[]
const availableImages = await runtime.getAvailableOfType("image");
const allAvailable = await runtime.getAllAvailable();

const image = runtime.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image");
if (image) {
  const result = await runtime.generateImages(image, {
    input: [{ type: "text", text: "Draw a small tree" }],
  }, { signal: AbortSignal.timeout(30_000) });
  if (result.stopReason !== "stop") throw new Error(result.errorMessage);
}
```

Generation requires configured auth; the example's empty credential store does not authenticate OpenRouter. No request occurs until `generateImages()` is called. For real integrations, supply your chosen credential store or use the runtime's login/API-key methods. `getAuth()` accepts either operation and resolves configured auth, headers, base URL and environment. Keyless native providers are configured when their resolver returns `{ auth: {} }`, not `undefined`.

Image generation applies auth/model/request headers and `transformHeaders` once. It does not forward the transform or reapply removed model defaults. Failures and cancellation return `AssistantImages` with `stopReason: "error" | "aborted"`; they do not reject. Cancellation stops waiting even when an adapter ignores the signal; stopping the underlying work requires adapter cooperation.

Unqualified `getModel()`, `getModels()`, `getAvailable()`, `ModelRegistry`, `/model`, CLI model resolution, scoped models and session model fields remain **chat-only**. Do not pass image models to chat/deferred calls. Runtime guards reject the wrong operation before auth or adapter dispatch.

## Removed public APIs

There is no compatibility adapter for the removed image-only collections/providers:

| Removed | Replacement |
| --- | --- |
| `ImagesModels`, `MutableImagesModels`, `ImagesProvider` | `Models`, `MutableModels`, `Provider` |
| `createImagesModels()`, `createImagesProvider()` | `createModels()`, `createProvider()` |
| `builtinImagesModels()`, `builtinImagesProviders()` | `builtinModels()`, `builtinProviders()` from `pi-ai/providers/all` |
| `openrouterImagesProvider()` | `openrouterProvider()` from `pi-ai/providers/openrouter` |
| `ImagesModel`, `ImagesApi`, `KnownImagesApi` | `ImageModel`, `ImageApi`, `KnownImageApi` |
| image-specific provider ID types | `ProviderId` |

The exported extension `ProviderModelConfig` is now a chat/image union rather than a chat-only interface. Code that extended the old interface should use a type intersection or narrow the desired variant first.

Change image definitions to include `type: "image"` and `output: ["image"]` (optionally also `"text"`). Move the old image provider's `api` implementation into `images: { [imageApi]: implementation }`. Dynamic `fetchModels(context)` may return a mixed list. Chat definitions may continue omitting `type`; explicit chat definitions use `type: "chat"`.

Existing low-level `generateImages`, `getImageModel`, `getImageModels`, `getImageProviders`, `ImagesContext`, `ImagesOptions`, `AssistantImages` and image API registry functions remain. Global compatibility helpers do not apply coding-agent configuration; prefer `ModelRuntime` when using extension or models.json overlays.

## Extension composition

Register a native `Provider` for custom auth/filtering, or use `pi.registerProvider(name, config)` with mixed `models` and provider-local `images` adapters. See [Custom Providers](custom-provider.md#image-providers).

- Provider-wide endpoint/header/auth overlays retain both catalogs and inherited image capability.
- An explicit extension `models` list replaces the **whole** chat/image catalog, even `[]`. Re-registration still merges defined config fields and preserves omitted fields.
- API/model defaults and model headers match operation plus ID. A chat model with an ID does not supply image defaults for that ID.
- Legacy OAuth `modifyModels()` receives chat models only; images survive its projection.
- Native `filterAllModels()` can filter both operations. Without it, `filterModels()` applies only to chat and authenticated images remain available.
- Session views isolate provider registrations and unregister operations. They still share trusted provider implementations and credentials; they are not JavaScript sandboxes. Image adapters are not registered globally by extension composition.

`models.json` `models` and `modelOverrides` remain chat-only. Provider-level `baseUrl`, headers and auth settings also affect images, but same-ID chat upserts/overrides do not. Register image definitions/adapters via an extension instead.

## Catalogs and cache

Cached provider catalogs can contain both operations. Legacy chat-only caches restore normally, and stale collisions are resolved by operation plus ID rather than ID alone. New remote requests add `?type=all`; a persisted `catalogType: "all"` marker scopes freshness and ETags to that request variant. An old chat-only ETag is never sent for a new all-operation request, and an unsolicited 304 without a matching cached body is rejected. TTL, force, cancellation and generation-checked publication still apply.

This is a **client contract**, not a claim that pi.dev or another configured catalog server implements typed queries. Legacy keyed chat responses remain readable and cannot overwrite bundled image entries. Unsupported routes keep the existing local catalog. Public legacy chat JSON remains unchanged in shape; additive mixed JSON arrays are described in the repository's [model catalog documentation](../../../docs/model-catalog.md).
