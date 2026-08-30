# Task Plan: v2 Tools bounded real evaluation and optimization

- Created: 2026-08-30
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: User authorized a real, reproducible, evidence-driven v2 Tools evaluation and bounded optimization run, then confirmed `openai-codex/gpt-5.6-luna` at `thinkingLevel: max`, Google `gemini-embedding-001`, a $15/80-request/800k-token/150-minute hard budget, and a public-repository-only evaluation data boundary.

<!-- task-doc-section:background-goal -->
## Background and goal

Measure the current opt-in v2 `search`, `read`, `edit`, and `run` tools on deterministic capability cases and bounded real coding workflows before changing product code. Freeze independent development and held-out oracles, locate the first divergence in failed or wasteful traces, make only evidence-backed minimal changes, and compare the final candidate with the frozen baseline under the same model, thinking level, task inputs, public repository commits, and budgets. Improve correctness and completion first, then reduce unnecessary calls, repeated reads/searches, broad or irrelevant output, retained context, latency, and cost. The final claim must be “bounded real evaluation,” not universal coverage.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope: current v2 schemas/guidance/providers/state; FFF, local structured fallback, TypeScript index, optional semantic candidates, bounded Read, versioned/prepare-commit Edit, Run execution and metadata; deterministic single-tool and workflow matrices; temporary synthetic fixtures and fixed-commit public repositories; hidden filesystem/content/mode/process oracles; content-free trace and usage instrumentation; one paid baseline development batch; at most two evidence-gated optimization iterations; one final held-out batch; focused tests, SDK/evaluation documentation, root checks, audit, and explicit commits.

