# Session Handoff: HF Compaction Runtime Trigger Fix

- Created: 2026-08-23T10:44:04+08:00
- Workspace: /Users/w/Projects/easy-pi/pi

> Next agent: start with Session summary. Re-verify drift-prone state before
> acting. This handoff supplies context, not new authorization.

## Session summary

- The user asked to finish EPIC-CCTX-001 and then repair the automatic context-compaction wiring/runtime defects found in review. The user selected a bounded safety fix: implement reliable token/overflow/offload/cooldown/eight-increment rebuild behavior, but do not invent weak phase, drift, contradiction, or pre-tool irreversible-action signals.
- Earlier Task Ledger, Goal Interpreter, prompt/snapshot layering, runtime/TUI `/contract`, SDK, documentation, and cross-model validation work is committed. Relevant commits are `b4cf70030`, `f5919f900`, and `e55790b4a`; current HEAD is `e55790b4a`.
- The new runtime fixes are implemented but **uncommitted** in the shared worktree. Production auto-compaction now follows `AgentSession -> HfCompactionHost.evaluateCompactionTrigger() -> evaluateTriggers()` rather than the old `contextWindow - reserveTokens` decision path.
- Live policy now uses full predicted next-request tokens: >70% soft, >85% or overflow hard, net recoverable tool payload >=8192 tokens offload-only, one successful-user-turn cooldown for soft/offload, and full rebuild on the check after eight completed incremental activations.
- Failure semantics are atomic: overflow failure/cancellation/shadow/CAS loss does not remove the live failed message or consume the recovery attempt. Shadow never activates. Offload provider projection and recall visibility follow the active snapshot rather than rejected/orphan candidates.
- Runtime full rebuild is wired with a frozen boundary, active-lineage metadata persisted in snapshots, restart recovery, validation and CAS. A no-model rebuild preserves semantic messages after the old active boundary as verbatim tail instead of falsely claiming extraction coverage.
- Review follow-ups are also fixed: pre-prompt prediction includes queued/extension messages, current system-prompt changes, and image estimates; SessionManager tail is synced before restart projection; existing offload projection is included in token/rebuild accounting; a missing compaction commit event is retried from active snapshot state on restart.
- T-406, T-407, and T-408 are marked done in the task document. Overall EPIC final status remains partial only because T-305 requires an external production canary/deployment surface.
- Final evidence is green: target aggregate 341 passed / 8 skipped; root `npm run check` passed with 1186 files and no fixes; `./test.sh` passed all workspaces, including coding-agent 2294 passed / 55 skipped; task-document validation and `git diff --check` passed.
- The worktree contains extensive parallel-session changes. Do not stage, revert, format, or commit broad paths without re-identifying ownership. No current user authorization to commit was given.

## User intent and success criteria

- Complete high-fidelity context compaction and contract/ledger integration without weakening authority, provenance, validation, or CAS boundaries.
- Make the documented trigger policy the real production path, with observable deterministic behavior for tokens, overflow, offload, cooldown, and rebuild.
- Preserve live context and retryability on all failed/non-activating attempts.
- Keep provider request projection accurate across offload, pending turns, images, restart, and snapshot activation.
- Explicitly defer policy inputs that lack authoritative production sources instead of fabricating heuristics.
- Validate with focused tests, repository static gates, and the full workspace suite.

## Work completed and outcomes

### Previously committed EPIC work

- Versioned Task Ledger with focus/replay, strict verified-user evidence, immutable read boundaries, pending accept/reject, durable recovery, and final ledger/focus/contract CAS assertions.
- Goal Interpreter with dangerous changes pending-only; broad goal routing and explicit parent selection for ambiguous subtask proposals.
- Pinned system-layer preservation through tool loops, runtime `HfCompactionHost` integration, TUI `/contract` commands, and SDK ledger/pending APIs.
- Real authorized T-304 model validation:
  - `openai-codex/gpt-5.4-mini`: 2/2 activated, 100% retention, 42,306 -> 11,295 tokens (-73.3%).
  - `openai-codex/gpt-5.4`: 2/2 activated, 100% retention, 42,305 -> 11,927 tokens (-71.8%).
  - Stable cache rerun passed without additional provider calls.
