# Owned save/replacement regression

macOS arm64, Node24.15.0 and a qualified installed Computer bundle are required.
This opt-in test foregrounds only its new AppKit fixture and submits real input.
Do not interact with the keyboard during a run. No website API/model request.
Do not run multiple GUI probes concurrently or while another Computer owns the
desktop. A refused lease must be inspected, never deleted/retried automatically.

From the `pi` root, compile to a newly created temporary directory:

```sh
fixture_dir=$(mktemp -d /tmp/epi-save-fixture.XXXXXX)
swiftc native/computer/desktop/fixtures/save-panel/SaveFixture.swift -o "$fixture_dir/SaveFixture"
ALLOW_GUI_TESTS=true node native/computer/desktop/fixtures/save-panel/probe.mjs \
  "$fixture_dir/SaveFixture" "$PWD/packages/coding-agent/computer/bridge.js"
```

The default mode verifies parent/sheet separation, exact Unicode filename
replacement, consumed-reference refusal, Return save, Command+O reopen, AX
readback and equality to the original body and saved bytes. The fixture writes
only to its new `/tmp/easy-pi-owned-saved-*` directory, with exclusive creation;
it never overwrites a business document. Those tiny test files are retained.

Run the same command separately with a final `broken-synthetic` or
`working-synthetic` argument. Both disable the AXValue setter; the broken mode
also makes Select All a no-op. Broken must preserve the entire original text
and report `replacement_selection_unproved`; working must replace exactly and
pass independent fixture plus fresh AX readback. Before the native selection
guard, broken mode deterministically appended the replacement and failed.

The fixture's short startup deferral only allows its show animation to settle;
it is not an acceptance oracle. All target authority comes from fresh native
checks, not fixture titles. State/reopen stdout and disk reads are independent
test oracles, not alternative ways to perform the requested GUI actions.
Every run awaits feature close and natural fixture exit. The printed lease
marker is supplementary evidence, not permission to recover a lock.
