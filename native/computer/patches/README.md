# Controlled native qualification patches

These patches are build/source materials, not a standalone SDK installer. Current `desktop/` pins select the qualified fast profile described in [p06-fast.md](p06-fast.md); its optional runtime/source package is documented in [PACKAGING.md](../PACKAGING.md). Historical P04 loaders remain pinned to their separate builds.

The following chronological records retain their original qualification limits. Statements about then-pending stages are historical, not the current task status. P03/P04 patches are alternatives against the same pinned Cua base, **not sequential patches**. P05 is incremental against the qualified browser source. P06 discovery is cumulative after qualified P05; apply the fast-build patch after qualified discovery. Do not stack alternative P06 candidates or apply these increments to bare upstream.

## P06 discovery candidate (limited qualification)

- [`p06-discovery.patch`](./p06-discovery.patch):37 Rust paths; SHA-256 `8314efe72f71e14b438776acbed0293fefd187f82d925c8b6a49f5dc4f489e51`. Cumulative after qualified P05, **an alternative to** the P06 patches below. Independent apply/byte/reverse proof: `.artifacts/computer/p06/discovery-eligible-patch-verification.json`.
- Adds a separate metadata-only Discovery scope and genuine `openDiscoverySession`, `startListWindows`, `startSelectWindow`. Selection consumes the catalog, revalidates the exact window/process instance and creates a revocable child. Metadata never grants content/input permission; canonical per-window authorization remains mandatory.
- At most256 catalog rows. Unproved identity/geometry or over-budget metadata is explicitly counted in `omittedWindows` and receives **no reference**. This is a selectable-candidate catalog, not proof of an exhaustive/empty desktop, and must never replace the complete helper catalogs used for resource-drain proof.
- Contract50/core76/platform84+1 explicit benchmark ignore/SDK59 and genuine generation/header/types/load passed. Two per-candidate aggregation regressions failed before and pass after; the initial geometry-only repair still failed on an unrelated unproved process identity, and that failure is retained.
- Six GUI runs independently checked145 raw files,11 terminals and12 natural exits to C144, all with zero input. Five remain failed qualifications. The final stale-selection run passed: a separate read-only session first observed old WindowServer bounds after the AppKit move acknowledgement, then the moved bounds; only then was the old selection reference correctly refused. No fixed sleep is treated as readiness, and no old failure is relabeled successful.
- The initial positive-input admission was blocked by hardware activity; those refusals remain. After a user-confirmed quiet interval, discovery→selection→two captures→Tab/Return passed with27 independently verified raw files,8 terminals and two natural exits to C145, including catalog/image reference-reuse refusals. See `discovery-live-verification.json`. The quiet interval ended and the user was notified. Product P04 pins remain unchanged; Pi host image projection, production trimming and packaging are not yet qualified.

## P06 image/keyboard candidate (partial qualification)

- [`p06-image-keyboard.patch`](./p06-image-keyboard.patch):32 Rust paths; SHA-256 `41f020d2deff619c9b7adbeb598f874b2f7d52f1b7780c41f6f4158c566b95ca`. Cumulative after qualified P05, **an alternative to**, not layered on, either P06 patch below. Independent apply/byte/reverse proof: `.artifacts/computer/p06/keyboard-final-patch-verification.json`.
- Adds genuine `ComputerKey`/`startImageKey` for13 fixed non-text keys. One consumed image reference, fresh pixels/geometry and full target/modal checks, unique eligible same-PID keyboard destination and hardware-input conflict checks. Canonical `press_key` retains `destructive: true`. Exactly one admitted down with its matching-up release obligation; no chord/repeat/text synthesis, focus write, global HID or transport fallback.
- Contract50/core74/platform80+1 explicit benchmark ignore/SDK56, genuine generation/check/N-API/header/types/no-host load passed. Five dedicated GUI runs independently verified131 raw files,13 terminals and10 natural exits to C138. Tab/Return each reached the exact fixture as one down/up pair, counter0→2, without pointer or activation changes. Consumed-ref reuse, visible-image change, same-PID sibling, modal and preabort refused with no key input.
- Other11 keys have mapping/compile coverage, not actual delivery qualification. Mid-pair cancellation/revocation release is a pure seam test, not a real GUI cancellation race. See `.artifacts/computer/p06/keyboard-runs-verification.json`; full isolated checks passed193 host tests+5 opt-in skips and38 controller tests. Product P04 pins remain unchanged. Window discovery/selection, host image projection, trimming and packaging remain open; this is not full P06 delivery or a cold-checkout build recipe. Same upstream MIT notice applies.

