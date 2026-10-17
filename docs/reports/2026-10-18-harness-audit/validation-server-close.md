# 实施与验证回执快照

实现方回执，部分可能是未完成的中间回执；最终接受状态见任务计划与 root 复查。

T-151 implemented; recommend ready for coordinator review and integration gates, not acceptance.

Changed only:
- packages/server/src/server.ts:152-175 — memoize before starting cleanup, clear only rejected close attempts, rethrow the original error, retain successful closure and sealed admission. Drain all listener close calls (including synchronous throws) before exposing a retryable failure.
- packages/server/test/close-retry.test.ts — three deterministic regressions. Ten gated runtime schedules verify one cleanup attempt per concurrent close group, retained ownership after failure, successful retry after settlement, unchanged original rejection, no replacement runtime/command replay, and continued admission refusal. Listener tests cover synchronous/asynchronous failure with another cleanup blocked.

Evidence:
- Red, before source patch: 3 failures / 37 passes. Public close reused the rejected promise; asynchronous listener failure settled early; synchronous failure skipped the next listener. /tmp/fix-service-t151-red.log
- Final server command from packages/server: node ../../node_modules/vitest/dist/cli.js --run test/close-retry.test.ts test/server.test.ts test/sessions.test.ts test/conformance.test.ts test/listener.test.ts test/unix-connection.test.ts test/unix.test.ts — 51/51 passed. /tmp/fix-service-t151-final.log
- Ownership neighbors from packages/coding-agent: node ../../node_modules/vitest/dist/cli.js --run test/harness-service.test.ts test/server/create-harness.test.ts — 28/28 passed. /tmp/fix-service-t151-ownership.log
- Scoped Biome check --error-on-warnings, focused diff check, and source/new-test review passed.

Base HEAD f7606c3df763e4dcbc75261211346e67124ee628. SHA256: server.ts 7201673c2e5c86cda36aa2a7e9e7f997fd624caaa858807cf928b4ef5ab5d1e6; close-retry.test.ts cb1ca0496f087f87fb271f3e7c1f151ebe2dccd88e1fe7ef5c089bae8371ca9b.

Limits: no root check/build/typecheck or cross-platform runs; no APIs, credentials, commits, docs, or earlier source edits. An added assertion initially assumed a particular start-rejection message; empty-listener servers report 'already starting'. The test now checks the actual requirement (start rejects); start lifecycle was not changed. Intermediate log retained at /tmp/fix-service-t151-admission-assertion.log.

Doc recommendation for coordinator: server README should state failed close keeps admission sealed and can be explicitly retried after retained work settles; concurrent calls join an attempt, successful close stays idempotent, and listener cleanup must settle before retry.
