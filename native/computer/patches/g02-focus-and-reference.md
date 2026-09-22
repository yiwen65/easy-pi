# Focus capability and retained-reference fixes

Apply after the preceding General candidate, action-metadata and canonical-ancestor patches, in this order:

1. `g02-focus-capability.patch`: `742f9110a254dbc8e9afebe1a595349284ef199e8635819ad02994a14e72098d`.
2. `g02-segment-runtime-scope.patch`: `4fbb4c1d79475e8a467fbb8ca0690c87c8ab7bd16f85b66b2c4134ba0c803e95`.

Each changes two Rust paths. Independent apply/byte-compare/reverse proof is in `.artifacts/computer/general/focus-reference-source-verification.json`. Same upstream MIT notice: `LICENSE.cua.md`. No handwritten bindings or dependency/lock changes.

## Focus is not a generic click

C356 proved the bug on a harmless real button: `AXFocused` was not settable, `AXPress` was advertised, and a requested Focus incremented its business counter once. Native correctly reported an unknown committed effect, but the implicit committing click itself was wrong.

The route now distinguishes successful capability queries from unknown/denied queries. Semantic AXFocus remains unchanged. Pointer focus fallback is retained only for eligible value-settable text fields/areas with readable metadata and no advertised `AXPress`; it is not allowed for generic enabled controls. Unsupported/unknown capability is refused before activation or pointer input. Owned releases and bounded identity-only focus confirmation remain.

- Native capability seam failed before; Computer 41 and SDK 81 tests passed after, with genuine generation/check/staging/header/types.
- Installed C359 refused the non-focusable button with `focus_not_supported`, zero mouse events/counter and `inputCommitted=false`.
- C361 preserved actual editable-field pointer focus with zero button commitment. C362 Chrome Unicode/submit and C364 TextEdit explicit Focus plus exact 1632-byte save passed.
- C360/C363 held-state refusals remain failures; later clear passive samples do not establish their input source. The old editable harness's `noImplicitClick` label was incorrect; its raw synthetic route and zero button counter are independently verified, not relabeled as no pointer input.

## A current ref must reach the correct runtime cache

C357 rejected a current text-field ref as stale; C358's equivalent selector succeeded. The direct segment producer entered tracked blocking work without the trusted runtime namespace used to construct the element cache. The core guard correctly rejected it as `generation_mismatch`; the platform mapped that to `stale_session_observation`.

The segment worker now installs its host-derived runtime scope around execution. Caller/model references cannot choose it. Cache generation, window and replacement validation remain unchanged.

- Private SDK seam before: one pass/one failure, showing `None` scope and `generation_mismatch`; after: complete SDK 83 and core cache nine passed.
- Installed C365 current ref succeeded; C366 ref-based non-focusable-button refusal and C367 ref-based editable pointer fallback both passed.
- C368 one original AgentSession completed the 612-byte Chrome → VSCode → Finder → Terminal checksum workflow, with 41 terminals/two natural exits. Finder folder opening was setup, not autonomous path navigation.
- Independent GUI seals: `focus-reference-verification.json` and `reference-crossapp-verification.json`. C355's earlier exit0 on an unrelated stale refusal is explicitly excluded as qualification.

Latest matched candidate: SDK `3d1d792357ba39da3aca016bd99fd28ead109bc248a3a8e8e428d7f51f8aa415`, N-API `5c2ad562d4b614dc25b6bfd316fce1916b7480c47a82a3fb331e5693a87fa177`, helper `e17ff560525e2908b684da706cc8c5f1a4cf540e09ace34f054cdd3593cacecc`.

These are installed original-loop/faux qualifications, not product real-provider or physical-source proof. Production pins and whole-goal acceptance remain unchanged.
