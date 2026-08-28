# Task Plan: Subagent Phase 2 writer DAG recovery and merge

- Created: 2026-08-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User confirmed the complete Phase 2 shared-understanding contract in this session.

<!-- task-doc-section:background-goal -->
## Background and goal

Phase 1 added a bounded read-only Subagent package. The confirmed Phase 2 goal is to add isolated writer tasks, durable single-controller DAG recovery, deterministic validation, and a fail-closed Merge Coordinator without modifying the user's checked-out branch. The implementation must preserve the existing read-only path and the repository's unrelated dirty files.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope:

- Extend `packages/subagent` contracts with read-only and writer DAG nodes, explicit dependencies, owned paths, retry policy, validation command IDs, and integration intent.
- Create one Git worktree and branch per writer from the frozen baseline; the model receives read/grep/find/ls/edit/write but no Bash, network, recursive delegation, commit, or merge authority.
- Validate writer diffs, canonical path ownership, symlink safety, and configured command IDs in trusted controller code; create task commits only after acceptance.
- Persist DAG dependencies, attempts, leases/checkpoints, artifacts, task commits, and integration state in SQLite; reopen and resume a run after controller restart.
- Integrate accepted commits in topological order into a separate integration worktree/ref. Conflicts fail closed and the user's branch/worktree remain unchanged.
- Expose start, resume, and inspect operations through package APIs and the Pi Extension adapter; update package documentation and tests.

Non-goals:

- Container/VM sandboxing, host network namespaces, hostile-local-process filesystem race resistance, distributed/multi-host scheduling, recursive Subagents, arbitrary model-selected shell commands, automatic conflict resolution, automatic updates to the user's branch, repository commit/publish, or paid-provider evaluation.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The user selected and confirmed complete Phase 2 rather than a partial writer-only, recovery-only, or merge-only scope. | Structured choices `phase2_scope=完整 Phase 2` and `confirm_phase2_contract=确认并继续` in this session. |
| F-002 | Phase 1 already provides read-only contracts, immutable snapshot creation, SQLite run/task/event persistence, bounded child Pi execution, orchestration, structured handoff, and Extension registration. | `packages/subagent/src/{contracts,snapshot,ledger,process-runner,orchestrator,extension}.ts`. |
| F-003 | Phase 1 tests currently pass and root integration exists locally, but the package is untracked and the repository contains extensive unrelated dirty work. | Prior task evidence and current `git status --short`; `packages/subagent/` is untracked while multiple unrelated paths are modified/untracked. |
| F-004 | Repository rules require relative `.ts` imports, erasable TypeScript, targeted tests for modified test files, and final `npm run check`; real providers are off-limits by default. | `/Users/w/Projects/easy-pi/pi/AGENTS.md` and `scripts/check-ts-relative-imports.mjs`. |
| F-005 | Child Pi can be constrained to an explicit built-in tool list and launched without sessions, extensions, skills, prompt templates, context files, or approval prompts. | Existing `packages/subagent/src/process-runner.ts` Phase 1 implementation and tests. |
| F-006 | `npm run check` writes with Biome and can touch files in a shared dirty worktree, so unrelated paths require before/after comparison. | Project `LEARNS.md` entry and the prior Phase 1 task's observed check behavior. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: Recovery means reopening the local SQLite database after one Controller process exits; it does not provide distributed leases or cross-host failover. This was explicitly accepted in the confirmed summary.
- Assumption: Integration produces a candidate ref/worktree only. Human application to the user's branch remains outside the subsystem.
- Assumption: Controller validation command IDs map to administrator-supplied argv/cwd/timeout definitions; model-authored command strings are invalid.
- Assumption: A writer task commit is produced by trusted infrastructure after diff and validation gates, not by the child agent.
- Open question: None; the requirements contract is confirmed.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Existing read-only requests remain valid and continue to pass their tests.
- Writer tasks run only in separate baseline-derived worktrees and branches, cannot claim or modify paths outside their owned path set, and cannot use symlink traversal to escape that set.
- The child writer invocation exposes only read/grep/find/ls/edit/write and no arbitrary shell, network, nested Subagent, commit, or merge tool.
- Only registered validation `commandId` values execute; a failed, timed-out, or unregistered check prevents commit acceptance.
- SQLite records DAG dependencies, attempts, lease/checkpoint state, structured artifacts, and task commit IDs. Reopening and resuming does not rerun verified successful nodes and converts stale running nodes into retryable or terminal states according to the contract.
- Merge Coordinator integrates accepted commits in deterministic topological order into a separate integration ref/worktree; conflicts fail closed and the original branch and checked-out worktree are unchanged.
- Extension/package APIs support start, inspect, and resume with structured progress and final details.
- Targeted package tests, package build, pack/import smoke check, full `npm run check`, diff review, and task-document validation pass without a real provider call.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> {T-002, T-003}; {T-001, T-002} -> T-004; {T-001, T-002, T-004} -> T-005; {T-002, T-003} -> T-009; {T-002, T-004, T-009} -> T-010; {T-003, T-005} -> T-011; {T-002, T-003, T-004, T-005, T-009, T-010, T-011} -> T-006; {T-003, T-005, T-006} -> T-007; T-007 -> T-008.
- Parallel batches: after T-001, T-002 (worktree boundary) and T-003 (ledger persistence) may run in parallel because they own separate implementation/test files. T-004 and T-005 are serialized where runner/worktree contracts overlap. All Extension and final integration work is serialized.
- Serialization constraints: the coordinator exclusively owns this authority document, shared types/contracts, `orchestrator.ts`, `extension.ts`, package metadata, and root validation. Subagents may write only explicitly assigned non-overlapping files and may not edit this document.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Freeze Phase 2 contracts and policy ceilings

