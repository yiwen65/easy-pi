# Task Plan: Task Contract Drift and Staleness Hardening

- Created: 2026-08-24
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User request to turn the preceding web-researched goal/non-goal drift recommendations into a task plan and execute it.

<!-- task-doc-section:background-goal -->
## Background and goal

The current high-fidelity compaction subsystem keeps the focused task contract outside lossy snapshots, but the live update path can still miss requirement changes, project a stale contract during the first provider call, and accept an old pending change after its base task has moved. The goal is to harden the authoritative Task Ledger path so continued user prompts update a complete typed task contract through version-checked operations before the provider context is built, while preserving raw user-event provenance and the previously confirmed approval policy.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope:

- Bind pending goal changes to the ledger/task versions and immutable operation hash on which they were proposed; reject stale or altered approvals.
- Add one atomic field-level task-contract patch operation for scope, exclusions/non-goals, acceptance criteria, partial permission/budget changes, output contract, and blockers.
- Give the Goal Interpreter the full focused task contract and make every substantive persisted user prompt eligible for interpretation rather than treating a keyword miss as authoritative `noop`.
- Refresh the provider system prompt after persisted-user interpretation and before each provider call so one request does not carry old system state plus a synthetic new user-role contract.
- Add focused unit/integration tests and update subsystem documentation for the new invariants.

Non-goals:

- Branch-scoped durable ledgers, graph-merge conflict handling, or replacing the existing session event-log projection; these remain the separately documented design in `docs/compaction/05-deferred-follow-up-designs.md`.
- A periodic independent semantic reconciliation/evaluator service, context-reset orchestration, or a wholesale compaction-policy rewrite.
- Changing the previously confirmed policy that only ambiguous operations and permission loosening require a second confirmation.
- Committing, pushing, releasing, or cleaning unrelated shared-worktree changes.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Compaction snapshots bind to Task Ledger/focus/task versions and reject a candidate if the ledger moves during compaction. | `packages/coding-agent/src/core/compaction/subsystem/orchestrator.ts:146-163,470-489`. |
| F-002 | Subsequent user messages currently skip interpretation when `GOAL_CHANGE_PATTERN` does not match. | `packages/coding-agent/src/core/agent-session.ts:320-321,606-618`. |
| F-003 | The interpreter currently receives only a one-line non-terminal task index, not the full focus contract. | `packages/coding-agent/src/core/compaction/subsystem/goal-interpreter.ts:57-59,274-286`. |
| F-004 | `TaskGoal.scope` and `TaskGoal.exclusions` are rendered in the fixed layer but have no mutation operation; output contract and blockers have the same practical gap. | `task-ledger.ts:40-78,230-275`; `prompt-builder.ts:133-160`. |
| F-005 | Pending changes retain operations and source event but no base ledger/task versions or operation hash; acceptance applies those operations to current state. | `task-ledger.ts:620-705`. |
| F-006 | The agent loop snapshots `context.systemPrompt` before emitting and awaiting the persisted user `message_end`; the current workaround appends a newer full ledger layer as a user message. | `packages/agent/src/agent.ts:388-425`; `packages/agent/src/agent-loop.ts:96-116`; `agent-session.ts:730-752`. |
| F-007 | The handoff records an observed stale runtime Task Ledger and old pending entry. | `docs/handoff/2026-08-23-230710-compaction-runtime-approval-offload-fixes.md:159-166`. |
| F-008 | External best practices favor durable structured/checkpointed state, per-action serialized approvals, and optimistic version checks rather than treating compacted context as the source of truth. | Anthropic context engineering; LangGraph persistence/interrupts; OpenAI Agents HITL; Temporal approval pattern; AWS optimistic locking; RFC 9110 §13.1.1, all linked in the preceding research response. |
| F-009 | Relevant goal-interpreter/runtime tests pass before this task. | `node .../vitest --run test/compaction-subsystem/goal-interpreter.test.ts test/compaction-subsystem/task-ledger-runtime.test.ts`: 2 files, 26 tests passed on 2026-08-23. |
| F-010 | The worktree contains many unrelated and interleaved changes, including relevant files. | `git status --short` and `git diff` inspected on 2026-08-24; no cleanup or whole-file staging is authorized. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “根据以上调研建议方案” authorizes the bounded correctness implementation above, not the separately deferred branch-ledger and evaluator epics. Impact: this run delivers the root-path P0 hardening plus typed contract patches, while recording broader architecture as non-goals.
- Assumption: Existing uncommitted approval/offload changes belong to prior work and must be preserved exactly. Verification: inspect targeted diffs before and after every edit and do not stage or commit.
- Assumption: Backward compatibility must fail closed for legacy pending entries that lack trustworthy base-version metadata; they remain visible and reject acceptance as stale rather than being silently rebased.
- Open question: None blocking. A product decision is still required before implementing periodic model-based reconciliation or branch-scoped durable ledgers, so those are explicitly excluded.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Every non-empty persisted user prompt after T1 creation reaches deterministic approval selection or the Goal Interpreter; a keyword miss cannot itself commit `noop`.
- The interpreter prompt identifies the current focus and includes its complete typed contract, including scope, exclusions, acceptance criteria, constraints, permissions, budgets, output contract, blockers, relations, version, and provenance references.
- `PATCH_TASK_CONTRACT` applies an atomic field-level update, preserves omitted permission/budget fields, rejects no-op/invalid/removal-of-missing-value patches, and increments the task/ledger version once.
- New pending changes persist their base ledger version, target task versions, and deterministic operations hash. Acceptance rejects changed, legacy-unverifiable, or stale pending state without partial mutation.
- The first provider request after a user-driven contract change uses the latest contract in `systemPrompt`; it does not require a duplicate full contract injected as a user message.
- Existing permission-loosening approval behavior remains intact and ambiguous operations remain pending.
- Focused Task Ledger, Goal Interpreter, Agent loop, prompt-builder, runtime integration, replay, and compaction tests pass; scoped static checks introduce no new diagnostics.
- This task document validates and records exact evidence and limits.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003 -> T-004 -> T-005 -> T-006`.
- Parallel batches: None. The implementation is intentionally serialized because T-002 through T-004 overlap `task-ledger.ts`/`goal-interpreter.ts`, T-004 and T-005 overlap runtime prompt wiring, and the shared worktree already contains interleaved changes.
- Serialization constraints: Only the coordinator edits the authority document and relevant shared files; no subagent writer is used because there is no boundary-clear parallel write set.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Freeze baseline and adversarial contract

- Status: done
- Owner: coordinator
- Objective: Record current behavior, dirty-file boundaries, exact target invariants, and focused baseline tests before implementation.
- Inputs and prerequisites: User authorization; repository instructions; prior handoff; web-research conclusions.
- Scope or files: Read-only inspection of relevant source/tests/history; this task document.
- Expected output: Validated execution plan and baseline evidence sufficient to make surgical changes.
- Dependencies: None.
- Execution steps:
  1. Inspect relevant source and existing diffs in full enough to preserve prior edits.
  2. Record target behavior and exclusions in this authority document.
  3. Run focused baseline tests and validate the task document.
- Acceptance criteria:
  - Baseline facts and worktree risks are recorded with evidence.
  - Task graph is acyclic and all implementation acceptance criteria are testable.
- Verification method:
  - Task document validator.
  - Focused existing Vitest files.
- Validation evidence: Baseline command `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/compaction-subsystem/goal-interpreter.test.ts test/compaction-subsystem/task-ledger-runtime.test.ts` passed 2 files / 26 tests; task-document validator passed on 2026-08-24.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Add stale-safe pending-change CAS

- Status: done
- Owner: coordinator
- Objective: Bind pending changes to immutable proposal/base versions and reject stale approval atomically.
- Inputs and prerequisites: T-001 done; existing approval policy and replay format.
- Scope or files: `task-ledger.ts`; Task Ledger and Goal Interpreter tests; replay/prompt tests if snapshots change.
- Expected output: Persisted/replayable pending metadata, deterministic hash verification, base-version checks, explicit stale errors, and no partial mutation.
- Dependencies: T-001.
- Execution steps:
  1. Extend pending-change schema with backward-compatible optional serialized fields.
  2. Record base ledger/task versions and deterministic operation hash when proposing.
  3. Verify metadata and current versions before acceptance; fail closed for unverifiable legacy entries.
  4. Add fresh, stale, tampered, replay, and atomicity tests.
- Acceptance criteria:
  - Fresh pending approval succeeds once.
  - Any intervening ledger/task change or operation-hash mismatch rejects with no mutation.
  - Persisted pending metadata survives replay.
- Verification method:
  - Focused `task-ledger`, `goal-interpreter`, and event-replay tests.
- Validation evidence: `vitest --run task-ledger.test.ts goal-interpreter.test.ts task-ledger-runtime.test.ts` passed 3 files / 51 tests on 2026-08-24; added fresh replay, stale-ledger, hash-tamper, legacy fail-closed, single-use, and atomic rollback assertions.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Add atomic field-level task-contract patching

- Status: done
- Owner: coordinator
- Objective: Make scope, exclusions/non-goals, acceptance criteria, partial permissions/budgets, output contract, and blockers mutable without whole-object loss.
- Inputs and prerequisites: T-002 done; existing immutable version/event model.
- Scope or files: `task-ledger.ts`, exports/types, prompt rendering as needed, Task Ledger tests.
- Expected output: One validated `PATCH_TASK_CONTRACT` operation with deterministic merge/removal/no-op semantics and provenance/version updates.
- Dependencies: T-002.
- Execution steps:
  1. Define the typed patch schema and clone/validation rules.
  2. Apply all patch fields atomically through one task version.
  3. Preserve omitted permission/budget fields and reject invalid duplicates/missing removals.
  4. Add operation, atomicity, and rendering tests.
- Acceptance criteria:
  - All in-scope fields can be added, removed, set, or cleared as applicable.
  - Invalid/no-op patches do not mutate task, ledger version, focus, or event log.
- Verification method:
  - Focused Task Ledger and prompt-builder tests.
- Validation evidence: `vitest --run task-ledger.test.ts prompt-builder.test.ts` passed 2 files / 34 tests on 2026-08-24; coverage verifies typed add/remove/clear, partial permission/budget preservation, single-version commit, no-op rejection, verified-user authority, and no mutation/events on invalid patches.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Make interpretation complete and keyword-independent

- Status: done
- Owner: coordinator
- Objective: Interpret every substantive persisted user message against the complete current focus contract and parse/validate field-level patches.
- Inputs and prerequisites: T-003 done; separate `goalComplete` injection preserved.
- Scope or files: `goal-interpreter.ts`, `agent-session.ts`, Goal Interpreter/runtime tests.
- Expected output: Full typed interpreter state, `PATCH_TASK_CONTRACT` parsing/validation, no authoritative regex skip, and multilingual false-negative coverage.
- Dependencies: T-003.
- Execution steps:
  1. Replace one-line focus context with a bounded full typed representation and explicit focus marker.
  2. Teach proposal parsing and semantic validation about the patch operation.
  3. Remove the keyword-based early `noop` while retaining empty-message and injection guards.
  4. Add tests for previously missed English/Chinese requirement changes and ordinary no-op messages.
- Acceptance criteria:
  - Phrases without the old regex keywords can update non-goals/scope.
  - Ordinary conversation can return model `operations: []` without ledger mutation.
  - Existing approval selection and injection guards continue to pass.
- Verification method:
  - Focused Goal Interpreter and AgentSession task-ledger runtime tests.
- Validation evidence: Separate focused runs passed `goal-interpreter.test.ts` (21), `task-ledger.test.ts` (26), and `task-ledger-runtime.test.ts` (9), totaling 56 tests on 2026-08-24. New coverage proves complete focus-state input, typed patch parsing, partial-permission approval, an old-regex Chinese false negative, and model-returned noop without mutation.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Refresh authoritative system state before provider build

- Status: done
- Owner: coordinator
- Objective: Eliminate the first-call old-system/new-user contract split by resolving the live system prompt after awaited user-message processing.
- Inputs and prerequisites: T-004 done; low-level Agent event ordering understood.
- Scope or files: `packages/agent/src/types.ts`, `agent.ts`, `agent-loop.ts`, focused Agent tests, `agent-session.ts`, runtime tests.
- Expected output: Backward-compatible live-system-prompt resolver used by active Agent runs; removal of full-ledger synthetic user projection.
- Dependencies: T-004.
- Execution steps:
  1. Add an optional request-time system-prompt resolver to `AgentLoopConfig`.
  2. Wire `Agent` to read its latest state after awaited message events.
  3. Simplify AgentSession transform injection to pending behavior only if still needed, preferring current system state.
  4. Test first call, tool-loop calls, direct low-level callers, and absence of duplicate contract user messages.
- Acceptance criteria:
  - Existing direct low-level callers retain snapshot behavior when no resolver is supplied.
  - Agent-backed requests see system-prompt mutations made by awaited message listeners before streaming.
  - Runtime first provider context contains the latest task version only in the authoritative system layer.
- Verification method:
  - Focused `packages/agent` loop/agent tests and coding-agent runtime tests.
- Validation evidence: `packages/agent` focused runs passed `agent.test.ts` (24) and `agent-loop.test.ts` (23); coding-agent run passed `task-ledger-runtime.test.ts` plus `agent-session-auto-compaction-queue.test.ts` (15), totaling 62 tests on 2026-08-24. Assertions prove listener-updated first-call system state, optional low-level fallback, tool-loop fixed state, and absence of duplicate full-contract user messages.
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Integration validation and documentation

- Status: done
- Owner: coordinator
- Objective: Validate the full dependency path, document behavior/compatibility, and leave truthful final evidence.
- Inputs and prerequisites: T-002 through T-005 done.
- Scope or files: Relevant subsystem docs/README if necessary; authority document; no unrelated cleanup.
- Expected output: Passing focused/integration/static checks, reviewed diff, updated invariants, and final task status.
- Dependencies: T-002, T-003, T-004, T-005.
- Execution steps:
  1. Run the smallest complete targeted test matrix and scoped static checks.
  2. Inspect worktree diff against the pre-task baseline for unrelated changes.
  3. Update subsystem documentation and this task's evidence/status.
  4. Validate this task document.
- Acceptance criteria:
  - All overall acceptance criteria have current evidence or are recorded as blocked/failed.
  - No unrelated file is modified by this task and no commit is created.
- Verification method:
  - Targeted Vitest suites, scoped Biome/type checks supported by the package, `git diff`, and task-document validator.
- Validation evidence: Both package builds passed. Full `packages/agent` suite passed 29 files / 470 tests with 1 skipped. Final full `packages/coding-agent` suite passed 272 files / 2320 tests with 57 skipped. Scoped Biome checks passed on all 13 changed TypeScript files, `git diff --check` returned no errors, and the tracked ADR documents the new invariants. Exact commands and limits are recorded below.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Unit: Task Ledger fresh/stale/tampered/replayed pending; patch merge/removal/no-op/atomicity; interpreter full-context parsing and proposal validation.
- Runtime integration: previously missed Chinese/English changes, first provider system prompt, explicit permission approval, no duplicate synthetic contract message, tool-loop fixed layer.
- Low-level Agent: request-time system prompt resolver updates only active Agent runs and remains optional for direct callers.
- Compaction integration: prompt builder and ledger CAS tests continue to prove snapshot references and drift rejection.
- Static: run scoped Biome/check commands only on changed files; do not run repository-wide `npm run check` because project learnings confirm it rewrites shared-worktree files.
- Final: inspect exact diff, rerun the dependency-path tests, validate this document.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- High: Relevant files already contain uncommitted prior-task changes. Mitigation: targeted edits only, repeated diff inspection, no staging/commit.
- High: Reinterpreting every user prompt adds one internal model call in production. Mitigation: preserve the dedicated `goalComplete` adapter and test noop behavior; cost optimization must not reintroduce an authoritative false-negative gate.
- Medium: Strict pending-version checks make legacy pending entries unapprovable. This is intentional fail-closed behavior; users can reject and regenerate them.
- Medium: Live system prompt resolution changes a low-level Agent seam. Mitigation: optional callback, snapshot fallback, focused low-level and coding-agent integration tests.
- Medium: New interpreter schema increases prompt size. Mitigation: bounded JSON representation of only the full focus plus compact other-task index.
- Deferred: Branch navigation can still produce session/ledger projection defects described in the design-only branch-ledger document.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-24: User authorized planning and execution based on the web-researched recommendations.
- 2026-08-24: Repository instructions, relevant project learnings, source paths, current diffs, handoff risks, and baseline focused tests inspected.
- 2026-08-24: Scope bounded to correctness-critical Task Ledger/Goal Interpreter/provider projection hardening; branch-ledger and periodic evaluator epics recorded as non-goals.
- 2026-08-24: T-001 set `in_progress`; implementation had not started.
- 2026-08-24: T-001 completed after baseline 2 files / 26 tests passed and the authority document validator passed; T-002 started.
- 2026-08-24: T-002 added proposal hash/base-version metadata with replay and fail-closed legacy handling; focused 3 files / 51 tests passed; T-003 started.
- 2026-08-24: T-003 added atomic `PATCH_TASK_CONTRACT` with typed field-level merge/removal semantics; focused 2 files / 34 tests passed; T-004 started.
- 2026-08-24: T-004 removed the authoritative keyword skip, added bounded complete focus-contract input and typed patch parsing, and passed 56 focused tests; T-005 started.
- 2026-08-24: T-005 added an optional post-message system-prompt resolver to the low-level Agent loop, removed synthetic user-role contract projection, and passed 62 focused tests; T-006 started.
- 2026-08-24: The known runtime tool-ledger defect intermittently rejected several tool dispatches as `Unknown tool call`; equivalent retried/smaller commands succeeded. No repository code was changed to mask this external runtime issue.
- 2026-08-24: An independent two-agent read-only review attempt failed before reporting (`budget_exhausted` / child event-size limit). Coordinator adversarial review found and fixed two concrete edge cases: empty optional-list patches no longer create false versions, and legacy `UPDATE_BUDGETS` now preserves omitted limits.
- 2026-08-24: Direct concurrency/retry fixtures were explicitly configured with HF compaction off because their mock stream owns only main-agent calls; the session-switch regression fixture gained the expected dedicated Goal Interpreter noop response.
- 2026-08-24: Scoped Biome checks passed on 13 changed TypeScript files; `packages/agent` and `packages/coding-agent` builds passed.
- 2026-08-24: Full `packages/agent` suite passed 29 files / 470 passed / 1 skipped. Final full `packages/coding-agent` suite passed 272 files / 2320 passed / 57 skipped.
- 2026-08-24: `git diff --check` passed for all task-owned tracked paths; T-006 completed and overall result set to passed.
- 2026-08-24: Merged two verified reusable lessons into `LEARNS.md`: direct AgentSession faux-stream isolation for expanded internal model calls, and semantic normalization for optional-list versioned patches.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence:
  - `npm --prefix packages/agent run build` — passed.
  - `npm --prefix packages/coding-agent run build` — passed.
  - `npm --prefix packages/agent test` — 29 files passed; 470 tests passed; 1 skipped.
  - `cd packages/coding-agent && npm test` — 272 files passed; 2320 tests passed; 57 skipped.
  - `npx biome check <13 changed TypeScript files>` — passed with no diagnostics.
  - `git diff --check -- <task-owned tracked paths>` — passed with no whitespace errors.
  - Task-document validator — passed after final status update.
- Limitations: No real-provider production canary was run. Running CLI processes do not hot-load the rebuilt `dist` and must restart to exercise these changes. Branch-scoped durable ledger and periodic semantic reconciliation remain out of scope by design. The shared worktree still contains unrelated pre-existing changes, and no commit was created.
