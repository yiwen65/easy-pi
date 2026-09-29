# Web-field synthetic Fill foreground routing

Incremental patch after `pointer-keyboard-boundary.patch`, preserving that
approved boundary and all native AX write, permission, target, cancellation and
unknown-input invariants. No ABI or dependency changes.

## Cause and repair

In the desktop profile, Chrome web AXTextField accepts AX focus while background
PID keyboard events can be reported dispatched without changing its value.
TypeText already activates for non-native editors; Fill's fallback only did so
for AXTextArea. Extend the existing fallback condition to non-native elements.
Direct native AXValue writes take the earlier unchanged branch. Activation is
bounded by the existing controlled native checks; no input retry is introduced.

The durable `../desktop/fixtures/real-model/background-fill-guard.mjs` uses an
owned competing AppKit window, one Chrome field and one tool fill. It checks the
initial focus state, exact DOM/AX result, untouched competitor and full cleanup.
Old installed library fails with an empty value after four reported background
events; the candidate passes with foreground delivery. The raw failed sample is
retained, not counted as success. Explicit-activation controls also passed.

## Provenance

- Patch SHA256: `a01443cf72dbc09a9190338c779b08265018131307ca42a164cd5cbd3318a6a9`
- Base library: `b5ab897ec0f8d724436d42c93b6b41fc81f38218266cef699ca61a46985807cb`
- New library: `a1f1aea264a8dbc6792a10bb66123c3d93cd908427cd1f0607c78b4c3c1a2f82`
- Unchanged NAPI: `1f3296c11bc25b1586670678f59297dbca425a6173b0151df7f8aee85de71b52`
- Unchanged Cargo.lock: `fe2ece2843bd07ebdcdab67a44b34c89868a4c6e96fd326c80fd3b9aa0ba9a39`
- Build: existing isolated Rust 1.97.1, `cargo build --release --locked --offline -p cua-driver-sdk`.
- Materials contain source, incremental patch and `web-fill-foreground-build.json` with before/after hashes.

Forward/reverse patch checks, 27 native segment tests, 40 bridge tests, 14
benchmark oracle/lifecycle tests, 8 package checks, strict desktop typecheck and
root check passed. Existing unrelated upstream compiler warnings remain.
The initial candidate general suite passed 14/14, including native batching,
pointer boundary recovery and cancellation. Final durable background-fill
passed again, clean C0866.

The first real-model candidate form failed: premature screenshot fallback led
to boundary refusal and repeated stale image recovery. Tool description and
boundary guidance now state the actual split rule, one follow-up semantic read
for asynchronously initialized controls, and fresh semantic suffix recovery.
A regression failed for missing guidance before the change, then passed while
still refusing unresolved input. A malformed first test fixture requested a
native-confirmed visual condition and stalled its fake terminal; that isolated
no-host test was terminated and corrected, not counted as product regression.

After the contract change, real model `openai-codex/gpt-6-sol` desktop form passed
in 48.881 s / 10 turns / $0.072026 with independent oracle and full cleanup.
One synthetic multi-fill boundary still occurred; no comparative speedup or
general reliability claim is established. Candidate bridge SHA256:
`a28cd24362cafaef2549fb2955cc782dec9da208a97113a257f5b205a90ddf44`.

Evidence: `/tmp/epi-pointer-boundary.PFHOUz/{durable-fill-before,durable-fill-after,durable-fill-final,general-web-fill,model-web-fill-candidate,model-web-fill-contract}`.
Temporary artifacts can disappear. Current installation and later qualification
are recorded in `docs/tasks/2026-09-29-computer-focus-routing-evidence.md`.
