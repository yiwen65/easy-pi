# General Computer measured results

Status authority: `docs/tasks/2026-09-18-computer-native-implementation-task.md`, T-054. Frozen gates: `.artifacts/computer/general/g00-contract.md`. Historical P08 measurements remain separate in [benchmark-summary.md](benchmark-summary.md).

## Equivalent AX form:100 independent pairs

Node24.15.0/macOS arm64, shared desktop, fixed2× fixture geometry. Both arms execute exactly one eight-step Fill/AssertValue plan over Name/City/Team/Note through an original installed AgentSession and faux provider. Every native assertion and independent fixture value/focus/geometry check passed. No product optimization occurred during sampling.

| Metric | Before General | General |
|---|---:|---:|
| Task median |18.8425s|4.5582s|
| Task empirical p95 |19.0040s|4.8026s|
| Owner CPU median |362.821ms|138.493ms|
| Native plan median |17.719s|4.534s|
| Endpoint owner RSS median |208,568,320B|237,412,352B|
| Process peak RSS median |227,560KiB|231,896KiB|
| Timed faux requests |3|3|
| Timed native operations / scheduler acquisitions |2 /2|2 /2|

Median reduction **75.81%**, paired-bootstrap95% interval **75.72–75.87%**, passes the frozen≥50% gate. p95 bootstrap95% intervals: control18.9716–19.0328s; General4.6410–4.8461s. All200 arms succeeded:1,600 distinct native terminals,400 natural owner/fixture exits, clean C770. No formal sample was discarded.

**Timing boundary:** already selected target, completed readiness and five observation warm-ups, from `session.prompt` to the final faux reply. General additionally uses **four discover/select preparation requests outside this boundary**; the control is prebound. Thus this is not a claim that autonomous discovery plus the entire first-use task takes three requests. Both arms retain all eight native confirmation obligations; the faster four-fill/last-field-only segment pilot was rejected as non-equivalent.

Resources above cover owner CPU and memory only, not target/WindowServer/helper totals. Endpoint RSS increased28,844,032B; process peak RSS increased4,336KiB. This is not a memory-reduction, no-leak, universal GUI-speed or real-model network-latency claim. Tail uncertainty is limited by100 samples/arm.

## Preserved interrupted cohort

The first1× cohort completed38 pairs. In its next control arm the fixture changed from(x1000,y246,scale1) to(x0,y249,scale2) during the measured task. All four values and native assertions passed, but the geometry gate failed and stopped the batch. All77 attempts remain recorded:615 terminals/154 natural exits, clean C568. This cohort is not passed or pooled into the2× distribution. After fresh two-arm qualification, a separate2× cohort was frozen with the same task, thresholds and assertions plus pre-owner geometry admission. No actor or unique OS cause is inferred from the display change.

## Observation and disabled startup

- Structured observation,100 samples/arm after five warm-ups: median1109.187→**9.703ms**, p951138.427→**10.840ms**, passing250/500ms gates. One fresh process/arm;212 no-input terminals/four natural exits, clean C772. This is the fixed fixture, not every application's AX tree.
- Disabled startup,300 pairs: p95330.748→328.906ms. Paired-bootstrap95% regression interval **−3.027% to +1.717%**, upper endpoint below5%. Includes the same isolated shell wrapper and process-cold `--version`, with warm file cache. Whole installed owner versions are compared; unrelated intervening source changes are included, so the small point difference is not attributed to Computer or claimed as a speedup.
- Renderer overhead retains its separately frozen T-051 evidence: original RSS gate failure remains; the later context-identity candidate passed with only4,390,912B margin on mean endpoint RSS. Two starts/arm, no peak/leak guarantee. The renderer binary is unchanged in this candidate.

## Reproduction evidence

Under `.artifacts/computer/general/`:

- `form-performance-scale2/{contract.json,progress.json,completed.json,raw-verification.json,verification.json}`; contract SHA256 `40fed7f6662e349c6f1ba9aa7ab948bffffa8163c5522088a9142a181569a187`.
- `form-performance/interruption-verification.json` and original1× raw runs; failed pilots retained separately.
- `form-performance-scale2/observation-verification.json`.
- `form-performance/{startup-contract.json,startup-raw.jsonl,startup-verification.json}`; startup contract SHA256 `9261d78bea13868c46c086b033693230502b022851c6315668db502ebaff0cd1`.

Actual GUI correctness is separately catalogued in [workflow qualification](general-workflow-qualification.md). Final pins, relocation and repository-wide audit are separate delivery gates.
