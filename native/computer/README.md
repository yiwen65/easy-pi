# Optional Computer native boundaries

Current delivery is explicit, lazy Computer activation for **Node24.15.0 / macOS arm64**. Start with [PACKAGING.md](PACKAGING.md), the [desktop bridge](desktop/README.md), and [P07 qualification](../../docs/implementation/computer/p07-qualification.md). The fast SDK, installed AgentSession GUI path, native child and bounded real-model image/action loop are separately qualified. Bun and other platforms are not supported; exact limits and current P08 status are in the sole task authority.

Ordinary coding does not load native code or register Computer. No native dependency is added to the main npm workspace. Native assets are a separate `computer/` installation directory, not a replacement Agent loop.

## Historical P02–P04 boundaries

The sections below preserve earlier qualification records and their narrower APIs. They are not the current delivery/status summary. The historical P02 adapter is deliberately not connected to the P01 fake ComputerBackend or used by the current controlled desktop entry.

## Boundary

- `loader.ts`: inspect pinned input files without executing them; explicitly load the generated SDK; construct a lazy adapter using the host's exact configured options, authorization callback and activity observer. No permission defaults, auto-approval, daemon or foreground fallback.
- `adapter.ts`: `open()`, exact-window `observe()`, one `click()`, per-call `{ result, cancel }`, and awaited `close()`. Method/input/output types come from the actual generated SDK declarations, not reconstructed bindings.
- `integrity.ts` / `pinned-inputs.json`: detect drift in the reviewed JS/declarations, runtime resolver and two binaries before loading. The SDK initializer checks UniFFI version and 109 API checksums. See [UPSTREAM.md](UPSTREAM.md) for provenance.

Creating the adapter does not load native code. Its first `open`, `observe` or `click` loads the SDK **and creates a desktop driver**. That requires a separately authorized and qualified GUI host. Configuration/callback objects are supplied by trusted code and must remain stable until creation. This is not a model-facing arbitrary JSON API.

`loadPinnedSdk()` alone initializes N-API, SDK bindings and callback vtables, but does not invoke a driver constructor or TCC method. The separate opt-in fixture probe has also exercised real construction, tree observation, a single background AX click, SDK cancellation and shutdown/destruction. Currently loading fails closed outside **Node 24.15.0 / macOS arm64**; this is a narrow experimental runtime pin, not a claim of general Node/Bun or macOS-version support.

## Cancellation and ownership limits

A call's `cancel()` requests cancellation through the generated API's AbortSignal. It does not fabricate a result, replay an action, or release resources using a timeout. Calls remain pending until the SDK promise settles. Pre-aborted calls never create a driver or dispatch work.

`close()` gates new work, requests cancellation, waits for pending SDK promises, calls uncancelled `shutdown()`, then explicitly destroys the owned handle. Creation failure and close failure are cached. A failed shutdown retains the handle rather than destroying it early. The adapter has no post-create setup that could orphan a successfully acquired owner.

**SDK settlement is not OS terminal acknowledgement.** The pinned Rust ABI aborts tasks without awaiting termination; macOS AX work can escape into `spawn_blocking`. Neither a rejected SDK promise nor shutdown proves those effects stopped. Do not connect this adapter to P01 `ComputerService`, release a desktop lease on its settlement, or enable concurrent production desktop use. P03/P04 must qualify/fix that boundary first. Fulfilled click results retain `Partial`/`Unverifiable`/other effects; they are not converted into confirmed success.

## P03 ownership foundation (historical qualified surface)

`controlled/` is independent of the unchanged P02 adapter and pins. Its reviewed Rust delta and MIT notice are in [`patches/`](patches/README.md). The generated UniFFI facade has an owned host, parent-bound native sessions, inert operation allocation, explicit cancellation, and separate result/terminal subscribers. `controlled/adapter.ts` derives its types from those actual generated declarations; `loader.ts` checks its own 81 pinned inputs before loading. No handwritten binding or default tool is added.

The accepted P03 qualification surface was exact-window tree-only observation and one enabled, advertised background AXPress using the same session's latest token. That frozen P03 patch has no screenshot, pixel/selection/foreground fallback or batch executor; current P04 additions are described separately below. Native supervisors retain blocking workers and matched focus callbacks independently of foreign waiters. Cancellation closes new admission; already committed calls may finish. A terminal receipt proves driver-owned drain, **not external application effects or rollback**. Rejected proof/cleanup quarantines the owner; no timeout, GC, retry or replacement releases its lease.