## P06 image/scroll candidate (partial qualification)

- [`p06-image-scroll.patch`](./p06-image-scroll.patch):26 Rust paths; SHA-256 `69ef0c0b8e8a0b18fc08a6eed5c114ec1be88d56634d8bf7d7d83c369a6bca6f`. Cumulative after qualified P05, **an alternative to**, not a patch on top of, the image/pointer patch below. Independent apply/byte/reverse verification: `.artifacts/computer/p06/target-recheck-patch-verification.json`.
- Adds genuine `startImageScroll` with four typed directions and one line-wheel event, preserving image-reference consumption, fresh pixel/geometry/target checks, per-primitive cancellation, canonical authorization and tracked cleanup. No key/AX/foreground fallback or global HID delivery.
- Latest contract49/core74/platform77+1 explicit benchmark ignore/SDK55 and genuine generation/header/types/load passed. Target/modality checks are repeated immediately before each primary input, including after tracking move; a synthetic late-target regression failed before and passes after. One actual wheel moved an owned NSScrollView; its qualification failed because the test assumed unflipped view coordinates. An empty assertion-message reporting bug also produced an erroneous exit0. Both test defects have before/after regressions and original evidence; that run is not accepted as a pass.
- A corrected attempt was refused before input by `user_input_conflict`; that failure remains. During a user-confirmed quiet interval, all nine wheel cases passed to C130 (234 raw files/31 terminals/18 natural exits, independently verified). The final target-recheck build then passed click/scroll/modal adjacency to C133 with13 terminals/six natural exits. No lease recovery, foreground fallback or production pin switch. Evidence: `scroll-ready-runs-verification.json`, `target-recheck-click-verification.json` and `target-recheck-scroll-verification.json` under `.artifacts/computer/p06/`. Keyboard/window selection, host projection, trimming and packaging remain separate open gates.

## P06 image/pointer candidate (limited qualification)

- [`p06-image-pointer.patch`](./p06-image-pointer.patch):21 Rust paths, incremental after the qualified P05 source; SHA-256 `6cc17c2a2f84d58d1c35fc83c63c0dc87e6a74bd6aefc0284c91d8bcc6dedede`. It is not standalone against bare upstream. Strict independent-root apply/byte-compare/reverse evidence: `.artifacts/computer/p06/pointer-patch-verification.json`.
- Genuine `startCapture` returns bounded PNG bytes and explicit geometry without a Base64/raw-JSON duplicate. `startImageClick` consumes a session-local image reference, rechecks pixels/geometry/target, and maps output pixel centers natively. Browser scope refuses this native route.
- Pointer delivery preserves canonical authorization, native cancellation, tracked blocking/focus cleanup and a matching-up release obligation for an already admitted down. No global HID, dual transport, foreground fallback or automatic replay. Caps Lock toggle state is not treated as a held ordinary key; other held keys/buttons and concurrent hardware-counter changes still refuse.
- Contract49/core73/platform75+1 explicit benchmark ignore/SDK53, genuine generation/check/staging/header/types/load passed. Two real image sizes produced exactly two non-AX canvas down/up pairs, with independently checked fractional coordinates, no foreground transition, six terminals and two natural exits to C112.
- The original stale-image test remains **failed**: swapping identically rendered empty fields still admitted one canvas click; native cleanup reached C113 and its raw effect is preserved. After unlock, explicit visible-pixel changes, window moves, modal/bounds/preabort and a new live run passed to C119:157 raw files,21 terminals,12 natural exits independently checked in `pointer-visible-runs-verification.json`. New1× and historical2× captures both have exact point evidence. This does not validate every application or complete P06/P07/P08.
- Full evidence/limits: `.artifacts/computer/p06/pointer-report.md` and `pointer-runs-verification.json`. Main product pins remain P04; this is not production trimming, host activation, packaging, model-image delivery or overall P06 acceptance. Same upstream MIT notice applies.

