# 实施与验证回执快照

历史回执；最终接受状态见任务计划与 root 复查。

Completed both assigned followups; recommend T-025/T-026 ready for root review and serial gates, not accepted solely on this report.

Changes (only these four files edited by this child):
- `packages/mcp/src/transports/stdio.ts:193–228`: distinguish child `close` (stdio drained) from leader/group exit. Cleanup waits for both within the existing deadline; missing stdio closure produces a bounded error. TERM→KILL escalation and shared close promises remain; no further probes/signals after observing ESRCH. Temporary close listener is removed in finally.
- `packages/mcp/src/transports/streamable-http.ts:378–388`: diagnostic-body failures no longer erase known HTTP status. Non-cancellation failures use an empty diagnostic body; caller abort reasons still propagate. Byte limits and reader cleanup are unchanged.
- NEW `packages/mcp/test/stdio-close-order.test.ts`: exit→data→close under three controlled schedules; pending client receives final result; shared cleanup waits for surviving descendants; absent-group identity is not reused; missing pipe closure is bounded.
- NEW `packages/mcp/test/streamable-http-status.test.ts`: immediate/mid-body failures retain 401/404/503 classifications; stalled-body cancellation cancels once and releases the lock; GET retry policy follows status, not body TypeError.

Independent red/green evidence:
- Base HEAD: `f7606c3df763e4dcbc75261211346e67124ee628`; started from the existing modified worktree, preserving prior cancellation/group/budget changes. Pre-edit transport copies and scoped production patches are under `/tmp/pi-mcp-review-followup/`.
- Red command (cwd `packages/mcp`): `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/stdio-close-order.test.ts test/streamable-http-status.test.ts` → 15 failed, 5 passed. Observed close→message, McpConnectionClosedError instead of final result, TypeError instead of known HTTP errors, and unwanted 401/404 GET retries. Log: `/tmp/pi-mcp-review-followup/red.log`.
- Same focused tests after fixes → 20/20 passed.
- Final command (same cwd): `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/client.test.ts test/streamable-http.test.ts test/stdio.test.ts test/streamable-http-cancellation.test.ts test/streamable-http-bounds.test.ts test/stdio-cleanup.test.ts test/stdio-close-order.test.ts test/streamable-http-status.test.ts` → 8 files, 70/70 passed. This includes native self-created process-group fixtures. Log: `/tmp/pi-mcp-review-followup/green-final.log`.
- Scoped Biome check on all four edited files passed; `git diff --check` on both edited source files passed. One new test's formatting was corrected before the final run.

Observed counts/bounds:
- Pending final-result cases: 0/3 successful before, 3/3 after. Broken-body 401/404 GET attempts: 2 before, 1 after; 503 still retries.
- Mock surviving-group cleanup retains exactly one TERM and one KILL; all three error-body cancellation cases retain one cancellation and an unlocked reader before/after.
- Final preservation suite consumed JSON 320/4132 bytes (5 pulls), error body 8192/131072 (8 pulls), SSE 374/23552 (17 pulls), with one cancellation each. These are measured preservation results, not throughput claims or a fresh pre-original-fix comparison.

Limits: verified on darwin arm64, Node v24.15.0. Windows/Linux/Bun/Cloudflare and downstream coding-agent reconnect behavior were not exercised end-to-end; transport status classes and retry behavior were verified directly. Root-wide check/build/full-suite gates remain with root. No remote APIs, credentials, commits, dependency/lockfile changes, or repository report/task/LEARNS edits.
