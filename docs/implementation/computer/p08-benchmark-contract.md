# P08 frozen measurement contract

Status remains solely in `docs/tasks/2026-09-18-computer-native-implementation-task.md`.
This document defines measurements, not completion or performance results.

## Platform and invariants

Apple M5, 10 logical CPUs, 24 GiB RAM; macOS 26.5.1 (25F80), Node24.15.0, qualified Rust1.97.1 release artifacts. AC power and job-bound `caffeinate -di`; no frequency, affinity, thermal or persistent power-policy changes. The desktop is shared, not an OS sandbox. Each GUI arm requires fresh console, quiet-input, exact fixture, TCC/responsibility and canonical-lease admission. Stop the batch on failure; retain the failed row and raw evidence, never replay unknown input or clear the lease automatically.

## Full native form: 30 paired runs

Frozen contract: `.artifacts/computer/p08/benchmark-contract.json`, SHA256 `50e0fff5ff18c2c28753586987ca6643aee78fd297a2f7e64b081df66b03b7fb`; 194 hashed source/runtime/harness inputs.

- **B1 baseline:** qualified P04 SDK; four observe → two-step Fill/AssertValue segments through the real installed AgentSession/faux provider.
- **B4 candidate:** qualified trimmed SDK; one observe → eight-step segment through the same installed AgentSession and host/adapter implementation.
- Both arms prebind the same exact owned fixture through trusted host configuration. Discovery, application launch and browser setup are outside this hot-form comparison.
- Fresh process and fresh blank `P06DiscoveryFixture` for each arm; five read-only observation warm-ups. Its four fields are Name, City, Team, Note; requested values are `value-<label>`. Window geometry, scale and foreground/key-window facts are recorded and must remain unchanged.
- Time `session.prompt()` through the final faux answer, including the first necessary observation and all eight semantic steps. Exclude setup, warm-up, independent verification and shutdown. Faux has no simulated/network latency.
- Thirty pairs, 15 AB and 15 BA, shuffled with seed20260920 before measurement. Expected request counts are9 versus3, not substituted for latency measurements.
- Record wall time, Node plus in-process native CPU, process memory/peak RSS, native plans/operations/receipts, completed steps and independent final field values. CPU excludes external `plutil` subprocess CPU.
- Practical targets: median task reduction≥30%, model request reduction≥50%, zero correctness failures. Report paired bootstrap95% uncertainty (10,000 resamples, fixed seed). Keep every sample; no outlier removal.
- Thirty samples per arm do **not** establish a formal task p95 gate. No universal speedup for browser, pixels, keys, arbitrary applications or real-model latency is implied.

The first draft named the old P04 fixture but assumed focus fields that its recorded protocol does not expose. Before any form/observation measurement, that draft and helper were preserved and the contract was refrozen around the already qualified discovery fixture, rather than weakening focus checks. The earlier single no-host SDK load is qualification evidence, not a formal benchmark sample.

## Native observation microbenchmark

One independent warm process per arm, five warm-ups plus100 timed observations through the genuine SDK, existing host/adapter, projection and outer scheduler. No model requests and no input. All observations must be complete; verify105 native terminal receipts per arm and natural clean close. This is diagnostic within-process data, not an independently paired task or formal fleet-tail result.

## Disabled-Computer startup: 300 paired runs

Frozen contract: `.artifacts/computer/p08/startup-contract.json`, SHA256 `a3b43cadca61cb3fbdc02f9719d3ac3449dfbfad5107c2935e4e3c90d70ba4ad`.

- Baseline is the same product snapshot with only four saved pre-P07 activation source files restored and recompiled; other sources and production dependencies match.
- Candidate is the installed P07 product. Both run outside the monorepo against the same copied dependency closure, with no external symlinks.
- Five warm-up pairs, then300 pairs, balanced/shuffled with seed20260920. Each sample launches a fresh Node process with `--version`; verify the exact version and natural exit0.
- Measure launch-to-exit wall time with identical `/usr/bin/time -lp` wrapping, plus CPU, RSS and available instruction/cycle counters. OS file cache is warm: this is process-cold, not disk-cold, TUI startup or request latency.
- Empirical nearest-rank p95; candidate/baseline p95 ratio minus1. Target≤5% regression, with paired-bootstrap95% interval reported; a confidence upper bound≤5% is the conservative pass criterion. No sample removal.

Native admission stress and final platform/regression verification remain separate correctness gates, not performance samples.
