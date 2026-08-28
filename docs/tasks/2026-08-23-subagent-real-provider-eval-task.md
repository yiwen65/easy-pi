# Task Plan: Subagent Real Provider Evaluation

- Created: 2026-08-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User authorization and confirmed real-provider evaluation contract in this conversation.

<!-- task-doc-section:background-goal -->
## Background and goal

Evaluate `@earendil-works/pi-subagent` against the configured real OpenAI Codex Provider, reproduce production-protocol failures that fake-child tests cannot reveal, and apply minimal verified fixes. The evaluation must exercise read-only delegation, isolated writing, durable DAG handoff, writer quality, and candidate-ref integration without modifying the user's current Git branch.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope: an explicit-opt-in real-model eval under `packages/subagent/test/eval/`, temporary repositories/worktrees, no more than 10 real child executions, aggregate reported Provider cost no more than US$5, diagnosis and minimal fixes in `packages/subagent/`, focused regressions, documentation where behavior changes, package tests/build, root check, and a final real-provider rerun when budget permits.

Non-goals: npm publication, Git commits, production deployment, merging a candidate into the caller's branch, exposing credentials, changing unrelated packages, changing Provider authentication, or using a Provider other than `openai-codex`.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The user explicitly authorized real Provider evaluation and bug fixes. | Confirmed conversation contract. |
| F-002 | Authorization permits at most 10 real calls and US$5 aggregate reported cost. | User selected the expanded evaluation matrix and confirmed the summary. |
| F-003 | `openai-codex` authentication is ready through OAuth without credential output. | `pi auth check --provider openai-codex --json --no-refresh` returned `status: ready`, `authType: oauth`. |
| F-004 | Available Codex models are visible and the runner can prefix guarded CLI arguments through `ChildPiInvocation`. | `pi --provider openai-codex --list-models openai-codex`; `packages/subagent/src/process-runner.ts`. |
| F-005 | Real API tests must be opt-in and targeted, and credentials must not be printed or persisted. | `AGENTS.md` real-provider test rules. |
| F-006 | The current worktree contains unrelated concurrent changes and `packages/subagent/` is untracked. | Current `git status --short`; previous Phase 2 task evidence. |
| F-007 | A provider-only child invocation did not pin a Codex model and emitted unrelated model `k3`; explicit provider plus model emitted `gpt-5.4-mini`. | Real eval before/after evidence and `/tmp/pi-subagent-real-eval-report.jsonl`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: The total evaluation window is approximately 30 minutes; stop rather than switch Provider if readiness changes.
- Assumption: OAuth/subscription calls may report zero dollar cost; call count remains bounded even when reported cost is zero.
- Open question: None. The execution contract was explicitly confirmed.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- A targeted eval is gated by `PI_REAL_MODEL_EVAL=1` and never runs in default CI/package tests.
- Real calls use only `openai-codex`, operate only in temporary snapshots/worktrees, and do not emit credentials.
- The evaluated matrix covers a read-only handoff and an isolated Writer/DAG/integration path; failures retain bounded usage and actionable terminal reasons.
- No more than 10 real child executions occur and aggregate reported cost does not exceed US$5.
- Every reproducible product defect receives a causal diagnosis, minimal fix, and focused regression; no speculative cleanup is included.
- Focused tests, full package tests, package build, root `npm run check`, pack/import smoke, diff check, task validator, and the final affordable real eval pass, or any external Provider blocker is reported truthfully.
- No commit, publish, candidate merge into the user branch, or unrelated-file restoration occurs.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004 -> T-005.
- Parallel batches: None. Provider budget accounting, shared package files, and real-call evidence require serialized execution.
- Serialization constraints: Only the coordinator edits the eval harness, implementation, and authority document. Real calls execute sequentially to keep call/cost accounting deterministic.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Add an explicit-opt-in bounded real-provider eval harness

