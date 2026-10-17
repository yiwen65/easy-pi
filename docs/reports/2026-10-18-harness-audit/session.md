# 模块边界初审证据（实施前，只读）

历史初审证据；不是最终验收状态。最终状态见主报告与唯一任务计划。

T-005 — read-only audit result, not remediation completion or overall acceptance.
Root: /Users/w/Projects/easy-pi/pi. Coordinator-supplied baseline f7606c3df / my-pi; Git not independently checked. No edits, tests, builds, scripts or provider calls. Locations identify enclosing symbols. Unless prefixed otherwise, source/test paths below are relative to packages/coding-agent.

## Findings

### 1. Cold child loading can execute an old task
- Severity: High
- Axis: Correctness
- Location: `src/extensions/pi-child-session-host.ts:create()`; `src/core/agent-session.ts:bindExtensions()`.
- Problem: Host creation calls bindExtensions before installing its stream guard or returning to the controller. Binding automatically resumes a running TaskRecoveryJournal. After a crash, team recovery updates SQLite status but leaves the child's JSONL running intent intact. An explicit cold followup can therefore resume the old task during host.create(), before controller.start() runs the new assignment. Root cause: generic recovery ignores host admission ownership.
- Impact: Old inference/tools run outside the new assignment and its result/usage capture. Startup cancellation is only checked around binding. Violates session-host.ts's creation/loading-never-starts-a-turn contract.
- Recommended fix: Explicitly suppress automatic recovery in controller-owned child loading, preserving historical facts. Gate all execution on an admitted child turn. Extend `test/pi-child-session-host.test.ts`: reopen a child with a running journal and undispatched tool; require zero calls until run; recovered-controller followup must execute only the new task. Test cancellation during binding.
- Certainty: High confidence — complete host/controller/store/journal/session path inspected; existing cold-load tests cover settled/unstarted children.

### 2. Fork-before-user resumes the prompt intended for editing
- Severity: High
- Axis: Correctness
- Location: `src/core/agent-session-runtime.ts:fork()`; `session-manager.ts:createBranchedSession()`; `task-recovery.ts:start()`; `agent-session.ts:bindExtensions()`.
- Problem: Intent is persisted before its user message. Fork cuts at that user's parent and copies recovery entries verbatim, including the running intent containing the selected prompt. Binding the new runtime automatically resumes it. Root cause: copied recovery metadata is treated as executable authority for a new identity.
- Impact: Merely forking can send the old request and execute tools before submission of the edited prompt.
- Recommended fix: Make inherited recovery state/queues historical, not automatically executable, including after reopen; retain audit history. In `test/suite/agent-session-runtime.test.ts`, cover fork-before-first/middle user, persistent/in-memory, bind and reopen: zero new calls, selected input absent, work waits for explicit submission. Share finding 1's policy seam but fix durable identity too.
- Certainty: High confidence — journal order/copy/startup chain explicit. Existing event tests do not assert call counts after binding.

### 3. Import overwrites colliding history before validation
- Severity: High
- Axis: Correctness
- Location: `src/core/agent-session-runtime.ts:importFromJsonl()`.
- Problem: copyFileSync targets currentSessionDir/basename(input) without collision protection, then validates the session/cwd. A malformed external import can overwrite an unrelated retained session before being rejected. Root cause: destructive publication precedes validation and exclusive destination selection.
- Impact: History loss; an active-file collision also leaves its manager stale.
- Recommended fix: Validate first, then exclusively publish to a unique destination or reject collision unchanged. Extend `test/suite/agent-session-runtime.test.ts` with valid/malformed collisions, including the active session; assert original bytes/runtime are preserved.
- Certainty: High confidence — full import and UI confirmation tests read; confirmation names runtime replacement, not unrelated history destruction.

### 4. Native task locks break budgeted parallel admission
- Severity: Medium
- Axis: Correctness
- Location: `packages/subagent/src/collaboration-storage.ts:scan()/checkCollaborationStorageAdmission()`; `src/core/task-recovery.ts:acquire()`.
- Problem: Running tasks create <session>.jsonl.task.lock and a temporary .task.lock.claim. Scanner accepts only exact child JSONL and .logs directories, so legitimate locks become Unknown child entry/incomplete inventory. Positive maxTeamBytes/maxTotalBytes then reject another spawn/followup regardless of free bytes. Root cause: storage vocabulary omits recovery-owned files.
- Impact: Supported byte budgets block normal parallel work; crash-left locks also obstruct inspection/manual deletion.
- Recommended fix: Validate/count known lock formats, distinguish ownership protection from incomplete measurement, retain fail-closed handling of uncertain claims. Extend `test/pi-collaboration-storage.test.ts` with actual native host, generous budget, blocked running child and successful second admission; add live/dead/invalid lock cases in `packages/subagent/test/collaboration-storage.test.ts`.
- Certainty: High confidence — scanner/lock/admission paths fully read; existing budget tests use empty teams.

