# Native subtype observation candidate

Status: isolated qualification only; not installed.

## Problem and repair

Native general observation already reads `AXSubrole` and deliberately skips
`AXValue` for `AXSecureTextField`. Its serialized row and `WindowElement` ABI
previously omitted that subtype. A model therefore saw an ordinary `AXTextField`
and attempted unsupported fill, then futile coordinate recovery.

`native-subrole-observation-candidate.patch` serializes the existing descriptive
subrole and appends an optional field to the record. The model projection retains
it, and focus/fill descriptions state the existing native secure-input boundary.
It grants no additional input authority, reads no secure value, creates no cache
or service, and changes no click, ownership, cancellation, or replay guard.

## Build boundary

The patch is incremental against the frozen v23 sources, not the installed
baseline. First apply the v23 `native-target-click-candidate.patch` (SHA256
`514a4f0c7abf15294b51b934b31560378f83b339a73bd3463699ca0d945207b7`),
then this patch. `git apply --check` against the frozen v23 material tree passed.

Regenerate real TS/Python bindings with `scripts/generate-uniffi-bindings.mjs`,
repeat with `--check`, compile `typescript/tsconfig.computer.json`, and package the
matched SDK, dylib, bridge, and manifest. Never replace only the dylib or edit
generated bindings manually. Installed pins remain unchanged.

The local Rust 1.97.1 release build required `CARGO_PROFILE_RELEASE_STRIP=none`.
An empty release directory still failed loading `zerofrom_derive`; direct dlopen
of the failing artifact reported a misaligned LINKEDIT string pool. Changing
only stripping let that dependency build and load. See the matching
[Rust upstream issue](https://github.com/rust-lang/rust/issues/157750).
This is an isolated build workaround, not a compiler upgrade, optimization
downgrade, or runtime permission change.

## Verification and limits

- Native metadata regression failed before the repair; metadata group 4/4 and
  optional record carrier 1/1 passed afterward.
- Model projection regression failed before the repair; projection, filter,
  and action schema tests 20/20 passed afterward.
- Canonical generation, repeated generation check, SDK emit, and targeted
  TypeScript check against the new SDK passed.
- Owned Chrome public-tool test `subrole-gui-3` passed: secure subtype visible,
  no password value in observation, fill `target_not_editable`, no committed
  input, exact synthetic value unchanged, zero input/change events, normal
  Chrome exit and clean lease `09f0`.
- The two preceding GUI attempts remain failures: insufficient page-tree
  readiness, then an unnecessary early activation with an unresolved effect.
  The latter blocked further input; it was not replayed or silently reconciled.
- Full root `npm run check` passed. Unrelated formatter changes were reversed.

Evidence is under `.artifacts/computer/navigation-paint.eCQmJA/`. The isolated
candidate native hash is
`143b64cb4d84f2c815f41a0cfca6066eb4e892defa05392b81d43a4988c881e7`.
Native password entry remains unsupported. Metadata does not make a login
business oracle pass; model retry reduction and general installation eligibility
remain separate gates.

The first real-model rerun (`subrole-model-fields-1`) passed enter-text in
22.934s/6 turns. Login remained an independent-oracle failure, but the model
identified the unsupported secure field and stopped in 14.913s/4 turns with no
input attempts or coordinate fallback. The prior login sample took 43.218s/13
turns with futile retries. This single comparison supports clearer agent behavior,
not a stable speedup ratio or newly supported password input. Both owners closed
normally (clean leases `09f1`/`09f2`); total reported cost was 0.0931476 USD.
