# 模块边界初审证据（实施前，只读）

历史初审证据；不是最终验收状态。最终状态见主报告与唯一任务计划。

T-007: read-only audit. Paths below are relative to /Users/w/Projects/easy-pi/pi/packages/. No edits or executable checks. f7606c3df/my-pi is parent-supplied, not git-verified. This reports observed pre-remediation code, not overall acceptance. fix-service separately owns harness-service.ts and its test.

FINDINGS

1. Retain ownership after failed disposal
- Severity: High
- Axis: Correctness
- Location: coding-agent/src/server/harness-service.ts, HarnessSessionRuntime.dispose; server/src/sessions.ts, maybeDispose.
- Problem: finally releases the writer/unregisters the runtime even when harness.close rejects because a physical timed-out tool remains unsettled. AgentHarness.close explicitly intends to retain ownership on this failure; maybeDispose also deletes failed runtimes.
- Impact: a replacement runtime can acquire the session while the old effect still runs, without the old unsettled-tools guard.
- Recommended fix: retain ownership and retryable failed-disposal state until successful close. Test blocked replay-never tool → timeout → failed dispose → second owner rejected → tool settles → retry close → reopen succeeds.
- Certainty: High confidence — close/dispose trace, not executed. Coordinate service changes with fix-service.

2. Restore persisted cwd
- Severity: High
- Axis: Correctness
- Location: coding-agent/src/server/harness-service.ts, openSession/openRuntime.
- Problem: creation honors requested cwd; reopen discards metadata.cwd and uses defaultCwd/process.cwd. Tools bind to that environment.
- Impact: reopened project A can execute relative mutations in project B.
- Recommended fix: use durable cwd with an explicit fallback only for stores lacking it. Test JSONL create in A/default B, dispose/reopen, relative tools and snapshot still use A.
- Certainty: High confidence; root independently confirmed. fix-service owns remediation.

3. Unsubscribe snapshot-only watchers
- Severity: Medium
- Axis: Performance
- Location: coding-agent/src/server/harness-service.ts, snapshot; agent/src/harness/events.ts, watch.
- Problem: every snapshot creates a harness.watch handle but never starts/unsubscribes it; the event bus retains its closure and buffered run events.
- Impact: repeated snapshots accumulate watchers and buffers throughout a live session.
- Recommended fix: unsubscribe in finally after reading snapshot data. Test repeated snapshots and conversion failures release every temporary watch.
- Certainty: High confidence; root independently confirmed. fix-service owns remediation.

4. Recheck connection generation per decoded frame
- Severity: Medium
- Axis: Correctness
- Location: client/src/connection.ts, #handleData.
- Problem: ID is checked before decoding, not between messages. A listener reconnecting on the first coalesced frame lets the second old frame reach the new lifecycle.
- Impact: old data can fail the new handshake or affect new connection state.
- Recommended fix: check #isCurrent(id) before each message. Regression in connection.test.ts: two frames together, reconnect from first callback; new handshake succeeds, old second frame ignored.
- Certainty: High confidence — deterministic reentrancy trace; current tests cover single-frame reconnect.

5. Validate response session identity
- Severity: Medium
- Axis: Correctness
- Location: client/src/client.ts, #handleMessage.
- Problem: matching request ID/command is accepted even if returned session.id/detach.sessionId differs from requested sessionId.
- Impact: malformed peer responses mutate the wrong attachment or resolve an unattached handle.
- Recommended fix: reject mismatches before applyResult. requests.test.ts: attach A returns B; detach A returns B; B state must not change and connection fails.
- Certainty: High confidence — no cross-envelope guard; README treats peers as untrusted.

6. Drain admitted Unix writes on graceful close
- Severity: Medium
- Axis: Correctness
- Location: server/src/transports/unix/listener.ts, UnixByteConnection.close/write.
- Problem: close sets closing before awaiting writeTail, while write rejects when closing. Queued, already-admitted sends are discarded.
- Impact: preceding responses/events can be lost before finalChunk.
- Recommended fix: reject new sends but drain accepted jobs until closed/timeout. unix-connection.test.ts: block first write, enqueue second, close(finalFrame), release; both sends resolve and precede finalFrame.
- Certainty: High confidence — queue/flag trace; existing test covers only one started write.

7. Preserve reserved JSON keys in adapters
- Severity: Medium
- Axis: Correctness
- Location: server/src/protocol.ts, toProtocolJsonValue/sanitizeProtocolDetails.
- Problem: assigning an own JSON '__proto__' key into {} invokes the inherited setter instead of creating a property.
- Impact: arguments/details lose data; object values change the prototype and fail wire validation, closing snapshot connections.
- Recommended fix: define own properties, as CBOR decoder already does. protocol.test.ts: scalar/null/object '__proto__' values survive adapter plus wire roundtrip without changing Object.prototype.
- Certainty: High confidence — local prototype mutation, not global prototype-pollution proof.