- Status: done
- Owner: coordinator
- Objective: Define the smallest versioned DAG, writer, validation, artifact, recovery, and integration contracts while preserving Phase 1 read-only inputs.
- Inputs and prerequisites: Confirmed requirements contract; Phase 1 types/contracts/handoff behavior.
- Scope or files: `packages/subagent/src/types.ts`, `packages/subagent/src/contracts.ts`, `packages/subagent/src/handoff.ts`, focused contract tests.
- Expected output: Validated start/resume/inspect request shapes, DAG invariants, role ceilings, path ownership declarations, retry/lease policy, and versioned artifacts.
- Dependencies: None.
- Execution steps:
  1. Read existing package source/tests in full and identify compatibility invariants.
  2. Add Phase 2 types and strict validation without accepting free-form commands.
  3. Add tests for cycles, dependencies, writer requirements, role/tool ceilings, and backward-compatible read-only requests.
- Acceptance criteria:
  - Invalid DAGs, duplicate IDs, writer-without-owned-paths, unregistered command IDs, and privilege escalation requests fail before execution.
  - Existing Phase 1 request compilation remains supported.
- Verification method:
  - Run focused contract/handoff tests and package TypeScript validation.
- Validation evidence: Added versioned DAG/writer contracts, policy command ceilings, ownership/cycle/retry validation, contract hashes, and writer handoff parsing. `test/contracts-handoff.test.ts` passed 11 tests and package TypeScript validation passed on 2026-08-23.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Implement isolated writer worktrees and path ownership

- Status: done
- Owner: worktree-worker
- Objective: Create and clean per-task Git worktrees/branches from a frozen commit while enforcing owned-path and symlink-safe diff boundaries.
- Inputs and prerequisites: T-001 contracts; temporary Git repository fixtures.
- Scope or files: New workspace/worktree module and focused tests; no ledger/orchestrator/Extension edits.
- Expected output: Trusted worktree manager that creates task workspaces, audits changed paths, and cleans refs/worktrees idempotently.
- Dependencies: T-001.
- Execution steps:
  1. Implement argv-only Git process calls with bounded output and cancellation.
  2. Create detached task refs/worktrees from the baseline and expose structured handles.
  3. Audit status/diff paths against normalized ownership and reject symlink escapes or repository metadata paths.
  4. Test isolation, cleanup retry, dirty baseline behavior, and path violations.
