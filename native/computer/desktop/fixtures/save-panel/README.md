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

`image-synthetic` selects and captures in one call, sends one image-bound Tab,
then compares the complete body through fixture state and fresh AX readback.
It checks the new combined visual route without a website or model API.

The fixture's short startup deferral only allows its show animation to settle;
it is not an acceptance oracle. All target authority comes from fresh native
checks, not fixture titles. State/reopen stdout and disk reads are independent
test oracles, not alternative ways to perform the requested GUI actions.
Every run awaits feature close and natural fixture exit. The printed lease
marker is supplementary evidence, not permission to recover a lock.

## Paired speed/accuracy screening

```sh
ALLOW_GUI_TESTS=true node native/computer/desktop/fixtures/save-panel/benchmark.mjs \
  "$fixture_dir/SaveFixture" "$PWD/packages/coding-agent/computer/bridge.js" \
  "$fixture_dir/results" 20
node --test native/computer/desktop/fixtures/save-panel/metrics.test.mjs
```

The output directory must not exist. This performs 20 pairs per scenario,
120 fresh-owner runs total, interleaving split select/observe and combined
select+observe. Both arms use the same installed binary, tasks and oracles.
There is no model/network cost or artificial model-delay simulation. This is
tool/UI E2E screening, not autonomous model or application-launch E2E.

`contract.json` records runtime and binary/probe fingerprints; every attempt is
preserved in `samples.jsonl` and its log. `summary.json` reports success counts
and successful-attempt P50/P95 separately. Broken selection is an expected
refusal test, never a successful replacement. Failed attempts are not retried
or removed, and failed batches return nonzero. Percentiles at 20 samples are
descriptive, not proof of a reliable tail or a non-inferiority result.

Timing includes cold bridge loading, lazy native initialization, discovery,
selection, observation, actions and final exact readback. Fixture setup is
separately recorded; it is not a Computer action. Close/fixture exit is timed
separately and must succeed. Detailed console writes are buffered until after
close timing; JSON construction and independent checks remain instrumented
overhead shared by both arms. No warm-up is silently excluded.

Benchmark save mode omits only the deliberate stale-reference attempt and
parent-isolation test, identically in both arms. Default probe mode retains
these correctness regressions. All business field/file/readback checks remain.
Each probe requests cancellation after 60 seconds; the supervisor requests
abort at 90 seconds and records `pending-drain`. It does not kill a native owner
or advance while close is unproved. A stuck drain requires inspection, not
lease deletion. Future GUI suites must remain serial on this desktop.

Current implementation/execution status is owned by
`docs/tasks/2026-09-24-computer-e2e-speed-accuracy-task.md`.
