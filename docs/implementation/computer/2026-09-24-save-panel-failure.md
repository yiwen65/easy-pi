# Save-panel failure: native repair and installed regression verification

## Current result — 2026-09-24

The installed native repair passes the independently owned AppKit save/reopen
workflow. Historical diagnostic-only findings below remain as failure evidence.
The user's original unsaved VS Code document was not modified and the entire
paid-model SAE research workflow was not rerun.

Three causal defects are addressed:

1. The host AXSheet is nested under AXWindow, while its host-PID AX proxy field
   maps to the remote service's CG window. The old root/member resolver rejected
   this valid sheet. The fix proves bounded bidirectional AX ancestry, exact
   host/sheet identity and stable remote ownership; it does not infer authority
   from titles, rectangles or application names.
2. In the controlled fixture, AXValue replacement succeeded after that fix, but
   PID-posted Return did not save. With only the hosted-sheet keyboard route
   switched to a guarded, non-suppressing foreground HID source, Return saved.
   Normal document Command+O still uses PID input and successfully reopened.
   Owned key-up cleanup survives sheet closure/cancellation; no input replay.
3. A separate editable fixture makes Command+A a no-op. The pre-guard installed
   binary appended `replacement only` to the original body. The final binary
   reads back exact focus, unchanged full AXValue and equal AXSelectedText
   before text/Delete. Broken selection now stops before replacement and keeps
   the original body; normal synthetic selection still replaces correctly.
   This is a controlled causal reproduction of the append mechanism, not proof
   of the exact reason the original service ignored Command+A.

Installed qualification:

- NSSavePanel: Unicode filename exactly replaced, consumed-ref replay rejected,
  parent window unable to read its sheet field, Return saved, Command+O reopened,
  original body = AX readback = saved file bytes (86 bytes). Clean close C0333;
  final delivery metadata/package recheck repeated the workflow to C0334.
- Synthetic working mode: exact replacement and fresh AX/fixture readback,
  clean C0331. Incomplete surrounding metadata correctly remained
  `needs_observation`, not fabricated native confirmation.
- Synthetic broken mode: `replacement_selection_unproved`, original text
  unchanged, clean C0332. The already dispatched selection prefix remains
  `inputCommitted:true` / unknown effect, not a false zero-input claim.
- Desktop: 122 passed, zero skipped with both explicit no-host native-value
  opt-ins. Native SDK: 94 passed; final native Computer tools: 56 passed;
  input ownership/cleanup: 20 passed. Generated bindings `--check`, desktop
  typecheck and root `npm run check` passed. Unrelated formatter deltas restored.
- Broader platform run before the final selection guard: 179 passed, five
  browser image/process-catalog failures, one explicit benchmark ignored. The
  unmodified retained native test binary fails the same five cases in the same
  environment (`image_path_unavailable` / zombie completeness). These are not
  relabeled passes; browser-wide qualification is outside this repair.
- Package integrity: 1432 files and eight package tests passed. Seven-file
  source increment independently applied, byte-compared and reversed. Genuine
  locked/offline Rust build; unchanged ABI and N-API, not handwritten bindings.

Reproduction commands and owned fixture are checked in at
`native/computer/desktop/fixtures/save-panel/README.md`.
Source/build pins: `native/computer/patches/save-panel.md`.
Sanitized raw probes/build records: `/tmp/easy-pi-native-save.rkAaFu`.
Original installation backup: `installed-before` beneath that directory;
intermediate pre-selection-guard package: `installed-before-guard`.
No business file, desktop lease, unrelated worktree change or paid API was altered.

Activation requires a complete easy-pi process restart; `/reload` cannot replace
an already loaded dylib. No claim is made that every application/custom editor
is supported or that all future refusals can be eliminated. Unknown selection
now fails safely instead of silently appending.

## Captured failure

Session `ses_01M38S9JB18FF6YT`, 2026-09-24 12:29–12:34 Asia/Shanghai.
The final reply correctly did not claim that `SAE_levels.md` had been saved.

