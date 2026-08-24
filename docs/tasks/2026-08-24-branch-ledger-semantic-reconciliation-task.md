# Task Plan: Branch-Scoped Ledger and Semantic Reconciliation

- Created: 2026-08-24
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User authorization following the explanation of branch-scoped durable ledgers and periodic semantic TaskContract reconciliation.

<!-- task-doc-section:background-goal -->
## Background and goal

The prior task made live TaskContract updates versioned, field-addressable, stale-safe, and visible in the first provider system prompt. Two long-session correctness gaps remain:

1. Task/tool ledger, snapshot activation, and CAS are session-scoped even though SessionManager is an append-only tree. Navigating between sibling branches can replay or persist the wrong state.
2. Structural version consistency cannot prove that the current TaskContract still expresses recent user intent. A model may return `noop`, normalize away a requirement, or leave unsupported/stale contract items.

This task will make the durable event projection, TaskLedger, ToolLedger, and activated compaction snapshot branch-visible by ancestry, then add a read-only periodic semantic reconciler that compares branch-visible user events with the current focused TaskContract, persists auditable reports, and never mutates authoritative state automatically.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope:

- Add optional branch-head metadata to durable events and a branch-scoped EventLog view whose membership is derived from SessionManager ancestry plus causal/source references.
- Keep one durable JSONL log while rebuilding TaskLedger and ToolLedger from the current branch view; never downgrade to an in-memory append target after navigation.
- Detect any branch-path change, including equal-length sibling navigation, and sync the branch view after every persisted session message relevant to tool ancestry.
- Bind snapshots/CAS to the branch head and select the latest previously activated snapshot visible from the current branch rather than using another branch's global active pointer.
- Add deterministic and optional semantic reconciliation with typed findings, branch/task/ledger/version checkpoints, hash/provenance validation, bounded event ranges, persistence in the branch event log, and no automatic state mutation.
- Run reconciliation periodically after a configurable number of substantive user turns and expose an explicit AgentSession/TUI `/contract reconcile` path.
- Add unit, restart, sibling-branch, snapshot-CAS, malformed evaluator, periodic scheduling, command, and regression coverage; update tracked architecture/runbook documentation.

Non-goals:

