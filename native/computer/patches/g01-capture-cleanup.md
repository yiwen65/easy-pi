# G01 exact-window capture cleanup candidate

Experimental T-044 subset, **not production promotion or general Computer delivery**.

Apply `g01-capture-cleanup.patch` after the qualified `p06-fast.patch` and current `g01-segment-contract.patch` sources. SHA-256: `dd58f482ee7b9884b8b3c7f1028d246e4d3cbc80f8a9abfe4eec0e847efc1bee`. Two authored Rust paths; no locks, ABI declarations or generated bindings are handwritten.

## Change and retained behavior

Exact-window ScreenCaptureKit still capture neither activates an application nor enables Chromium AX. Its old wrapper nevertheless enumerated windows, armed focus-restoration leases, waited 50 ms, and polled window changes for roughly one second. The detection result was discarded.

Only capture now uses a separate cleanup path: check native-window scope and cancellation, execute the existing synchronous tracked capture, then await registered callbacks. Existing process/window/geometry revalidation, capture permit, PNG bounds, native work ownership, cancellation and terminal/close rules remain unchanged. No detached timeout or screenshot fallback is introduced.

AX observation and every input path still use their previous cleanup. In particular, first Chromium AX enablement writes attributes and pumps readiness for 0.5 seconds; it has not been mislabeled as an already-proven read-only path.

## Verification

Evidence: `.artifacts/computer/general/capture-{inputs,verification,seal}.json`.

- Platform controlled tests: 88 pass, one explicit existing benchmark ignore; SDK controlled: 70/70. Added capture-scope, pre-cancel and quarantine checks preserve non-input/terminal facts.
- Isolated `p07/g01c`: full check passed (1424 files, no fixes), host 204 pass + 5 skip, controller 38, source drift zero. The full suite was not rerun; historical failures remain recorded.
- Genuine generation/check, N-API staging and Computer TypeScript emission passed. Patch forward application, exact byte comparison and reverse application passed. Old qualified 636 source hashes and 81 pins remained unchanged.
- A/B/B/A component diagnostic: two fresh processes per arm, two warm-up captures and ten measured captures per process. Aggregate capture median **1148.95 ms → 57.57 ms**; median process CPU **34,540 µs → 20,952 µs**. Baseline native window-detection median was about 1021–1027 ms; candidate capture no longer enters that wrapper.
- All four qualified runs passed independent PNG decoding/color/orientation/geometry checks, blank-field/no-input checks, background app/key-window checks, stale-reference rejection and cancellation. **68 native terminals, eight natural exits**, last clean **C246**; no lease recovery or real model request.
- Initial harness failure used an older fixture without `appActive`/`keyWindow` evidence. Raw failure and input contract are preserved; two natural exits and clean C242, no input. The corrected runner requires those fields before owner admission and uses the already-qualified discovery fixture; two harness regressions pass. Failed data are not counted as qualified samples.

This is a small capture-component measurement, not formal p95, end-to-end task speedup, user-concurrency qualification, or T-044 completion. It does not reduce structured-observation costs. Product pins and the historical delivery archive remain untouched.