The cooperating-process lease is derived from the actual account's persistent home at `.pi-computer-desktop-v1/desktop.lock`, not the process HOME/TMPDIR. Clean native shutdown preserves its inode and publishes a clean generation. A stopped owner is not stolen; an unclean exit leaves a dirty marker that refuses future admission. **Do not delete/reset the marker or automatically retry.** There is no recovery API or isolation from unrelated automation/the user. Failure evidence and an explicit recovery decision are required.

The controlled GUI probe wraps the real adapter with `core/computer/host.ts`, using only the existing outer scheduler, independent parent/worker/sibling capabilities and persistent per-session ownership. Its parent must qualify every action process's own TCC identity and permission, forward fixture Stop, drain all output, count effects independently and require natural exit. It is not an unattended desktop tool or a P01/model-facing bridge. Necessary SDK application/window metadata and prior-focus restoration are still part of the authorized route.

## P04 bounded form profile — experimental, AppKit subset qualified

Current `controlled/pinned-inputs.json` targets the separately generated P04 SDK and [`p04-controlled.patch`](patches/p04-controlled.patch), not the frozen P03 SDK. The P02 route and historical P03 evidence remain unchanged.

- Rust `startPlan` executes 1–8 ordered Fill/Press/AssertValue steps with a deadline capped at 30 seconds. Deadline/cancel closes new admission and still waits for tracked workers and callbacks; it never unlocks live work. Ref targets never rebind; exact role+label selectors re-resolve from fresh complete observations. Press requires a postcondition. No script, retry or replay.
- Controlled observations traverse the reported AXChildren hierarchy, including layout/read-only rows and exact string values. Errors, cuts, cycles or modal surfaces invalidate completeness and tokens; web/secure rows never grant native mutation tokens. Bounds are 512 nodes, depth 32 and 64 KiB text. This is not an atomic UI, pixels or hidden-DOM completeness claim.
- Fill retains canonical permission/manifest/target checks, the per-PID lease and original-handle membership checks; it performs one string AXValue write and exact same-handle readback. No focus/key/coordinate fallback.
- `controlled/{contracts,tool,binding}.ts` provides a distinct optional model-facing form protocol through the existing ComputerSession binding and outer scheduler, not another Agent loop. Inputs are strictly validated with 16 KiB aggregate UTF-8 text. Only rows actually shown in the 4 KiB model view can grant targets; refresh/segment attempts invalidate old grants. Incomplete, degraded, web or ambiguous rows grant no selectors. Per-step facts, completed prefix and unknown outcomes are preserved; details do not duplicate input text, raw tree, images or app metadata.

Offline Rust/build/generation checks passed, as did 8 genuine-generated-value/fake-host tool tests and 4 real AgentSession/faux tests. The same eight-step fake form required 9→3 model requests, 4→1 plan calls and 8→2 outer scheduler acquisitions. **These are synthetic request counts, not real desktop performance.** Root isolated `npm run check` passed; Computer/session193 passed/5 skipped and controller38/38.

Six historical read-only failures ended with native terminal/clean close and natural exits, reaching C9 with no form input. A known-locked-console preflight was added without weakening AX or TCC gates. After the user manually unlocked, unchanged P04 observation and a fresh eight-step form passed: four independently verified values, Completed8/8 and clean C11. This resolves that environmental obstruction, not every possible AX refusal.

Ten AppKit scenarios now have expected-outcome evidence: layout, ambiguity, detached/replaced ref, stale snapshot, Press postcondition, modal before input, modal after a completed prefix, unsatisfied assertion, post-input Stop and partial native deadline. One real failure exposed lost modal reason projection; two regressions failed before the minimal SDK fix and all33 controlled SDK tests pass after it. The fixed native route preserves prefix/unknown facts and never dispatches the tail or replays. Every scenario/diagnostic has terminal→close→destroy, natural exits/EOF and no forced cleanup; last clean marker C23. No automatic unlock or lease recovery occurred.

Current evidence: `.artifacts/computer/p04/scenarios-report.md`, `scenarios-{initial,repaired}-verification.json`, `modal-repair/` and `modal-check/`. Latest isolated full check passed; only this task's pin JSON needed formatting. Browser session/ref qualification, pixels and broader input remain outstanding. P04 overall and P05–P08 are not delivered. Single-run timings and faux request counts are not desktop performance results; no real-model call has occurred.

## Validation

Run from the pi root with existing workspace dev dependencies. No install is needed for fake tests. The optional SDK path must be an **absolute** path to the reviewed Cua `typescript` directory, with root/native-only emitted `dist` and its resolvable pinned runtime/platform packages. No source code refers to a particular local artifact directory.