### 5. abort() leaves automatic compaction running
- Severity: Medium
- Axis: Correctness
- Location: `src/core/agent-session.ts:abort()/_runAutoCompaction()/_tryHfAutoCompaction()`; `src/extensions/pi-child-session-host.ts:abort()/dispose()`.
- Problem: Compaction uses an independent AbortController. session.abort cancels retry and Agent, then awaits idle without aborting compaction. Child disposal awaits that abort before reaching shutdown's compaction cancellation. Root cause: cancellation ownership does not cover the awaited summary request.
- Impact: Interrupt/shutdown waits for summarization/provider timeout even when the summary provider cooperates with cancellation.
- Recommended fix: Propagate run cancellation into automatic compaction before awaiting idle. In `test/suite/agent-session-compaction.test.ts`, block the summary on its AbortSignal, abort, and assert cancellation, settlement, no checkpoint/continuation. Add child coverage in `test/pi-child-session-lifecycle.test.ts`.
- Certainty: High confidence — independent signals/await ordering explicit; duration not measured.

### 6. Compaction skips cancellation hooks for short/checkpoint history
- Severity: Medium
- Axis: Correctness
- Location: `src/core/agent-session.ts:compact()/_runAutoCompaction()`; `src/core/compaction/compaction.ts:prepareCompaction()`.
- Problem: session_before_compact only fires when legacy preparation exists. Short nonempty history below keepRecentTokens or a checkpoint with little raw tail returns undefined; modern HfCompactionHost nevertheless calls the model and may publish. Root cause: modern cancellation is conditional on obsolete cut eligibility.
- Impact: Extensions cannot observe/cancel those compactions despite the documented boundary.
- Recommended fix: Emit the hook for every eligible modern attempt, using effective-history preparation or an optional legacy field. Add short-history/default-keepRecentTokens and checkpoint-only cancellation tests to `test/suite/agent-session-compaction.test.ts`; assert no model call/publication. Existing extension tests set keepRecentTokens=1.
- Certainty: High confidence — complete preparation and caller implementations inspected.

### 7. Modern compaction usage disappears from session totals
- Severity: Medium
- Axis: Correctness
- Location: `src/core/agent-session.ts:_publishCompactionCheckpoint()/getSessionStats()`; `src/core/compaction/subsystem/session-integration.ts:createPiAiCompleteFn()/CheckpointCandidate`.
- Problem: Full Usage is reduced to input/output; candidate carries reduced modelUsage; checkpoint publication omits its supported usage argument. Stats counts entry.usage, not diagnostic custom entries. Root cause: producer-to-accounting integration lost full usage.
- Impact: Modern summary token/cache/cost usage is absent from totals; no price/cache-benefit claim.
- Recommended fix: Preserve/account full Usage exactly once across summary/retry/overflow attempts. Extend `test/agent-session-stats.test.ts` with actual faux-stream manual/automatic compaction, known nonzero cache/cost, live/reopen totals and retries. Current test injects a legacy compaction directly.
- Certainty: Confirmed by direct producer/consumer inspection; not executed.

### 8. forkFrom stamps v3 onto unmigrated entries
- Severity: Medium
- Axis: Correctness
- Location: `src/core/session-manager.ts:forkFrom()/loadEntriesFromFile()/migrateToCurrentVersion()`.
- Problem: forkFrom reads raw entries, replaces the header with CURRENT_SESSION_VERSION, writes, then opens. Constructor skips migration under the new header. V1 IDs/parent links remain missing; V2 hookMessage conversion is skipped. Root cause: version changed before migration.
- Impact: Forking supported legacy history loses active context or retains incompatible roles.
- Recommended fix: Migrate detached entries using their original header before replacement; preserve source bytes. Extend `test/session-manager/migration.test.ts` with v1/v2 forkFrom fixtures, context and reopen assertions.
- Certainty: High confidence — entire manager/migration tests read.