## P05 observation candidate

- [`p05-observation.patch`](./p05-observation.patch): nine Rust files; SHA-256 `4225ac11771551fa8267b3800eaa8948049146f9a2ed0ae0a442c6ce892a787e`.
- Base: the qualified P04 browser source retained in `.artifacts/computer/p04-browser/upstream`, including browser form fixes. Exact before/after file hashes and independently checked forward/reverse application are in `.artifacts/computer/p05/final-patch-verification.json`. This is not a cold-checkout build recipe.
- Replaces repeated normal Info.plist subprocess reads with bounded CoreFoundation decoding, retaining the unchanged legacy fallback. Five counterbalanced real AppKit form pairs measured median26.512s→17.929s (−32.37%); this is component evidence, not formal whole-task/p95 performance.
- Fixed-name, opt-in phase timings retain the original focus settle/detection/callback lifetime. Authorization, complete observation and cancellation checks are not removed.
- Browser readiness passively retries only catalog changes within its existing budget. Native catalogs now positively include unreaped zombies and classify a process disappearing during its path read as an incomplete catalog, never an empty one. Complete identical global catalogs remain mandatory.
- Final native checks: platform70 passed/1 explicit benchmark ignored, SDK45, core69, genuine generation/check/N-API/header/types/load. Thirteen browser cases and ten AppKit form/adjacency cases passed with46 natural exits and clean leases C84–C106; independent raw verifiers are `final-browser-verification.json` and `final-appkit-verification.json`.
- The original D65/D70/D83 failures and retained profiles remain evidence. Separately recorded administrative recoveries do not prove their old terminals; no automatic runtime recovery or action replay was added. See `d70-report.md` for proven local causes and attribution limits.
- Main product pins are deliberately unchanged; P06/P07 must qualify and package the selected final source. Same upstream MIT notice applies.

## P04 current experimental patch

- Upstream: Cua `05f29785b508a4441ec3aa06c556a8e8b26c1d71`, same base as P03.
- [`p04-controlled.patch`](./p04-controlled.patch): 27 Rust files, includes the repaired P03 ownership/lease/foreign-waker foundation plus the bounded form executor and conservative observation/value-write paths.
- Patch SHA-256: `51fbcae08af29bba69fa4d228d6990208310fac14238eb78de582f7abcde9030` (includes the minimal modal-reason projection repair).
- Local dylib SHA-256: `0427ba07d77b3ded1f185f3e62bc4bc73c40bc4342e58bed80af6c3518fc61ff`.
- Rebuilt N-API SHA-256: `6d65d72c5de0b37e4ac62951a845629ce797f96473992bb5f477998546b1dedd`; all four reviewed locks remain unchanged. The old P04 pin was `0070e34c…`, not the P03 hash formerly quoted here. The unchanged stage script rebuilds it; byte reproducibility is not claimed.
- Same MIT notice in [`LICENSE.cua.md`](./LICENSE.cua.md). Strict forward application, exact patched-file comparison and reverse checks passed in `.artifacts/computer/p04/modal-repair/native-patch-provenance.json`; original P04 provenance is retained separately.

Apply P04 only to a clean copy of the pinned base, not on top of P03:

