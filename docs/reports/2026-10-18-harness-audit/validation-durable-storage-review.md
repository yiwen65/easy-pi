# 实施与验证回执快照

历史回执；最终接受状态见任务计划与 root 复查。

Implemented and verified all three assigned followups: T-132, T-136, T-113. Recommended status: ready for root review/closure, not final acceptance. Base HEAD: f7606c3df763e4dcbc75261211346e67124ee628; existing shared-worktree changes preserved.

Changes (only four owned files):
- packages/agent/src/harness/agent-harness.ts:1370–1380: the existing uncertainty check now includes physically unsettled executions, independently of durable reconciliation persistence. Same-instance resume remains needs_reconciliation, starts no duplicate invocation, and retains close/release protection until actual settlement.
- Same file:1742–1750: finishRun rereads pause under the terminal control lock, returns paused without a terminal record, and preserves abort priority.
- packages/agent/test/harness/agent-harness-runtime-regressions.test.ts:178–206,400–454: deterministic pause-before-finish and failed-reconciliation-append regressions, each repeated three times. Also annotated the existing findRecords callback with RecordQuery at line 276, fixing root-reported TS7006.
- packages/session-backends/sqlite-node/src/sqlite/repo.ts:314–331,871–891: failed release/close promises become retryable while admission stays sealed; failed lease cleanup stays registered; all storages stop timers and attempt release; the dependent connection remains open until failed lease cleanup succeeds, then closes once.
- packages/session-backends/sqlite-node/test/storage-boundaries.test.ts:207–293: three deterministic injected release-failure runs, concurrent-close identity, permanently rejected admission, resource counts, explicit retry, and final lease inspection.

Independent red evidence (before production changes):
- Harness new tests: 6 failures / 6 selected. Pause acknowledged but returned completed. Reconciliation-append failure followed by resume produced 2 physical mutations, peak active 2, and 1 release while the first mutation remained active.
- SQLite new tests: 3 failures / 3 selected. Starting from 2 heartbeat timers, 2 leases, 1 connection, first failed close and subsequent retry left 1 timer, 2 leases, 1 connection; retry returned the cached rejection.
- Logs: /tmp/pi-durable-harness-red.log and /tmp/pi-durable-sqlite-red.log.

Green evidence:
- Harness now keeps mutation count/peak at 1, release count 0 while live, then active count 0/release count 1 after real settlement. Pause keeps one open operation and zero terminal records; resume completes with exactly one terminal record and no extra provider request.
- SQLite failed close now leaves 0 timers, only the failed lease, and its needed connection. Explicit retry leaves 0 timers/leases and closes that connection exactly once.
- Harness changed file: 34/34 passed. Final named neighbors: 109/109 across 9 files.
- SQLite changed file: 20/20 passed, rerun after formatting. Named neighbors: 111/111 across 12 files.
- Scoped Biome check (four owned files) and git diff --check passed. Incremental source diff reviewed.

Commands (each Vitest command used node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run from its package cwd):
- packages/agent: test/harness/agent-harness-runtime-regressions.test.ts -t 'T-132 honors|T-136 retains live' (red).
- packages/agent: test/harness/agent-harness-{runtime-regressions,budgets,controls,faults,operations,recovery,run,scaffold,tool-gateway}.test.ts (explicitly named files; final 109 passed).
- packages/session-backends/sqlite-node: test/storage-boundaries.test.ts -t 'T-113 retries' (red); test/storage-boundaries.test.ts (final 20 passed).
- Same SQLite cwd: test/{storage-boundaries,repository,writer-leases,conformance,adapter,migrations,branch-cache,branch-query,facts-query,log-query,search,sql}.test.ts (explicitly named files; 111 passed).
- Root: node node_modules/@biomejs/biome/bin/biome check [four owned files], read-only scoped check.

One implementation iteration was rejected by an existing neighbor: an early admission-level LaneBusy guard changed the established resume result. Replaced it with the existing interpreter uncertainty branch; tool-gateway and all neighbors pass unchanged. No LEARNS.md edit because file scope forbids it.

Limits: fault injection at the SQLite transaction seam, not an OS-level busy-lock experiment; tool/provider execution was offline/fake. Root npm run check/build/typechecking remain root-owned and were not run here. No commits, dependency/lockfile changes, report/task edits, APIs, credentials, or remote changes.

Final source SHA256s: harness f65eeaa7f65210f131565392f66f2edd16191b0261716a0bc5185a99aa1cbf56; SQLite repo b8899497b48959e03b35160c158a262b39d819efe542ebdf95bd6985edbf091a.
