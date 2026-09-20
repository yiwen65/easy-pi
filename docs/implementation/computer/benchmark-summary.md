# P08 measured results

Contract: [p08-benchmark-contract.md](p08-benchmark-contract.md). Status authority: [task record](../../tasks/2026-09-18-computer-native-implementation-task.md).

## Full native form — 30 paired runs

Actual installed AgentSession/faux, fresh blank fixture per arm, identical eight semantic steps and independent value/focus/geometry checks. Baseline: qualified P04 SDK with four two-step segments. Candidate: qualified fast SDK with one eight-step segment. Both use the same installed host/adapter and prebound exact target.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Median complete task | 32.6682 s | 19.0869 s |
| Median Node + in-process native CPU | 1.4061 s | 0.4709 s |
| Model requests, faux | 9 | 3 |
| Main native plan boundaries | 4 | 1 |
| Outer scheduler acquisitions | 8 | 2 |
| Median process RSS at completion | 208,986,112 B | 208,527,360 B |
| Median SDK load/verification, fresh process | 28.352 ms | 25.543 ms |

**Median task reduction: 41.57%**, paired-bootstrap95% interval **41.41%–41.76%**; the frozen≥30% target passes. Request reduction is66.67%. All60 arms completed: **zero failed arms, 600 native terminal receipts, 120 natural exits**, clean C235. No sample or outlier was removed.

This measures the combined B1→B4 implementation. It does not assign the entire gain to trimming, FFI or any one optimization. CPU excludes external `plutil` subprocess CPU. Thirty samples per arm are not a formal task-p95 qualification. Browser/pixel/key workflows and real-model network latency are not covered by this speedup.

## Other measurements

- Native observation:100 measured samples after5 warm-ups in each independent process. Medians **1632.381ms →1122.464ms**; median Node/native CPU68,215.5µs→26,645µs. All210 receipts are no-input, with four natural exits and clean C174/C175. This is within-process diagnostic data, not a paired task distribution.
- Disabled-Computer startup:300 balanced pairs of fresh Node `--version` processes, identical production dependencies, only pre-/post-P07 activation source differences. p95 **312.333ms →310.564ms**. Regression estimate−0.57%, paired-bootstrap95% interval **−3.30% to +1.03%**; upper bound is below the frozen5% limit. Treat the small point difference as noise, not a speedup. OS file cache was warm; this is not disk-cold or TUI startup.
- DLL size: fast P06 build22,976,672B versus the feature-equivalent untrimmed P06 build27,257,440B. This is size evidence, not a latency conclusion; it is distinct from the P04 benchmark baseline.

## Correctness/stress follow-up

-100 genuine pre-dispatch cancellations and100 ancestor-revocation refusals, each attempting a previously valid fixture AXPress token. Together with101 observations: **301 native receipts, zero input, two natural exits**, clean C236. This is sequential native admission stress, not a claim about all post-dispatch cancellation latency.
- Installed browser profile: actual AgentSession/faux prepare→navigate→observe→eight-step DOM form, including layout change. Four native receipts, nine independent page events, background focus, native close and empty-parent removal verified; clean C237. This is correctness qualification, not a browser performance benchmark.

Raw data and independent verifiers: `.artifacts/computer/p08/{benchmark-contract.json,startup-contract.json,startup-raw.jsonl,startup-summary.json,micro-verification.json,paired-form-verification.json,paired-form-summary.json,final-gui-verification.json}`. All per-arm commands, TCC evidence, fixture events, terminal receipts and failures remain alongside them.
