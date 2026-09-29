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
`transparent-cover`, and `reorder-cover`. Run only one desktop owner at a time;
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

This is a click regression, not a general security proof or a speed benchmark.
It does not cover scroll-container changes, post-move races, inaccessible canvas
subtargets or model task success. The fixed 150 ms delay is fixture display
settling, not a production wait strategy.