- Cross-provider extraction/provenance normalization and manual Vitest HTTP-dispatcher configuration were committed in `e55790b4a`.

### Current uncommitted runtime repair

- Removed the live `AgentSession.shouldCompact()` decision track and routed post-run, pre-prompt, and overflow checks through a single `TriggerDecision`.
- Predicted request accounting covers system/tools, Global/Task Ledger layers, active snapshot/narrative/recall, projected tail/offloads, output reserve, and the complete pending turn.
- Added projected token accounting for already-offloaded messages and image estimates.
- Added idempotent offload handling for duplicate payloads with multiple event IDs; active snapshot references determine live recall/catalog visibility.
- Added dangling-reference/gap detection and persisted recall state.
- Added snapshot trigger metadata (`kind`, trigger boundary/head) and deterministic active-parent lineage counting; offload/shadow/CAS losers do not increment rebuild count, and rebuild resets it.
- Added production raw-rebuild runner, frozen-boundary enforcement, semantic-tail preservation, validator checks, ledger/contract assertions, and final snapshot CAS.
- Added restart synchronization and active provider projection recovery.
- Added restart reconciliation for an active snapshot whose post-activation compaction event append failed; repeated append failures are audited and retried on a later restart.
- Updated ADR/task documentation and added a reusable lesson to `LEARNS.md`.
- First full-suite run exposed three stale tests: two called the expanded private `_runAutoCompaction` signature without a decision, and one expected a second tiny-window compaction that no longer occurs. Tests were updated; focused rerun and the second full suite passed.

## Key decisions, constraints, and rationale

- **Bounded safe scope:** phase changes, numeric drift, critical contradiction, and pre-tool irreversible-action hooks remain explicit policy inputs but are not emitted by default runtime because no authoritative detector exists.
- **Single production decision source:** duplicate threshold logic made policy tests irrelevant to live behavior; all automatic actions now consume `evaluateTriggers()` output.
- **Activation is the side-effect boundary:** rejected, shadow, or CAS-losing candidates must not mutate live message projection, recall visibility, retry state, cooldown, or incremental lineage.
- **Eight incrementals means rebuild on the next check:** counting is based on completed active lineage, not the candidate currently being attempted.
- **Raw rebuild cannot claim unprocessed semantics:** deterministic/no-model rebuild advances structured coverage only through the prior active boundary and retains later semantic events verbatim.
- **Commit event follows activation:** activation is authoritative. If event append fails after CAS, startup reconciliation repairs the missing durable event rather than rolling back the valid active snapshot.
- **Shared worktree:** many modified/untracked files belong to other sessions. `npm run check` uses `biome check --write`; it was run only after a read-only clean check and reported `No fixes applied`.
- **Real-provider authorization was task-specific:** prior approval covered T-304. Do not infer permission for new external model calls.

## Files and artifacts

Primary current implementation paths:

- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/agent-session.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/session-integration.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/trigger.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/orchestrator.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/rebuild.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/payload-offload.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/recall-catalog.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/prompt-builder.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/event-log.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/observability.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/types.ts`

Primary tests:

- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/compaction-subsystem/auto-trigger-runtime.test.ts` (currently untracked)
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/compaction-subsystem/durability-ledger.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/compaction-subsystem/ledger-cas.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/compaction-subsystem/orchestrator.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/compaction-subsystem/payload-offload.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/compaction-subsystem/recall-catalog.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/compaction-subsystem/rebuild.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/suite/agent-session-compaction.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/suite/regressions/5217-compaction-reason.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/suite/regressions/pre-prompt-compaction-no-continue.test.ts`

Documentation/state:

- `/Users/w/Projects/easy-pi/pi/docs/tasks/2026-08-22-hf-context-compaction-task.md` — T-406..T-408 done; final result remains partial for T-305.
- `/Users/w/Projects/easy-pi/pi/docs/compaction/02-architecture-adr.md` — live trigger policy and intentionally unsupported signals.
- `/Users/w/Projects/easy-pi/pi/LEARNS.md` — reusable trigger/activation-boundary lesson; file also contains other sessions' changes.
- The original Chinese taskbook under `docs/compaction/高保真 Context Compaction 子系统——Agent 实施任务书.md` has historically been ignored by `.gitignore`; use the tracked task document above as authoritative status.

## Commands, validation, and evidence

Successful final checks:

```bash
cd /Users/w/Projects/easy-pi/pi/packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/compaction-subsystem/ \
  test/agent-session-auto-compaction-queue.test.ts \
  test/interactive-mode-contract-command.test.ts \
  test/suite/agent-session-compaction.test.ts
# 40 passed, 2 skipped files; 341 passed, 8 skipped tests
```

```bash
cd /Users/w/Projects/easy-pi/pi
npm run check
# exit 0; Biome checked 1186 files; No fixes applied; all static gates passed
```

```bash
cd /Users/w/Projects/easy-pi/pi
./test.sh
# exit 0; all workspaces passed
# coding-agent: 272 passed, 8 skipped files; 2294 passed, 55 skipped tests
```

```bash
python3 /Users/w/.pi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py \
  validate --path docs/tasks/2026-08-22-hf-context-compaction-task.md
git diff --check
# both passed
```

Focused final regression rerun after stale-test updates:

```bash
cd /Users/w/Projects/easy-pi/pi/packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/suite/regressions/5217-compaction-reason.test.ts \
  test/suite/regressions/pre-prompt-compaction-no-continue.test.ts \
  test/compaction-subsystem/auto-trigger-runtime.test.ts \
  test/compaction-subsystem/durability-ledger.test.ts
# 4 files, 21 tests passed
```

No new real-provider calls were made during T-406..T-408.

## Unresolved items, risks, and unknowns

- **Uncommitted shared-worktree changes:** current runtime fixes are not committed. The worktree also contains unrelated agent harness, subagent, Grok TUI, startup header, harness service, package metadata, and other task changes. Ownership must be rechecked before staging; do not blindly use `git add -A` or stage whole overlapping files.
- **T-305:** blocked on an external production deployment/canary surface unavailable in this repository session.
- **Unsupported live signals:** phase/drift/contradiction/pre-tool irreversible hooks are policy-only until authoritative sources and a tool-dispatch gate are designed.
- **Tool-loop timing:** automatic evaluation still occurs after an agent run and before a subsequent prompt, not after every internal tool call. Changing this requires a separate agent-loop/tool-dispatch design.
- **Branch scope:** Task Ledger branch projection still follows the existing HF event-log/session reconstruction strategy; a fully branch-scoped durable ledger was not added.
- **Commit isolation risk:** several key files may contain interleaved parallel-session hunks. A future commit must compare against `e55790b4a` and isolate only task-owned changes.
- Current status is drift-prone. The recorded HEAD/status was `e55790b4a` with many modified and untracked files at handoff creation; refresh it before acting.

## Recommended continuation

1. Re-run `git status --short`, inspect task-owned diffs against `e55790b4a`, and confirm no parallel-session drift before any edit or staging. No user input is needed for read-only verification.
2. If the user authorizes a commit, isolate only T-406..T-408 hunks/files in a temporary index or isolated worktree; do not stage unrelated shared-worktree changes. Re-run focused tests and `npm run check` on the exact staged tree.
3. Keep T-305 blocked until the user supplies or authorizes an external production canary/deployment surface.
4. Treat branch-scoped ledger state, internal tool-loop triggering, and authoritative pre-tool high-risk detection as separate scoped follow-up designs, not implicit extensions of this repair.