```sh
git apply --check --whitespace=error /path/to/p04-controlled.patch
git apply --whitespace=error /path/to/p04-controlled.patch
cd libs/cua-driver/rust
cargo build --release --locked --offline -p cua-driver-sdk
```

Generation, N-API staging, header checks and strict declaration emission remain required; the latest reviewed sequence is `.artifacts/computer/p04/qualify-modal.sh` (original sequence retained as `qualify-generated.sh`). These commands are not authorization to load a host or drive a desktop. A cold checkout/install has not been qualified.

The genuine UniFFI additions provide `ComputerSelector`, separate ref/selector addresses, Fill/Press/AssertValue steps, `ComputerPlan` and `startPlan`, with per-step dispatch/action/effect/condition/timing, completed prefix and first unfinished index. Plans are limited to 1–8 steps and 30 seconds; cancellation/deadline never bypasses blocking-work or callback drain. Ref identity does not rebind, selectors resolve freshly, and Press requires a postcondition. Conservative complete AXChildren traversal gates tokens; one string AXValue write retains canonical authorization, per-PID ownership and original-handle validation. No script, retry, pixel/foreground/key fallback, browser engine or default activation is added.

Original offline core25/platform16/SDK31/private lease13 checks passed. After manual unlock, unchanged native observation and an eight-step form succeeded. Ten AppKit scenarios now cover layout/ref/ambiguity/modal/partial/cancel/deadline boundaries. The first modal refusal lost its dedicated error code; two executor regressions failed before the allowlisted projection fix, and SDK33/33 passed after it. Only two Rust files changed, generated declarations remained identical, and locked builds/generation/header/strict types/load-only passed. Repaired modal and mid-plan modal passed without weakening gates or replaying input. All raw runs close cleanly; last marker C23. See `.artifacts/computer/p04/scenarios-report.md` and the two scenario verification manifests (324 raw files). Historical locked-console failures and `blocked-verification.json` remain unchanged. **P04 overall is not accepted; browser and wider capability gates remain.**

## P03 historical provenance and build boundary

The following P03-only contract and checks describe the frozen repaired P03 patch, not current P04 generated types. It adds no P04 executor.

- Upstream: Cua `05f29785b508a4441ec3aa06c556a8e8b26c1d71`.
- Patch: [`p03-controlled.patch`](./p03-controlled.patch), 19 Rust files; apply from the Cua repository root.
- Patch SHA-256: `21d8ff66de2dfecf9105a870225a5081084a4f28c18844cb4e035a99131d77c6` (includes the offline foreign-waker repair).
- Upstream MIT license retained in [`LICENSE.cua.md`](./LICENSE.cua.md); SHA-256 `c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9`.
- Unchanged Rust lockfile SHA-256: `fe2ece2843bd07ebdcdab67a44b34c89868a4c6e96fd326c80fd3b9aa0ba9a39` (`fs2` remains locked to 0.4.3).
- Qualification dylib SHA-256: `7b94a64a683841fd759e152ce09fe0e664deb940101adc7283624e613a43cee3` (local build, not a portable/reproducible binary promise).
- Rebuilt N-API SHA-256: `3ff6b386e30f622fd9200844f33adf1fb2518ea90f1dbf7e2cc84af84aa91b1c`.

Historical P03 offline evidence is under `.artifacts/computer/p03-offline-repair/`: `native-patch-provenance.json` pins every base/patched file; `native-patch-formatted.log` records strict forward application, byte/hash comparison, and reverse checking. `repair-only.diff` isolates the two changed SDK files from the original P03 patch. The original failed P03 sources/binaries remain in `.artifacts/computer/p03/`, and its patch/pins are preserved in the repair directory's `before/`. P02 was read-only; each build uses independent copy-on-write outputs. No dependency/lock changes or installs were made. A clean checkout without the reviewed tool/dependency caches has **not** been qualified.

Apply only to the pinned upstream revision after reviewing the patch:

