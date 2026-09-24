# Bounded read waits during native browser prompts

Apply `browser-navigation-alert.patch` after `browser-select.patch` and its
documented predecessors. Three Rust source/test paths; existing MIT notices
apply. No generated binding, public ABI, permission or renderer change.

- Patch SHA256: `7cccea336d31ffcaf60854fd09eaca84cc02443d32d7c13fc68e4a26d15dd196`.
- SDK SHA256: `e25bdbd56d3017d4928e669e2ade42667fc3b7c0e088f6c425b5cff41cffa62e`.
- N-API SHA256: `93ffdcc7fbba3437af84c61d60d5d6a8cbf231129f5b1ad4c947abeb8a5aed5a`.

## Causal evidence

An on-load alert appeared to hang navigation. Method-only diagnostic tracing
proved Page.navigate returned in 6–10 ms; the subsequent Page.getFrameTree call
started after the dialog event and waited for the 20-second CDP timeout. The
15-second operation cancellation did not wake that read wait. In isolated Chrome,
0/10 ms alert delays reproduced 20.198/20.351-second navigation; no-alert and two
100 ms cases did not stall. All five baseline owners closed normally.

Candidate runs with identical timing inputs returned the two previously blocked
cases in 344/357 ms with `unexpected_modal_surface`, not a false navigation
success. All owners closed; prompt-return beacons were absent before cleanup.
These measurements isolate this failure, not a general throughput A/B.
Diagnostic sources, original failures and traces remain in
`/tmp/epi-nav-alert.zrMLcZ/{baseline,candidate}` and sibling logs. Temporary
method tracing is absent from the final source.

## Repair and boundaries

Page validation checks the native dialog journal before new work. Controlled CDP
calls reject an already-open prompt for their exact page session. Pending
read-only replies listen for that session's dialog event and operation
cancellation. Notification registration precedes the journal check, avoiding a
lost wakeup. A ready reply wins; otherwise the transport closes admission,
joins the reader and drops both socket halves before returning. No prompt
dismissal, reconnection, input fallback or replay is introduced.

Already-submitted input commands retain the original wait-for-completion
contract. An early candidate also interrupted input waits; the existing
committed-input regression rejected it, so the final change is read-only.
Closing a socket alone cannot prove browser-side input execution finished.
Input handlers that themselves block on alerts remain outside this fix.

## Qualification

The new pending-read regression failed before the repair and passed afterward.
38 CDP tests and 12 page tests pass, covering cancelled reads, page-session
isolation, native transport joins and preservation of committed-input behavior.
131 desktop/context tests pass (renderer-value skipped there and run separately),
8 package tests, native TypeScript, unchanged UniFFI generation and root npm check
pass. Incremental patch apply, byte comparison and reverse check pass.

The opt-in `navigation-alert-guards.mjs` fixture runs seven native-owned Chrome
scenarios: no prompt, then two rounds each at 0/10/100 ms. It checks bounded
navigation/observation, exact refusal codes, no automatic prompt return and
native close proof. Final build passed 7/7; elapsed times under concurrent
offline validation are qualification bounds, not latency distribution estimates.

```sh
ALLOW_GUI_TESTS=true node --import tsx native/computer/desktop/fixtures/real-model/navigation-alert-guards.mjs \
  /absolute/new-results /absolute/qualified-sdk /absolute/computer-renderer /absolute/Chrome.app
```

Final qualification artifacts: `/tmp/epi-nav-final.VvOeIZ`. Installed-package
and neighboring GUI results are tracked in the task document and real-model
`RESULTS.md`; do not infer installation from a candidate qualification.

Subsequent installed qualification passed: 11/11 neighboring dialog guards,
3/3 real-model form/dialog/navigation tasks with independent receipts and proved
close, then 7/7 installed navigation-alert guards (35–56 ms navigation). One model
navigation attempt used an old observation and recovered after a fresh read;
no unknown input was replayed. Earlier locked-desktop and unreadable-process
failures remain recorded separately. Endpoint preparation failures (3/30 select
neighbors) remain under T-012; this patch does not change endpoint parsing.
