# 实施与验证回执快照

历史回执；最终接受状态见任务计划与 root 复查。

T-156 journal seam ready; overall caller/host integration remains with execution worker/root, not accepted here.

API: TaskRecoveryJournal.start(prompt, systemPrompt?, promptEntryIds?, options?: { inheritQueuedInputs?: boolean }). Native assignments can call start(prompts, systemPrompt, ids, { inheritQueuedInputs: false }). Default/explicit true behavior is unchanged.

Changes in this follow-up only:
- packages/coding-agent/src/core/task-recovery.ts:258-295: false creates no inherited active queue. Where prior work requires suspension, all three queue kinds—including nextTurn—remain with that suspended task; otherwise prior input remains immutable journal history. Existing suspended tasks, unknown effects and confirmed results are retained without fabricated cancellation/consumption. Prior T-081 origin-marker change preserved.
- packages/coding-agent/test/task-recovery-admission.test.ts (new): 9 focused cases cover steer/followUp/nextTurn, old initial prompt, memory/persistent reopen, known/unknown tool results, existing suspended tasks, repeat-effect rejection, default behavior and atomic save failure.

Red: 4 failures / 5 passing controls before patch; old active queues contained all three kinds, or nextTurn when old work was suspended. /tmp/pi-t156-journal-red.log.
Green: 9/9 focused tests, /tmp/pi-t156-journal-green.log.
Neighbors: 79/79 across 5 files, /tmp/pi-t156-journal-neighbors.log.
Exact final command from packages/coding-agent:
PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run test/task-recovery-admission.test.ts test/suite/agent-session-task-recovery.test.ts test/suite/agent-session-queue.test.ts test/suite/regressions/session-history-boundaries.test.ts test/session-manager/history-integrity.test.ts
Scoped Biome check of both changed files and git diff --check passed.

Base remains f7606c3df763e4dcbc75261211346e67124ee628. No AgentSession/caller edits, shared docs, commits, dependency changes, real-provider calls, or root check/build. Caller must use the new option and handle its live in-memory queues; actual cold-followup end-to-end correction was not claimed or tested by this unit-seam task.
