# 实施与验证回执快照

实现方回执，部分可能是未完成的中间回执；最终接受状态见任务计划与 root 复查。

Implemented T-081/T-082/T-083/T-087/T-088/T-089; recommend implementation-complete pending parent review/global checks, not acceptance. Base f7606c3df763e4dcbc75261211346e67124ee628. Full commands, red/green evidence, paths and documentation recommendations: /tmp/pi-session-history-remediation.md.

Per-task evidence:
- T-081: Before-first/middle-user forks each triggered one unsolicited faux request in persistent and memory modes. Copied recovery entries now carry audit-only sourceSessionId; TaskRecoveryJournal excludes them from executable state while retaining data/result receipts. Bind, persistent reopen, empty queues and explicit edited-prompt execution pass. Sources: session-manager.ts:133,1879,2055; task-recovery.ts:109-114.
- T-082: Invalid imports overwrote active/retained basename collisions and left invalid destinations. Source validation, COPYFILE_EXCL, copied-file revalidation and owned-inode cleanup now preserve original bytes/runtime. Valid/malformed collisions, missing cwd, late collision, invalidated/emptied source and successful same-file import pass. Source: agent-session-runtime.ts:407-449.
- T-083: Actual second native spawn failed with “Team storage cannot be measured safely” while first child held task lock. Registered-child task locks are now schema-validated/counted; live locks protect deletion without invalidating inventory; dead locks support deletion. Uncertain claim directories/invalid metadata/unknown files/symlinks/hardlinks remain fail-closed, and deletion retry rechecks ownership. Native concurrent admission passed 3 gated repetitions without sleeps. Observed red inventory omitted one file: 28,689 B instead of 28,749 B for live lock / 28,754 B for dead lock; green tests verify +1 file and +60/+65 B. Sources: subagent collaboration-storage.ts:371,471,618. No throughput claim.
- T-087: v1 fork lost user context and kept hookMessage; v2 kept hookMessage. Migration now occurs under original header before new header/version publication. Both reopened contexts and unchanged source bytes pass. Source: session-manager.ts:2052.
- T-088: Isolated subprocesses demonstrated runaway parent traversal/RangeError for self/pair cycles and duplicate IDs. Graphs now validate before loaded-state publication or fork writes; both walkers additionally guard cycles. Source bytes and prior manager identity remain unchanged. Sources: session-manager.ts:363,400,1303,1707.
- T-089: Actual switchSession after model change restored stale affinity/SSE. SDK now validates forwarded stored lineage against the final model. Different-provider and same-provider/different-model reopen/request checks pass; existing same-model affinity behavior passes. Source: sdk.ts:353-364. No main.ts change needed.

Baseline diagnosis: independently reproduced 5 sdk-session-manager/file-operations failures caused by /var versus /private/var fixture spelling. Session file identity intentionally canonicalizes for writer ownership; temporary fixtures now canonicalize before path construction, preserving exact assertions. A new symlink regression proves aliases use the same canonical task lock. Existing source CLI invalid-file test passes in parent-managed rebuilt environment.

Complete changed files (12):
packages/coding-agent/src/core/{agent-session-runtime,sdk,session-manager,task-recovery}.ts
packages/subagent/src/collaboration-storage.ts
packages/coding-agent/test/suite/regressions/session-history-boundaries.test.ts (new)
packages/coding-agent/test/session-manager/history-integrity.test.ts (new)
packages/coding-agent/test/pi-task-lock-storage.test.ts (new)
packages/coding-agent/test/session-cache-affinity.test.ts
packages/coding-agent/test/sdk-session-manager.test.ts
packages/coding-agent/test/session-manager/file-operations.test.ts
packages/subagent/test/collaboration-storage.test.ts

Verification actually run:
- Coding-agent named neighbor batch: 246/246 tests, 22 files; /tmp/pi-history-final-coding-agent.log.
- Final expanded subagent storage suite: 47/47; /tmp/pi-history-final-subagent.log.
- Final repeated gated native admission: 3/3; /tmp/pi-history-native-storage-repeat.log.
- Final affinity/model/hint checks: 18/18, 2 files; /tmp/pi-history-final-affinity.log.
All runs used package cwd and root Vitest CLI; coding-agent PI_OFFLINE=1. Final two coding-agent batches extend/repeat the 246 batch rather than adding unique totals. All changed tests and related neighbors ran. Scoped Biome checks and final git diff --check passed. Functional red logs: /tmp/pi-history-{runtime,integrity,affinity,storage,native-storage,import-publication}-red.log; baseline /tmp/pi-history-baseline-alias.log.

No shared docs, main.ts, agent-session.ts, pi-child-session-host.ts, dependencies/lockfiles or commits changed. Root npm check/build left to parent. No real provider calls or remote changes.

Parent doc updates: stream-recovery.md should describe inherited recovery as audit-only; session-format.md should document sourceSessionId, migration order and cycle/duplicate rejection; sdk.md should describe collision rejection and final-model binding validation; collaboration.md should describe measured task locks versus protected uncertain claims. Exact recommendations are in report.

Limits: pre-fix fork histories without provenance are not retroactively rewritten or guessed; the marker applies to newly copied histories. Explicit non-recorded SDK affinity hints retain caller verification responsibility. Power loss/crash-during-copy, hostile same-user path replacement and non-macOS execution are unverified; import does not claim a transactional snapshot of concurrently modified source history.
