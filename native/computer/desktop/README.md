# Optional desktop bridge

Explicit Node/macOS activation and packaging are documented in [PACKAGING.md](../PACKAGING.md).
The loader selects the qualified P06 fast profile; historical P04 loaders remain separate.
Status authority: `docs/tasks/2026-09-18-computer-native-implementation-task.md`.

- `loadDesktopSdk()` explicitly loads the separately pinned P06 candidate. Importing the bridge does not load native code. P04 loaders/pins remain unchanged.
- A trusted host constructs `ControlledComputerRuntime` with a genuine `openDiscoverySession` factory and passes its existing `ComputerSession` to `createDesktopBinding`. Metadata selection does not grant native content/input authorization.
- One `computer` tool supports discovery, opaque-ref selection, bounded semantic observation/plans, exact-window PNG capture, one image click/line-scroll/listed key. Selected native children are retained and drained by the original runtime.
- The existing AgentSession provider-context observer checks the final canonical messages after transforms/image filtering. Only an exact live tool result grants its refs; missing/changed images, compaction omission, cancellation, renewal and replacement invalidate them. History cannot recreate capabilities. Direct tool callers must supply the actual provider context through the binding observer; merely executing capture does not enable input.
- PNG is encoded once into flat Pi image content. Details contain no image bytes or Base64. The view retains a SHA256 fingerprint, not a second image. Header checks are not a full PNG decoder or provenance proof.
- Existing outer desktop scheduling and result/terminal separation remain authoritative. No inner loop, scheduler, foreground fallback, arbitrary script, text synthesis or unknown-action replay is added.

## Checks

```sh
node --test native/computer/desktop/test/{contracts,projection,view}.test.ts
node native/computer/desktop/typecheck.mjs /absolute/verified/p06/typescript
```

Generated-value tool tests require `ALLOW_NATIVE_LOAD_TESTS=true`,
`ALLOW_GUI_TESTS=false`, `ALLOW_REAL_APIS=false`, and
`CUA_DRIVER_TYPESCRIPT_DIR=/absolute/verified/p06/typescript`:

```sh
node --test native/computer/desktop/test/tool.test.ts
node node_modules/vitest/dist/cli.js --run --config native/computer/desktop/integration/vitest.config.ts
```

These automated tests use a fake desktop and faux provider, not GUI delivery.
Separate installed-product qualification exercised actual AgentSession discovery,
selection, capture, Tab/Return and a native child. A bounded gpt-6-astra/low run
selected and clicked the red fixture rectangle from its actual image. See
[P07 evidence](../../../docs/implementation/computer/p07-qualification.md).
Other11 listed keys have mapping/compile coverage, not actual delivery qualification.
P08 measurement status remains in the sole task authority.