- Status: done
- Owner: coordinator
- Objective: Implement a targeted, sequential test harness that can exercise real child Pi calls without entering default suites.
- Inputs and prerequisites: F-001 through F-006; current `process-runner`, DAG, worktree, quality, and merge APIs.
- Scope or files: `packages/subagent/test/eval/real-provider-eval.test.ts` and only directly required package exports/configuration.
- Expected output: A gated eval with temporary repositories, an explicit Codex invocation, call/cost counters, and deterministic assertions.
- Dependencies: None.
- Execution steps:
  1. Build temporary read-only and Git writer fixtures.
  2. Wrap real child execution with provider, call-count, cost, and sequential guards.
  3. Ensure default test execution skips every real call.
- Acceptance criteria:
  - No real call occurs without `PI_REAL_MODEL_EVAL=1`.
  - Credentials are neither requested nor logged.
  - The harness cannot exceed the confirmed call/cost contract in one invocation.
- Verification method:
  - Run the targeted file without opt-in and confirm it skips; inspect invocation arguments.
- Validation evidence: `test/eval/real-provider-eval.test.ts` added with explicit `PI_REAL_MODEL_EVAL=1`, sequential Codex invocation, temporary paths, and 10-call/US$5 accounting. Targeted run without opt-in skipped 1 file and all 3 tests; root `tsgo --noEmit` passed without making a Provider call.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Execute the read-only real-provider evaluation

- Status: done
- Owner: coordinator
- Objective: Validate current Pi JSON events, tool lifecycle, usage accounting, model reporting, and structured read-only handoff against Codex.
- Inputs and prerequisites: T-001.
- Scope or files: Temporary snapshot and the targeted eval only.
- Expected output: A successful evidence-backed read-only artifact or a reproducible bounded failure.
- Dependencies: T-001.
- Execution steps:
  1. Run the targeted read-only scenario with opt-in.
  2. Record actual model, turns, tokens, reported cost, and terminal status without recording prompt-sensitive content unnecessarily.
- Acceptance criteria:
  - The child uses only read-only tools and returns a valid structured handoff.
  - Usage/model metadata is non-empty and within budget.
- Verification method:
  - Targeted Vitest scenario with `PI_REAL_MODEL_EVAL=1` and Codex provider environment.
- Validation evidence: The first two Codex attempts failed fast with Provider 403 concurrent-request limits and zero reported tokens/cost. A provider-only invocation exposed model `k3`, proving that `--provider` alone does not pin a Codex model. After selecting `gpt-5.4-mini` explicitly and correcting the eval timeout, the targeted read-only scenario passed with a non-empty model, turns, tokens, `cobalt-17` summary, and `fact.txt` evidence; the fixture remained unchanged.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Execute isolated Writer, DAG, and merge real-provider evaluation

- Status: done
- Owner: coordinator
- Objective: Validate real-model write behavior, path enforcement, artifact creation, prerequisite handoff, and isolated integration candidate creation.
- Inputs and prerequisites: T-002 and remaining call/cost budget.
- Scope or files: Temporary Git repository/worktrees and targeted eval only.
- Expected output: Writer changes only declared files, durable DAG tasks complete, quality commits accepted changes, and Merge Coordinator creates the expected candidate without touching caller state.
- Dependencies: T-002.
- Execution steps:
  1. Run a direct bounded Writer scenario.
  2. Run a small Writer-to-reviewer DAG with merge enabled and deterministic fixture/validation.
  3. Verify caller branch/index/worktree invariants and candidate contents.
- Acceptance criteria:
  - Tool policy blocks undeclared writes and writer handoff parses.
  - DAG artifacts, usage, and candidate ref are coherent.
  - User/caller state remains invariant.
- Verification method:
  - Targeted sequential real-provider Vitest scenarios plus Git invariant assertions.