- Acceptance criteria:
  - Concurrent writers never share a writable directory or branch.
  - User branch/worktree is byte-for-byte and ref-for-ref unchanged by task workspace lifecycle.
- Verification method:
  - Run focused worktree tests in temporary Git repositories.
- Validation evidence: Worker implementation was parent-reviewed and adversarially reviewed. Verified findings drove ignored-file, pre-existing-symlink, content-digest, Git environment/hooks/filter, cancellation reconciliation, temporary-directory, and submodule hardening. `test/worktree.test.ts` passed 15 tests and package TypeScript validation passed on 2026-08-23.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Extend SQLite ledger for durable DAG recovery

- Status: done
- Owner: ledger-worker
- Objective: Persist DAG topology, attempts, leases/checkpoints, artifacts, commits, validation results, and integration state with transactional recovery semantics.
- Inputs and prerequisites: T-001 state contracts and existing CAS ledger transitions.
- Scope or files: `packages/subagent/src/ledger.ts` plus focused recovery/migration tests; no workspace/orchestrator edits.
- Expected output: Backward-compatible schema migration and APIs for runnable-node claims, heartbeats, checkpoints, stale-attempt recovery, and run inspection.
- Dependencies: T-001.
- Execution steps:
  1. Add versioned schema migration and normalized DAG/attempt/artifact records.
  2. Implement transactional claim/CAS/heartbeat/checkpoint/terminal updates.
  3. Implement reopen recovery that preserves succeeded nodes and handles stale running attempts deterministically.
  4. Test close/reopen, stale lease, retry exhaustion, idempotency, and migration.
- Acceptance criteria:
  - A reopened ledger yields the same accepted artifacts and only eligible unfinished nodes become runnable.
  - Concurrent/stale owners cannot both finalize one attempt.
- Verification method:
  - Run focused SQLite ledger recovery tests.
- Validation evidence: Worker implementation was parent-reviewed and adversarially reviewed. Verified findings drove explicit-failure retry, terminal-run fencing, parent-run CAS predicates, busy timeout, two-connection claims, legacy-schema migration, and lost-ack replay coverage. DAG and Phase 1 ledger tests passed 17 tests and package TypeScript validation passed on 2026-08-23.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Add trusted validation and writer child execution

- Status: done
- Owner: coordinator
- Objective: Run writer children with bounded edit/write tools, validate their structured handoff and diff, execute only registered checks, and create accepted task commits through trusted infrastructure.
- Inputs and prerequisites: T-001 contracts and T-002 worktree handles.
- Scope or files: `packages/subagent/src/process-runner.ts`, new quality/validation module, writer fixtures and tests.
- Expected output: Writer runner and validation registry with timeout/cancel/output budgets and fail-closed task commit production.
- Dependencies: T-001, T-002.
- Execution steps:
  1. Generalize child tool ceiling by role while keeping writer tools fixed and shell-free.
  2. Add validation registry using administrator-defined argv arrays and bounded execution.
  3. Verify handoff evidence and worktree diff before infrastructure commit.
  4. Test invalid commands, failed checks, cancellation, dirty/out-of-scope diffs, and accepted commits.
- Acceptance criteria:
  - The model cannot supply executable strings or commit directly.
  - Any quality gate failure prevents an accepted commit and produces structured evidence.
- Verification method:
  - Run process-runner and quality tests with fake children and temporary Git repositories.
- Validation evidence: Added role-specific child tool ceilings, structured prerequisite artifacts, writer handoffs, immutable validation command registry, bounded process-group validation, exact diff/handoff gates, post-validation audit, infrastructure commit, and content-addressed task artifacts. Process-runner tests passed 18 tests, quality tests passed 7 tests, and package TypeScript validation passed on 2026-08-23.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Implement fail-closed Merge Coordinator