```sh
# Fake lifecycle/integrity/loader-gate tests; native test skips by default.
node --test native/computer/test/*.test.ts
node_modules/.bin/biome check native/computer --error-on-warnings

# Static check against real generated declarations; does NOT load the SDK.
node native/computer/scripts/typecheck.mjs "$SDK_TS"

# Only after explicit native-loading authorization. No driver/TCC methods called.
ALLOW_NATIVE_LOAD_TESTS=true ALLOW_GUI_TESTS=false ALLOW_REAL_APIS=false \
  CUA_DRIVER_TYPESCRIPT_DIR="$SDK_TS" \
  node --test native/computer/test/native-load.test.ts
```

For current controlled pins, use the independently generated **P04** SDK. Historical P03 SDKs intentionally fail current integrity checks; old qualification evidence retains its own frozen loader/pins.

```sh
# Fake/static checks; generated-value and load tests skip without explicit opt-in.
node --test native/computer/controlled/test/*.test.ts
node native/computer/controlled/typecheck.mjs "$P04_SDK_TS"
# Binding composition uses the root compiler contract, including the full application graph.
node native/computer/controlled/integration/typecheck.mjs "$P04_SDK_TS"
# Explicit load-only opt-in: no constructor, lease acquisition or TCC call.
# The test name retains its historical P03 label; the pins select P04.
ALLOW_NATIVE_LOAD_TESTS=true ALLOW_GUI_TESTS=false ALLOW_REAL_APIS=false \
  CUA_DRIVER_TYPESCRIPT_DIR="$P04_SDK_TS" \
  node --test --test-name-pattern='opt-in P03 generated API' native/computer/controlled/test/loader.test.ts
# Genuine generated values with fake native host and real AgentSession/faux provider.
ALLOW_NATIVE_LOAD_TESTS=true ALLOW_GUI_TESTS=false ALLOW_REAL_APIS=false \
  CUA_DRIVER_TYPESCRIPT_DIR="$P04_SDK_TS" \
  node --test native/computer/controlled/test/tool.test.ts
ALLOW_NATIVE_LOAD_TESTS=true ALLOW_GUI_TESTS=false ALLOW_REAL_APIS=false \
  CUA_DRIVER_TYPESCRIPT_DIR="$P04_SDK_TS" \
  node node_modules/vitest/dist/cli.js --run \
  --config native/computer/controlled/integration/vitest.config.ts \
  native/computer/controlled/integration/loop.test.ts
```

The offline-repaired P03 build/generation/header consistency, 50 targeted Rust tests, strict generated types, 33 fake/static tests (one load test skipped by default) and the separately opted-in fresh-process load have passed. Those offline checks alone do not qualify actual AX behavior. The subsequent live qualification and current root check are recorded below.

**The first P03 live qualification failed.** After its own TCC checks passed, the owner stalled on the first read-only observation and did not acknowledge Stop/close before harness-forced termination. No click was sent; the fixture exited with counter 0. No native terminal receipt, clean owner shutdown or successor qualification was established. The canonical lease was left dirty after that failure; no automatic reset or retry occurred. Evidence: `.artifacts/computer/p03/native-qualification/` and `qualification-failure/report.md`. The subsequent authorized offline repair isolates foreign result/terminal wakers from native admission locks. A paired-subscriber barrier regression fails before and passes after that repair; dropped subscribers still cannot cancel producers or bypass drain. New inputs/evidence are in `.artifacts/computer/p03-offline-repair/`, while the original failed build is preserved. No live retest occurred during that offline repair. Consult the task authority, not the passing load/unit results.

After a verified macOS reboot and separate explicit confirmation, the evidence-only recovery in `.artifacts/computer/p03-recovery/` archived the original D/1 marker and changed only its state byte to C/1 under a nonblocking exclusive lock, syncing both archive and marker. The historical inode, generation, owner and permissions were preserved. Twenty private recovery tests passed; this is not a product recovery API or proof of the old owner's terminality.

**The new qualification attempt stopped before driver admission.** Both permission getters were true, but the inherited TCC validator incorrectly required the responsible AgentPort PID to equal the requesting Node PID. The captured chain named the expected bundle/path with responsible PID1084 and requesting PID9498. The capture also lacked the per-service Allowed decision rows, so relaxing that PID comparison alone would not establish the full gate. No native owner was constructed, no observation/click was dispatched, and both fixture and probe exited naturally with no effects or forced teardown. The marker remained C/1. The failed evidence is retained; no automatic second recovery, gate change or retry followed. At that point a new decision was required; the user subsequently authorized continuous repair and delivery. The historical failed attempt remains unchanged.

