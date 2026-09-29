# Target-region comparison candidate (not installed)

2026-09-29. User authorized target-local click/scroll validation only after moved,
replaced and covered target negatives pass. This patch is an incomplete native
candidate, not an approved production relaxation or a verified speedup.

The sections through “Required next integration” are historical notes for the
comparison-only/capture-only revisions. The final section records the current
consumer, hashes and verification; earlier “no consumer/no GUI” statements do
not describe the current candidate.

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

## Current consumer and GUI qualification (2026-09-29)

Patch SHA256: `94fc708d6d5ad3a35723cc9219d2dadc16d7a16f0dcc5231915752094a4445cf`.
Candidate native SHA256: `7778c6ee5e5f202aa53fc130d35683891858ef1e16ed9fc17df6ab61c067d419`.

Single-click and scroll validation now binds retained capture metadata to the
exact image ID, verifies live hit identity, original ancestry, parent identity,
role and geometry, and compares the full target rectangle (scroll: containing
AXScrollArea). PID/window identity, geometry, occlusion, coordinate boundaries,
cancellation and input ownership remain checked. Validation runs before and
after tracking movement. Drag, multi-click and popup-screen paths stay on
whole-image comparison. Missing optional capture metadata keeps that old path;
proved mismatch refuses. No public mode, ABI, service or second cache was added.

The first consumer was the legacy image-action path. Trace inspection showed
the initial 14/14 general GUI run used segment instead, so it was NOT evidence
of local comparison. The actual segment route was then connected. New native
refusal names initially projected as native_fault; existing error contracts
are now reused, notably stale_image_observation.

Artifacts under `/tmp/epi-pointer-boundary.PFHOUz/`:

- `region-baseline-distant`: installed native a1f1aea refused an unchanged
  target after a distant color change; zero clicks, positive oracle failed.
- `region-final-{distant,replace,move,cover,transparent-cover}`: candidate
  aa118c47 passed all five strict GUI cases; clean leases through C08b0.
- `general-target-region-final`: that candidate passed 14/14 general cases.
- `region-final-reorder-cover`: aa118c47 FAILED an added adversarial case.
  Two same-looking controls kept identity, parent and geometry but changed
  stacking order. The covering control received one click. Pixel equality and
  cached membership did not establish original hit identity.
- Repair: reject ambiguous capture geometry when a retained non-ancestor
  target also covers the point. Do not fall back or replay on this ambiguity.
  This deliberately conservative rule may also reject overlapping AX decoration.
- `region-fixed-{reorder-cover,distant,replace,move,cover,transparent-cover}`:
  current native 7778c6ee passes 6/6. Positive: exactly one target click.
  Five negatives: zero target/cover clicks, not_dispatched,
  stale_image_observation, inputCommitted=false. Every owner closed normally,
  fixture exit 0, clean leases C08c2–C08c7. Failure artifacts are retained.
- Current release build passes with existing unused-shutdown/duplicate-rpath
  warnings. Patch applies to untouched frozen materials. Pixel mapping: 2/2.
- `general-target-region-fixed`: current native passes 14/14 general GUI
  scenarios after the ambiguity repair, including click, scroll, drag, pointer
  cancellation, focus boundary, stale references, text editing and web form.
- Root npm run check passes. Its four unrelated formatter-only edits were
  inspected and reverted; unrelated user work is preserved. git diff --check
  flags literal blank-context lines inside the generated unified patch and a
  pre-existing user LEARNS.md EOF change; no source whitespace repair is implied.

Durable reproducer: `native/computer/desktop/fixtures/image-region/README.md`.
Installed artifacts and pinned inputs remain unchanged. The candidate has not
passed scroll-container negatives, post-tracking races or matched real-model
A/B. Capture latency/memory and missing geometry/AX-hidden subtargets need
qualification. These bounded results do not establish universal correctness or
end-to-end speedup. The old SDK lifecycle fixture issue above remains unresolved.

## Scroll-container regression and repair

Current patch: `ac145feaba1a9f7592dcc7189d32754c5d00ff12c91dfe10dc84341faddedafb`.
Current native: `fe94cdfd8a9e2e482950f214f849c7decc98799558dc73e08429ec68b8412011`.
These supersede the preceding revision hashes; still not installed.

Added owned NSScrollView scenarios with actual clip-offset readback before and
after input. Distant animation succeeded (500 to 550) and replacement refused,
but `region-scroll-move-strict` FAILED against native 7778c6ee: moving a blank
white container left the pixels effectively unchanged. The live hit no longer
had a scroll ancestor; region() returned None before checking captured competing
geometry. Whole-image fallback then dispatched a wheel to the old location.
Offset stayed 500, but inputCommitted=true violated the negative oracle.