- Status: done
- Owner: merge-worker
- Objective: Integrate accepted writer commits in deterministic topological order into an isolated candidate ref/worktree without touching the user's branch.
- Inputs and prerequisites: T-001 contracts, T-002 worktree primitives, and T-004 accepted task commits.
- Scope or files: New merge-coordinator module and focused tests.
- Expected output: Candidate integration ref/artifact or structured conflict failure with cleanup support.
- Dependencies: T-001, T-002, T-004.
- Execution steps:
  1. Create an isolated integration worktree/ref at the frozen baseline.
  2. Apply accepted commits in stable topological order and record each result.
  3. Abort and preserve diagnostics on conflict; never auto-resolve or update the user branch.
  4. Test success, conflict, cancellation, idempotent retry, and branch invariance.
- Acceptance criteria:
  - Integration order is deterministic and all commits are traceable to accepted DAG nodes.
  - Conflicts cannot produce a successful integration artifact.
- Verification method:
  - Run focused Merge Coordinator tests in temporary Git repositories.
- Validation evidence: Added isolated candidate refs/worktrees, hardened Git execution/config ceilings, deterministic topological commit application, stale-worktree reconciliation, retry determinism, bounded conflict diagnostics, and fail-closed cleanup. Focused Merge Coordinator tests passed 5 tests and package TypeScript validation passed on 2026-08-23.
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — Pin durable Git objects and reconcile stale task worktrees

- Status: done
- Owner: coordinator
- Objective: Ensure synthetic baselines and accepted task commits remain reachable across Controller crashes and that only expired task-owned worktrees are reconciled before retry.
- Inputs and prerequisites: T-002 worktree manager and T-003 durable attempt state.
- Scope or files: `packages/subagent/src/worktree.ts` and focused worktree tests.
- Expected output: Exact private refs for baseline/task commits plus safe task-prefix worktree cleanup APIs.
- Dependencies: T-002, T-003.
- Execution steps:
  1. Add validated `refs/pi-subagent/...` baseline/task pin APIs with expected-value CAS deletion.
  2. Add exact run/task branch-prefix reconciliation that refuses the user worktree and unrelated refs.
  3. Test object reachability, idempotency, CAS conflicts, stale retry cleanup, and unrelated-ref invariance.
- Acceptance criteria:
  - A baseline or accepted task commit remains resolvable after all temporary worktrees are removed and the ledger is reopened.
  - Reconciliation removes only the requested run/task worktrees and branches and cannot touch the current user worktree.
- Verification method:
  - Run focused worktree durability/reconciliation tests and package TypeScript validation.
- Validation evidence: Added CAS-protected private baseline/task refs and exact task worktree/ref reconciliation. Expanded worktree suite passed 18 tests and package TypeScript validation passed on 2026-08-23.
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — Enforce writer paths at the tool boundary

- Status: done
- Owner: writer-boundary-worker
- Objective: Replace unrestricted built-in writer file tools with a fixed trusted Extension that enforces canonical worktree and owned-path boundaries before every operation.
- Inputs and prerequisites: T-002, T-004, and T-009 write-path findings.
- Scope or files: Trusted writer-tool Extension, process runner, worktree/quality hardening, and focused tests.
- Expected output: Explicitly loaded fixed tool overrides for read/grep/find/ls/edit/write, recursive symlink rejection, staged-tree verification, and process-tree cancellation.
- Dependencies: T-002, T-004, T-009.
- Execution steps:
  1. Load only the package-owned tool override Extension for writer children while retaining disabled discovery.
  2. Enforce lexical/canonical/no-symlink/no-`.git` checks and exact ownership for edit/write before delegating to built-in implementations.
  3. Verify final staged tree matches the audited digest; harden child/validation process groups and environments.
  4. Add path escape, inherited symlink, staging race, environment, and descendant cancellation tests.