### 9. Cyclic parent links hang context construction
- Severity: Medium
- Axis: Correctness
- Location: `src/core/session-manager.ts:_buildIndex()/buildSessionPath()/getBranch()`.
- Problem: Loaded graph receives no cycle validation; walkers lack a visited guard. Valid JSONL with parentId=self (or a two-node cycle) is accepted by open and loops synchronously during SDK context construction.
- Impact: Malformed imported/hand-edited history hangs instead of failing safely. No claim that ordinary writers generate cycles or remote exploitation exists.
- Recommended fix: Validate graph identity/cycles before publishing loaded state, or guard both walkers. Preserve source bytes. Add subprocess-timeout cases to `test/session-file-invalid.test.ts` and traversal tests; avoid running the known loop inline in Vitest.
- Certainty: High confidence — complete loader/traversal module contains no protective validation.

### 10. Resume bypasses model-bound cache validation
- Severity: Low
- Axis: Correctness
- Location: `src/core/agent-session-runtime.ts:switchSession()`; `session-cache-affinity.ts:recordedCacheAffinityId()/forModel()`; `sdk.ts` affinity application; `src/main.ts` factory excerpt 600–999.
- Problem: switchSession resolves a hint without a model, accepting any boundModel. CLI prefers that ID over model-filtered fallback; SDK applies it after model selection without checking binding. A clone switched to a new model drops live affinity, but reopening restores the old hint and may force Codex SSE. Root cause: binding metadata is discarded before final model resolution.
- Impact: Wrong routing metadata and transport policy; cache rate/cost/latency unmeasured.
- Recommended fix: Validate hints against the final selected model at one authoritative boundary. Extend `test/session-cache-affinity.test.ts` with runtime switchSession after model change; its similarly named existing test only checks the helper.
- Certainty: High confidence — complete runtime/cache/SDK plus factory excerpt inspected.

## Opportunities / exclusions
- Related to finding 1: `_runAgentPrompt()` starts unknown-effect investigation without checking successful child delivery. Delivery plus an uncertain effect in one batch can start another inference despite the termination contract. Add this adversarial regression while fixing recovery admission; not separately counted.
- `docs/session-format.md` describes retainedTail, while modern entries use replacementHistory. Old real-provider extension tests also assert deprecated custom summaries. Update docs/tests with fixes; neither was executed as evidence.
- Legacy DAG excluded from product defects: subagent index/package exports/files/build graph and easy-pi wiring expose native collaboration; legacy process context fails closed. Legacy implementations were not exhaustively reviewed; no removal proposed.
- No speculative performance findings.

## Coverage / limitations
Complete source modules read:
- coding-agent core: agent-session.ts (5441 lines), session-manager.ts, task-recovery.ts, agent-session-runtime.ts, agent-session-services.ts, sdk.ts, session-cache-affinity.ts;
- compaction/compaction.ts; subsystem session-integration.ts, narrative.ts, trigger.ts, types.ts, observability.ts;
- extensions easy-pi.ts, pi-collaboration-root.ts, pi-child-session-host.ts, pi-collaboration-tools.ts, pi-collaboration-context.ts, pi-collaboration-storage.ts;
- subagent collaboration-controller.ts, collaboration-store.ts, collaboration-mailbox.ts, context-fork.ts, session-host.ts, collaboration-storage.ts, collaboration-storage-guard.ts, index.ts and package/build configs.
Read AGENTS, coding-agent README and collaboration/sessions/session-format/compaction/stream-recovery docs fully. Subagent README attempt returned ENOENT.
Chains: SDK/root→controller→native create/bind/run→delivery/completion/ack; recovery→cold followup; live tool intersection; mailbox→compaction; journal→fork/reload; request→checkpoint; locks→retention/admission; runtime import/cache restore.
Tests inspected include pi-child-session-host/lifecycle, pi-collaboration-storage, subagent-storage-policy, suite runtime/task-recovery, runtime-events, manager migration/file-operations, session-file-invalid, cache-affinity/hint, compaction/extension/auto-queue and stats tests.
Boundary-focused, NOT per-file exhaustive review. collaboration-contract validator implementation, UI/monitor, detailed tool-output leases, generic agent/harness/session and sqlite backends were not audited. Main read only at factory/end excerpt. All findings need targeted offline reproduction. Installed dist, providers, physical drain, power loss and cross-platform behavior unverified. Coordinator-reported baseline path-alias failures were not independently checked or counted.

## Proposed ownership
Coordinate fixes to coding-agent core agent-session.ts, task-recovery.ts, agent-session-runtime.ts, session-manager.ts, session-cache-affinity.ts, sdk.ts; relevant compaction subsystem files; extensions/pi-child-session-host.ts; subagent/collaboration-storage.ts; named regression tests. Main callsite edits only with coordinator agreement. Docs/task plan remain coordinator-owned. No files changed.
