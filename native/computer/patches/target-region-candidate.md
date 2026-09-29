# Target-region comparison candidate (not installed)

2026-09-29. User authorized target-local click/scroll validation only after moved,
replaced and covered target negatives pass. This patch is an incomplete native
candidate, not an approved production relaxation or a verified speedup.

## Scope

`target-region-candidate.patch` applies to the current frozen core source under
`materials/sources/cua-driver` (git apply --check passed there). It adds exact
output-pixel rectangle comparison to ImageReference and four integration tests.
No existing input caller switches from whole-image `matches` to `matches_region`.
Drag policy, public tool schema, native ABI and installed artifact hashes stay
unchanged. Do not add this candidate to pinned-inputs before integration gates.

SHA256: `e8658135d89e7ea16b42328204e8361eca515753112d9f5bec062499fefed0a7`.

Reference creation decodes a bounded PNG once and retains RGBA pixels. Comparison
decodes the current image, requires unchanged PID/window/geometry, rejects empty,
overflowing or out-of-bounds rectangles without clamping, then compares exact
row slices. The caller must obtain the rectangle from native target geometry;
this API does not establish target identity, membership, occlusion or authority.
Pixel contents are excluded from Debug output. Legacy whole-image matching keeps
its PNG digest semantics.

Tradeoff: up to 16 MiB retained pixels per maximum-size reference, plus fresh
decode memory and CPU. No performance claim is made. The constructor now rejects
invalid PNG data beyond the earlier IHDR-shape check; canonical capture produces
valid PNGs. This needs actual capture latency/memory qualification before install.

## Verification

Working native source: `/tmp/epi-pointer-boundary.PFHOUz/cua-driver/rust`.
Use the existing `.artifacts/computer/p03-offline-repair/env.sh` wrapper from the
pi root by absolute path, with cwd set to that Rust workspace.

- Initial API absence produced E0599; this was a compile gap, not bug evidence.
- A temporary method forwarding to old whole-image matching produced 1 pass,
  3 failures: distant changes rejected, region bounds unchecked, invalid PNG
  accepted by the old header-only constructor. This forwarding method was removed.
- Candidate `cargo test --locked --offline -p cua-driver-core --test
  image_target_region --test image_freshness_characterization`: 7/7 passed.
  Characterization source is preserved in
  `docs/tasks/2026-09-29-image-reference-characterization.md`.
- `cargo test --locked --offline -p cua-driver-core --lib controlled::`:
  91/91 passed, including cancellation, scope, resources and unknown input.
- `cargo test --locked --offline -p cua-driver-sdk controlled_image`: 4/4 passed.
  Existing native build warnings remain: unused shutdown, irrefutable embedded
  backend test pattern, duplicate rpaths. No warning arose in the new source.
- pi root `npm run check`: passed. Four unrelated formatter-only changes were
  inspected and reverted; user changes were preserved.
- No real-model/GUI run for this candidate, no release build or installation.

## Required next integration

The prior captured failure and pure comparison tests justify a local comparator,
not successful stale-target protection. Existing captures omit AX identity and
reset snapshot addressing. The observed native Scan already retains AX handles
and parent/depth, but not element geometry. SnapshotOwner can retire retained
resources; reset_snapshot clears addressability, not necessarily the cleanup
payload. Review these lifetimes before reusing them; do not bolt on a second
unbounded cache or silently rebind a concrete reference.

Capture-time identity/geometry must be tied to the returned image, compared with
the actual hit target before dispatch and after tracking movement. Same-looking
replacement, movement, visible/transparent cover and changed scroll container
remain untested. AX container-only results cannot establish identity of hidden
canvas subtargets. Preserve full-image behavior where the candidate cannot prove
its target contract, without declaring those general cases solved. A target
change after a tracking move must report that committed move while withholding
down/wheel. Run owned GUI negatives, existing general scenarios and matched
real-model A/B before installing anything.