Repair: perform the captured-point ambiguity check before the no-scroll-ancestor
fallback. This preserves evidence of the original target even when the live
ancestry no longer contains a scroll area. No new mechanism or permission added.

Native fe94cdfd passes the original failure in `region-scroll-move-fixed`:
not_dispatched, stale_image_observation, inputCommitted=false, offsets 500.
`region-v5-{scroll-replace,scroll-distant,distant,replace,move,cover,transparent-cover,reorder-cover}`
passes all eight neighbors. Total 9/9, all normal closures and clean leases
C08dc–C08e4. Build and frozen-source patch-application checks pass. The probe
now consumes fixture responses so the second state read cannot reuse the first.
The older failed artifact is retained. Broad model and race qualification remain.
`general-target-region-v5` also passes all 14 general GUI scenarios against the
same native revision; this remains a one-run screening, not a statistical claim.

## Real-model qualification: not ready for installation

`model-region-v5-desktop/` preserves serial real openai-codex/gpt-6-sol,
semantic/desktop, seed 42 runs against native fe94cdfd and unchanged MiniWoB
HTML/evaluator. Both native owners and CfT process groups closed cleanly.

- click-tab-2 FAILED: 148.504 seconds, 30 tool calls, reported cost $0.1918864.
  Four stale_image_observation refusals remain. The retained image-9.png shows
  the model's (35,253) coordinate on the visible Tempor link; this does not
  establish which native freshness/identity check refused it. Other failures
  include stale_image, stale_observation, focus_not_supported and unresolved
  intent. Do not weaken the unresolved-input guard to make this task pass.
- scroll-text PASSED: 50.772 seconds, 12 requests, 11 tool calls, $0.0949544.
  Tool time 1.147 seconds. One sample is not an A/B speedup.
- Total reported cost $0.2868408. This result blocks promotion despite 9/9 owned
  widget negatives and 14/14 general regressions.

The failed task exposed a separate harness defect: modelMs=282.409 seconds
exceeded taskMs=148.504 seconds. run.mjs enforced budgets in onProviderContext,
but agent-loop.ts catches that observer's errors and continues the request.
After the 24th counter increment, later requests could run without advancing
the timing origin. Thus the reported 24 turns is not a trustworthy request
count and the failed task's modelMs is invalid. Original evidence is unchanged.

Harness repair moves admission to the actual streamFunction wrapper. A request
meter rejects request 25 and cost >=10 before calling the provider; finish
consumes a timing origin once, so synthetic error messages cannot double count.
metrics.test.mjs passes 5/5, including deterministic 24-request exhaustion,
zero-admission cost exhaustion and duplicate completion. Root check passes.
The corrected harness still needs a real-model rerun; no retrospective metrics
were invented. Next product diagnostic should distinguish missing capture AX
proof, hit/ancestry ambiguity and local pixel changes on this concrete link.

## Chrome hit-test first divergence

An isolated loopback page reproduces a clickable styled span and unrelated
100 ms clock. Diagnostic-only builds log branch names, AX roles/indices and
rectangles, never labels or personal UI content. They are NOT install candidates:
native 9eaba5ba and 901bf1ac include extra temporary logging not represented in
the candidate patch; their staging source hashes preserve the exact diagnostic
source. Source logging was removed after the experiments. The shared release
build directory still contains the diagnostic binary; rebuild before packaging
a production candidate. Installed artifact and pins remain unchanged.

Reproducer: `/tmp/epi-pointer-boundary.PFHOUz/region-chrome-diagnostic.mjs`.
Isolated profile/screenshot directories and observations:

- `/tmp/epi-region-chrome-w2Ex5d`: dynamic page, capture_bound then refused,
  zero clicks. Native 9eaba5ba.
- `/tmp/epi-region-chrome-OHDjz2`: static page, no_image_metadata fallback,
  exactly one click. This is not a clean clock-only causal comparison because
  capture readiness also differed; do not attribute it solely to animation.
- `/tmp/epi-region-chrome-y8x7lw`: dynamic page, native 901bf1ac reports
  capture_bound, image_id_bound, then hit_missing. Live hit is AXScrollArea,
  desktop rect [100,243,1100,707], absent from the retained 51-row snapshot.
  The live scan also has 51 rows. Refusal precedes local pixel comparison.
- `/tmp/epi-region-chrome-OtP2gh`: adding semantic observe followed by fresh
  capture reproduces the same hit_missing and zero clicks. This excludes the
  simple hypothesis that one prior semantic read alone resolves the mismatch.
- `/tmp/epi-region-chrome-Y4ImgT`: harness error, capture omitted required
  maxDimension. Corrected in the script; not counted as a product failure.
