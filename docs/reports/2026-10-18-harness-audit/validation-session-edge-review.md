# 实施与验证回执快照

历史回执；最终接受状态见任务计划与 root 复查。

Both final-review followups of T-080/T-084 reproduced and fixed. Source is frozen for coordinator checks. Baseline remains f7606c3df763e4dcbc75261211346e67124ee628.

T-084 post-publication cancellation:
- Red: all 8 prompt/resumeTask × session_compact/compaction_end × abort/stopAfterCurrentTurn cases made an unwanted third provider call after the checkpoint committed.
- Fix: AgentSession now rechecks logical cancellation/stop/disposal after awaited continuation decisions, immediately before agent.continue(), in both prompt and resumeTask loops. The shared predicate also gates post-run processing. Locations: src/core/agent-session.ts:2420–2423, 2561–2565, 2585–2591.
- Green: exactly two calls remain (initial response + summary), the committed checkpoint remains unchanged, the run settles, and a later explicit prompt works normally. No rollback of valid compaction history.

T-080 startup-signal lifetime:
- Red: synchronously cancelling startup from a real controller observer at either loaded or running notification retained the child but poisoned its next explicit followup: zero provider calls rather than one.
- Fix: removed the creation-only request.signal from the long-lived stream and report_progress guards. Existing creation checks and controller admission checks retain startup ownership; current interrupted/closed state and the active tool signal govern admitted turns. Early no-admitted-turn guard remains. Locations: src/extensions/pi-child-session-host.ts:319–330, 418–424.
- Green: both retained-child followups make exactly one intended provider call, persist fresh current-turn progress and deliver successfully. Existing genuine startup cancellation and active abort/reuse neighbors pass.

Files changed THIS turn (under packages/coding-agent):
1. src/core/agent-session.ts
2. src/extensions/pi-child-session-host.ts
3. test/pi-child-session-host.test.ts (two controller-observer regressions near line 393)
4. test/suite/regressions/harness-audit-post-compaction-stop.test.ts (new; eight gated regressions)
No task-recovery.ts, other-owner failure files, docs/reports/tasks, dependencies or lockfiles edited. No commits.

Verification (all package cwd, offline faux/deterministic gates):
Command stem: node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run
- Red: new post-compaction file + host file: 10 failed/28 passed. /tmp/pi-session-execution-review/red-boundaries.log
- Targeted green: those two + test/pi-collaboration-progress.test.ts: 3 files/47 passed. green-boundaries.log
- Neighbor green: 29 files/396 passed. green-neighbors.log
- Repeated boundaries: five runs, each 10 passed/28 deliberately unselected, using the two new-boundary files with -t 'T-084 stop at post-publication|a cancelled startup at'. No sleeps schedule these races. repeated-boundaries.log
- Scoped Biome passed (four files; formatted two); focused git diff --check passed; changed source boundaries reviewed.
All named logs are under /tmp/pi-session-execution-review/.

The 29-file neighbor run contains the previous 24-file set plus post-compaction-stop, pi-collaboration-progress, suite/agent-session-queue, suite/agent-session-retry-events and suite/agent-session-socket-retry-budget. Complete named set (all test/ paths ending .test.ts): pi-child-session-host; pi-child-session-lifecycle; pi-collaboration-progress; suite/regressions/harness-audit-post-compaction-stop; suite/regressions/harness-audit-host-recovery-policy; task-recovery-admission; suite/regressions/harness-audit-compaction-execution; suite/regressions/harness-audit-compaction-usage; suite/regressions/harness-audit-compaction-accounting; suite/agent-session-compaction; suite/agent-session-task-recovery; compaction-subsystem/narrative; compaction-summary-reasoning; agent-session-stats; agent-session-auto-compaction-queue; suite/agent-session-retry-compaction-history; compaction-subsystem/session-integration; compaction-diagnostics; compaction-diagnostics-session; compaction-subsystem/default-on; compaction-subsystem/auto-compaction-feasibility; footer-width; cache-stats; stats-core; stats-command; stats-server; suite/agent-session-queue; suite/agent-session-retry-events; suite/agent-session-socket-retry-budget.

Recommended status: both review findings implementation-verified, not coordinator acceptance. Root full suite/check/build and type verification were not run by this child. No real APIs/credentials or physical-provider drain tests; no performance claims. Documentation wording, if needed: cancelling after publication preserves the valid checkpoint but denies continuation; startup signals do not permanently cancel retained sessions.
