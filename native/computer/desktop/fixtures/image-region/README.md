# Image-region GUI regression

Opt-in, serial tests against an owned AppKit window. Requires an unlocked macOS
desktop, existing Computer permissions and a separately built candidate package.
Does not install the candidate, alter permissions or repair/delete a lease.

```sh
swiftc native/computer/desktop/fixtures/image-region/RegionFixture.swift -o /tmp/RegionFixture
ALLOW_GUI_TESTS=true node native/computer/desktop/fixtures/image-region/probe.mjs \
  /tmp/RegionFixture /absolute/package/bridge.js distant /tmp/region-distant-new
```

Repeat with fresh output directories for `replace`, `move`, `cover`,
`transparent-cover`, `reorder-cover`, `scroll-distant`, `scroll-replace`, and
`scroll-move`. Run only one desktop owner at a time;
inspect closure and clean lease before proceeding after a failure. The bridge
must retain its package's expected relative imports.

The fixture changes its own state after capture as a deterministic disturbance;
the actual click goes through the public Computer `segment` path. `distant`
requires exactly one original-target click. All negative cases require zero
target/cover clicks, `not_dispatched`, `stale_image_observation` and no committed
input. Closure, normal fixture exit and a clean desktop lease are required.
Reports preserve native/bridge/fixture/probe hashes, calls, timing and counters.

`reorder-cover` preserves both same-looking controls, their bounds and parent,
but raises the previously covered one. It detects confusing cached membership
with original hit identity. A pre-fix candidate dispatched to this wrong control.

Scroll cases first assert the actual clip offset is 500. `scroll-distant`
requires a changed offset after public-tool dispatch; replacing/moving the
container must leave both current and retained-old offsets unchanged at 500,
with the same strict pre-input refusal assertions as click negatives.

This is a bounded regression, not a general security proof or a speed benchmark.
It does not cover post-move races, inaccessible canvas
subtargets or model task success. The fixed 150 ms delay is fixture display
settling, not a production wait strategy.

Append `target` as the final argument to validate the separate native-target
candidate against the same six click cases (not scroll). It selects with semantic
observation, resolves the fixture's unique `owned-target` reference, mutates the
fixture, then submits `click` with `target.ref`. There is no image/coordinate
fallback. Replacement/movement must return `stale_session_observation`; covers
must return `pointer_hit_changed`, with the same zero-input and cleanup gates.
These candidate results do not qualify the independent local-pixel path.

Target mode also accepts `window-cover` and `window-behind`. A second owned
window has identical bounds and is ordered in front of or behind the selected
window. The front case requires `target_occluded` and zero clicks in either
window; the behind case requires exactly one click on the original target.

## Chrome direct-text child regression

Use a dedicated Chrome for Testing bundle and a fresh output directory:

```sh
ALLOW_GUI_TESTS=true node native/computer/desktop/fixtures/image-region/chrome-probe.mjs \
  /absolute/package/bridge.js '/absolute/Google Chrome for Testing.app' \
  /tmp/chrome-child-new link
```

Cases: `link`, `button`, `radio`, `replace-text`, `move-text`, `replace-parent`,
`cover`, `nested-control`, `button-replace-text`, `button-move-text`,
`button-replace-parent`, `button-cover`, `button-add-text`.
Positives require exactly one click; negatives require
zero target/cover clicks and refusal before any input. The fixture uses CDP only
to set up controlled disturbances and read independent counters; Computer sends
the actual native-target action. No personal browser or arbitrary target page is
used. Chrome's lazy AX subtree is observed with a bounded readiness loop; input
is never retried. Keep all failed reports.

The plain button failed before the observation-cache extension: Chrome hides its
sole text child from AXChildren, but asynchronous hit testing returns that child.
The approved candidate records only a button-center hit that is a direct
AXStaticText child, in the same observation snapshot, without granting it a new
model reference. Clicking requires the original child identity and geometry,
live direct parent relationship and window membership, and the existing
occlusion checks. Text added after observation remains a negative case.

Candidate v20 initially passed all 13 cases and the eight native-window cases,
but a later unchanged button positive was refused with `pointer_hit_changed`.
The intermittent failure remains unresolved; do not install this candidate.
The real-model dialog passed, while form timed out and navigation encountered a
provider error. Keep every failed report and the unchanged strict oracle.
Read-only diagnostic builds that intentionally refuse every action do not count
as passing negative regressions.

Diagnostic22 reproduced the missing-cache case: the initial hit was the parent,
then a read about 1.7 ms later returned its direct text child. Candidate v23
therefore waits only while a leaf web button still hits itself, with a 10 ms
settling budget and cancellation checks around each 1 ms pause. Already-resolved
hits do not wait. Expiry preserves missing evidence; it does not grant a child.
This is a between-read settling budget, not a bound on macOS IPC latency.
No input is retried and the pre-click checks are unchanged. The 13-case suite
plus 20 additional independent button positives passed (33/33); model and
installation qualification remain separate.