**The repaired P03 live qualification subsequently passed.** `.artifacts/computer/p03-tcc/` corrects the evidence collector/validator: requester and responsible PIDs are distinct roles; complete per-service request/activity chains, exact host identity, Allowed decisions and fresh getters remain required. A before/after saved-trace regression, 26 evidence tests and 8 parent-protocol tests passed. Each of the three live action processes then passed its own admission. The owned fixture received exactly one background AXPress; session/process contention was refused, four terminal receipts were recorded, and a clean successor cancelled a pending read-only observation. All four children exited naturally with no forced teardown. The historical marker inode progressed C1→D2→C2→D3→C3; no second recovery was needed. `live-verification.json` independently checks the raw events and hashes. This qualifies only the narrow controlled route, not batch/image/browser/production use or external application drain. Physical Stop clicking and the original stalled process's native stack remain unverified.

Three stale AI test inputs were updated separately without changing provider/generator code or generated data: targeted tests now pass 49 with 35 existing real-API skips. `p03-tcc/repaired-check/` records full `npm run check` exit0 (no formatting changes), Computer/session193 passing/5 skipped and controller38 passing, with no snapshot/live source drift. The earlier failed checks remain available.

The native test starts a fresh child with a minimal environment and isolated temporary HOME, then requires natural exit. Its 30-second process timeout is a diagnostic failure, **not** a cancellation mechanism. This is not an OS sandbox, and the marker describes the probe's calls, not exhaustive monitoring of library initializers. An event-loop turn after import is not proof of responsiveness during a desktop action.

Root TypeScript excludes `native/`; therefore the explicit controlled-boundary and root-aligned integration typechecks above are required in addition to root `npm run check`. The unchanged P02 non-GUI suite last passed 30 tests with one opt-in load test skipped. P04 restoration checks passed all three boundary/integration/probe typechecks and the selected adapter/loader/tool static tests (32 passed/7 opt-in skipped); earlier separate opt-in tool8/8 and loop4/4 results remain distinct.

## Opt-in GUI qualification harness

- `test/fixtures/P02GuiFixture.swift`: AppKit target and visible armed/busy/stopping control surface, independent increment counter and Stop button. Requires `ALLOW_GUI_TESTS=true` before AppKit initialization. Its nonce-checked owned pipe accepts state/checkpoint/stop-test/quit; Stop never disables late-effect counting. Keep stdout drained through EOF.
- `scripts/probe-gui.ts`: trusted test host, **not a production entry point**. Arguments are SDK directory, bounded manifest path, raw/adapter arm, exact fixture PID, decimal window ID and nonce. Requires `ALLOW_GUI_TESTS=true` and `ALLOW_REAL_APIS=false`; ready is load-only. Parent-owned JSONL commands separately perform preflight, admit, observe, one click, read-only cancellation and close. No automatic permission request, discovery, retry, escalation or foreground fallback.
- `test/fixtures/P04GuiFixture.swift` adds four AppKit fields, bounded layout/ambiguity/replacement/modal scenarios and independent current/retired values. Strict Swift6 compile, control smoke, real form and ten expected-outcome scenarios passed; the retained old field detects mistaken rebinding. No arbitrary input/script protocol is exposed.
- Before creating GUI children, reject a known locked or unavailable local console. This metadata does not replace the action process's own TCC identity/permissions, fixture identity from its owned pipe, visible state/Stop acknowledgement, independent effect checks or natural exit. A drained nonzero exit is a failed test, not forced teardown; record signal cleanup only if actually needed. Do not launch either host as an unattended arbitrary desktop tool.

The retained `p02-live` experiment on Node 24.15.0 / macOS 26.5.1 arm64 compared raw SDK and adapter against one persistent fixture: counter 0→1→2; both retained native **Unverifiable / Accessibility / Background**, with no escalation. Both action-owning processes passed their own TCC checks. Node pipe replies and fixture main-thread acknowledgements occurred while native promises were pending. A forwarded fixture Stop produced the matching generated UBJS AbortError, followed by SDK shutdown, destruction and natural exit. Missing-manifest rejection recovered using a new adapter in the same process; it failed before owner acquisition, so it is not a partial-owner leak test.

This proves only that narrow baseline. The Stop smoke used the fixture's same handler through its pipe, not a physical user click; local visibility and AX exposure are not proof of unobscured pixels. No screenshot, full TUI integration, OS-terminal cancellation, production ownership, installation, packaging, other Node/Bun or performance qualification is claimed. The sole status authority and evidence links remain `docs/tasks/2026-09-18-computer-native-implementation-task.md`.