```sh
git apply --check --whitespace=error /path/to/p03-controlled.patch
git apply --whitespace=error /path/to/p03-controlled.patch
cd libs/cua-driver/rust
cargo build --release --locked --offline -p cua-driver-sdk
```

These commands are documentation, not authorization to load the SDK or drive a desktop. Local repair checks used the reviewed Rust 1.97.1/cache through `.artifacts/computer/p03-offline-repair/env.sh`, with dependency changes, GUI tests, and real APIs disabled. Environment isolation is not an OS sandbox. The facade refuses non-macOS/non-arm64 at construction. Do not substitute the old aborting C ABI operation path.

## Exported UniFFI contract

Rust exports below compile; regenerated TS declarations passed strict adapter type-checking. Generated methods use lowerCamelCase. The repair changes no exported signature.

- `ComputerHost::create(options: ConfiguredDriverOptions) -> Result<Arc<ComputerHost>, ComputerError>` — constructor; native-derived desktop lease and immutable configured authorization; no TCC request.
- `ComputerHost::open_session(pid: u32, window_id: u64, parent: Option<Arc<ComputerSession>>) -> Result<Arc<ComputerSession>, ComputerError>` — synchronous; children inherit the same exact PID/birth identity/window and configured authorization; foreign parents are refused.
- `ComputerHost::revoke()` — synchronous, monotonic request, **not drain**.
- `ComputerHost::close() -> Result<(), ComputerError>` — async native drain and clean lease release.
- `ComputerSession::new_operation() -> Result<Arc<ComputerOperation>, ComputerError>` — synchronous, inert allocation.
- `ComputerSession::revoke()` — synchronous subtree request.
- `ComputerSession::close() -> Result<(), ComputerError>` — async subtree proof/cleanup, not host shutdown.
- `ComputerOperation::start_observe(max_elements: u32, max_depth: u32) -> Result<(), ComputerError>` — synchronous one-shot start; positive bounds capped at 512 nodes / 32 depth.
- `ComputerOperation::start_click(element_token: String) -> Result<(), ComputerError>` — synchronous one-shot start; latest same-session snapshot token, consumed once; exactly one enabled/advertised background AXPress.
- `ComputerOperation::cancel()` — synchronous request.
- `ComputerOperation::result() -> Result<ComputerResult, ComputerError>` — async subscriber.
- `ComputerOperation::terminal() -> Result<ComputerTerminal, ComputerError>` — async subscriber; error is **not** terminal acknowledgement.

Types:

- `ComputerResult`: `Observation { value: WindowStateOutput }` or `Action { value: ActionResult }`.
- `ComputerTerminal`: `operation_id: String`, `cancelled: bool`, `input_committed: bool`.
- `ComputerError`: `Refused { reason: String }`, `Cancelled { input_committed: bool }`, `Quarantined`. Reasons are bounded categories, not AX content.

## Lifetime and scope rules

Allocate/register before start. Forward AbortSignal to explicit `cancel()` only; never pass it into generated result/terminal/close waits. Inert cancellation settles terminal/result even if start validation failed. A busy native lane refuses synchronously; there is no second waiting scheduler. The independent producer retains the lane through blocking work and matched focus-callback drain. The existing per-PID mutation lease also spans callback drain.

Native admission is monotonic against cancellation, ancestor revocation and authorization expiry. A committed primitive is invoked immediately on the same stack, without a reusable permit; the cancellation gate is not held over AX. Cancellation cannot retract an already committed call. `input_committed` means admission crossed, **not effect confirmation**. A fulfilled canonical ActionResult, including Unverifiable, is retained across cancellation races. An already-established terminal record remains stable.

Terminal proves that the operation's **driver-owned producers/work/effect-capable cleanup** cannot submit more work. It does not prove that another application has finished processing earlier input, and cannot roll back external effects. Unknown or panicking work, poisoned proof state, failed cleanup, or a rejected terminal keeps the host quarantined and its native owner/FD retained. There is no timeout unlock or recovery API.

