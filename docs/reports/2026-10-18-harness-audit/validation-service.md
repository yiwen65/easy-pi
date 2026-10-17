# 实施与验证回执快照

实现方回执，最终接受状态见任务计划与 root 复查。

Implemented T-100, T-103, T-104, T-105, T-106, T-115 within owned source/tests; preserved accepted T-010/T-011. Recommend ready for coordinator review/serial checks, not acceptance. Base HEAD: f7606c3df763e4dcbc75261211346e67124ee628.

Per-task evidence:
- T-100: Actual gated replay-never tool, deterministic 100ms fake timeout: failed dispose previously let another JSONL service acquire the writer (1 regression failure). Manager previously discarded failed cleanup and could not retry (2 failures). Service now releases/unregisters only after successful close; manager retains failed owner, rejects reuse, and retries cleanup on attach/detach/shutdown, sharing concurrent retry. Final coding-agent 28/28; server 69/69, including shutdown retry/concurrent reacquisition. Writer exclusion remains until physical settlement, then retry/reopen succeeds; effect called once.
- T-103: Coalesced stale frame previously broke new handshake (1 failure); connection generation is checked per frame. Green with 10 controlled reconnect schedules.
- T-104: Seven session-bound commands previously accepted another session's response (7 failures); validates result session identity before state mutation and fails the connection. Green, no wrong-session notifications. Existing cleanup behavior remains: lease detach becomes a no-op when protocol failure invalidates all leases; protocol error is reported on connection state.
- T-105: Both already-queued close schedules failed with 'Unix connection is closed' (2 failures). Admission still rejects new sends; admitted writes now drain before final bytes. Green with 20 controlled schedules, exact byte order [1],[2],[3], plus forced-timeout rejection. No throughput claims.
- T-106: Five scalar/null/object __proto__ cases lost own properties before fix. Safe own-property definitions now preserve arguments/details, nested values, normal prototypes and CBOR roundtrips. Protocol file 21/21.
- T-115: Two reserved-name/array-detachment regressions failed before fix. Safe attribute copying/merging now preserves start/set/event names and detached snapshots. Telemetry 17/17.

Final exact test commands (each run from packages/<package>, all passed; 158 tests in 17 named files):
- coding-agent: node ../../node_modules/vitest/dist/cli.js --run test/harness-service.test.ts test/server/create-harness.test.ts — 28/28.
- client: node ../../node_modules/vitest/dist/cli.js --run test/connection.test.ts test/requests.test.ts test/sessions.test.ts test/disposal.test.ts test/state.test.ts test/unix.test.ts — 44/44.
- server: node ../../node_modules/vitest/dist/cli.js --run test/sessions.test.ts test/server.test.ts test/conformance.test.ts test/unix-connection.test.ts test/unix.test.ts test/listener.test.ts test/protocol.test.ts — 69/69.
- telemetry: node ../../node_modules/vitest/dist/cli.js --run test/conformance.test.ts test/telemetry.test.ts — 17/17.
Scoped Biome check --write --error-on-warnings (15 owned files), focused git diff --check, and production diff review passed. No root check/build/typecheck, commits, real APIs/credentials, docs or dependency changes.

Complete changed-file list (all under packages/):
- coding-agent/src/server/harness-service.ts; coding-agent/test/harness-service.test.ts
- client/src/connection.ts; client/src/client.ts; client/test/connection.test.ts; client/test/requests.test.ts
- server/src/sessions.ts; server/src/protocol.ts; server/src/transports/unix/listener.ts; server/test/sessions.test.ts; server/test/protocol.test.ts; server/test/unix-connection.test.ts
- telemetry/src/memory.ts; telemetry/src/testing/conformance.ts; telemetry/test/conformance.test.ts
Key implementation locations: harness-service.ts:365; client connection.ts:157/client.ts:317; server sessions.ts:331/protocol.ts:173,202/unix listener.ts:284; telemetry memory.ts:58,73.

Logs: /tmp/fix-service-{owner,sessions,client,unix,protocol,telemetry}-red.log; corresponding *-green.log. Final logs: /tmp/fix-service-{owner,client,server,telemetry}-final.log. All red failures were observed before their causal production changes; the two extra shutdown/concurrent-retry tests were added as green neighbor coverage afterward.

Remaining limits: T-151 (top-level PiServer.close permanently caching rejection) was reported and confirmed by root; server.ts was not touched, as directed. Do not claim public PiServer shutdown retries are fixed yet. Typechecking/build and cross-platform validation remain coordinator gates. Documentation recommendation: packages/server/README.md should state dispose failure retains runtime/writer ownership, requires retry after effects settle, and replacement acquisition must wait for successful cleanup; describe top-level shutdown retry only after T-151. Other changes restore existing contracts; no API/schema doc change required.
