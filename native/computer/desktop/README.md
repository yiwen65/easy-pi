# Optional desktop bridge

Explicit Node/macOS activation and packaging are documented in [PACKAGING.md](../PACKAGING.md).
Status authority: `docs/tasks/2026-09-18-computer-native-implementation-task.md`.

## General Computer contract

The current source uses host interface 2, genuine generated General Computer
bindings, and an owned renderer with lifetime protocol 3. **Root production pins
still identify the historical P06 build.** Use a matching qualified installation;
do not combine the new bridge with old binaries. Final promotion/delivery is
tracked only by the task authority.

One `computer` tool provides window discovery/selection, bounded semantic
observation, exact-window screenshots, information-dependent action segments,
and explicit two-window drag targeting. Segments include Unicode text, field
replacement, focus, keys/chords and paired holds/releases, pointer movement,
clicks, dragging, two-axis scrolling, and window actions. The closed schemas in
`contracts.ts`, `segment-contracts.ts` and `drag-contracts.ts` define accepted
requests; this is not an arbitrary script interface.

The desktop route works with existing applications/browser profiles. Native
routing prefers background delivery and automatically prepares or uses foreground
delivery when needed; results report the actual route. Foreground work may
interrupt the user. Physical input is not suppressed. The optional isolated
browser profile remains separate, not a prerequisite for existing-browser use.

An action dispatch is not business success. Segment results separate dispatched
prefixes, condition confirmation, unknown effects and remaining recovery budget.
Fresh evidence is required across relevant changes; unknown input is never
blindly replayed. Recovery stays in the original Agent loop and shared scheduler,
with a bounded native budget, not a second planner or recording/replay system.

Only current model-visible tool results grant image/element refs. Filtering,
compaction, renewal and capability removal invalidate old evidence. Children get
fresh bindings sharing the original host/scheduler; disposing a child does not
close that host. Final owners must await feature close. Missing or failed
rendering and emergency stop latch the feature, revoke descendants and stop the
original loop without fabricating terminal settlement. See
[SDK ownership](../../../packages/coding-agent/docs/sdk.md#optional-native-computer)
and [emergency keybindings](../../../packages/coding-agent/docs/keybindings.md#application).

## Historical P06 bridge and qualification

The following records describe the narrower P06 interface, not the General
contract above. Historical P04 loaders remain separate.

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