- 12:33:48: `saveAsNameTextField` contained
  `SAE_levels.md/Users/w/Desktop/SAE_levels.md`.
- 12:33:54: `fill("SAE_levels.md")` reported synthetic background delivery,
  four admitted primitives, unknown postcondition.
- 12:34:05: the field contained
  `SAE_levels.md/Users/w/Desktop/SAE_levels.mdSAE_levels.md`.
  Delivery was real, but replacement was not. Repeating fill is unsafe.
- Parent activation/restore was refused with `unexpected_modal_surface`;
  service activation returned `foreground_activation_unknown`.
- This round still emitted the old `previous_intent_unresolved; observe again`
  guidance. Host logs show its process started at 12:15:49; the next process
  start was 13:00:29. Installing new bridge bytes does not replace a loaded tool.
- Before this investigation the canonical lease was clean C031e, with no
  holder. This is not another abandoned-lease incident.

## Native evidence

An independently owned Swift NSSavePanel reproduced discover/select success
followed by observation refusal. Temporary interception of the SDK result
revealed `controlled_target_unproven`; the original bridge discarded that code
and showed `native_refused` instead.

Read-only AX inspection of the owned fixture showed an app AXWindow, its nested
AXSheet with another window ID, and remote panel contents with a third window
ID. The window catalog also exposed the separate Open and Save Panel Service.
The current resolver matches top-level or focused exact-PID/window roots. This
does not establish a supported binding for all these system-hosted surfaces.
Matching titles or rectangles is not sufficient authority to merge them.

The native synthetic Fill fallback sends Command+A then text without checking
that selection covered the old value. The captured append is consistent with
that missing check; the owned fixture refused observation before Fill, so this
investigation did **not** reproduce or conclusively identify the OS-level reason
for Command+A failing in the original service process.

## Implemented repair

- Preserve allowlisted native refusal codes for ordinary operations as well as
  segments; unknown native strings remain redacted.
- Preserve typed refusal/terminal facts for `select(observe:true)` instead of
  letting the host redact them into `native_fault`.
- Explain unbound/ambiguous surfaces, modal parents and failed activation, with
  explicit stop conditions rather than repeated observation/activation advice.
- A missing terminal input fact is not treated as proof of no input.

This repairs the error-reporting defect. It does not add remote-panel ownership
support, prevent the first synthetic Fill append, or prove autonomous saving.
The stop instructions are model guidance, not a new native circuit breaker.

## Verification

- Four new cases: three failed before, all four passed after; known and unknown
  reasons tested through separate and combined observation paths, with no input.
- Desktop suite: 120 passed, one pre-existing GUI opt-in skipped; typecheck and
  repository `npm run check` passed. Unrelated formatter changes restored.
- Asset package verified 1428 files; installed bridge and manifest backed up to
  `/tmp/easy-pi-save-panel.Fg3SLb/bridge-backup` before replacement. Native
  binaries and safety gates were not changed.
- Actual installed owned-panel probe now returns `controlled_target_unproven`
  plus the stop guidance and `inputCommitted:false`, and closes cleanly C0325.
  The probe still exits unsuccessfully at observation: saving remains unverified.
- Owned fixtures all exited naturally; no business document modified, no lock
  reset, no paid model call, no automatic replay.

Diagnostic fixture, screenshot and scripts: `/tmp/easy-pi-save-panel.Fg3SLb`.

## Historical remaining repair (resolved by the current result above)

1. Reproduce the synthetic replacement failure with a controllable remote-field
   fixture and an independent selection/value oracle.
2. Prove the actual parent/remote-surface identity relation before adding native
   support; do not authorize it from app names or matching geometry.
3. Require verified selection before synthetic replacement, retaining committed
   prefix/unknown outcomes when selection or typing cannot be established.
4. Rebuild and qualify native sources/bindings/materials together, then verify
   an owned save, file reopen and exact readback through the easy-pi tool path.

These were the gates retained after the diagnostic-only commit; the current
owned save/reopen and synthetic replacement results above close this repair.