- Acceptance criteria:
  - Absolute/traversal/symlink paths and writes outside ownership are rejected before filesystem mutation by the tool layer.
  - The committed tree cannot include a path/blob/mode not present in the final accepted audit.
- Verification method:
  - Run focused writer-tool, runner, worktree, and quality tests plus package TypeScript validation.
- Validation evidence: Added fixed explicit tool overrides, canonical ownership checks, recursive symlink rejection, private-index staged-tree verification, sanitized validation environments, POSIX process groups and Windows task-tree termination, plus durable worktree provenance markers. Four focused files passed 58 tests and package TypeScript validation passed on 2026-08-23.
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — Add durable run lease and integration failure state

- Status: done
- Owner: run-lease-worker
- Objective: Prevent split-brain resume and durably fence usage, attempts, integration, and terminal transitions to one Controller epoch.
- Inputs and prerequisites: T-003 ledger and T-005 Merge Coordinator review findings.
- Scope or files: `ledger.ts`, shared state types, ledger tests, and Merge Coordinator/ref lifecycle hardening.
- Expected output: CAS run lease/epoch with heartbeat, epoch-required mutations, durable integration attempt/failure diagnostics, and safe candidate-ref restoration.
- Dependencies: T-003, T-005.
- Execution steps:
  1. Add additive SQLite migration for run owner/epoch/lease and integration failure state.
  2. Require a valid run lease on Controller-owned task, usage, integration, and terminal mutations while preserving unleased direct test/legacy APIs only for runs with no owner.
  3. Harden Merge Coordinator preflight and restore/delete only refs changed by the current invocation.
  4. Test two-controller exclusion, lease takeover, stale-epoch rejection, terminal fences, persisted integration failure, and prior-candidate preservation.
- Acceptance criteria:
  - At most one Controller epoch can claim or mutate a running DAG at a time.
  - Failed/cancelled/stale controllers cannot overwrite usage, artifacts, integration, terminal state, or prior successful candidate refs.
- Verification method:
  - Run focused ledger and merge tests with two SQLite connections and temporary Git repositories.
- Validation evidence: Added additive run owner/epoch/lease migration, epoch-fenced mutations, terminal fencing, durable integration failures, topological integration checks, replacement-ref hardening, prior-candidate CAS restoration, candidate-ref release, and integration-worktree provenance markers. Ledger/merge tests passed within a 31-test focused batch and package TypeScript validation passed on 2026-08-23.
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Implement recoverable DAG orchestration

- Status: done
- Owner: coordinator
- Objective: Schedule dependency-ready read-only/writer nodes, persist every state transition/checkpoint, resume after Controller restart, and invoke integration only after all required gates pass.
- Inputs and prerequisites: T-002 through T-005 outputs.
- Scope or files: `packages/subagent/src/orchestrator.ts`, scheduler/recovery helpers, orchestration tests.
- Expected output: Start/resume/inspect APIs with bounded concurrency, retry/lease semantics, fail-fast cancellation, usage aggregation, and integration details.
- Dependencies: T-002, T-003, T-004, T-005, T-009, T-010, T-011.
- Execution steps:
  1. Separate durable run creation from execution/attachment.
  2. Schedule only dependency-ready nodes and pass immutable prerequisite artifacts.
  3. Persist attempts/checkpoints and reconstruct unfinished state on resume.
  4. Invoke Merge Coordinator only after terminal task acceptance and test crash/reopen scenarios.
- Acceptance criteria:
  - Succeeded nodes are not rerun after resume; stale work follows retry limits.
  - Failure/cancellation blocks downstream nodes and integration, with deterministic terminal status.
- Verification method:
  - Run focused orchestrator recovery tests with injected workers and temporary Git repositories.
