# Task Plan: Audit and optimize session run performance

- Created: 2026-08-29
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User request to apply `$code-performance` to review and optimize this session's commits.

<!-- task-doc-section:background-goal -->
## Background and goal

Review the runtime-affecting changes introduced by this session, with primary focus on commits `28901d011` and `fa7505b56`, identify measured or strongly supported performance costs in v2 run streaming/rendering, and apply only optimizations that show reproducible component-level benefit without changing behavior.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope:

- runtime paths added or materially changed by this session's v2 run commits;
- Node.js/TypeScript CPU, allocation, timer, and event-loop costs during chatty command streaming and TUI rendering;
- reproducible local component benchmarks plus correctness validation;
- minimal implementation and regression protection for demonstrated costs.

Non-goals:

- optimizing unrelated pre-existing subsystems or other agents' commit `fd0db5848`;
- claiming product-level or cross-platform speedups from a local component benchmark;
- changing run output, error, scheduling, replay, sandbox, or extension semantics;
- paid-provider evaluation or broad profiling infrastructure.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The session's latest runtime commits are `28901d011` and `fa7505b56`; other session commits are prompt evaluation, test resolution, or documentation changes. | Conversation history and `git log --oneline`. |
| F-002 | Run progress creation is deferred through a getter and invoked only by the 100ms update throttle, not for every shell chunk. | `packages/agent/src/harness/tools/run-v2.ts`; `shell-output.ts`. |
| F-003 | The new collapsed run renderer currently styles and visually wraps the full bounded output on every rendered update before keeping five visual lines. | `packages/coding-agent/src/core/tools/tool-profile.ts`; `visual-truncate.ts`. |
| F-004 | Bounded run output may contain up to 2,000 lines or the configured byte limit, making full-output rendering work material for chatty commands. | shell truncation constants and run tests. |
| F-005 | Repository rules require targeted tests and `npm run check`; ad-hoc scripts belong in `/tmp`. | `AGENTS.md`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: A 2,000-line bounded output updated/rendered repeatedly at terminal width 120 is a useful stress workload for the newly added collapsed renderer, but it is not an end-to-end product workload.
- Assumption: Preserve exact visible tail content and expansion behavior; an expansion hint need not expose a precise visual-line count if avoiding that count removes full-prefix wrapping.
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Baseline and candidate use the same Node runtime, host, output, width, warm-up, sample count, and correctness oracle.
- A committed optimization requires a repeatable component-level effect larger than observed noise and a causal reduction in full-prefix styling/wrapping work.
- Collapsed output still shows the latest five visual lines and an expansion hint; expanded output, truncation warnings, timing, status, prefix/environment, and execution semantics remain unchanged.
- No per-chunk unbounded allocation, timer leak, or unrelated runtime regression is introduced.
- Targeted tests, root `npm run check`, task validation, and explicit diff checks pass.
- `docs/harness_tools/Pi Agent Tools v2.md` remains untouched and uncommitted.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003`.
- Parallel batches: Serialized because measurement, intervention, and A/B verification share one renderer and benchmark workload.
- Serialization constraints: Coordinator owns benchmark scripts in `/tmp`, product/tests, this document, and staging.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Establish baseline and attribution

- Status: done
- Owner: coordinator
- Objective: Audit session runtime changes and measure the strongest supported renderer cost with a reproducible component workload.
- Inputs and prerequisites: Session commit diffs, current source, JavaScript/TypeScript performance adapter.
- Scope or files: Read-only source/commit inspection and `/tmp` benchmark artifacts.
- Expected output: Raw repeated baseline samples, correctness checksum, and a ranked causal finding or bounded no-finding result.
- Dependencies: None.
- Execution steps:
  1. Trace shell chunks through throttled updates and TUI rendering.
  2. Benchmark repeated collapsed rendering of bounded 2,000-line output at fixed width.
  3. Reject candidates not on the measured path.
- Acceptance criteria:
  - Measurement contract records runtime, host, revision, workload, warm-up, samples, and timer boundary.
  - Baseline output is observable and behaviorally checked.
- Verification method:
  - Repeatable `/tmp` Node benchmark and static causal trace.
- Validation evidence: On Node v24.15.0, Apple M5, Darwin arm64, 2,000 lines/53,999 bytes, width 120, 30 warm-ups and 7×150 measured collapsed update+render operations, baseline raw ms/op was 15.7469, 15.4326, 15.5538, 15.6601, 15.7132, 15.8789, 15.8308; median 15.7132, range 15.4326–15.8789. Tail checksum/correctness passed. Static trace attributes the repeated cost to styling and ANSI-aware wrapping of all 2,000 lines before slicing five.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Implement and A/B validate the minimal optimization

- Status: done
- Owner: coordinator
- Objective: Remove demonstrated full-prefix rendering work while preserving tail UX and all execution semantics.
- Inputs and prerequisites: T-001 baseline and attribution.
- Scope or files: v2 run renderer plus focused renderer tests only.
- Expected output: Minimal optimized collapsed path and comparable candidate samples.
- Dependencies: T-001.
- Execution steps:
  1. Restrict collapsed visual wrapping/styling to the suffix capable of contributing visible lines.
  2. Add an adversarial long/wrapped-tail correctness regression.
  3. Rerun interleaved/repeated baseline-candidate measurements where practical.
- Acceptance criteria:
  - Candidate output matches the visible-tail oracle and expanded behavior.
  - Measured component time improves beyond run-to-run noise with no material resource tradeoff found.
- Verification method:
  - A/B component benchmark and targeted Vitest.
- Validation evidence: Candidate limits styling/wrapping to the last five logical lines before ANSI-aware visual truncation. Three fresh candidate processes produced median 0.0280, 0.0303, and 0.0300 ms/op (per-process ranges 0.0241–0.0332, 0.0245–0.0371, 0.0243–0.0393) versus baseline median 15.7132 ms/op, approximately 99.81% lower component time / 524× throughput for this stress workload. Checksums and tail oracle passed; focused renderer tests passed 28/28 including a 400-character wrapped final line.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Complete repository validation and delivery

- Status: done
- Owner: coordinator
- Objective: Validate correctness/integration, document evidence limits, and commit only task-owned files.
- Inputs and prerequisites: T-002 candidate.
- Scope or files: Final corrections, task document, explicit commit.
- Expected output: Verified optimization or a truthful no-change diagnosis.
- Dependencies: T-002.
- Execution steps:
  1. Run modified targeted tests and root `npm run check`.
  2. Inspect auto-fixes, diff, timers, and unrelated status.
  3. Validate task document and commit explicit paths.
- Acceptance criteria:
  - Required checks pass and evidence is recorded without overstating component results.
  - User-owned untracked document remains untouched.
- Verification method:
  - Targeted Vitest, root check, task validator, git status/diff.
- Validation evidence: Focused component test passed 28/28; root `npm run check` passed with no fixes; `git diff --check` passed; status contained only the two task code/test files, this task document, and the untouched unrelated user document. Static review found no second supported hotspot: shell chunks only replace a getter until the 100ms update boundary, environment cloning occurs once per command, and the 1s elapsed timer is cleared on final/error rendering.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Performance: repeated fresh-process or repeated-run component benchmark of update+collapsed render for 2,000-line output, Node/runtime and raw samples recorded.
- Correctness: focused `test/tool-execution-component.test.ts`, plus profile/run tests if shared execution code changes.
- Static/integration: root `npm run check`.
- Process: task validator, `git diff --check`, explicit status/staging inspection.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Microbenchmark results may not predict interactive end-to-end latency. Mitigation: label results component-level and optimize only a directly traced repeated path.
- JIT, GC, and host noise can distort small effects. Mitigation: warm up, use multiple samples, retain raw results, and require a large effect consistent with reduced work.
- Suffix-only wrapping can mishandle a very long final logical line or ANSI state. Mitigation: retain the complete contributing suffix, use existing ANSI-aware visual truncation, and test wrapped tails with the real theme.
- Current blocker: None for T-001; downstream tasks depend on measured attribution.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-29: Performance review scoped to session-owned runtime changes, primarily commits `28901d011` and `fa7505b56`; task started in measured optimization mode.
- 2026-08-29: T-001 measured the collapsed 2,000-line renderer at median 15.7132 ms/op and traced the cost to full-prefix styling/wrapping; T-001 done and T-002 started.
- 2026-08-29: T-002 restricted collapsed styling/wrapping to the contributing suffix. Three fresh candidate medians were 0.0280–0.0303 ms/op, about 99.81% below baseline; wrapped-tail correctness and 28/28 component tests passed. T-002 done and T-003 started.
- 2026-08-29: Root check, targeted tests, diff check, and task validation passed; no additional supported session hotspot was found. T-003 done.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: Measured component baseline/candidate, causal source change, wrapped-tail oracle, 28/28 focused tests, root static/integration check, and explicit diff inspection all passed.
- Limitations: The 99.81% figure is a local collapsed-renderer component result on Apple M5/Node v24.15.0 with a 2,000-line stress input; it does not establish end-to-end agent latency, other hardware/runtime results, or typical-workload benefit. Allocation reduction is source-supported but was not directly profiled.