- `/tmp/epi-region-chrome-nfh6WY`: foreground activation control returned
  outcome_unknown, so no subsequent click ran. It does not establish a
  successful foreground comparison or justify replaying window activation.

All six native owners/CfT groups closed, clean leases C08f7–C08fc. The minimal
page establishes a concrete Chrome identity mismatch; it does not yet prove
the exact same branch caused every MiniWoB refusal. Next: distinguish host
scroll-area hit behavior, asynchronous renderer hit-testing and foreground
state without weakening capture identity or substituting geometry as identity.

Primary references consulted: Apple documents that
[AXUIElementCopyElementAtPosition](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition)
takes an application or system-wide object and performs z-order hit testing.
Do not pass arbitrary AX children as though that were documented. Chromium's
[mac hit-test test](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/accessibility/hit_testing_mac_browsertest.mm)
checks internal web-root hit identity, which is not proof that the external
macOS API returns the same object in our observed environment.

## Read-only hit refresh experiment

Diagnostic native b4ca0a40 (`target-region-diagnostic-build3`) repeats the same
hit lookup five times with 100 ms run-loop pumping, without dispatching input.
`/tmp/epi-region-chrome-8WPQZ0`: retry 0 remains AXScrollArea; retries 1–4 become
AXStaticText. None matches a live-scan handle. The original scroll area's parent
does match live row 25 (AXGroup). This supports asynchronous hit refinement but
does not establish that waiting restores the required identity proof.

Diagnostic native bcb8478e (`target-region-diagnostic-build4`) adds read-only
parent tracing. `/tmp/epi-region-chrome-C6Wses`: refined AXStaticText has parents
AXGroup -> AXGroup -> AXWebArea -> AXScrollArea; none of these four handles
matches the original live tree. Thus simply normalizing one internal text child
to its parent is not supported by this experiment. No identity test was bypassed.

`/tmp/epi-region-chrome-NgFgAo` adds one fresh-capture attempt only after explicit
not_dispatched/inputCommitted=false. First attempt repeats that ancestry
mismatch. Second capture lacks optional image metadata and falls back to the
whole-image path, which refuses the dynamic page. Both attempts deliver zero
clicks. This does not justify repeated input or installing a fixed sleep.

All three attempts close native/CfT normally, clean leases C08fd–C08ff. Probe:
`/tmp/epi-pointer-boundary.PFHOUz/region-chrome-diagnostic.mjs` (updated to include
the bounded second attempt). Diagnostic sources are frozen in their staging
directories; candidate native source has again been restored byte-for-byte.
Release build directory remains diagnostic, not eligible for installation.
No production candidate change or performance claim follows from these reads.
Next discriminating observation: compare snapshot AXChildren identities with
the post-hit tree and identify why optional capture metadata is intermittently
discarded; preserve both failure causes instead of treating every stale refusal
as a pixel mismatch.

## Separating lazy tree population from overlap refusal

Diagnostic native 983fd59f (`target-region-diagnostic-build5`), owned page
`/tmp/epi-region-chrome-Ubh6Lg`: rows whose geometry includes the click contain
only AXWindow/AXGroup, not webpage text. This rules out treating the initial
51-row capture as already containing the text target. No bind_geometry mismatch
was logged; intermittent loss of optional metadata is still not fully localized.

Diagnostic native 2bec6004 (`target-region-diagnostic-build6`) adds a fresh
read-only scan after each repeated hit query. In
`/tmp/epi-region-chrome-EsT4uE`, the fresh tree has 57 rows, and retries 1–4
match AXStaticText exactly at fresh index 30. The original 51-row tree does not.
CFEqual identity comparison therefore works once that subtree is represented;
do not replace it with labels, bounds, or invented stable IDs.

After the explicitly undispatched first call, a fresh capture and second click
reach hit_index=30. The remaining refusal is then the candidate's own overlap
rule: index 33 AXGroup covers the point but is not in ancestry
[30,29,28,27,25,24,4,3,2,1,0]. This is a distinct first divergence, before local
pixel comparison. A bounding box's overlap alone does not establish that a
container is an intercepting surface. Simply deleting the rule would regress
the verified same-looking reorder-cover negative, so no relaxation was made.

Both tests deliver zero clicks and close normally, clean leases C0900/C0901.
Diagnostic sources are staged separately; native candidate source restored.
Next design must reconcile two requirements: original hit identity through lazy
AX tree population, and real occlusion/stacking evidence rather than treating
every non-ancestor bounding rectangle as interception. Fixed waits, blanket
AXGroup exemptions and rebinding an old image to a new target are not supported
by this evidence. Current candidate remains unqualified and uninstalled.
