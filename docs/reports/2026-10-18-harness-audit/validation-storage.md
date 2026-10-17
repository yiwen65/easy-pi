# 实施与验证回执快照

实现方回执，最终接受状态见任务计划与 root 复查。

Implemented T-107–T-114; recommend ready for coordinator review/check, not accepted. Base: f7606c3df763e4dcbc75261211346e67124ee628. No commits, docs, dependencies, lockfiles, root check/build, real APIs, or unowned files changed.

Per-task evidence:
- T-107: Original JSONL/SQLite accepted pre-await mutations (including NaN/undefined and changed record id). Session now validates/clones before invoking storage; both queued backends validate/clone before admission. Shared conformance, direct-storage, delayed-backend, and reopen checks pass. Locations: agent session.ts:293–305; JSONL storage.ts:212–254; SQLite repo.ts:410–478.
- T-108: Original registry reached 3 registrations where only 1 was active at the second cycle. Now that checkpoint has 1; all six create/open/fork/release cycles finish with 0 registrations. Release callback evicts only the identical instance; deterministic delayed-release/replacement test passes. Locations: JSONL repo.ts:194–200, storage.ts:166–178. Counts measured; no heap-byte or throughput claim.
- T-109: All three newline-terminated corrupt tails originally opened successfully; now reject without modifying bytes. Existing unterminated-tail repair neighbors still pass. storage.ts:122–124.
- T-110: Malformed built-ins originally decoded, including retainedTail:null and SQLite null/array records and mismatched indexed identities. Shared validation now checks required built-in fields/discriminants, nested messages/targets, and SQLite record id/type/lane/run/op-kind consistency. JSONL first/middle/final corruption and unchanged-file checks pass; custom entry data remains opaque. validation.ts:1–321; JSONL codec.ts:122,137; SQLite repo.ts:194–245. Corrected the old codec checkpoint fixture to contain the required AssistantMessage fields instead of an incomplete untyped object.
- T-111: Controlled independent owning-connection append/move/label interleaving failed 3/3 times with “Entry concurrent not found”. One BEGIN IMMEDIATE now encloses all fork source reads and destination publication; 3/3 coherent-snapshot checks pass and the independent writer proceeds after fork. SQLite repo.ts:751–861.
- T-112: Independent subprocess initializer winning just before transaction acquisition caused UNIQUE migrations.id failures 3/3. Applied-id lookup is now inside the write transaction; both initializers succeed in 3/3 schedules. migrations.ts:35–45.
- T-113: Original late create was accepted during close, then disposal encountered a closed database. Admission is synchronously sealed; close shares one promise and drains admitted work. Final controlled delayed-open test: opens=1, closes=1, remaining leases=0, heartbeat timers=0; every repository operation rejects after close. SQLite repo.ts:864–881.
- T-114: Failed metadata/name decoding originally left 1 untracked lease. Decode now occurs in acquisition transaction; both cases leave 0 leases and immediate repaired reopen succeeds. SQLite repo.ts:605–619.

Verification (Node v24.15.0, Darwin):
- Red logs: /tmp/fix-storage-agent-red.log (69 expected failures), /tmp/fix-storage-sqlite-red.log (20 expected failures).
- From packages/agent: node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/session/session-input.test.ts test/harness/session/jsonl-boundaries.test.ts test/harness/session/jsonl-codec.test.ts test/harness/session/jsonl.test.ts test/harness/session/jsonl-storage.test.ts test/harness/session/jsonl-durable.test.ts test/harness/session/memory.test.ts test/harness/session/context.test.ts test/harness/session/search.test.ts — 9 files / 213 tests passed. /tmp/fix-storage-agent-final.log.
- From packages/session-backends/sqlite-node: same root Vitest CLI --run test/storage-boundaries.test.ts test/migrations.test.ts test/conformance.test.ts test/repository.test.ts test/writer-leases.test.ts test/adapter.test.ts test/branch-cache.test.ts test/branch-query.test.ts test/log-query.test.ts test/facts-query.test.ts test/search.test.ts test/sql.test.ts — 12 files / 108 tests passed. /tmp/fix-storage-sqlite-final.log.
- Scoped Biome check over all 14 changed files passed; scoped git diff --check passed. Read all modified source files and reviewed scoped diff.
- Intermediate SQLite green run exposed a test-fixture dependency on stale built workspace exports. Fixed the subprocess fixture to import migration source directly; final subprocess checks pass without a build.

Complete changed-file list (relative to pi/):
packages/agent/src/harness/session/session.ts
packages/agent/src/harness/session/validation.ts (new)
packages/agent/src/harness/session/jsonl/codec.ts
packages/agent/src/harness/session/jsonl/repo.ts
packages/agent/src/harness/session/jsonl/storage.ts
packages/agent/src/harness/session/testing/conformance.ts
packages/agent/test/harness/session/jsonl-codec.test.ts
packages/agent/test/harness/session/jsonl-boundaries.test.ts (new)
packages/agent/test/harness/session/session-input.test.ts (new)
packages/session-backends/sqlite-node/src/sqlite/repo.ts
packages/session-backends/sqlite-node/src/sqlite/migrations.ts
packages/session-backends/sqlite-node/test/migrations.test.ts
packages/session-backends/sqlite-node/test/storage-boundaries.test.ts (new)
packages/session-backends/sqlite-node/test/support/migrate-worker.ts (new; executed by migration tests)

Limits/doc recommendations: root typecheck/build remain coordinator-owned and unrun here. Linux, Windows, Bun and power-loss behavior were not tested. No future register-store architecture implemented. SQLite README should explicitly state close is terminal, rejects later repository calls, and drains admitted work; agent persistence documentation should distinguish repairable unterminated tails from newline-terminated corruption and note synchronous input snapshots. Docs/LEARNS remain untouched per ownership.