Non-goals: changing the externally visible v2 set from exactly `search/read/edit/run`; changing the default from `legacy`; adding Job, PTY, background-process management, or a sandbox claim; modifying legacy behavior except unavoidable shared regression fixes; sending private, untracked, credential, or current-worktree source content to the target model or embedding endpoint; hard-coding any public-repository target or oracle into production ranking; inflating context to hide retrieval defects; rerunning held-out attempts to improve scores; full repository builds/tests; production/network changes.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | v2 is opt-in, legacy remains default, and v2 exposes exactly `search`, `read`, `edit`, and `run`. | User contract; `packages/coding-agent/docs/sdk.md`; `packages/coding-agent/src/core/tools/tool-profile.ts`. |
| F-002 | Local legacy Bash and v2 Run now share `NodeProcessExecutor`; Run exposes signal/timeout termination metadata. | Commits `4daedceed` and `51a6534c9`; `docs/tasks/2026-08-30-shared-process-executor-task.md`. |
| F-003 | The prior real large-repository run used pinned VS Code commit `3aa54039a0bec1bd4f9b428cdb202b4271bf22ef`, passed one hidden mutation with Search/Read/Edit but made zero Run calls. | `docs/tasks/2026-08-30-real-large-repo-v2-validation-task.md`. |
| F-004 | Existing deterministic evidence passes 16/16 scenarios and reports FFF Recall@5 `0/5 -> 5/5`, but it does not establish broad real-task or Run effectiveness. | `packages/coding-agent/test/tool-profile-eval/RESULTS.md`; `full-requirement-evidence.test.ts`; `search-evidence.test.ts`. |
| F-005 | The previous replacement real evaluator completed 6 calibration sessions and only 4 held-out records before an 18-turn breaker defect aborted the fifth attempt; those held-out inputs must not be reused as fresh evidence. | `packages/coding-agent/test/tool-profile-eval/RESULTS.md`; `full-real-eval.real.test.ts`. |
| F-006 | Existing real-eval code is content-free and guarded, but its global limits are $5/48 sessions and synthetic embedding inputs; the newly confirmed contract is different and requires public fixed-commit evidence plus token/request/time gates. | `packages/coding-agent/test/tool-profile-eval/full-real-eval.ts`; `full-real-eval.real.test.ts`; confirmed user contract. |
| F-007 | A real-model metric can pass vacuously when the intended behavior never activates; activation counts and non-vacuous denominators are mandatory. | Relevant project lesson in `LEARNS.md` (“真实模型评测暴露的两类 schema 与断言陷阱”). |
| F-008 | Root `npm run check` can rewrite files, so before/after status and protected-file hashes must be compared immediately. | `AGENTS.md`; relevant project lesson in `LEARNS.md`. |
| F-009 | Current baseline commit is `51a6534c9`; unrelated untracked files under `docs/harness_tools/`, `docs/permission/`, and `docs/tasks/2026-08-30-linux-permission-runner-task.md` are protected. | Initial and post-seal `git status --short`, `git diff --stat`, and protected SHA-256 inventory. |
| F-010 | No paid request has occurred through T-001, and the 150-minute clock has not started. | Provider preflight used `allowModelNetwork: false`; the embedding provider reported zero requests; no baseline command ran. |
| F-011 | Development uses pinned `microsoft/vscode@3aa54039a0bec1bd4f9b428cdb202b4271bf22ef`; held-out uses distinct pinned `vitest-dev/vitest@c666d149a4516761bae92ca56ce1336d2fd352c3` (tag v3.2.4). The materialized public corpora contain 579 source files/7,276,587 bytes and 292 source files/1,160,297 bytes respectively. | Sealed contract repository inventory and clean clone checks under `/tmp/pi-v2-bounded-eval-contract.42c7hu`. |
| F-012 | Four disjoint public-repository repairs are frozen: development D-01 identity comparison and D-02 stale-view enum mapping; held-out H-01 offset boundary and H-02 multiline indentation. Old synthetic held-out families and the prior VS Code base/common target are excluded. | Sealed development/held-out manifests and case task-family/target records. |
| F-013 | Every hidden mutation fails, its exact expected restoration passes, mode drift is detected, wrong-location changes are detected, and both clones are clean afterward. | `/tmp/pi-v2-eval-build-contract.mjs` dry proof: 4 mutation failures, 4 expected passes, 4 mode-drift detections, and 4 wrong-location detections. |
| F-014 | Presence-only preflight resolves `openai-codex/gpt-5.6-luna`, configured auth, max thinking, and `GOOGLE_API_KEY`; the model-visible tools are exactly `search/read/edit/run`. Frozen schema hash is `95d775...a4a1`; no fetch occurred. | `/tmp/pi-v2-eval-provider-preflight.mts` output with credential values omitted and embedding request count zero. |
| F-015 | The sealed 150-minute clock started at `1788099424461`; deterministic T-002 completed with no chat or embedding dispatch, no budget ledger, and no product-source diff. | Sealed `evaluation-clock.json`; focused Vitest output; zero-request presence-only preflight; `git diff HEAD -- packages/agent/src packages/coding-agent/src`. |
| F-016 | The authoritative baseline is partial: D-01 aborted locally before dispatch on the repaired evaluator boundary false positive; D-02 used 10 chat and 2 embedding requests, restored the exact target and marker safely, but exhausted its turn cap after post-edit Read without calling Run. | Preserved `baseline-D-01.json`, `baseline-D-02.json`, primary and continuation summaries, budget ledger, hidden filesystem grade, and content-free call trace. |
| F-017 | Held-out evidence is partial and unsuccessful: H-01 aborted before dispatch on the repaired prompt-normalization defect and was not rerun; H-02 ranked the target first semantically but exhausted 8 turns on 6 Search/5 Read calls without Edit or Run. | Preserved H-01/H-02 markers and records, held-out summary, content-free trace, unchanged candidate hash, reconciled usage, and clean clones. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Confirmed budget interpretation: all new target-model and embedding network requests share hard caps of $15 known/reported cost, 80 combined paid requests, and 800,000 combined reported model plus embedding tokens. Technical sub-caps are at most 56 chat requests, 24 embedding requests, and 250,000 embedding tokens; any global cap wins first.
- Confirmed time interpretation: the 150-minute evaluation clock starts with the first baseline evaluation command, excludes requirements confirmation and read-only contract preparation, and includes deterministic baseline, paid batches, iteration evaluation, and held-out execution.
- Confirmed data boundary: target-model and Google payloads may contain evaluator instructions, tool schemas/descriptions, synthetic fixtures, and bounded paths/symbols/comments/source excerpts from pinned public repositories only. They must not contain current Pi worktree source bodies, unrelated untracked files, private data, transcripts, or credentials. Credential values are neither printed nor persisted.
- Assumption: Model-provider usage is counted from finalized provider usage; pre-request gates reserve estimated input plus configured output allowance so the next call cannot knowingly cross request/token/cost caps. Unknown or missing usage fails closed for subsequent calls.
- Assumption: Google usage is counted from reported or conservative estimated tokens. Each session is limited to 32 selected documents, batch size 32, 128 KiB uncached operation input, and three embedding requests, below the global breakers.
- Frozen provider mode: AgentSession compaction is off for these short tool-profile sessions, provider retries are zero so counted chat dispatches equal attempted paid requests, and output is capped at 8,192 tokens/request.
- Frozen allocation: at most six sessions—two unmodified development baseline sessions, one targeted session per optimization iteration, and two one-shot held-out sessions. Case chat caps are D-01 8, D-02 10, H-01 8, and H-02 8; the worst authorized schedule reserves 54 of 56 chat and 18 of 24 embedding requests.
- Frozen corpus/oracle hashes: full `01cee1db...94278`, development `23654990...aeca5`, held-out `31b3d857...8ad2e`, and verifier `f7aeef7a...5f892`. Exact values are in `/tmp/pi-v2-bounded-eval-contract.42c7hu/sealed-hashes.json`.
- Frozen semantic scopes are case-specific. Actual TypeScript catalogs are complete and contain 1,840/1,707/953/525 documents; local target ranks before embedding are 4/4/3/18, all inside the 32-document cap.
- Open question: None requiring user input. The user confirmed the material model, budget, provider, data, scope, and stopping decisions.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Before product-code modification or paid calls, freeze baseline commit, exact scenario manifest, public repository commits/sizes/languages, hidden development and held-out oracles, evaluation prompts, provider modes, metric rubric, seeds/order, data allowlists, and breaker implementation; prove initial mutations fail and expected restorations pass.
- Execute non-vacuous deterministic scenarios for every Search/Read/Edit/Run capability listed below and at least one actual four-tool `Search -> Read -> Edit -> Read/Run verify` chain.
- Run the paid baseline on the unmodified `51a6534c9` product code with the confirmed model/thinking/embedding configuration and content-free records. Do not treat historical runs as the new baseline.
- Attribute every baseline failure or waste finding to the earliest evidenced category: tool implementation, provider/ranking, schema/guidance, host capability, evaluator/infrastructure, or model decision.
- Each optimization iteration addresses one measured primary bottleneck, adds the smallest regression, passes deterministic gates, and demonstrates measurable development-set benefit without correctness, wrong-location, data-boundary, or budget regression. Stop after two consecutive no-benefit iterations or any safety regression.
- The held-out corpus is not executed before the final candidate. Its exact answers are not used to tune production code. Every started held-out attempt is authoritative and is not rerun to improve results.
- Final evidence contains per-tool and end-to-end correctness, calls, repeats, provider/context bytes, useful/duplicate/irrelevant bytes, tokens, latency, cost, activation counts, truncation/coverage, and peak retained output, with baseline/candidate paired development comparison and candidate-only held-out safety results.
- Final focused tests and root `npm run check` pass; automatic rewrites are audited; only task-owned files are staged; validated changes and the final task record are committed.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-009 -> T-003 -> T-004 -> T-005 -> T-006 -> T-010 -> T-007 -> T-011 -> T-008`.
- Parallel batches: None. Corpus/oracle sealing, baseline, diagnosis, code changes, paid requests, and held-out access share mutable budget and anti-overfitting state and are intentionally serialized. Additional subagents are not used because they would add external model calls over current-worktree source outside the evaluation data boundary.
- Serialization constraints: The coordinator owns this document and all budget counters. Product source cannot change before T-003 baseline completes. T-007 cannot start before a candidate is frozen and all development work stops. Root formatting runs only after code is final and after a protected-state snapshot.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Freeze the auditable contract, corpus, oracles, and breakers

- Status: done
- Owner: coordinator
- Objective: Convert the confirmed request and current evidence into an immutable pre-baseline evaluation contract.
- Inputs and prerequisites: User-confirmed model/budget/data contract; current source/tests/history; public repository metadata; no model output from this task.
- Scope or files: This task document; read-only source/tests/docs; exact guarded temporary manifests and public clones only.
- Expected output: Valid task document plus sealed development/held-out manifests containing exact commits, prompts, targets, expected state, hashes, seeds, provider modes, metric labels, and breakers.
- Dependencies: None.
- Execution steps:
  1. Characterize current schemas/providers/evaluator without changing product code.
  2. Select and pin public development and held-out repositories/tasks; build independent hidden oracles and prove fail/pass cycles.
  3. Freeze the deterministic matrix, real-task ordering, context-label rubric, request/token/cost/time gates, data allowlists, and baseline commit.
  4. Validate this document and hash sealed manifests before any baseline command.
- Acceptance criteria:
  - Oracle creation precedes model exposure and detects wrong-location, missing, extra, mode, and verification failures where applicable.
  - Development and held-out tasks are disjoint by target/task family; old partially exposed held-out inputs are excluded.
  - No paid request or product-code change occurs.
- Verification method:
  - Task validator; Git/status evidence; manifest/hash checks; mutation fail/pass dry runs; presence-only auth checks deferred until the public allowlist exists.
- Validation evidence: Pinned clean clones were created for VS Code `3aa54039...22ef` and Vitest `c666d149...52c3`. `/tmp/pi-v2-eval-build-contract.mjs` proved all four mutation-fail/expected-pass cycles plus mode and wrong-location detection, then restored both clones clean. Actual scoped semantic catalog probes found every target within the 32-document preselection cap at ranks 4/4/3/18. Presence-only `allowModelNetwork:false` preflight found the exact model/auth and Google-key presence, created exactly `search/read/edit/run`, froze schema/system-prompt hashes, and made zero embedding requests. Independent `shasum -a 256` matched the four sealed hashes; Pi HEAD remained `51a6534c9` with no tracked product diff; protected hashes remained recorded; the task validator passed before and after sealing. No paid call or baseline command occurred.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Run the current deterministic baseline and validate instrumentation

- Status: done
- Owner: coordinator
- Objective: Measure current tool behavior without modifying product code or using paid providers.
- Inputs and prerequisites: T-001 done; baseline commit `51a6534c9`; sealed matrix and metric rubric.
- Scope or files: Existing focused tests/evidence runners plus temporary baseline runner; no product edits.
- Expected output: Per-scenario Search/Read/Edit/Run/workflow baseline, non-vacuous activation counts, and validated content-free metrics.
- Dependencies: T-001.
- Execution steps:
  1. Run existing deterministic v2 suites and 16-scenario evidence gate.
  2. Run additional frozen Run, duplicate-context, UTF-8, and public-corpus dry scenarios where existing evidence is insufficient.
  3. Verify metric arithmetic, byte classification, duplicate fingerprints, peak retention, hidden grading, and content-free serialization.
- Acceptance criteria:
  - Every declared deterministic scenario has an actual denominator and pass/fail result.
  - Instrumentation agrees with independently computed fixture bytes and does not persist content-bearing fields.
- Verification method:
  - Targeted Vitest commands and temporary independent metric cross-checker.
- Validation evidence: The sealed clock was created immediately before the first focused command. The new evaluator unit test first exposed one real arithmetic-label defect (`view_id` metadata was classified as irrelevant), then passed 6/6 after line-level metadata and duplicate accounting were corrected. Focused Agent Search/Read/Edit/Run/tool-state/process suites passed 108 tests with one platform skip. Focused coding-agent v2/provider/index/read/evidence/trace/evaluator suites passed 87 tests with two gated real-test skips. The independent 16-scenario evidence gate passed 16/16 without remote calls. Root `npm run check` initially rejected one unused evaluator import, then passed after its removal; the formatter touched only the three task-owned evaluator TypeScript files, and all protected hashes remained exact. Final presence-only preflight reconfirmed model/auth/key presence, max thinking, exact four-tool/schema/system-prompt hashes, and zero embedding requests. Product source diff stayed empty; no paid request or budget state exists.
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — Repair the pre-dispatch evaluator boundary false positive

- Status: done
- Owner: coordinator
- Objective: Preserve the authoritative aborted D-01 record, correct the proven system-prompt path false positive without weakening source-body protection, and make the unstarted D-02 baseline resumable.
- Inputs and prerequisites: T-002 done; authoritative zero-dispatch D-01 record; redacted dry reproducer showing the frozen system prompt contains exactly three static Pi documentation-reference lines.
- Scope or files: Bounded evaluator helper/tests/real runner, durable content-free budget-resolution state, and this task document; no product source or public-repository oracle changes.
- Expected output: Exact-line boundary allowance with regression coverage, auditable no-dispatch integrity resolution, and continuation logic that skips rather than reruns D-01.
- Dependencies: T-002.
- Execution steps:
  1. Encode the redacted system-prompt-path reproducer as a focused boundary unit test.
  2. Allow only the three exact frozen documentation-reference lines; continue rejecting every other Pi-root occurrence and all source bodies/secrets.
  3. Preserve the D-01 attempt/record/summary, record a bounded no-dispatch integrity resolution, and permit only the still-unstarted D-02 baseline attempt.
  4. Rerun focused evaluator tests, root checks, task validation, and the zero-network dry boundary oracle before resuming paid execution.
- Acceptance criteria:
  - The original D-01 attempt is never deleted, relabeled, or rerun.
  - The exact three static path-only lines pass, a suffixed or different Pi path fails, and no current-worktree source body becomes allowed.
  - Durable counters remain zero before D-02, and the integrity resolution is content-free and justified by the pre-reservation failure trace.
- Verification method:
  - Red/green boundary unit; redacted dry provider-context probe; ledger-state assertions; focused Vitest; root `npm run check`; protected hashes.
- Validation evidence: The pre-fix authoritative attempt recorded one local synthetic assistant turn but zero provider contexts, chat reservations, embedding requests, tokens, cost, and tools. A no-network exact-session probe localized the rejection to `provider_context_forbidden_root`; a second redacted probe found only the three frozen Pi documentation-reference lines in the system prompt and no secret match. A focused regression now allows only those exact full lines and rejects a suffixed/different Pi path; evaluator units pass 7/7 and the gated real file remains skipped by default. An exact frozen-session dry context passed while an unrelated Pi path failed, with zero model/embedding requests. Root `npm run check` passed and protected hashes stayed exact. The content-free ledger resolution required exactly the initial D-01 zero-request/zero-token/zero-cost state, appended `allowed_static_documentation_lines`, and preserved the original marker/record/summary hashes. Continuation loads and skips the authoritative D-01 record rather than starting it again.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Execute the paid unmodified development baseline

- Status: done
- Owner: coordinator
- Objective: Collect the new authoritative real-model baseline before any product-code change.
- Inputs and prerequisites: T-002 done; model/auth/key presence checks; sealed public/synthetic development tasks; active global budget ledger.
- Scope or files: Temporary clones/fixtures/runner and content-free result artifact only.
- Expected output: One authoritative development record per frozen baseline case with hidden grades, tool/context metrics, usage, cost, and breakers.
- Dependencies: T-002, T-009.
- Execution steps:
  1. Perform presence-only provider preflight and verify exact model/provider configuration without printing credentials.
  2. Execute cases in frozen order with pre-request and post-response request/token/cost/time gates.
  3. Stop on any systemic/data/safety breaker; grade from hidden state; remove temporary source/transcript state after extracting content-free metrics.
- Acceptance criteria:
  - At least one successful real scenario exercises each v2 tool and at least one complete four-tool chain, or the task is marked blocked/partial with the exact breaker.
  - No target-model/embedding payload crosses the allowlist; no credentials or content-bearing transcript is persisted.
- Verification method:
  - Independent one-shot markers, sanitized records, hidden graders, usage reconciliation, request ledger, boundary counters, and temp cleanup checks.
- Validation evidence: D-01 remains an authoritative zero-dispatch evaluator-infrastructure abort and was skipped on continuation. D-02 is authoritative: 10 chat plus 2 embedding requests, 56,346 combined reported tokens, 72,794 ms, and `$0.00766434` known cost. Search ranked the target first; all target/mode/wrong-location/verifier filesystem checks and the concurrent marker passed. The model made 2 Search, 4 Read, and 4 Edit calls, including two `PREIMAGE_MISMATCH` recoveries, then used turn 10 for the required post-edit Read. It made zero Run calls, so activation and end-to-end success failed on `session_chat_request_budget_exhausted`. Usage reconciliation passed; both clones were restored clean. The baseline is explicitly partial, satisfying the terminal-breaker branch of this task's acceptance criteria.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Diagnose first divergences and select one optimization target

- Status: done
- Owner: coordinator
- Objective: Explain failures and waste causally before editing code.
- Inputs and prerequisites: T-003 completed or terminally stopped with usable evidence.
- Scope or files: Baseline records, current source/tests, task document; read-only diagnosis.
- Expected output: Ranked bottlenecks with first-divergence traces, competing hypotheses, excluded causes, and one selected minimal intervention.
- Dependencies: T-003.
- Execution steps:
  1. Compare hidden success with tool sequence, result bytes, next decision, and model usage.
  2. Classify schema/provider/implementation/host/model/evaluator causes at the first divergence.
  3. Select only the highest-impact falsifiable target that has a deterministic regression and measurable development metric.
- Acceptance criteria:
  - The selected change is not oracle-specific and predicts an observable metric movement.
  - Safety/correctness gates and reasons for rejecting broader changes are explicit.
- Verification method:
  - Source trace, counterexample review, and baseline-record cross-check.
- Validation evidence: D-02 excluded retrieval/provider/host causes at the first divergence: semantic Search ranked the exact target first, Read was target-first with full required-range coverage, and the final filesystem/verifier state was exact and safe. The first avoidable divergence was Edit sequence 3: `PREIMAGE_MISMATCH` after fresh target evidence, followed by another Read, an unnecessary literal Search, and a second `PREIMAGE_MISMATCH`; those two extra recovery turns displaced Run beyond the 10-turn cap. Source tracing proved `applyRangeReplacements` attaches `recovery: read_again`, but the agent exception path exposes only `error.message`; the visible PREIMAGE message names path/range but does not tell the model to copy unnumbered fresh Read text and retry Edit directly. The selected minimal intervention is that general visible recovery instruction. It predicts PREIMAGE errors `2 -> <=1`, Search calls `2 -> 1`, and enough saved turns to activate Run. Changing the frozen cap, ranking, or oracle was rejected because each would hide rather than prevent the measured waste.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Implement and validate optimization iteration 1

- Status: done
- Owner: coordinator
- Objective: Apply the smallest complete fix for the selected baseline bottleneck.
- Inputs and prerequisites: T-004 done; frozen development metrics/oracles.
- Scope or files: Only source/tests/docs implicated by the proven first divergence.
- Expected output: Minimal product diff, regression test, deterministic gates, and paired development candidate evidence.
- Dependencies: T-004.
- Execution steps:
  1. Add a focused failing regression, then implement the minimal change.
  2. Run affected unit/integration/evidence tests.
  3. Run the frozen development subset; use paid retest only when deterministic evidence cannot measure model decision impact.
- Acceptance criteria:
  - Correctness does not decline; wrong-location changes remain zero.
  - At least one predeclared primary metric measurably improves or the iteration is rejected and reverted only in task-owned files.
- Verification method:
  - Red/green regression, deterministic matrix delta, optional paired paid development records, and scoped diff review.
- Validation evidence: The focused regression failed before the product change on the missing `without displayed line-number prefixes` recovery instruction, then passed after one PREIMAGE message was made actionable. Focused Agent suites passed 45/45; coding-agent evidence/evaluator suites passed 9 tests with the gated real test skipped; the independent matrix remained 16/16; root `npm run check` passed with protected hashes unchanged. The paired D-02 iteration completed successfully at score `1.0` versus baseline `0.8667`: PREIMAGE errors `2 -> 1`, Search `2 -> 1`, Edit `4 -> 3`, Run `0 -> 1`, verifier activation false -> true, and all filesystem/safety/usage gates passed. Combined reported tokens fell `56,346 -> 53,194` (-5.6%), provider payload bytes `601,362 -> 581,971` (-3.2%), elapsed `72,794 -> 62,818` ms (-13.7%), and known cost `$0.00766434 -> $0.00672958` (-12.2%). Tool-result bytes fell `7,547 -> 7,074`; active tool-result context rose `44,794 -> 45,690` (+2.0%) and peak `6,819 -> 7,074` (+3.7%) because the one visible recovery error is longer. That localized context tradeoff is retained and disclosed because correctness/completion improved and total provider context/tokens fell.
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Apply stopping rule or one final optimization iteration

- Status: done
- Owner: coordinator
- Objective: Decide from evidence whether a second distinct bottleneck warrants the last allowed development iteration.
- Inputs and prerequisites: T-005 terminal evidence; remaining budget and development failures.
- Scope or files: One additional evidence-backed bottleneck at most; otherwise documentation-only stopping decision.
- Expected output: Either a validated second minimal improvement or a recorded stop with no speculative code.
- Dependencies: T-005.
- Execution steps:
  1. Re-rank remaining first divergences and check correctness, budget, and consecutive-no-benefit breakers.
  2. If justified, repeat focused regression/change/development validation once; otherwise freeze the T-005 candidate.
  3. Freeze final candidate commit/diff and prohibit further development-set tuning.
- Acceptance criteria:
  - No more than two optimization iterations occur.
  - Two consecutive no-benefit results, any safety regression, or insufficient integrity/budget stops new paid calls immediately.
- Verification method:
  - Iteration ledger, paired metrics, breaker state, and candidate hash.
- Validation evidence: Iteration 1 achieved full correctness and four-tool activation with the predicted recovery-call reductions. No distinct remaining correctness or safety divergence is evidenced; a second change would tune one stochastic sample or trade against the successful recovery instruction. The stopping rule therefore selected no iteration 2. Candidate product state was frozen once at HEAD `51a6534c9` and product diff hash `3a011dab...359b`; the file is content-free, held-out markers/records were both zero, and subsequent product tuning is prohibited.
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — Repair cross-repository frozen prompt normalization

- Status: done
- Owner: coordinator
- Objective: Preserve H-01 as a zero-dispatch infrastructure abort, correct the proven repository-name normalization defect without changing the frozen prompt, and permit only untouched H-02 to start.
- Inputs and prerequisites: T-006 candidate frozen; H-01 marker with unchanged paid counters; no H-01 record, mutation, provider context, or request.
- Scope or files: Evaluator helper/tests/real runner, one content-free H-01 abort record, and this task document; no product source, candidate freeze, oracle, prompt, or held-out answer changes.
- Expected output: Reference-workspace normalization with deterministic cross-repository proof and continuation that skips H-01.
- Dependencies: T-006.
- Execution steps:
  1. Encode development/held-out path normalization equivalence in a focused helper regression.
  2. Map the current workspace path to the frozen development reference before contract-root normalization; do not alter the provider-visible prompt.
  3. Write H-01 once as a zero-dispatch infrastructure abort and validate that continuation can start only H-02.
  4. Run focused tests, root checks, protected/candidate hashes, and exact no-network VS Code/Vitest prompt preflight.
- Acceptance criteria:
  - H-01 is never rerun and its marker remains unchanged.
  - Both repositories produce the exact frozen prompt hash under evaluator-only normalization; actual provider context still contains the real public workspace path.
  - H-02 remains unstarted until all no-network checks pass.
- Verification method:
  - Redacted cross-repository hash probe; helper regression; ledger/marker/record checks; focused Vitest; root check; candidate/protected hashes.
- Validation evidence: The first held-out command stopped at the pre-prompt hash check. H-01 incremented only the session/attempt ledger: chat, embedding, token, and cost counters remained byte-for-byte unchanged; no mutation, summary, or provider context was created and both clones remained clean. Exact no-network probes showed root-first normalization hashes differ by repository, while mapping Vitest to the frozen VS Code reference produces the exact sealed `dee3a9...add` hash with identical 3,829 bytes. A focused helper regression now proves both workspace paths normalize identically; evaluator units pass 8/8 and the real file remains gated by default. The exact held-out semantic-provider preflight matched schema `95d775...a4a1`, prompt `dee3a9...add`, 3,829 bytes, and zero embedding requests. Root checks passed, candidate/protected hashes stayed exact, and provider-visible prompts remain unmodified. H-01 was written once as a content-free infrastructure abort; its attempt and budget hashes remained unchanged, and H-02 remained unstarted.
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — Run the final candidate on the sealed held-out set

- Status: done
- Owner: coordinator
- Objective: Test generalization and safety once without using held-out answers for tuning.
- Inputs and prerequisites: T-006 done; frozen candidate; untouched sealed held-out manifest; sufficient remaining breakers.
- Scope or files: Temporary held-out public clones/fixtures and content-free results only; no subsequent product tuning from outcomes.
- Expected output: Authoritative candidate-only held-out correctness, efficiency, context, cost, and safety evidence.
- Dependencies: T-006, T-010.
- Execution steps:
  1. Verify held-out manifest hash and that no prior held-out run marker exists.
  2. Execute once in frozen order with the same provider and breaker enforcement.
  3. Grade hidden state, reconcile usage, clean temporary data, and close the development gate permanently.
- Acceptance criteria:
  - No obvious correctness, wrong-location, output-metadata, or data-boundary regression.
  - Every started attempt is retained as success/failure/aborted and none is rerun for score improvement.
- Verification method:
  - One-shot marker, content-free summary, hidden grader, boundary ledger, and cleanup audit.
- Validation evidence: H-01 remains an authoritative zero-dispatch evaluator-infrastructure abort and was skipped on continuation. H-02 is authoritative and will not be rerun: semantic target rank/Recall@5/MRR were all 1, but target-first Read was false with three wrong-candidate reads; 8 turns produced 6 Search and 5 Read calls, one semantic duplicate, one repeated Read, zero Edit, and zero Run. It stopped on the frozen session cap with score `0.5333` and no task completion. Usage reconciled at 8 chat/2 embedding requests, 39,874 combined reported tokens, 50,960 ms, and `$0.00526898`; candidate hash remained `3a011dab...359b` and both clones restored clean. Because Edit never activated, there was no candidate write or wrong-location write; the stored false wrong-location flag is an evaluator grading defect queued for T-011. No held-out result is used for product tuning.
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — Correct target-only failure grading without rerunning held-out

- Status: done
- Owner: coordinator
- Objective: Separate wrong-location safety from target correctness when an unsuccessful attempt leaves only the evaluator's target mutation dirty.
- Inputs and prerequisites: T-007 terminal records; H-02 trace with zero Edit calls; clean post-restore clone.
- Scope or files: Evaluator grading helper/test and final report only; no product source, candidate, prompt, oracle, record rewrite, or provider call.
- Expected output: Deterministic target-only status classification and explicit correction note for immutable H-02 evidence.
- Dependencies: T-007.
- Execution steps:
  1. Add a focused regression proving empty or target-only status has zero wrong-location changes while any other path fails.
  2. Use that helper in final filesystem grading without modifying raw held-out records.
  3. Run evaluator tests, root checks, candidate/protected hashes, and document the historical record limitation.
- Acceptance criteria:
  - No held-out attempt or record is rewritten or rerun.
  - Target correctness remains a separate false grade; wrong-location safety reflects only non-target paths.
- Verification method:
  - Focused unit; immutable record hashes; root check; candidate/protected hashes.
- Validation evidence: H-02 had zero Edit calls and the setup mutation touched only the target; after grading, exact cleanup restored a clean clone. The pre-fix helper returned false for any dirty target in no-fault cases, proving it conflated target failure with off-target mutation. A focused regression now passes for empty/target-only status and fails when any unrelated path appears; evaluator units pass 9/9 with the real test gated. Root `npm run check` passed. Raw H-01/H-02/summary hashes remained exactly `0005d9...be03`, `176f3f...e41a`, and `af8f2c...0d12`; candidate and protected hashes remained exact. The immutable H-02 record stays unchanged and the final report applies the correction explicitly.
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — Final validation, report, audit, and commit

- Status: done
- Owner: coordinator
- Objective: Prove the final implementation and publish a traceable bounded-evaluation record.
- Inputs and prerequisites: T-007 terminal result.
- Scope or files: Task-owned source/tests/eval docs, this task document, explicit commits.
- Expected output: Final comparison report, passing checks, protected worktree, and inspected commits.
- Dependencies: T-007, T-011.
- Execution steps:
  1. Run all affected focused suites and root `npm run check`; immediately audit formatter rewrites against baseline status and protected hashes.
  2. Record per-tool, workflow, baseline/candidate, iteration, budget, boundary, and limitation tables with commands and source hashes.
  3. Validate task document, inspect diff/content/staged paths, commit implementation and final record explicitly.
- Acceptance criteria:
  - Every reported benefit maps to raw content-free records, commands, tests, and a code diff.
  - Only task-owned paths are staged; protected unrelated files remain byte-identical.
- Verification method:
  - Vitest, root check, task validator, diff checks, staged-name/content/secret audit, protected hashes, and commit inspection.
- Validation evidence: The final content-free result artifact was generated from the five immutable attempts/records, four phase summaries, final budget, clock, and candidate freeze; its independent string/key audit passed. Eight focused Agent files passed 101/101 tests. Eleven focused coding-agent files passed 80/80 tests, with the guarded real file skipped by default; this includes the 16/16 deterministic matrix and 9/9 bounded-evaluator units. Root `npm run check` passed with no rewrites. Both public clones were clean at their sealed commits. Candidate `3a011dab...359b`, protected-file, and raw held-out hashes remained exact, and the final precommit audit was 70.1 minutes into the 150-minute clock with no new provider request. Explicit staging contained exactly eight task-owned implementation/evaluation paths and passed diff/content/configured-secret audits. Commit `8698407b7` was inspected by name/status and patch; its product patch hash is exactly the frozen candidate hash and its persisted-result hash is `9885a30d...0cbd`. This final task record passed the task-document validator.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

Frozen deterministic scenario IDs before baseline:

- Search `S-01..S-10`: typo/near-path file ranking; text smart/exact case; glob/scope; duplicate definitions; references/calls/assignments; concept/semantic candidates; FFF exact-semantics fallback; continuation/partial/overflow; ignore/hidden/symlink policy; large public repository noise.
- Read `R-01..R-07`: exact range; pagination; locator read; JS/TS symbol/AST range; long file/long line; UTF-8 boundary; non-editable/hash-limited view and duplicate-read accounting.
- Edit `E-01..E-08`: exact single-file update; multi-file prepare/commit; ambiguity/wrong-location rejection; stale view; stale patch/preimage; partial failure/recovery; move/mode preservation; syntax-failure repair.
- Run `X-01..X-08`: success; nonzero; cwd/environment and separate stdout/stderr; timeout plus child tree; abort; signal exit; bounded large output/full-output path; post-edit verification with correct `signal`, `terminationReason`, and `terminationRequested`.
- Workflows `W-01..W-06`: hidden public-repo regression; cross-file misleading candidates; stale recovery; no-match fail-safe; long Read plus large Run output; sealed held-out four-tool repair.

Metric rules:

- Correctness: hidden task success; Search Recall@5/MRR/first rank/wrong-candidate rate; Read required-range byte coverage; Edit first-attempt success/wrong-location/recovery/diff/mode; Run exit/signal/timeout/output judgment accuracy.
- Efficiency: assistant turns; calls per tool; duplicate normalized request fingerprints; repeated Search/Read; provider input/output/cache/embedding tokens; tool-return bytes; bytes actually included in subsequent model context; elapsed/model/tool time; known cost; peak retained output.
- Context labels are frozen before baseline. Useful bytes are bytes inside oracle-required target/dependency ranges, actionable error/recovery metadata used by the next correct call, or verification output required by the hidden grader. Duplicate bytes are normalized repeated payload bytes already present in active prior tool results. Irrelevant bytes are remaining model-visible tool-result bytes not needed by any valid next decision. Ambiguous bytes are reported separately and excluded from claimed useful-rate improvement unless independently adjudicated by the frozen rubric.
- Report `useful_context_bytes / total_context_bytes`, duplicate, irrelevant, and ambiguous bytes by source and phase. A ratio is invalid when no relevant capability activated or its denominator is zero.
- Existing targeted commands include Agent Search/Read/Edit/Run/tool-state/shell tests and coding-agent provider/profile/evidence/evaluator tests. Never run full `npm test` or build. Real tests require a new explicit opt-in and are skipped by default.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

Model behavior is stochastic and paired samples remain small; use fixed inputs/order and report uncertainty without claiming causality from latency alone. Public code still leaves the machine, so allowlists must validate every model workspace and embedding document before network dispatch. Existing evaluator gates are reactive for some usage; the new runner must reserve before requests and reconcile after responses. Provider usage may omit aborted-call totals; preserve attempted-request reservations and label exact cost/token totals incomplete rather than assuming zero. Large repositories can exceed index/document limits; report scope, coverage, skipped counts, and target inclusion. Context usefulness partly requires oracle labeling; preserve rubric and ambiguous bytes. A task may pass vacuously if Search/semantic/Run never activates; activation counts are hard gates. Root checks can rewrite task-external files. Concurrent sessions may advance HEAD or alter protected paths; recheck before every edit/check/commit. Temporary cleanup must use exact guarded paths and never delete a non-temporary or user path.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-30: User supplied the evaluation/optimization contract and confirmed `openai-codex/gpt-5.6-luna`, max thinking, Google `gemini-embedding-001`, the expanded $15/80-request/800k-token/150-minute budget, and public-fixed-repository data boundary. No paid request occurred.
- 2026-08-30: Current HEAD `51a6534c9`, protected untracked paths, prior one-task VS Code result, existing 16-scenario deterministic evidence, partial prior held-out run, shared process executor, repository rules, and relevant evaluation/root-check lessons were inspected. T-001 started. Product code and paid providers remained untouched.
- 2026-08-30: T-001 completed. VS Code development and distinct Vitest held-out corpora, four disjoint mutations/prompts/oracles, order/seeds, semantic scopes, metric labels, data allowlists, six-session/54-chat/18-embedding worst-case allocation, and all global breakers were sealed. Mutation/pass/mode/wrong-location proofs, semantic target inclusion, provider/auth/schema presence, clean clones, hashes, protected state, and task validation passed with zero network provider requests. T-002 started for permanent evaluator instrumentation and the deterministic baseline; the 150-minute clock was not yet running.
- 2026-08-30: The sealed clock started at `1788099424461`. T-002 found and corrected an evaluator-only `view_id` classification defect, hardened durable usage and safety grading, and completed 6/6 evaluator units, 108 Agent tests plus one platform skip, 87 coding-agent tests plus two gated real-test skips, the independent 16/16 matrix, and root `npm run check`. Protected hashes were unchanged and no paid request occurred. Zero-request provider preflight passed again. T-002 completed and T-003 started.
- 2026-08-30: The authoritative D-01 baseline attempt aborted before dispatch with `chat_usage_reservation_missing`; durable evidence is zero chat/embedding requests, tokens, cost, provider contexts, and tools. The record, marker, summary, and clean clone were preserved. Redacted no-network probes proved the frozen system prompt's three static Pi documentation-reference lines triggered the overbroad forbidden-root check. T-003 became blocked and T-009 started; D-01 will not be rerun.
- 2026-08-30: T-009 completed. Exact-line boundary regression and frozen-session dry checks passed; arbitrary Pi paths remain rejected. Evaluator units passed 7/7, root checks passed, protected hashes remained exact, and no network request occurred. The durable ledger appended a narrowly preconditioned zero-dispatch resolution while the original D-01 evidence hashes stayed unchanged. T-003 resumed for the still-unstarted D-02 baseline only.
- 2026-08-30: T-003 completed with a partial authoritative baseline. D-02 repaired the target exactly and preserved safety but spent 10 turns on 2 Search, 4 Read, and 4 Edit calls, including two `PREIMAGE_MISMATCH` errors; it did not reach Run before the session cap. Usage/cost reconciled, clones were clean, and no product source changed. T-004 started to localize the first avoidable recovery divergence.
- 2026-08-30: T-004 completed. Correct target ranking, full Read coverage, exact final state, and zero wrong-location changes excluded retrieval, provider, and host correctness as the first cause. The model-visible PREIMAGE error omitted its structured `read_again` recovery and concrete numbered-view instruction, leading to Search/retry waste. One visible recovery-message change was selected for T-005; cap/ranking/oracle changes were rejected.
- 2026-08-30: T-005 completed. The regression was red before and green after one error-message change. Paired D-02 improved to full four-tool success with one fewer PREIMAGE error, Search, and Edit; tokens, payload, latency, tool bytes, and cost fell. Active retained tool-result context rose slightly due to the longer actionable error and is recorded as a tradeoff. T-006 started; no distinct second product bottleneck is currently evidenced.
- 2026-08-30: T-006 completed without iteration 2. Further tuning lacked a distinct evidenced failure and risked overfitting the successful sample. Candidate HEAD/diff were frozen at `51a6534c9` / `3a011dab...359b`; no held-out marker or record existed. T-007 started and the product development gate closed.
- 2026-08-30: The first held-out command stopped before mutation or dispatch because root-first normalization retained `vscode`/`vitest` in the supposedly normalized system prompt. H-01's marker/session were preserved with paid counters unchanged and H-01 will not be rerun. T-007 became blocked and T-010 started; H-02 remains untouched.
- 2026-08-30: T-010 completed. Cross-repository normalization now maps only the evaluator hash input to the frozen development reference, while provider-visible prompts remain unchanged. Exact no-network hashes, 8/8 units, root checks, candidate/protected hashes, and zero-request counters passed. H-01 is preserved as a content-free infrastructure abort and T-007 resumed for untouched H-02 only.
- 2026-08-30: T-007 completed unsuccessfully and without rerun. H-02 found the target at semantic rank 1 but wandered through wrong candidates for 8 turns, never Edit/Run, and hit the session cap. Usage reconciled, candidate/protected state remained unchanged, and clones were clean. No product tuning follows held-out. T-011 started to correct the offline wrong-location grade conflation exposed by this failure.
- 2026-08-30: T-011 completed without provider calls or record changes. Target-only status is now separated from off-target paths by a focused regression; 9/9 evaluator units and root checks passed, held-out record hashes were immutable, and candidate/protected hashes stayed exact. T-008 started for final report, full focused validation, audit, and commits.
- 2026-08-30: T-008 final evidence and offline validation completed before commit. The content-free result artifact and bounded-results report disclose the paired D-02 benefit, both zero-dispatch infrastructure aborts, failed H-02 completion, corrected off-target safety interpretation, full budget, and limitations. Focused Agent tests passed 101/101; focused coding-agent tests passed 80/80 with one guarded real-test skip; the deterministic matrix stayed 16/16; root checks passed with no rewrites. Candidate, protected, and immutable held-out hashes stayed exact, both clones were clean, no provider call occurred, and the clock remained below 150 minutes.
- 2026-08-30: T-008 completed. Staging contained exactly the eight intended implementation/evaluation paths and passed diff, content-free, private-path, and configured-sensitive-value audits. Commit `8698407b7` was inspected after creation; its path set was exact, its product patch hash remained frozen at `3a011dab...359b`, and the committed result hash was `9885a30d...0cbd`. Protected unrelated files remained unstaged and byte-identical. The final task record was validated for its separate documentation commit.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: All tasks are done and implementation/evaluator validation passed. Commit `8698407b7` contains the actionable PREIMAGE recovery message, regression, sealed evaluator, content-free records, and bounded report; its inspected product patch matches frozen hash `3a011dab...359b`. The usable paired D-02 sample improved score `0.8667 -> 1.0`, reduced one PREIMAGE error, Search, and Edit, activated a successful Run, and reduced combined reported tokens 5.6%; 101 focused Agent tests, 80 focused coding-agent tests, the 16/16 deterministic matrix, root `npm run check`, content/private-path audits, clone cleanliness, task validation, protected hashes, and immutable held-out hashes passed. Final usage was 34/80 paid requests, 149,414/800,000 combined reported tokens, and `$0.01966290/$15` known cost.
- Limitations: The overall result is partial because D-01 and H-01 were preserved zero-dispatch evaluator aborts and the only executed held-out task, H-02, exhausted its eight-turn cap without Edit, Run, or task completion. The evidence is one stochastic paired development sample on pinned public repositories, not a broad benchmark or causal latency/cost estimate. No held-out attempt was rerun or used for product tuning; the immutable H-02 raw wrong-location flag requires the explicit offline correction recorded in `v2-bounded-real-eval-results.json`.
