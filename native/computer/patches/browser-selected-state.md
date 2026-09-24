# Browser selected-state observation

This two-file native increment propagates Chrome AX's optional boolean `selected`
through the existing `WindowElement.selected` contract. It does not change the
ABI, add an action, infer selection from a role, or treat selection as a text
value postcondition. `false` and missing remain distinct. Ignored, protected,
DOM-detected secure, and metadata-required nodes without a backend identity do
not publish selected state. The browser-only bridge includes the field and does
not compact away a row containing it. Input admission and reference consumption
are unchanged.

## Identity and reproduction

- Base increment: `browser-scroll-into-view.patch`, SHA-256
  `387af39ff3de1bf539efdc04757597137092c0b560aa6460b86a4af3ed2f175e`.
- Increment SHA-256:
  `5017a53f5e7c84a460b61172cc9ef529114a8afe2656d295b4988a7fe5118f45`.
- SDK dylib:
  `6d5cec7ecd18a5729d61a7571ba7919ce2969ac233e68750c65d33e5c6c5f9f9`.
- N-API:
  `da7c4a8ef6b666518c6ca9278e8065334872817750611c9337c553291aee48f4`.
- Local evidence: `/tmp/epi-selection.avjmjg`; exact forward application,
  candidate byte comparison, and reverse application passed. Matching frozen
  SDK, source/build materials and previous installation are retained there.

Run the explicit-GUI fixture with new absolute output, adjacent-to-dist package,
and dedicated Chrome for Testing bundle paths:

```sh
ALLOW_GUI_TESTS=true node native/computer/desktop/fixtures/real-model/selection-state.mjs OUTPUT PACKAGE CFT_BUNDLE
```

It first reads raw AX from a separate owned page, then normally closes that
browser before testing the packaged native path. Its privileged fixture oracle
is not available to an agent. No personal Chrome data is used.

## Evidence boundary

The previous installed package failed `undefined != true` despite Chrome AX
reporting the correct true/false pair; it still closed normally. Both native and
bridge regression tests failed before their respective fixes. Fifteen native
page tests, 29 browser contract/tool tests, eight legacy controlled tests,
54 context/desktop/segment tests, eight qualified packaging tests, native/SDK
type checks and root checks passed.

The candidate fixture completed four calls: prepare, navigate+observe,
tab click+observe, option selection+observe. New selected flags agreed with the
independent receipt (`clicks=1`, Second selected, plan Pro), including clearing
the previous selection. A seven-call scrolling/Unicode/select/save neighbor
also passed; both closed normally. This proves the observation defect is fixed,
not that it caused additional model turns or that latency is universally lower.
Real-model measurements and remaining gates are tracked under T-019 in
`docs/tasks/2026-09-24-computer-e2e-speed-accuracy-task.md`.
