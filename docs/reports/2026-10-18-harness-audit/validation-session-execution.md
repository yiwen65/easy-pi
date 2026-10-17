# 实施与验证回执快照

实现方回执，部分可能是未完成的中间回执；最终接受状态见任务计划与 root 复查。

Implemented assigned source fixes at baseline f7606c3df763e4dcbc75261211346e67124ee628, with one retained T-080 adversarial red awaiting the coordinated journal seam. No commits, dependency/lockfile changes, authority reports, or package docs edited.

Per-task result (recommendations, not acceptance):
- T-080 PARTIAL: bindExtensions now accepts recoveryPolicy:"automatic"|"host-controlled" (default automatic); child host selects host-controlled and installs its stream admission/cancellation guard before binding. Red: cold load and startup cancellation each made 1 unassigned provider call; green: 0, old undispatched write never executes, journal remains retained. Default root startup recovery still passes its existing neighbor tests. NEW confirmed remaining failure: an old queued followup is restored into a newly admitted cold child assignment, producing 2 provider calls rather than 1. Retained red test: test/pi-child-session-host.test.ts, "controller cold followup executes only its new assignment despite a retained running intent" (around 852–895); log /tmp/pi-session-execution-audit/red-cold-queue.log. Do not mark T-080 complete.
- T-084 implementation verified: AgentSession.abort() now aborts compaction before waiting for idle, and cancelled post-run work cannot continue. Deterministic overflow/threshold summary regressions were red (summary signal stayed false), now green with zero checkpoints/no continuation. Native child abort and dispose drain coverage passes. Related reproduced fallback edge: local abort followed by overflow previously made 2 summary calls; narrative now checks the signal before/after generation so no overflow fallback begins. Cancellation relies on provider cooperation; no forced physical-drain claim.
- T-085 implementation verified: session_before_compact no longer depends on a legacy cut. Four short/checkpoint-only × manual/automatic cancellation cases were red (0 hooks), now 1 hook, 0 provider calls, unchanged checkpoints. Owned legacy suite consumer guards optional preparation; shared event type/docs were handled by the other worker.
- T-086 activated accounting verified: CompleteFn, narrative and CheckpointCandidate carry full Usage. Adapter aggregates all retry attempt usage; host aggregates logical completion/overflow-fallback usage; checkpoint and CompactionResult persist it exactly once. Eight manual/automatic × single/retry/overflow/retry-then-overflow tests exercise the real summarization stream adapter, full cache/cost/reasoning/cacheWrite1h values, diagnostic attempts and reopened totals. Red: checkpoint.usage undefined; green: single 100 tokens/$1; retry 200/$2; overflow 25,190/$2; combined 25,290/$3 (synthetic reported usage, not pricing/performance evidence). Non-activated accounting remains explicit T-154, not claimed fixed; production diagnostics retain those full attempt records.
- T-152 implementation verified: successful delivery calls AgentSession.stopAfterCurrentTurn(), a run-local latch honored by agent-core and post-run investigation/continuation. Red: delivery plus an unknown sibling effect made 2 provider calls; green: 1, unresolved journal facts survive, and a later explicit independent followup resets the latch and completes normally.

Exact next seam requested for T-080:
TaskRecoveryJournal.start(prompt, systemPrompt?, promptEntryIds?, options?: { inheritQueuedInputs?: boolean }), default true. With false, prior pending prompt/steer/followUp/nextTurn receipts must remain historical/suspended rather than migrate as executable queues into the new task. Unknown effects must remain retained. AgentSession should remember host-controlled policy, clear only live restored queue mirrors (not cancel/delete durable records), pass the false option at new host-owned admission, and exclude old _pendingNextTurnMessages BEFORE prompt preflight assembles messages. Current bind-only policy is not yet sticky or connected to this option. Test all three queue kinds and preserve root defaults. I did not edit task-recovery.ts.

Changed files (all under packages/coding-agent):
1. src/core/agent-session.ts
2. src/core/compaction/subsystem/session-integration.ts
3. src/core/compaction/subsystem/types.ts
4. src/core/compaction/subsystem/narrative.ts
5. src/extensions/pi-child-session-host.ts
6. test/pi-child-session-host.test.ts
7. test/pi-child-session-lifecycle.test.ts
8. test/suite/agent-session-compaction.test.ts
9. test/suite/regressions/harness-audit-compaction-execution.test.ts (new)
10. test/suite/regressions/harness-audit-compaction-usage.test.ts (new)
11. test/compaction-summary-reasoning.test.ts
12. test/compaction-subsystem/narrative.test.ts

Verification commands/results:
All Vitest commands ran from packages/coding-agent using node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run <named files>, no real APIs.
- Initial red: execution regression + host test: 9 failed/21 passed (one initial threshold fixture timeout was corrected; final isolated compaction red had all 6 expected assertions fail). Logs red-execution.log and red-compaction-execution.log.
- Usage red: test/suite/regressions/harness-audit-compaction-usage.test.ts, 6 expected usage failures after correcting retry fixture classification; red-compaction-usage.log.
- Green neighbor run: 16 files/230 tests passed before adding the old-queue adversary. Files: pi-child-session-host, pi-child-session-lifecycle, suite/regressions/harness-audit-compaction-{execution,usage}, suite/agent-session-compaction, suite/agent-session-task-recovery, compaction-subsystem/narrative, compaction-summary-reasoning, agent-session-stats, agent-session-auto-compaction-queue, suite/agent-session-retry-compaction-history, compaction-subsystem/session-integration, compaction-diagnostics, compaction-diagnostics-session, compaction-subsystem/default-on, compaction-subsystem/auto-compaction-feasibility (all .test.ts). Log green-neighbors.log.
- Latest usage+cancellation run: 4 files/46 passed (usage regression including combined retries, narrative, child lifecycle, summary reasoning); green-usage-cancellation.log.
- Controlled cancellation regression repeated 5 runs: 6/6 each, no sleeps used to schedule the races; repeated-cancellation.log.
- Current known failure: host test -t 'controller cold followup': 1 failed/24 skipped, 2 calls vs 1. red-cold-queue.log.
- Scoped Biome check --write over the 12 owned files passed (formatted 6); focused git diff --check passed. Latest tiny queue-test change was not re-formatted afterward. Root check/build deliberately not run; no whole suite or real-provider acceptance.
All logs above are under /tmp/pi-session-execution-audit/.

Docs recommendations: document host-controlled binding as suppressing automatic recovery only, pending queue isolation after the seam lands, stopAfterCurrentTurn preserving uncertain facts rather than cancelling them, optional legacy preparation migration, full Usage requirement for injected compaction completions, and activated summary usage including retries/overflow once. Do not claim failed/aborted summaries count until T-154 integration. No LEARNS.md write (outside owned scope).
