# 实施与验证回执快照

实现方回执，部分可能是未完成的中间回执；最终接受状态见任务计划与 root 复查。

T-155 completed; recommend ready for root review, not acceptance. Test-contract correction only; no product behavior changed.

Files changed (under packages/coding-agent):
- test/compaction-extensions.test.ts: removed only the two obsolete custom-summary-adoption cases. The other six provider integration cases and PI_REAL_MODEL_EVAL=1 opt-in remain; T-085 narrowing/assertions preserved.
- NEW test/suite/regressions/harness-audit-compaction-extension-summary.test.ts: two parametrized AgentSession/faux cases cover ordinary legacy cut metadata and the original modified tokensBefore=999 override. Assertions prove the override was actually returned, before/after hooks run in order, exactly one compactor request occurs, the exact model-generated handoff becomes the persisted replacementHistory and live context, legacy summary/cut fields are absent, supplied text/tokens are ignored, and fromExtension=false.

Contract evidence: AgentSession.compact() and _runAutoCompaction() explicitly ignore extension compaction results; extensions.md and compaction.md document that policy. No paid-provider fixture imported by the new suite.

Red/green:
- Red command (package cwd): PI_REAL_MODEL_EVAL=0 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/regressions/harness-audit-compaction-extension-summary.test.ts
- Before correcting expectations: 2 tests failed for the intended mismatch. Actual result contained the subsystem handoff, persisted legacy summary was undefined, fromExtension was false, and tokensBefore was 7627 rather than 999. Log: /tmp/T-155-compaction-summary-red.log.
- Green command (same cwd/prefix): --run test/compaction-extensions.test.ts test/suite/regressions/harness-audit-compaction-extension-summary.test.ts test/compaction-subsystem/default-on.test.ts test/suite/regressions/5217-compaction-reason.test.ts
- Result: 13 passed, 6 skipped; 3 files passed, 1 skipped. All six real-provider tests were skipped, NOT passed. Log: /tmp/T-155-compaction-summary-green.log.
- Reviewed final diff/new file. Tracked diff --check passed; new-file no-index --check emitted no whitespace diagnostics (expected difference exit 1).

Limits: base f7606c3df763e4dcbc75261211346e67124ee628, shared dirty worktree. No product/docs/other-test changes, commits, root check/build, real API calls or dependency changes. Root final type-check remains required; runtime Vitest results are not type-check evidence.