- Automatic branch merge or conflict resolution; users must explicitly choose/merge task changes.
- Changing SessionEntry JSON schema or assigning a permanent branch id to every entry; current branch identity is the current head and membership is ancestry-derived.
- Making the legacy session-level GlobalContract branch-local. It remains labeled non-authoritative; focused TaskLedger state is the branch-scoped authority.
- Automatically applying reconciliation suggestions, automatically accepting pending changes, or allowing evaluator output to call tools.
- Per-tool-call compaction triggering, pre-tool risk detection, context-reset orchestration, or cross-session long-term memory.
- Commit, push, release, or cleanup of unrelated shared-worktree changes.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | SessionManager stores an append-only tree with stable entry `id`/`parentId`, current `leafId`, `getBranch()`, and explicit `branch()`/`branchWithSummary()` navigation. | `packages/coding-agent/src/core/session-manager.ts:845-853,1196-1270,1355-1405`. |
| F-002 | EventEnvelope has session/seq/causal parents but no branch-head metadata; durable JSONL is one monotonic file per session. | `event-log.ts:20-52,65-104,143-206`; `types.ts:129-154`. |
| F-003 | Session-entry projections preserve entry ids and parent ids as event ids/causal parents, so the current branch ancestry is recoverable without rewriting raw history. | `event-log.ts:250-371`. |
| F-004 | Current `syncFromEntries()` only recognizes shrink, replaces durable `JsonlEventLog` with `InMemoryEventLog`, rebuilds only TaskLedger, and leaves readonly ToolLedger bound to the old log. | `session-integration.ts:126-172,488-541`; deferred design `docs/compaction/05-deferred-follow-up-designs.md:17-24`. |
| F-005 | Task and Tool ledger internal events currently omit branch metadata/causal parents; task events retain `sourceEventId` in payload, while tool transitions retain `toolCallId`. | `task-ledger.ts:228-264`; `tool-ledger.ts:63-91`. |
| F-006 | SnapshotStore has one active pointer per session. Candidates can remain unactivated, so branch selection cannot safely treat every stored version as active. | `snapshot-store.ts:20-48,72-153,200-290`. |
| F-007 | StructuredSnapshot task-ledger references do not carry branch identity and orchestrator CAS compares only ledger/focus/task versions. | `types.ts:300-317`; `orchestrator.ts:146-163,470-489,853-875`. |
| F-008 | Existing `reconcileActiveSnapshotCommit()` only repairs a missing compaction commit event; it does not compare user semantics with TaskContract state. | `session-integration.ts:596-630`. |
| F-009 | Trigger policy exposes `driftScore`/contradiction hooks, but tracked ADR says production has no weak proxy detector. | `trigger.ts:40-75`; `docs/compaction/02-architecture-adr.md:65-74`. |
| F-010 | Prior task final baseline passed Agent build/full suite (470 passed, 1 skipped), Coding Agent build/full suite (2320 passed, 57 skipped), scoped Biome, and diff checks. | `docs/tasks/2026-08-24-task-contract-drift-hardening-task.md`. |
| F-011 | Relevant files already contain interleaved uncommitted work and the running CLI intermittently rejects tool dispatch as `Unknown tool call`. | Current `git status --short`; prior handoff and preceding execution log. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: The user's unqualified “编写task plan并执行” authorizes both workstreams just described: branch-scoped durable ledger/snapshot behavior and periodic read-only semantic reconciliation, including command/UI wiring and tests.
- Assumption: Branch identity at a state boundary is the current SessionManager head entry id. It changes as the branch grows; continuity comes from ancestry visibility, not a permanent mutable branch label.
- Assumption: Global event `seq` remains session-monotonic for backward compatibility. A branch view filters events but preserves global seq; `(branchHeadId, ledgerVersion)` plus ancestry is the CAS identity.
- Assumption: Legacy untagged internal events are visible only when deterministically connected through session entry id, `entryId`, `sourceEventId`, tool-call identity, or another visible causal reference; detached events fail closed and are audited.
- Assumption: Reconciliation reports are advisory. A report may contain suggested `OperationInput[]`, but applying them requires the existing proposal/pending/user-confirmation path in a later explicitly authorized action.
- Open question: None blocking. Cross-branch contract merge and automatic reconciliation-finding application are explicitly excluded.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Durable events can carry `branchHeadId`; one durable base EventLog remains append-only and branch views never replace it with an in-memory append target.
- Event visibility is ancestry-derived and deterministic. Fork-point events are shared; sibling post-fork task/tool/compaction/reconciliation events are isolated; detached events are hidden and audited.
- `syncFromEntries()` detects equal-length sibling switches, rebinds/replays both TaskLedger and ToolLedger from the visible branch, and keeps strict verified-source validation working.
- New internal task/tool/compaction/control/reconciliation events are tagged with the current branch head and remain durable across navigation and restart.
- TaskLedger version/focus/pending and ToolLedger operations independently restore on two sibling branches after restart without cross-contamination.
- Snapshot task-ledger refs contain branch identity. Switching branches selects the latest previously activated ancestor-visible snapshot (never an unactivated candidate), and compaction CAS rejects branch-head or same-branch ledger movement without false conflicts from a sibling branch.
- A typed ReconciliationReport detects at least: missing semantic delta, unsupported contract item, contradiction, ambiguous focus, stale pending, evaluator/schema failure, and no-op/clean state. Reports bind branch head, task ref/version, ledger version, event range, evaluator policy version, and hash.
- Deterministic checks run without a model; semantic evaluation is bounded, tool-free, injection-guarded, schema-validated, separately injectable via `reconcileComplete`, and cannot mutate TaskLedger/ContractStore.
- Periodic reconciliation runs after a configurable number of substantive branch-visible user turns, persists a checkpoint/report event, avoids rechecking already covered events, and does not consume main-agent faux responses in the common test harness.
- `/contract reconcile` forces and displays the latest report; `/contract` summary exposes reconciliation status. No command auto-applies suggestions.
- Agent and Coding Agent builds pass; full package suites and scoped static/diff/document validation pass, or any unrelated pre-existing failure is isolated with evidence.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003 -> T-004 -> T-005 -> T-006 -> T-007`.
- Parallel batches: None for writes. Branch filtering, host rebinding, snapshot activation, reconciliation scheduling, and TUI all touch shared runtime types/state in a dirty worktree and must be integrated serially.
- Read-only analysis/review may be delegated with tightly bounded focus paths after the authority document is valid; no subagent may edit the task document or shared source files.
- Serialization constraints: T-004 requires stable branch-visible ledger semantics from T-003; reconciliation checkpoint identity in T-005 requires branch/snapshot identity from T-004; runtime scheduling/TUI in T-006 requires the engine from T-005.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Freeze branch/reconciliation design and baseline

- Status: done
- Owner: coordinator
- Objective: Convert repository evidence and the deferred design into exact branch membership, migration, snapshot, reconciliation, and test invariants before edits.
- Inputs and prerequisites: User authorization; prior completed drift-hardening task; repository rules/learnings; deferred branch design.
- Scope or files: Read-only source/tests/design inspection; this task document.
- Expected output: Validated authority document, explicit compatibility rules, task-owned path map, and current baseline evidence.
- Dependencies: None.
- Execution steps:
  1. Inspect event, ledger, snapshot, SessionManager, AgentSession, TUI, and test seams.
  2. Record current defects, compatibility assumptions, non-goals, task graph, and acceptance criteria.
  3. Run/record focused baseline and validate this document.
- Acceptance criteria:
  - Plan is valid, acyclic, executable, and evidence-backed.
  - Dirty-worktree boundaries and prior task dependency are explicit.
- Verification method:
  - Task-document validator and focused current tests.
- Validation evidence: Authority document validator passed. Baseline focused runs passed event-log/session-integration/snapshot-store/ledger-CAS (42 tests) and task-ledger runtime/tree/branch group (9 passed, 13 environment-skipped), totaling 51 passed / 13 skipped.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Implement durable branch event projection

- Status: done
- Owner: coordinator
- Objective: Add optional branch metadata and a deterministic branch-scoped EventLog view over one durable base log.
- Inputs and prerequisites: T-001 done; SessionManager ancestry entries.
- Scope or files: `types.ts`, `event-log.ts`, new focused branch-event tests.
- Expected output: `BranchScopedEventLog` (or equivalent) with `setBranch`, visible-event filtering, durable delegated append, global seq preservation, legacy reference inference, and orphan reporting.
- Dependencies: T-001.
- Execution steps:
  1. Extend additive event schemas/input with `branchHeadId`.
  2. Compute visible closure from entry ids, payload `entryId`/source refs, tool-call identity, branch tags, and causal parents.
  3. Delegate append/freeze/storage to the durable base while filtering read APIs.
  4. Add linear, fork inheritance, sibling isolation, legacy linkage, duplicate, restart, and orphan tests.
- Acceptance criteria:
  - One durable JSONL remains truth; views never renumber or rewrite events.
  - Visibility is deterministic and defensive copies remain intact.
- Verification method:
  - Event-log/branch projection tests and scoped static checks.
- Validation evidence: `event-log.test.ts` plus new `branch-event-log.test.ts` passed 2 files / 23 tests. Coverage proves ancestor sharing, sibling isolation, legacy source/tool linkage, orphan fail-closed/report-once, durable delegated append/reopen, global seq preservation, and defensive copies. Scoped Biome fixed/validated the three touched files.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Rebind Task/Tool ledgers on every branch-path change

- Status: done
- Owner: coordinator
- Objective: Make HfCompactionHost branch switching/restart replay TaskLedger and ToolLedger from the branch view without losing durable append behavior.
- Inputs and prerequisites: T-002 done; replayTaskLedger/replayLedger.
- Scope or files: `session-integration.ts`, `task-ledger.ts`, `tool-ledger.ts`, `agent-session.ts`, runtime/durability tests.
- Expected output: Exact-path change detection, branch-context append tagging, mutable/rebound tool ledger, strict source validation, and no shrink-to-memory path.
- Dependencies: T-002.
- Execution steps:
  1. Wrap the durable base EventLog once and track the current path/head.
  2. Reproject all missing session entries and replay both ledgers when the path changes.
  3. Bind new internal events to the active branch head; sync after non-user session messages needed for tool ancestry.
  4. Add sibling navigation, equal-length switch, tool isolation, control-event, persistence, and restart tests.
- Acceptance criteria:
  - Branch A/B task and tool state are isolated and restartable.
  - Durable log identity remains stable across branch switches.
  - Existing single-branch behavior remains unchanged.
- Verification method:
  - Focused session integration/task/tool/durability/tree-navigation tests.
- Validation evidence: Coding Agent build passed. `task-ledger-runtime`, `session-integration`, `tool-ledger`, and `branch-event-log` passed 4 files / 27 tests. New runtime coverage proves equal-length sibling task/tool isolation, root inheritance, stable durable-log identity, and branch-by-branch restart replay. Existing restart test now explicitly supplies the SessionManager branch before replay.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Make activated snapshots and compaction CAS branch-visible

- Status: done
- Owner: coordinator
- Objective: Prevent another branch's active snapshot or ledger movement from influencing the current branch while preserving auditable unactivated candidates.
- Inputs and prerequisites: T-003 done; visible event closure and branch head.
- Scope or files: `types.ts`, `snapshot-store.ts`, `validator.ts`, `orchestrator.ts`, `session-integration.ts`, snapshot/ledger-CAS/runtime tests.
- Expected output: Branch-bound snapshot refs, activation-history tracking, ancestor-visible active selection, branch-head final assertion, and durable restart semantics.
- Dependencies: T-003.
- Execution steps:
  1. Add optional branch id to snapshot ledger refs and bind candidates at freeze.
  2. Track which candidate versions actually activated; select latest activated snapshot visible on current ancestry and allow a branch with none to select active version 0.
  3. Re-select on branch sync before prompt/compaction; preserve global candidate numbering/audit.
  4. Extend validator/final CAS and add sibling false-conflict, same-branch conflict, candidate-not-active, restart, and legacy tests.
- Acceptance criteria:
  - Branch switching never projects a sibling snapshot.
  - Failed/unactivated candidates are never selected.
  - Same-branch head/ledger changes reject activation; sibling changes do not.
- Verification method:
  - Snapshot-store, ledger-CAS, orchestrator, branch runtime, and rebuild tests.
- Validation evidence: Coding Agent build passed. Snapshot-store, ledger-CAS, validator, orchestrator, task-ledger runtime, and session-integration passed 6 files / 66 tests. Added activation-history persistence, unactivated-candidate exclusion, deepest-visible-ancestor selection (not merely newest global version), branch-zero selection/restart, branch-bound snapshot refs, and branch-head CAS rejection.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Implement deterministic and semantic reconciliation engine

- Status: done
- Owner: coordinator
- Objective: Produce persisted, version-bound, read-only reports comparing branch-visible user evidence with the focused TaskContract.
- Inputs and prerequisites: T-004 done; Goal Interpreter schemas/operations; injection guard and CompleteFn.
- Scope or files: New `reconciliation.ts` plus exports/types/tests; `session-integration.ts`; event/audit types as needed.
- Expected output: Typed findings/reports/checkpoints, deterministic validators, bounded semantic prompt/schema/parser, report hashing, event persistence/replay, and no mutation path.
- Dependencies: T-004.
- Execution steps:
  1. Define report/finding/checkpoint schemas and stable ids/hash.
  2. Implement deterministic provenance, pending freshness, focus, exact-coverage, and contradiction checks.
  3. Implement optional semantic evaluator over only unreviewed branch-visible user events plus the full focused contract.
  4. Validate evaluator output/operation suggestions structurally without applying them; persist report/checkpoint as branch events.
  5. Add clean/missing/unsupported/contradiction/ambiguous/stale/malformed/injection/timeout/restart/idempotency tests.
- Acceptance criteria:
  - Reports are reproducible, bounded, branch/version bound, and read-only.
  - Malformed or hostile evaluator output becomes a finding/audit failure, never state mutation.
- Verification method:
  - Reconciliation unit and persistence tests; task ledger before/after equality assertions.
- Validation evidence: Coding Agent build passed. New reconciliation plus Goal Interpreter/TaskLedger suites passed 3 files / 53 tests. Coverage proves stable report hashing, clean deterministic state, contradictions, unsupported provenance, stale pending, advisory patch validation without mutation, malformed/injection/unknown-source fail-closed behavior, and branch-isolated durable report restore.
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Add periodic scheduling and `/contract reconcile`

- Status: done
- Owner: coordinator
- Objective: Run reconciliation at bounded periodic safe points and expose explicit inspection without consuming main-agent responses or auto-applying suggestions.
- Inputs and prerequisites: T-005 done; dedicated internal CompleteFn lessons; current `/contract` command.
- Scope or files: `session-integration.ts`, `agent-session.ts`, interactive command/UI, config/types, common test harness, runtime/TUI tests.
- Expected output: Configurable interval/enabled policy, separate `reconcileComplete`, checkpoint-based incremental scheduling, explicit force API/command, status rendering, and audit/telemetry.
- Dependencies: T-005.
- Execution steps:
  1. Add reconciliation config defaults and independently injectable evaluator.
  2. Count substantive branch-visible user events since checkpoint and run only when due or forced.
  3. Add AgentSession force/get APIs and `/contract reconcile` rendering.
  4. Make test harnesses inject deterministic empty reconciliation output; audit direct fixtures.
  5. Add periodic, no-repeat, forced, disabled, failure, queue/retry, branch-switch, and TUI tests.
- Acceptance criteria:
  - Periodic runs are bounded and incremental; clean turns do not create duplicate reports.
  - Main agent/compactor faux response queues are not consumed in unrelated tests.
  - User can inspect findings/evidence/suggestions, but no suggestion is auto-applied.
- Verification method:
  - Runtime/TUI/config/queue/retry tests and evaluator call-count assertions.
- Validation evidence: Coding Agent build passed. Initial reconciliation/runtime/TUI group passed 25 tests; expanded prompt/queue/concurrent/retry, interactive status/TUI, and reconciliation/session groups passed 10 files / 108 tests. Coverage proves interval=2 scheduling, disabled periodic + explicit force, independent evaluator calls, no TaskLedger mutation, `/contract reconcile` rendering, branch/report status, and no unrelated faux-response consumption.
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — Full validation, documentation, and lessons

- Status: done
- Owner: coordinator
- Objective: Validate branch/reconciliation behavior end to end, update tracked documentation, and record truthful final evidence without disturbing unrelated work.
- Inputs and prerequisites: T-002 through T-006 done.
- Scope or files: Tracked ADR/runbook/README as needed; tests; this authority document; `LEARNS.md` only for verified reusable detours.
- Expected output: Passing builds/full suites/scoped static checks, reviewed task-owned diff, updated design status, final task result, and explicit limitations.
- Dependencies: T-002, T-003, T-004, T-005, T-006.
- Execution steps:
  1. Run focused branch/reconciliation/adversarial matrix.
  2. Run Agent and Coding Agent builds/full suites; isolate any unrelated failures.
  3. Run scoped Biome/diff checks, inspect dirty boundaries, and update tracked docs.
  4. Record verified reusable lessons and validate this document.
- Acceptance criteria:
  - Every overall acceptance criterion has current evidence or a documented blocker.
  - No commit or unrelated cleanup occurs.
- Verification method:
  - Targeted/full Vitest, builds, scoped Biome, `git diff --check`, status/diff inspection, task-document validator.
- Validation evidence: Agent and Coding Agent builds passed. Agent full suite passed 29 files / 470 tests with 1 skipped. Final Coding Agent full suite passed 274 files / 2343 tests with 57 skipped. Scoped Biome passed on 22 changed TypeScript files; tracked `git diff --check` passed. README/ADR document branch projection, snapshot selection, reconciliation policy, and `/contract reconcile`. Two reusable verified lessons were merged into `LEARNS.md`.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Event projection: linear/fork/sibling/equal-length/detached/legacy/restart/global-seq/defensive-copy.
- Ledger: task focus/version/pending plus tool planned/started/terminal/idempotency on two branches before and after restart.
- Snapshot: activated history, branch-visible selection, no-active branch, failed candidate exclusion, ancestor inheritance, branch-head and ledger CAS.
- Reconciliation: deterministic findings, semantic clean/missing/unsupported/contradiction/ambiguous/stale, malformed schema, injection, aborted evaluator, report hash, checkpoint incrementality, branch isolation, no mutation.
- Runtime/UI: periodic interval, disabled/forced, status and `/contract reconcile`, queue/retry/internal-call isolation, first provider prompt unaffected.
- Regression: prior drift-hardening focused tests, session tree/navigation, compaction/ledger CAS, prompt/queue/concurrent/retry/extensions.
- Static/build: exact changed-file Biome checks; package builds. Do not run repository-wide `npm run check` because project learnings confirm it rewrites shared-worktree files.
- Final: full Agent and Coding Agent suites, `git diff --check`, task-document validator, and explicit no-canary/restart limitations if applicable.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- High: Branch identity based on a changing head must not be mistaken for a permanent branch label. Mitigation: membership and inheritance always use ancestry closure; head id is only a state/CAS boundary.
- High: Existing snapshots have one session-global active pointer. Mitigation: track actual activation history and re-select only activated ancestor-visible versions; never infer activation from candidate existence.
- High: Internal task/tool events were historically untagged. Mitigation: deterministic legacy linkage through source/entry/tool references; ambiguous detached events fail closed with audit.
- High: Relevant runtime files contain interleaved uncommitted work. Mitigation: serial coordinator edits, targeted replacements, repeated diff inspection, no staging/commit.
- Medium: Periodic semantic calls add cost/latency and can consume faux responses. Mitigation: interval/checkpoint bounds, dedicated `reconcileComplete`, common harness noop, direct-fixture audit, no tools.
- Medium: Evaluator false positives can create confusing reports. Mitigation: report-only behavior, evidence refs, deterministic severity, no automatic TaskLedger mutation.
- Medium: Replaying ToolLedger during an active tool transition could lose in-memory state if sync timing is wrong. Mitigation: sync at persisted message boundaries and replay only durable transitions; add in-flight tests.
- Deferred: Legacy session-level GlobalContract remains session-scoped/non-authoritative and automatic branch merge remains unsupported.
- External: The currently running CLI may intermittently reject tool dispatches as `Unknown tool call`; retry equivalent commands and record this separately rather than patching around it here.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-24: User authorized planning and execution of both branch-scoped ledger and periodic semantic reconciliation.
- 2026-08-24: Consulted current repository instructions/learnings, deferred branch design, event/ledger/snapshot/session seams, and dirty-worktree status.
- 2026-08-24: Created and validated the authority document; T-001 baseline passed 51 tests with 13 environment-skipped; T-001 completed and T-002 started.
- 2026-08-24: T-002 added additive branch-head event metadata and a durable `BranchScopedEventLog` ancestry view; 23 focused tests passed; T-003 started.
- 2026-08-24: T-003 replaced shrink-to-memory reseeding with exact-path branch replay of both TaskLedger and ToolLedger over the stable durable view; Coding Agent build and 27 focused tests passed; T-004 started.
- 2026-08-24: T-004 bound snapshots to branch heads, persisted actual activation history, selected the deepest activated ancestor-visible snapshot, and extended validator/final CAS; Coding Agent build and 66 focused tests passed; T-005 started.
- 2026-08-24: T-005 added deterministic + optional semantic read-only reconciliation, typed/hash-bound reports, evaluator hardening, and branch-event persistence/restart; Coding Agent build and 53 focused tests passed; T-006 started.
- 2026-08-24: T-006 added default periodic scheduling (8 substantive turns), independent `reconcileComplete`, force/get AgentSession APIs, `/contract reconcile`, and branch report status; Coding Agent build and 108 expanded tests passed; T-007 started.
- 2026-08-24: Bounded branch adversarial review found five concrete issues; all were fixed and regression-tested: path-id/tag precedence, branch-visible freeze seq, ToolLedger memory-before-durability, markerless/wrong-depth snapshot fallback, and stale captured ledger under A→B→A ABA.
- 2026-08-24: A separate reconciliation subagent review failed with `invalid_handoff`; coordinator review added branch/ledger/global-contract final assertions, independent provider fallback, report runtime verification, interval validation, and branch navigation resync.
- 2026-08-24: Final Agent and Coding Agent builds passed; focused adversarial branch/reconciliation group passed 57 tests; Agent full suite passed 470 with 1 skipped; Coding Agent full suite passed 2343 with 57 skipped.
- 2026-08-24: Scoped Biome passed on 22 changed TypeScript files; tracked `git diff --check` passed. Updated tracked README/ADR and merged two verified lessons into `LEARNS.md`; T-007 and the overall task completed.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence:
  - `npm --prefix packages/agent run build` — passed.
  - `npm --prefix packages/coding-agent run build` — passed after final adversarial fixes.
  - `npm --prefix packages/agent test` — 29 files passed; 470 tests passed; 1 skipped.
  - `cd packages/coding-agent && npm test` — 274 files passed; 2343 tests passed; 57 skipped.
  - Focused final branch/reconciliation/tool/snapshot/CAS group — 6 files / 57 tests passed.
  - Scoped `npx biome check` — 22 changed TypeScript files, no diagnostics.
  - Tracked `git diff --check` — passed with no whitespace errors.
  - Task-document validator — passed after final status update.
- Limitations: No real-provider production canary was run. Running CLI processes must restart to load rebuilt `dist`. Legacy snapshots without explicit branch binding intentionally fail closed to raw/session replay. The legacy GlobalContract remains session-scoped/non-authoritative; automatic branch merge and automatic reconciliation finding application remain excluded. Periodic semantic reconciliation adds one bounded internal model call per configured interval (default 8 substantive user turns). The shared worktree still contains unrelated pre-existing/concurrent changes, and no commit was created.
