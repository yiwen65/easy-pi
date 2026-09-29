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

SHA256: `bb20de7367ef4ad06e2871dd18208dfaf2ed97295f0b75e13f30b649f4eb6c5a`.

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

## Capture evidence integration (second candidate revision)

The candidate now gathers bounded AX handles, parent relationships, roles and
finite rectangles before capture, then rechecks retained geometry after capture.
The optional image metadata is published with the existing CachedSnapshot and
retired by the existing SnapshotOwner. No second cache, global map, service or
public action mode was added. Absent/incomplete AX evidence grants no local
eligibility; image observation remains available through its original path.
Capture does not perform AX readiness setters or focus writes. Cancellation and
target checks still precede publication. AX/SCK observations are not atomic.

Native retained_snapshot checks runtime scope, PID and exact window, clones
retained handles under the existing cache lock, and releases that lock before
any subsequent AX inspection. Callers must additionally compare image IDs;
merely obtaining the latest payload is not authorization to rebind an old image.
There is no input consumer yet. Missing local proof must never be confused with
a proved changed target once the consumer is implemented.

This revision adds AX scanning and geometry reads to capture; latency remains
unmeasured and is a qualification risk, not an optimization claim. Missing
per-element geometry is not local-target evidence. Dispatch must still validate
identity, live membership, ancestry, occlusion and the exact selected region.

Verification of this revision:

- Native cache tests: 5/5 passed, including retain/release counts, metadata
  surviving replacement unchanged, exact-old-generation cleanup preserving the
  new snapshot, and cross-runtime/PID/window rejection.
- Core element_cache tests: 9/9 passed.
- SDK controlled_image tests: 4/4 passed after adding image=None to the existing
  native test payload initializer. The first compile failed on that missing
  field; it was not a runtime failure.
- Root npm run check and patch application check passed. Unrelated formatter
  changes were reverted again.
- Additional SDK snapshot_lifecycle_tests: 2 passed, 3 failed. First failure:
  `built-in native cache registered`; two subsequent failures were poisoned-lock
  fallout. An independent run against the untouched frozen materials source
  reproduced the same first failure (0/1, exit 101). The generic SDK fixture
  builds the legacy registry, whereas native cache registration is in the
  controlled register_computer composition. This excludes the candidate as the
  cause of that specific failure, but does not turn these lifecycle tests green.
  No production registration was changed to accommodate a legacy fixture.
- Native warnings include the existing unnecessary unsafe in cursor/shape.rs;
  SDK warnings remain as listed above. No release/GUI/model run or install.

The untouched-baseline reproduction used the P03 environment wrapper and:

```sh
cargo test --locked --offline \
  --manifest-path /tmp/epi-pointer-boundary.PFHOUz/materials/sources/cua-driver/rust/Cargo.toml \
  --target-dir /tmp/epi-pointer-boundary.PFHOUz/cua-driver/rust/target \
  -p cua-driver-sdk --lib sdk_shutdown_releases_native_snapshot_while_closed_handle_is_retained
```

The shared debug build directory may now contain baseline artifacts; always run
Cargo in the candidate source before using its outputs. Installed/release
artifacts were not changed.

## Required next integration

The prior captured failure and pure comparison tests justify a local comparator,
not successful stale-target protection. Capture-side evidence is now retained;
the input consumer must bind it to the consumed image ID before comparing target
identity and geometry. reset_snapshot clears addressability, not necessarily the
cleanup payload. Do not silently rebind a concrete reference or treat cache
retention as current membership proof.

Capture-time identity/geometry must be tied to the returned image, compared with
the actual hit target before dispatch and after tracking movement. Same-looking
replacement, movement, visible/transparent cover and changed scroll container
remain untested. AX container-only results cannot establish identity of hidden
canvas subtargets. Preserve full-image behavior where the candidate cannot prove
its target contract, without declaring those general cases solved. A target
change after a tracking move must report that committed move while withholding
down/wheel. Run owned GUI negatives, existing general scenarios and matched
real-model A/B before installing anything.
