# 实施与验证回执快照

历史回执；最终接受状态见任务计划与 root 复查。

T-080 final integration implemented and verified. Recommended status: implementation-verified, pending coordinator review/global checks; no remaining internal dependency.

Changes this turn (paths under packages/coding-agent):
- src/core/agent-session.ts: sticky recovery policy (around 380, 4023–4068); host binding/new prompt clears only live queue mirrors, without cancelling/deleting durable receipts (2146–2157, 2692–2694). New host prompt admission passes inheritQueuedInputs:false through _runAgentPrompt into the T-156 journal seam (2443, 2495, 2864). Internal investigation and default root paths retain the default true behavior.
- test/pi-child-session-host.test.ts: all three retained queue kinds, later explicit followups, startup cancellation, old undispatched and unknown-effect tools, retained historical receipts and suspended queues. Removed invalid AgentToolError executionOutcome:"unknown" option; omission retains unknown semantics, verified by the existing unknown-effects assertions.
- test/suite/regressions/harness-audit-host-recovery-policy.test.ts (new): host policy survives rebinding; restored queues do not run; default root recovery/queue behavior remains.
- test/suite/regressions/harness-audit-compaction-execution.test.ts: narrowed seeded user/assistant fixtures with satisfies AgentMessage[] so appendMessage cannot receive special summary variants.

Owned interim type issues:
- Preserved the actual cancellation read after awaited work via the existing public taskRecovery getter, avoiding TypeScript's stale narrowing; safety check was not removed.
- Fixed invalid AgentToolError option and broad message fixture noted above.
- The accounting fixture already returns null from getGitBranch; no modelsPath/undefined occurrence exists in its current source. That reported error was from an earlier file version. No redundant edit made.
- Did not run root tsc/check/build, so final type verification remains coordinator-owned.

Red/green evidence:
- Reproduced caller failure with T-156 already present: 4 failed/25 passed. Retained followUp produced 2 provider calls rather than 1; steer/nextTurn entered the new request payload; host bind retained 2 visible queued messages. Log: /tmp/pi-session-execution-final/red-host-policy.log.
- Targeted green: 4 files/71 passed, including host, policy, compaction cancellation and native recovery neighbors. Log: green-host-policy.log.
- Final combined previous 230/98 neighbor sets plus policy/T-156 dependency: 24 files/328 tests passed. Log: green-all-neighbors.log.
- Controlled boundary repetition: 5 runs × 9 selected tests passed (21 intentionally unselected each run), no sleeps used to schedule races. Log: repeated-host-boundaries.log.
- Scoped Biome over the four changed files passed; focused git diff --check passed and source diff reviewed.

All commands used package cwd packages/coding-agent and:
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run <named files>
Final named files (all .test.ts): pi-child-session-host; pi-child-session-lifecycle; suite/regressions/harness-audit-host-recovery-policy; task-recovery-admission; suite/regressions/harness-audit-compaction-execution; suite/regressions/harness-audit-compaction-usage; suite/regressions/harness-audit-compaction-accounting; suite/agent-session-compaction; suite/agent-session-task-recovery; compaction-subsystem/narrative; compaction-summary-reasoning; agent-session-stats; agent-session-auto-compaction-queue; suite/agent-session-retry-compaction-history; compaction-subsystem/session-integration; compaction-diagnostics; compaction-diagnostics-session; compaction-subsystem/default-on; compaction-subsystem/auto-compaction-feasibility; footer-width; cache-stats; stats-core; stats-command; stats-server.
Repeated selection: host + new policy file with -t 'controller cold followup|startup cancellation during binding|cold loading retains|successful delivery|host-controlled|default root'. All logs above are under /tmp/pi-session-execution-final/.

Verified semantics: cold loading/cancelled binding makes zero unadmitted provider calls; old tools are not replayed; steer/followUp/nextTurn remain historical; each new controller assignment makes exactly one intended call; later explicit followup works; unknown effects/queues remain retained; delivery still stops automatic investigation; default root startup continues its own accepted queues. T-084/T-085/T-086/T-152/T-154 prior changes were preserved and their neighbor tests rerun.

No task-recovery.ts, docs/authority reports, lockfiles/dependencies or other-owner files edited. No commits, real API/credential use, builds or performance claims. Docs recommendation: describe host recovery policy as sticky unless explicitly changed, and distinguish dropping old live queue mirrors from cancelling/deleting retained receipts. A reusable lesson for the coordinator: disabling bind-time recovery alone is insufficient—test all three restored queue kinds at new-admission boundaries, including request payloads, not just provider call counts.
