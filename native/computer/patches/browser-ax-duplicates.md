# Identical Chrome AX records

Chrome can return identical synthetic InlineTextBox records more than once in
one accessibility snapshot (reproduced with ordinary unstyled list markers).
Rejecting every repeated ID made the entire page unobservable.

This two-file increment normalizes only fully equal JSON records at the existing
snapshot boundary. First-occurrence order and identity are preserved. Conflicting
records still fail. Raw record limits and aggregate text budgets still count
duplicates; parent, depth, frame and backend-target checks are unchanged. No new
action, ABI, cache, retry or persistent state is introduced.

## Reproduction and identity

- Apply after `browser-selected-state.patch`
  (`5017a53f5e7c84a460b61172cc9ef529114a8afe2656d295b4988a7fe5118f45`).
- This patch: `b4500af7321ce7d0ce83c0c6d732bedca489aeaf78dd03ae7e45c9c637d41fa9`.
- Dylib: `1080e21b50fe3ef2d2a10099d884985c7196e65bab83026a1956e85a7db6788f`.
- N-API: `1f3296c11bc25b1586670678f59297dbca425a6173b0151df7f8aee85de71b52`.
- Local evidence/materials: `/tmp/epi-ax-duplicates.hu0bQg`.

Independent forward application, exact candidate comparison and reverse
application passed. Both the real-record regression and repeated-text budget
regression failed before their respective fixes; all 18 native page tests pass.

```sh
ALLOW_GUI_TESTS=true node native/computer/desktop/fixtures/real-model/ax-list-duplicates.mjs OUTPUT PACKAGE MINIROOT CFT_BUNDLE
```

All arguments must be absolute paths; use a new output directory and a package
adjacent to the coding-agent dist. The fixture uses an owned isolated browser,
local jQuery UI from MiniWoB and independent click/state receipts, not personal
browser data. The same fixture failed observation on the old package and passed
five calls on the candidate, with exactly the intended three click targets and
normal native close. The selection-state neighbor also passed, including
pre-input rejection of an unobserved value postcondition.

This establishes a reproducible correctness improvement, not a universal
performance claim. Real-model results and remaining gates belong to T-022 in
`docs/tasks/2026-09-24-computer-e2e-speed-accuracy-task.md`.
