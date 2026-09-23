# G03 bounded condition confirmation increment

Apply `g03-condition-confirmation.patch` **after** `g02-cross-window-drag.patch`.
SHA256: `5696e64c87ab5f9e61cf23e561c0688b384b43453b9e69229323005bbba0e089`.

## Problem and change

The installed product dispatched a key once, then returned `unsatisfied` after
88ms. The dedicated application's counter changed 787ms after receiving the
key. The old confirmation loop stopped after two 20ms pauses, independently of
the existing operation deadline.

The two-file native increment polls only the requested condition until it is
satisfied, becomes unknown, is cancelled, or reaches the existing segment
budget. It never repeats input. Already-true, visual/unknown and unfinished
prefixes do not wait. Owned releases still precede confirmation and genuine
terminal proof. This does **not** implement the pending cross-operation recovery
time budget.

The accompanying Desktop change publishes fresh evidence for an unfinished
prefix even when its requested condition is satisfied. `confirmed` describes
the condition, not completion of all requested actions.

## Evidence

Under `.artifacts/computer/general/segments/`:

- `baseline-verification.json`: C398–C401, 43 terminals/eight natural exits.
  Twelve known AX fills use one observation/segment instead of twelve each;
  faux requests 52→8 in this harness, not a speed benchmark. C401 remains failed.
- `confirmation-before.log`: three expected assertion failures; after: five
  confirmation tests, Computer58, SDK92 and core98 passed, zero skips.
- `source-verification.json`: strict apply, byte comparison and reverse passed;
  generated text/locks and the earlier qualified candidate unchanged.
- `after-verification.json`: C402–C407, 28 terminals/twelve natural exits.
  Delayed effect confirmed at 836ms; immediate effect at 28ms; unfinished
  keyboard→Fill returns fresh evidence and only the remaining Fill runs.
  No effect consumes the existing 30s budget without false success. Stop during
  confirmation cancels, with one initiating faux request and no continuation.
- Root targeted tests: 53 passed against genuine candidate values. Original
  AgentSession context/compaction/drag: ten passed; the three loader-based loop
  tests require matching experimental snapshot pins and passed there. Root
  historical production pins correctly refused this candidate.
- `general/g03cf/check.log` and final `general/g03cg/check.log`: full isolated
  checks passed, 1459 files, no fixes, source/live drift zero. Independent offline build/install and both type
  layers passed; 1425 assets, twelve packed workspace packages, 135 installed
  packages, 132 external lock entries unchanged.

Candidate: `general/segments/candidate`.
Independent installation: `/private/tmp/epi-computer-install-EBHtDY/product`.

| Asset | SHA256 |
| --- | --- |
| SDK | `5e9e117fd3c51d9b6a9f5f13dd15f53335c158dd59e8f1d211a043ac221e5877` |
| N-API | `faef6d22de08075ca345939f495d24561e27d633bfc674c09ca9a2c20e53c8f4` |
| Renderer | `e17ff560525e2908b684da706cc8c5f1a4cf540e09ace34f054cdd3593cacecc` |

Production pins remain historical. General upstream staged binaries remain
stale and must not be loaded. No new real-provider calls or lease recovery.

## Remaining boundary

This is a qualified confirmation increment, **not T-049 or whole-goal completion**.
C408 then reproduced a separate missing modal dependency check: a pre-sheet
semantic ref still wrote the selected parent window. Four terminals/two natural
exits/clean C408 are preserved in `general/installed-segment-modal-boundary-01`.
T-074 owns that repair; T-049 remains open in the sole task authority.