8. Capture durable inputs before asynchronous queues
- Severity: Medium
- Axis: Correctness
- Location: agent/src/harness/session/session.ts, commitEntry/commitRecord; JSONL and SQLite append methods.
- Problem: Session validates a reference, then JSONL clones/SQLite reads it in a later queued microtask. Caller mutation bypasses validation.
- Impact: appendCustomEntry with {value:1}, immediately changed to undefined, acknowledges in-memory data whose property disappears on serialization/reopen; effective tool arguments share this boundary.
- Recommended fix: synchronously validate/detach before queue admission. Shared conformance: mutate nested entry/record input before awaiting; accepted original and reopened data must match, including undefined/NaN attempts.
- Certainty: High confidence — deterministic microtask ordering; current tests mutate after await.

9. Evict released JSONL storages
- Severity: Medium
- Axis: Performance
- Location: agent/src/harness/session/jsonl/repo.ts, activeStorages; storage.ts, release.
- Problem: release never removes registered storage; only delete/same-path replacement does.
- Impact: long-lived repositories retain entire logs of every previously opened session after writer release/server detach.
- Recommended fix: release callback conditionally removes that exact instance. Test distinct create/open/release cycles leave no released registrations while active-source fork/reopen still work.
- Certainty: High confidence — strong-reference trace; no heap measurement claimed.

10. Reject newline-terminated corruption
- Severity: Medium
- Axis: Correctness
- Location: agent/src/harness/session/jsonl/storage.ts, loadOwned/isTornTail.
- Problem: syntax-invalid last lines are repaired even when newline-terminated.
- Impact: damaged completed records are silently erased on open.
- Recommended fix: repair only unterminated final lines. jsonl.test.ts: valid prefix + 'not-json\n' fails unchanged; existing unterminated-fragment repair still succeeds.
- Certainty: High confidence — missing terminator guard.

11. Validate durable decoded payloads
- Severity: Medium
- Axis: Correctness
- Location: agent/src/harness/session/jsonl/codec.ts, mutation parsers; session-backends/sqlite-node/src/sqlite/repo.ts, decoders.
- Problem: envelope checks precede unchecked casts. JSONL compaction retainedTail:null is accepted. SQLite record payload 'null' spreads into only seq/timestamp despite indexed record identity.
- Impact: syntactically valid corruption reaches recovery/context or becomes silently unrecognizable.
- Recommended fix: validate required discriminated fields and SQL indexed/payload identity; keep custom data opaque. Tests: malformed built-ins at all line positions; SQL null/array and mismatched id/type/lane; original data unchanged.
- Certainty: High confidence — inspected casts; not a demand for the future register-store rewrite.

12. Snapshot SQLite fork source transactionally
- Severity: Medium
- Axis: Correctness
- Location: session-backends/sqlite-node/src/sqlite/repo.ts, fork.
- Problem: source entries/lanes/tips/facts are read before db.transaction; another owning connection can commit between SELECTs.
- Impact: new tips may be absent from copied entries, failing fork; tree labels may reference uncopied entries or an incoherent snapshot.
- Recommended fix: one BEGIN IMMEDIATE encompassing source reads/publication, or equivalent snapshot. Test two connections interleaving append/move/label at read boundaries; all fork references resolve to one source snapshot.
- Certainty: Conditional — independently writing source connection; not executed.

13. Recheck migrations under the write transaction
- Severity: Medium
- Axis: Correctness
- Location: session-backends/sqlite-node/src/sqlite/migrations.ts, applyMigrations.
- Problem: applied IDs are read before transaction acquisition. Concurrent initializers both see absence; second later fails unique migrations.id insertion.
- Impact: concurrent repository/search startup fails; rejected databasePromise remains cached until close.
- Recommended fix: recheck inside transaction before DDL/INSERT. migrations.test.ts: two connections synchronized after old-set reads; both calls succeed with one application.
- Certainty: Conditional — concurrent independent connections; current test repeats only one connection.

14. Seal SQLite repository admission on close
- Severity: Medium
- Axis: Correctness
- Location: session-backends/sqlite-node/src/sqlite/repo.ts, close/getDatabase/public operations.
- Problem: close drains a captured tail without a closing flag/shared close promise. Immediately subsequent create can open after close resolves or race existing disposal.
- Impact: connections/leases/heartbeats can survive resolved disposal, or operations encounter closed handles.
- Recommended fix: seal synchronously, memoize close, drain admitted work. Test delayed sqlite.open, close/create orderings, concurrent closes; no resources survive resolved close.
- Certainty: High confidence — absent lifecycle guard; not executed.