- Validation evidence: The real direct Writer scenario passed and wrote exactly the owned `result.txt`. The real two-task read-to-writer DAG passed; both children succeeded, quality committed the writer artifact, Merge Coordinator created `refs/heads/pi/subagent/integration/real-provider-dag`, candidate content matched, and caller branch/HEAD/status remained invariant. Seven total generation attempts have been consumed across setup/retries: two Provider 403 failures, one test-harness timeout attempt, and four successful task executions.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Diagnose and fix evidence-backed defects

- Status: done
- Owner: coordinator
- Objective: Localize every reproducible real-provider failure to its first divergence and implement the smallest complete correction.
- Inputs and prerequisites: T-002 and T-003 evidence.
- Scope or files: `packages/subagent/src/`, focused package tests, eval harness, and README only if behavior changes.
- Expected output: Causal fixes with fake/protocol regressions and successful focused verification.
- Dependencies: T-003.
- Execution steps:
  1. Reproduce failures without additional paid calls where fake events or captured bounded evidence suffice.
  2. Add a failing focused regression before or with each fix.
  3. Apply surgical fixes and rerun local focused tests.
- Acceptance criteria:
  - Every change traces to observed evidence.
  - Regressions fail on prior behavior and pass after the fix where demonstrable.
  - Existing contracts and security boundaries do not weaken.
- Verification method:
  - Focused Vitest, TypeScript check, and adversarial review.
- Validation evidence: The regression `passes an explicit trusted child provider, model, and thinking level as guarded argv` failed before the fix because fake Pi reported missing model flags, then passed after the fix. `ChildModelSelection` is now validated and supplied through guarded argv; Extension runs inherit or use a trusted override; Phase 1 passes it to every child; DAG request JSON persists it and the runner receives it after ledger round-trip. Unsafe flag-like values fail before spawn. Focused process-runner/Extension/DAG/eval tests passed 32 tests with 3 opt-in skips; root TypeScript passed. Full default package suite passed 122 tests with 3 opt-in skips, and package build passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Re-evaluate and run final integration validation

- Status: done
- Owner: coordinator
- Objective: Confirm fixes on the real Provider within remaining budget and close all package/repository gates.
- Inputs and prerequisites: T-004 and remaining call/cost budget.
- Scope or files: Targeted eval, package tests/build, workspace checks, package artifact smoke, task document.
- Expected output: Current real-provider and deterministic validation evidence with explicit remaining limitations.
- Dependencies: T-004.
- Execution steps:
  1. Re-run only scenarios needed to verify fixes while staying below 10 calls/US$5.
  2. Run full package tests, package build, root check, pack/import smoke, and diff checks.
  3. Review scope, account calls/cost, validate this authority document, and report.
- Acceptance criteria:
  - Real and deterministic gates pass or an external blocker is explicitly evidenced.
  - Total real execution count is at most 10 and reported cost at most US$5.
  - No unrelated repository changes are attributed to this task.
- Verification method:
  - Exact commands/results in validation evidence and the task-document validator.
