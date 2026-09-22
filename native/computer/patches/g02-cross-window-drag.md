# General cross-window drag

Apply `g02-cross-window-drag.patch` after `g02-drag-lifetime.patch` and its predecessors.
SHA256: `79efbcc347ac5c5bf834b592b3b5c1f48a04d3bcfd2df10aeab5b718a44208d8`.

This increment contains 17 authored Rust paths and three genuinely generated Python/TypeScript source files. No lock changes or handwritten bindings. The dedicated generated method is `ComputerOperation.startCrossWindowDrag(destination, segment)`; ordinary segments remain single-window.

## Contract

- Retain two genuine, distinct native-window capabilities from the same host; both recursive lifetimes participate in admission, cancellation and close.
- Require exactly one Drag action, a Visual expectation and two distinct current image refs. Consume both image slots before validating either; authorize capture and drag for both endpoints.
- Validate both process incarnations, geometry, fresh images and default WindowServer hit identity. No query-below-overlay exclusions.
- Use only global foreground input, which moves the system cursor. Start movement inside the source; skip samples outside both owned windows instead of sending them over unrelated gap surfaces.
- Use a private event source with suppression interval zero and permit-all masks, plus a listen-only interference observer. Never swallow physical input. CGEvent tags are not physical-device evidence.
- Preallocate matching mouse-up and arm its release obligation inside actual down admission. Release remains possible after cancellation, target loss or observer failure. Cancellation does not undo a drop already reached.
- If activation is necessary, return `drag_foreground_prepared`: activation may commit input, but the requested drag was not dispatched. Require fresh images/points before another drag attempt.

The root tool adds `select_destination`, `capture_pair` and `drag_between`. One current DesktopView fingerprint covers both images; filtering either image or compaction invalidates the entire pair. Source replacement retires both endpoints. An ordered pair target key and selection-generation identity use the existing intent ledger rather than introducing another scheduler or Agent loop.

## Qualification

Fixed Node24.15.0/Rust1.97.1, locked/offline:

- Core98, input17 and SDK92 tests passed; inherited warnings remain recorded.
- Genuine generation/check, N-API staging, ABI header check, SDK emission and both root type layers passed.
- Root `g02da` check: 1459 files, no fixes, snapshot/live drift zero.
- Parser/tool/adapter/terminal and original AgentSession/faux regressions passed, including real compaction and either-image filtering. These use synthetic desktop state, not GUI delivery.
- Installed original AgentSession: same-/cross-PID real AppKit drop, activation-only then fresh-pair drop, mid-gesture Stop, and revoke/close of either native endpoint passed. Independent verifier: 51 terminals, 23 natural exits, C387–C392.
- Existing Finder PID463: activation-only, one stale-image/no-input refusal, then exactly one dispatched drag moved the dedicated UTF-8 file. Independent filesystem oracle, 15 terminals, two natural exits, C393. AppleScript only opened/arranged/closed dedicated windows; it did not move the file.

Matching installed candidate: `/private/tmp/epi-computer-install-FkRS0d/product`.
SDK `4578225b0dc57196f58b4c3b6ab3963e333fd6e12ff496e273ac6eabc6490840`;
N-API `0f44e2858db5482356f753e549f7479d0740249e99f9925a86732a9001108405`;
renderer `e17ff560525e2908b684da706cc8c5f1a4cf540e09ace34f054cdd3593cacecc`.

Evidence: `general/cross-drag-api-parent/source-verification.json`, `general/cross-drag-installed-verification-v2.json`, `general/finder-drag-installed-verification.json`, relative to `.artifacts/computer/`.

Production pins remain historical, and General staged binaries remain stale. This candidate qualification does not complete physical-input coexistence, formal performance or final General delivery. Task status is governed only by `docs/tasks/2026-09-18-computer-native-implementation-task.md`.