- Validation evidence: Added run-lease acquisition/heartbeat/takeover, per-attempt aggregate budget allocation, transitive writer composition with pinned handoff, artifact-ready checkpoint replay, durable task/baseline pins, final integration and persistent failure recovery. Seven focused orchestration tests passed, including concurrent resume exclusion, close/reopen replay, writer-to-writer materialization, conflict-crash recovery, retries, usage, and user-branch invariance; package TypeScript validation passed on 2026-08-23.
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — Integrate Extension/API and documentation

- Status: done
- Owner: extension-worker
- Objective: Expose start, resume, and inspect operations and document the security/operational boundary.
- Inputs and prerequisites: T-003, T-005, and T-006 public APIs.
- Scope or files: `packages/subagent/src/extension.ts`, `packages/subagent/src/index.ts`, `packages/subagent/README.md`, Extension tests.
- Expected output: Backward-compatible Pi tool behavior plus explicit Phase 2 operations, progress, structured results, shutdown, and recovery instructions.
- Dependencies: T-003, T-005, T-006.
- Execution steps:
  1. Extend the tool/API schema without weakening Phase 1 read-only defaults.
  2. Render DAG/writer/integration progress and patch failed result details/usage.
  3. Document command registration, recovery, cleanup, candidate refs, and residual risks.
  4. Test start/resume/inspect and shutdown behavior.
- Acceptance criteria:
  - Existing read-only calls still work; write behavior requires explicit writer contracts and configured infrastructure.
  - Shutdown waits for owned child/check processes and leaves durable resumable state.
- Verification method:
  - Run focused Extension tests and package TypeScript validation.
- Validation evidence: Extension now supports backward-compatible Phase 1 plus DAG start/resume/inspect, nested progress/usage, structured failure patching, configured validation commands, and durable shutdown. Public exports, package description, and README were updated. Extension tests passed 4 tests and package TypeScript validation passed on 2026-08-23.
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — Run package and repository integration validation

- Status: done
- Owner: coordinator
- Objective: Validate the complete Phase 2 dependency path and ensure no unrelated dirty work was changed.
- Inputs and prerequisites: T-001 through T-007 done.
- Scope or files: Package/root metadata only if required; authority document evidence.
- Expected output: Passing targeted tests, build, pack/import smoke, full root checks, focused diff review, and a validated final task document.
- Dependencies: T-007.
- Execution steps:
  1. Run all package tests and package build.
  2. Run package pack/import smoke checks.
  3. Snapshot unrelated dirty paths, run full `npm run check`, and compare before/after.
  4. Review focused diff, validate this document, and record limits.
- Acceptance criteria:
  - All planned checks pass without real provider calls.
  - Task-owned changes are isolated and all task statuses/evidence are truthful.
- Verification method:
  - Package test/build commands, `npm run check`, pack/import smoke, `git diff --check`, status/diff review, and task-document validator.
- Validation evidence: Final package suite passed 11 files and 120 tests; package build passed; full `npm run check` passed all Biome, pinned-dependency, relative-import, shrinkwrap, install-lock, root TypeScript, and browser-smoke checks; pack dry-run reported 58 files including `dist/writer-tools-extension.js`; built index import returned Extension/DAG/writer-tool functions; `git diff --check` passed. No provider was called. An unrelated-file backup/status comparison detected concurrent changes in `packages/coding-agent/src/core/agent-session.ts` and `packages/agent/test/agent-loop.test.ts` by other sessions; final check reported no fixes and this task did not restore or claim those files.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