- Validation evidence: The final opt-in run used the repaired `childModel` path and passed read-only plus two-task DAG/merge in 39.11 seconds. All three children emitted `gpt-5.4-mini`; results were 2,677, 2,875, and 8,636 tokens, totaling 14,188 tokens and US$0.0106494 reported cost. This consumed the final three attempts, bringing the task total to exactly 10 and preventing further real calls. For calls 3-10, the runner capped each child at 40,000 total tokens; the repository catalog prices `gpt-5.4-mini` output at the highest applicable rate of US$4.50/million tokens, so even an all-output 320,000-token upper bound is US$1.44, below the US$5 aggregate ceiling. Default package tests passed 122 tests with only the 3 explicit-opt-in tests skipped; package build passed; full `npm run check` passed after one package formatting fix; an unrelated-file archive/status comparison was identical before and after the auto-writing check; pack dry-run contained 58 expected files; built import smoke returned three functions; `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

Run the new real eval file first without opt-in and then only that file with `PI_REAL_MODEL_EVAL=1`. Keep scenarios sequential and expose only aggregate model/usage/cost evidence. After fixes, run affected focused tests, `npm run test --workspace=@earendil-works/pi-subagent`, package build, full `npm run check`, pack/import smoke, `git diff --check`, and task-document validation. Snapshot unrelated dirty state before any auto-writing root check and compare afterward without restoring concurrent work.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Provider OAuth may expire or service/model availability may change; stop rather than printing credentials or switching Provider.
- Model output is nondeterministic; assertions must validate behavior and schemas rather than exact prose.
- A streaming budget guard observes usage after Provider generation chunks and cannot guarantee zero overshoot; per-call caps and the call-count ceiling reduce exposure.
- Real Writer prompts are untrusted model output; all writes remain inside temporary isolated Git worktrees and package-owned path tools.
- Concurrent sessions can change unrelated files. The coordinator will not restore or claim them and will inspect any formatter writes.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: User selected `openai-codex`, up to 10 real child executions and US$5, and explicitly confirmed the execution contract.
- 2026-08-23: Provider readiness check returned ready OAuth without credentials; available Codex models were listed without a generation call.
- 2026-08-23: Task document created; T-001 started and assigned to coordinator.
- 2026-08-23: T-001 completed. The opt-in gate skipped all three scenarios by default and root TypeScript passed; zero real calls used.
- 2026-08-23: T-002 started and assigned to coordinator.
- 2026-08-23: Two provider-only read attempts failed with external 403 concurrency limits and emitted model `k3`; explicit `openai-codex/gpt-5.4-mini` then passed the real read-only scenario. T-002 completed.
- 2026-08-23: T-003 started and completed. Real direct Writer and two-task DAG/merge scenarios passed entirely in temporary paths; caller Git state was invariant. Seven of ten authorized generation attempts are accounted for.
- 2026-08-23: T-004 started. The first divergence is that child Pi received no pinned parent model; provider-only selection also retained unrelated model `k3`. A deterministic regression failed because guarded argv omitted trusted child model flags.
- 2026-08-23: T-004 completed. The Extension now pins parent provider/model/thinking (or a trusted override), DAG persistence retains it for resume, runner validates and passes guarded model argv, and focused/full package tests plus build passed.
- 2026-08-23: T-005 started with three authorized generation attempts remaining.
- 2026-08-23: Final real rerun consumed exactly three calls and passed read-only plus DAG/merge. All children reported `gpt-5.4-mini`; aggregate was 14,188 tokens and US$0.0106494.
- 2026-08-23: Package suite passed 122 tests with 3 opt-in skips, package build/root check/pack/import/diff checks passed, and unrelated dirty content was byte-identical across root check. T-005 completed.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 through T-005 are done. Ten authorized generation attempts were used: two external 403 concurrency failures with zero reported usage, one early harness-timeout attempt, four successful initial task executions, and three successful final verification executions. The final captured rerun proved exact child model pinning (`gpt-5.4-mini`), structured read-only and Writer handoffs, DAG artifact/quality/merge behavior, caller Git invariance, 14,188 tokens, and US$0.0106494 reported cost. The deterministic regression failed before the repair and passed after it; 122 default package tests, package build, root check, pack/import smoke, diff check, and task validation passed.
- Limitations: Successful stdout from the three initial targeted commands was not persisted by Vitest, so their exact token/cost subtotals are unavailable; each run still enforced its 40,000-token child cap and no run reported budget exhaustion. Calls 1-2 failed with zero usage, and calls 3-10 used `gpt-5.4-mini`; the catalog's highest token rate gives a conservative US$1.44 reported-cost upper bound for all eight capped calls. The early five-second test-timeout attempt ended before a usage record was captured. The final persistent report records the exact three-call verification subtotal. Provider concurrency is external and was not changed. The subsystem remains outside an OS/network sandbox, and no real recovery-after-process-crash scenario was generated because the 10-call ceiling was reached; deterministic recovery tests remain the evidence for that path.
