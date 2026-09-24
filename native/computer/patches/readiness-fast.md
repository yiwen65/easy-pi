# Unsupported AX readiness fast path

Apply `readiness-fast.patch` **after** `save-panel.patch`, which follows the
qualified `general-desktop.patch` stack. Three Rust paths; Cua's existing MIT
notice applies. No ABI, dependency, input route or permission policy changes.

- Patch SHA256: `ad5a77baa970959ed7885ccc5ad6598ba8fc5db30825debf3c1624614dc4d094`.
- SDK SHA256: `8b01d174bff81dc49101b3a85e692fbc8b4ceb7fbdf13c237e5411ad3d98d75a`.
- N-API and renderer unchanged from the save-panel delivery.

`Native.prepare()` now preserves whether optional AX enablement was accepted.
Only a successful preparation whose setter is explicitly unsupported/not
implemented skips the post-call 50ms settle and 1000ms window-change detector.
The detector's output was unused. Both suppression leases are still installed
before preparation and released before waiting for registered callbacks. Accepted
enablement and uncertain/error results retain the original cleanup and settling.
Process-incarnation checks, cache invalidation, permission errors, cancellation,
input ownership and quarantine remain unchanged.

The legacy action paths always retain their original cleanup policy. This does
not accelerate Chromium enablement or alter foreground activation. It must not
be described as a fix for the outstanding intermittent save-panel focus failure.

Rust 1.97.1 locked/offline release and genuine UniFFI `--check` passed. Independent
patch application, byte comparison and reverse application passed. Material file
`sources/readiness-fast-build.json` records exact modified source hashes. Existing
bindings and N-API remain unchanged. No byte-reproducible build claim.

Same source-bridge, alternating binary A/B: 10 pairs per scenario, 60/60 attempts
passed including expected broken-selection refusals. Successful task P50 (ms):
save/reopen 2238.9 -> 1273.7; working replacement 1514.8 -> 450.7; expected refusal
1666.6 -> 597.5. Each pair improved, but these are preopened owned AppKit fixtures,
not model/network, browser or application-launch benchmarks. Failures from the
earlier installed baseline remain recorded separately.

Evidence: `/tmp/epi-optimize.vOX6Su`; current status and installation qualification
are maintained only in `docs/tasks/2026-09-24-computer-e2e-speed-accuracy-task.md`.