Use focused Vitest files after every implementation task. Git behavior tests use temporary repositories with local identity configuration and assert original branch/ref/worktree invariance. Child behavior uses the existing fake JSON protocol child and no real model. Recovery tests close and reopen SQLite rather than mocking persistence. Final validation runs the package suite, package build, npm pack dry-run, built Extension import smoke, root `npm run check`, focused diff checks, and the task-document validator.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Git worktree and ref cleanup is failure-prone; cleanup must be idempotent and diagnostics must retain enough state for manual recovery.
- A child with edit/write can mutate its isolated worktree but still runs as the host user; this is not an OS security boundary. Tool ceilings, path auditing, diff validation, and isolated refs reduce repository risk but do not replace containers for hostile code.
- SQLite recovery can duplicate side effects unless claims, attempt identities, commits, and merge steps are idempotent and transactionally recorded.
- Merge order and independently based commits can conflict. Conflicts are expected terminal integration failures, not auto-resolution opportunities.
- The shared repository is heavily dirty and may be modified by other sessions. Work is restricted to task-owned paths; final formatting requires an unrelated-file before/after comparison.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: User selected and confirmed complete Phase 2 scope and safety boundaries.
- 2026-08-23: Task authority document created in execute mode.
- 2026-08-23: T-001 moved to in_progress and assigned to coordinator.
- 2026-08-23: T-001 completed after 11 focused contract/handoff tests and package TypeScript validation passed.
- 2026-08-23: T-002 and T-003 moved to in_progress and assigned to non-overlapping worktree and ledger workers.
- 2026-08-23: Initial T-002/T-003 implementations passed targeted tests after path and fixture corrections; adversarial review found concrete worktree and recovery weaknesses.
- 2026-08-23: T-002 and T-003 hardened against the review findings; 15 worktree tests, 17 combined DAG/Phase1 ledger tests, and package TypeScript validation passed.
- 2026-08-23: T-004 moved to in_progress and assigned to coordinator.
- 2026-08-23: T-004 completed after 18 runner tests, 7 quality tests, and package TypeScript validation passed.
- 2026-08-23: T-005 moved to in_progress and assigned to merge-worker.
- 2026-08-23: T-005 completed after deterministic retry and stale-worktree fixes; 5 focused merge tests and package TypeScript validation passed.
- 2026-08-23: Recovery design exposed a required Git object reachability invariant not covered by earlier tasks; T-009 was added and moved to in_progress.
- 2026-08-23: T-009 completed after 18 expanded worktree tests and package TypeScript validation passed.
- 2026-08-23: Initial T-006 implementation passed 4 orchestration tests, but adversarial review identified tool-boundary confinement and split-brain run-lease gaps. T-010 and T-011 were added and moved to in_progress; T-006 remains in_progress pending their integration.
- 2026-08-23: T-010 completed after 58 focused writer-boundary tests; T-011 completed after focused ledger/merge validation and provenance hardening.
- 2026-08-23: T-006 completed after seven orchestration recovery tests covered run leases, checkpoint replay, dependent writer materialization, durable pins, and integration-failure crash recovery.
- 2026-08-23: T-007 moved to in_progress and assigned to extension-worker.
- 2026-08-23: T-007 completed after four Extension adapter tests and package TypeScript validation passed.
- 2026-08-23: T-008 moved to in_progress and assigned to coordinator.
- 2026-08-23: Final adversarial review found and drove managed-ref namespace enforcement, candidate-worktree conditional-config revalidation, and stale partial-ref cleanup; focused regressions passed.
- 2026-08-23: Final package suite passed 120 tests, package build and 58-file pack/import smoke passed, and full `npm run check` passed.
- 2026-08-23: T-008 completed. Concurrent unrelated repository drift was observed and left untouched.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 through T-011 are done. The final package suite passed 120/120 tests; package build, root check, pack dry-run, built import smoke, diff check, and task-document validation passed. Adversarial reviews were repeated until the reported release-blocking ref, tool-boundary, recovery, and lease findings had regression coverage. No real provider or paid API was used.
- Limitations: The subsystem is single-host and is not an OS/network sandbox. Hostile local processes can still race host filesystem or Git metadata operations. Windows process-tree termination uses `taskkill` and was covered structurally rather than executed on this macOS host. Completed durable runs retain baseline/task pins and candidate refs because no automatic GC API is included; operators must apply an explicit reviewed retention policy. Real-model behavior was not evaluated. Concurrent unrelated repository changes remained outside this task.
