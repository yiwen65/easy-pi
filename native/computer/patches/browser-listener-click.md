# Scoped direct-listener clicks

Apply `browser-listener-click.patch` after `browser-navigation-alert.patch`.
Four Rust implementation/test files; no public ABI, generated binding, renderer,
personal-profile policy or arbitrary script surface changes.

- Patch SHA256: `e5e19061c12a5d8c326ff5dc71ea8ffd64474fcc0938cd5e4b54110650988df6`.
- SDK SHA256: `08b4fdbdb39b0322ffb7529c8a06ed8b87d88962b8c652bea1c79b8d081f3575`.
- N-API SHA256: `93ffdcc7fbba3437af84c61d60d5d6a8cbf231129f5b1ad4c947abeb8a5aed5a`.

## Behavior and boundaries

The observed generic SPAN/DIV keeps its own backend DOM identity. A missing AX
name can be derived from its visible direct StaticText children, bounded to
256 bytes. StaticText tokens are never redirected to an ancestor at dispatch.
Disabled, secure, outside-dialog and unnamed candidates do not gain actions.

Only a direct `click` listener, attested with the same backend ID, qualifies the
element. Listener inspection is depth zero, does not pierce frames, and accepts
at most 64 returned listeners. No delegated-listener or arbitrary ancestor
fallback exists. The observation publishes `press` only after this proof.
Before input, the exact DOM object and direct listener are checked again.

The new fixed input function checks document identity, connection, exact open
HTML dialog containment, SPAN/DIV type, visibility, opacity, inert and disabled
ancestors, then invokes one native HTMLElement click. The normal submission
gate and terminal drain remain unchanged. Submission is **unverifiable**, not
business success; no action is replayed. Listener removal between the last
inspection and submission can still produce a no-op, so callers must check the
business result. No claim of atomic listener-state stability is made.

## Evidence

The old SDK failed the span capability fixture and closed normally. The AX
parent-label regression failed before the change, then passed. A real isolated
Chrome inspection confirmed that the event listener belonged to SPAN/DIV, not
its text node. The initial candidate passed 11 cases, but an added
`visibility:hidden` case exposed incomplete visibility qualification.

`checkVisibility()` does not check CSS visibility or opacity by default; the
final fixed function explicitly opts into both checks. This matches the
[CSSOM View draft](https://drafts.csswg.org/cssom-view/#dom-element-checkvisibility)
and the failed-before/passed-after real Chrome case. The final 13-case fixture
also covers transparency, handler/node removal, inert/disabled state, no click
listener, unrelated event types, and inside/outside-dialog input.

Final direct-listener guards: 13/13 with independent event counts and native
close. 24 controlled CDP tests, 13 page tests, 139 desktop/context tests (one
separately enabled renderer test), package 8/8, native typecheck and root check
are recorded in the task document. Independent patch apply, exact source
comparison and reverse succeeded. Materials and failures are retained under
`/tmp/epi-click-handler.mz5oXh`; `sdk-final2`/`materials2` are the final candidate.
Installation, neighboring GUI and real-model acceptance must be checked in the
task log; candidate qualification alone does not prove deployment.

```sh
ALLOW_GUI_TESTS=true node native/computer/desktop/fixtures/real-model/listener-guards.mjs \
  /absolute/new-results /absolute/sdk \
  08b4fdbdb39b0322ffb7529c8a06ed8b87d88962b8c652bea1c79b8d081f3575 \
  /absolute/computer-renderer /absolute/Chrome.app
```

These are correctness qualifications, not a latency-distribution benchmark.
Per-operation timings are retained in the final fixture trace.