15. Roll back lease on metadata decode failure
- Severity: Medium
- Axis: Correctness
- Location: session-backends/sqlite-node/src/sqlite/repo.ts, claimStorage.
- Problem: lease transaction commits before decodeSessionMetadata; malformed metadata/name throws before storage registration/release callback exists.
- Impact: failed open leaves an untracked writer claim, locking even repaired data until expiry; repository.close cannot release it.
- Recommended fix: decode inside acquisition transaction or release on post-commit failure. Test corrupt metadata/name after releasing original owner; failed open leaves no lease, immediate repaired reopen succeeds.
- Certainty: High confidence — transaction/constructor ordering.

16. Preserve reserved telemetry attribute names
- Severity: Low
- Axis: Correctness
- Location: telemetry/src/memory.ts, copyAttributes/mergeAttributes.
- Problem: {} assignment drops own '__proto__' scalars or changes prototype for arrays; later copies lose them.
- Impact: reference adapter loses valid open-bag diagnostics.
- Recommended fix: safe own-property copying. Conformance tests for start/set/event '__proto__' attributes and detached snapshots.
- Certainty: High confidence — setter behavior; no business-state failure claimed.

COVERAGE
Fully read root AGENTS.md, review/best-practice skills, READMEs of agent/client/server/protocol/telemetry/sqlite-node/evals and agent/docs/harness.md. Current code is journal-based; future compound/register transaction design was NOT treated as an implementation requirement.
- client: all src modules; tests connection/requests/sessions/disposal/support. Connect→hello→decode→request correlation→listeners; lease release/reconciliation/invalidation; Unix send/backpressure/close.
- server: server/sessions/snapshots/connection/types/protocol; Unix listener/preset/types; tests server/sessions/listener/unix-connection/protocol. Authorized acceptance→handshake→concurrent prompt/steer/abort→snapshot→disconnect/dispose. Coding-agent service/create-harness and their tests fully read. AgentHarness inspected only through line 1120 for caller/watch/close evidence, not fully audited.
- protocol: schemas/codec/framing and cbor/{options,encoder,decoder}; framing tests. Fragmentation/coalescing/truncation, bounded allocation, Unicode/depth/container limits, duplicate keys and schema boundaries. No other codec defect established.
- persistence: agent session types/session/state/memory/context; JSONL types/codec/storage/repo/errors; shared conformance and JSONL codec/storage/durable/repository tests. SQLite adapter/repo/migrations/SQL/branch-cache/search-backend, all storage helper modules/initial SQL; repository/writer-leases/migrations/search tests. Validation→queue→append/transaction→publication/replay→release; BEGIN IMMEDIATE, fencing/heartbeat, forks, FTS triggers.
- telemetry: index/memory/noop/testing-conformance and telemetry/conformance tests; admission/rejection identity/status/passivity/parentage/snapshots.
- evals: all src modules (pi-harness, smoke/extensions, setup/artifacts/harness-table/reporter/summary), pi-harness test. Temp workspace→setup→prompt/reload→abort→artifact→cleanup→paired reports. No additional functional defect established.

OPPORTUNITIES / EXCLUSIONS
Client lease subscriptions remain registered until explicit unsubscribe/client.dispose; clarify ownership before changing it (README exposes independent unsubscribe). Evals need offline injected cancellation/setup/artifact/cleanup regressions; inspected pi-harness test covers model selection only. Persisting judge scores in runs.jsonl would aid analysis, but no durable-score requirement established. Co-located FTS rollback behavior is explicitly tested; no speculative replacement proposed. Unix permission-publication/startup-failure races and throwing custom close implementations remain hypotheses, not findings.

IMPLEMENTATION OWNERSHIP
Would own client/src/{connection,client}.ts + connection/requests tests; server/src/{sessions,protocol}.ts + transports/unix/listener.ts and sessions/protocol/unix-connection tests; agent session/{session,jsonl/codec,jsonl/repo,jsonl/storage}.ts + shared conformance/JSONL tests; sqlite-node/src/sqlite/{repo,migrations}.ts + repository/writer-leases/migrations tests; telemetry/src/memory.ts + conformance. Exclude harness-service.ts/test while fix-service owns them; coordinate finding 1. create-harness.ts reviewed without an independent fix finding.

VALIDATION GAPS
All proposed regressions NOT RUN. Only read authorized: no npm checks, reproductions, builds, hashes, or benchmark results. Parent baseline claims not reverified. Platform checks not executed: Node node:sqlite/FTS5; multi-process WAL/migration/fork races; Linux/macOS Unix hard-links/chmod/backpressure/close; Windows Unix rejection and JSONL rename/locking; Bun where supported; crash/sync/reopen fault injection. NodeExecutionEnv writer internals/runtime-wide telemetry emission not comprehensively reviewed. This is bounded core-path coverage, not per-file exhaustive review or overall acceptance.
