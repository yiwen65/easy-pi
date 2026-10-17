# 实施与验证回执快照

实现方回执，最终接受状态见任务计划与 root 复查。

T-150 implemented; recommended ready for parent acceptance/root checks. HEAD remains f7606c3df763e4dcbc75261211346e67124ee628.

Changed only this turn:
- packages/ai/src/api/openai-codex-responses.ts:170–189 — named abort listener removed on both timeout success and cancellation; abort registration is once-only. Existing cancellation message, retry policy and delays unchanged. Previous transport fixes preserved. Existing analogous delay helpers are private, so no additional source/API changes.
- packages/ai/test/codex-retry-sleep.test.ts (new) — six tests covering HTTP/network retries, cancellation, and both same-tick settlement orders, eight repetitions each (48 controlled schedules).

Observed red→green listener counts via node:events getEventListeners:
- Eight successful waits using one signal: [2,3,4,5,6,7,8,9]→[1,1,1,1,1,1,1,1], including one preserved caller listener; eight retained adapter listeners→zero.
- Cancellation: 2→1, baseline caller listener preserved, adapter listener removed.
- Same-tick abort-first/timeout-first: 1→0, matching empty baseline.
- Settled timer count zero; cancellation retains exact 'Request was aborted' message, one terminal event, and no second fetch. Successful requests retry only at the expected delay.

Commands (cwd packages/ai):
Red: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/codex-retry-sleep.test.ts` — six failures at intended listener-count assertions; /tmp/fix-ai-transports-T150-red.log.
Green: same CLI prefix with `test/codex-retry-sleep.test.ts test/codex-transport-boundaries.test.ts test/openai-codex-stream.test.ts test/codex-session-cleanup.test.ts test/openai-codex-cache-affinity.test.ts test/openai-codex-service-tier.test.ts` — six files/135 tests passed; /tmp/fix-ai-transports-T150-green.log.
Scoped Biome check on both files and git diff --check on source passed. Read complete current source before patch; reviewed final changed seam and test.

No docs, authority reports, dependencies, lockfiles, other source files or commits changed. No real API/credential/network use. Root check/build/full-suite checks remain parent-owned and were not run. No throughput claim or remaining T-150 defect asserted.