Public result/terminal futures now await native proof monitors, not the core watch channel directly. The pinned N-API bridge can block inside a foreign wake until JS returns; letting core notifications invoke it while holding admission locks creates a cancel/re-poll deadlock. Monitors retain only core proof state and expose completion after those locks are released. Dropping a foreign subscriber neither cancels the independent producer nor skips cleanup drain.

Native operation proof records survive foreign-facade destruction without retaining result payloads. Native session ancestry/cleanup records survive weak session handles and final Drop races. Session cleanup retires retained AX observations only if the PID/window/snapshot generation still matches; a sibling's newer snapshot is preserved and empty PID buckets are removed.

The narrow registry preserves canonical policy, session manifest and protected-resource authorization. It installs no consent provider, so residual grant requirements still refuse. It creates no active cursor hooks, history, recording, browser engine, permission UX or maintenance thread. Narrow shutdown verifies every known session cleanup before forgetting records; it does not use the legacy best-effort shutdown path. Observe excludes menu/sibling-sheet AX roots and exposes no screenshots. Click has no coordinate, selection, foreground or other fallback. Necessary application/window metadata and prior-focus restoration remain part of the audited path.

The canonical lease is the actual account-database user's persistent home plus `.pi-computer-desktop-v1/desktop.lock`, independent of HOME/TMPDIR/cwd/agent labels. It uses nonblocking advisory flock, private validated local inodes, generation markers, and explicit clean release. A stopped-but-alive owner is not stolen; a dirty crash marker refuses later acquisition. This is a cooperating-process protocol, not isolation from arbitrary same-user/root/native code or unrelated desktop automation. Stable account-home configuration and storage integrity remain assumptions.

## No-GUI verification

Repair results (including the expected pre-fix failure) are below; full logs and command/exit records are in `.artifacts/computer/p03-offline-repair/`:

| Evidence | Result |
| --- | --- |
| `root-core-controlled` | 18 core admission/lifetime/poison/snapshot tests |
| `root-core-lease` | 13 private-file/process tests, including fixture |
| `root-sdk-controlled` / `sdk-controlled-formatted` | 14 facade/subtree/drop/cleanup/result/foreign-wake tests, rerun after test-only formatting |
| `root-platform-controlled` | 5 pure AX-admission/tree/focus/press tests |
| `sdk-build` | release locked/offline SDK build |
| `native-patch-formatted` | strict final patch application and exact hash comparison |
| `bindings-generate` / `bindings-check` / `header-check` / `typescript-emit` | unchanged API/generated JS/declarations |
| `regression-paired-wake-before` / `regression-paired-wake-after` | expected failure 101 before repair, pass 0 after |

The first live P03 observation stalled; Stop/close lacked receipts and the harness forcibly terminated its owner. That offline regression proves a local foreign-waker lock cycle and its repair, not the original stall's unique cause. No live retest or lease recovery occurred during that offline repair. Its root `npm run check` exited 2 with five model-ID type errors also reproduced with the old Computer inputs. Subsequently, separately authorized reboot/recovery and TCC-evidence repairs led to the narrow successful P03 live run in `.artifacts/computer/p03-tcc/`; four terminals/four natural exit0 and C3 were verified. Three AI tests were corrected separately and full isolated check passed. These later results do not invent the old owner's terminality or qualify P04.

Warnings remain at untouched upstream unused/dead-code sites and duplicate linker rpaths. The original P03 lease implementation's first two runs failed on Darwin no-follow flags and the no-ACL NULL/ENOENT convention; that historical evidence remains in `p03/`. Corrected private positive/negative/ACL/contention/crash tests pass. The offline repair did perform an explicitly opted-in no-host SDK load with natural exit. It performed no GUI/TCC/input, canonical lease acquisition, full Rust suite, install, or cold-checkout packaging qualification.
