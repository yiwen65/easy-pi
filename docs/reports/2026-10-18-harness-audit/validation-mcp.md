# 实施与验证回执快照

实现方回执，最终接受状态见任务计划与 root 复查。

Implemented T-021/T-022/T-025/T-026 (F02/F03/F06/F07); recommended status: ready for parent review, not accepted. Baseline observed: f7606c3df763e4dcbc75261211346e67124ee628, branch my-pi.

Red → green evidence:
- T-021/F02: 8 original regressions failed: cancelled requests dispatched after token/auth waits; stalled JSON/SSE remained locked and uncancelled after abort/timeout; pending/active resumptions continued. Client-owned controllers now reach HTTP fetch/body/backoff/resumption, without cancelling shared authentication or unrelated requests. Follow-up buffered-chunk regression reproduced a late response after callback cancellation; parsing now checks cancellation between lines. All 9 cancellation cases pass. Main code: src/client.ts:443,566,589; transports/transport.ts:11-12; transports/streamable-http.ts:37-58,104-107,263-301,327-354,423-464. Logs: /tmp/fix-mcp-t021-red.log and /tmp/fix-mcp-t021-buffered-red.log.
- T-022/F03: real loopback 307/308 tests reproduced forwarding of synthetic code/verifier/client-secret and refresh credentials, and saving redirected tokens. Token POST uses redirect:error (oauth/flow.ts:228). Both redirects now send nothing to the target and save no redirected tokens; direct authorization/refresh neighbors pass. Logs: /tmp/fix-mcp-t022-red.log, /tmp/fix-mcp-t022-green.log, /tmp/fix-mcp-oauth-final.log.
- T-025/F06: all four leader-first/stdio variants failed before repair. Group ownership now outlives the leader; independent TERM→KILL escalation and group-exit checks replace leader/pipe completion. Cleanup is shared; failures are reported rather than retaining numeric identities indefinitely. Integration follow-up reproduced concurrent McpClient.close returning early in all four variants, so the client also shares its cleanup promise (client.ts:388-396). Eight final cases cover client/transport close, leader exit before/during close, inherited/closed pipes, TERM-ignoring descendants and an unaffected second server. New tests force-clean their own groups in finally, including on failed assertions. Main code: stdio.ts:17-66,119-127,170-224. Logs: /tmp/fix-mcp-t025-red.log, /tmp/fix-mcp-t025-client-close-red.log, /tmp/fix-mcp-t025-green.log.
- T-026/F07: incremental byte-bounded JSON/error consumption and reader cancellation/release. Measured deterministic source consumption: JSON 4,132 bytes/65 pulls → 320 bytes/5 pulls with a 256-byte limit (one overflow chunk); error body 131,072 bytes/128 pulls → 8,192 bytes/8 pulls; SSE overflow consumes the same 374 bytes/17 pulls but cancels unread body (0 → 1 cancellations). JSON/errors also cancel once; split UTF-8 at exact JSON limit remains valid. Source errors remain errors; no latency/RSS claims. Code: streamable-http.ts:37-76,128-141,289-292,378-383. Log: /tmp/fix-mcp-t026-red.log; final counts in /tmp/fix-mcp-final-tests.log.

All changed files (relative to packages/mcp/):
- src/client.ts
- src/transports/transport.ts
- src/transports/streamable-http.ts
- src/transports/stdio.ts
- src/oauth/flow.ts
- test/oauth.test.ts
- test/streamable-http-cancellation.test.ts (new)
- test/streamable-http-bounds.test.ts (new)
- test/stdio-cleanup.test.ts (new)
- test/fixtures/leader-exits-server.mjs (new)

Verification:
1. From packages/mcp: node ../../node_modules/vitest/dist/cli.js --run test/client.test.ts test/content.test.ts test/oauth.test.ts test/streamable-http.test.ts test/stdio.test.ts test/streamable-http-cancellation.test.ts test/streamable-http-bounds.test.ts test/stdio-cleanup.test.ts — 8 files, 66 passed; /tmp/fix-mcp-final-tests.log.
2. Final OAuth-only rerun after moving an existing issue comment back to its original test — 14 passed; /tmp/fix-mcp-oauth-final.log.
3. Scoped type check: node node_modules/typescript/bin/tsc --noEmit -p /tmp/fix-mcp-tsconfig.json — passed. Config extends root tsconfig but includes only mcp/src and mcp/test; /tmp/fix-mcp-types.log.
4. Biome check --error-on-warnings on the nine changed TS files — passed, no fixes; /tmp/fix-mcp-biome-final.log. git diff --check -- packages/mcp passed. Final process listing showed no leader-exits/stubborn fixture processes.

Coordinator-owned docs were not changed. Recommended README updates: token endpoints must answer directly (redirects rejected); request abort stops owned HTTP dispatch/body/resumption but cannot undo remote effects and does not cancel shared auth; maxMessageBytes bounds JSON bodies as well as SSE data, errors retain at most an 8-KiB source-byte prefix; stdio/client close awaits group cleanup even when the leader exits first. No commits, coding-agent edits, task/report/LEARNS edits, dependencies or lockfiles changed.

Limitations: root npm run check/build and integration suites intentionally left to coordinator. Process tests ran on macOS; Linux/Windows, the synchronous host-exit hook, escaped process groups and OS-level PID-reuse races were not independently validated. Only local fixture servers and self-created processes used; no provider APIs, credentials or desktop effects. Byte counts measure consumer reads, not total heap/native buffering or a single upstream chunk's allocation. Shared auth may continue intentionally after one request cancels; dispatched remote effects remain unknown.
