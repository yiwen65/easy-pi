# 实施与验证回执快照

历史回执；最终接受状态见任务计划。

Implemented T-010/T-011 in the two owned files only; recommend ready for coordinator review and serialized full checks, not self-approved.

Changes:
- packages/coding-agent/src/server/harness-service.ts:137-138 reads authoritative opened-session metadata and restores persisted cwd, retaining defaultCwd/process.cwd fallback when cwd is absent.
- Same file:253-266 releases the temporary snapshot watch in finally, including queue-projection errors.
- packages/coding-agent/test/harness-service.test.ts:69-199 adds five regression cases: live-handle accounting across 100 snapshots for normal/error paths on creation and reopening; two distinct JSONL workspaces reopened through fresh service/repository instances; createEnv, snapshot cwd, and actual relative read behavior; configured/default-process fallbacks for metadata without cwd.

Evidence (base HEAD f7606c3df763e4dcbc75261211346e67124ee628):
- Red: exact targeted command failed with 3 failed / 24 passed. Both snapshot paths retained 100 live watches from baseline 0; both workspace reopens used server-default and read wrong-server-default instead of their own marker.
- Green: identical command passed 27/27, then passed 27/27 again after formatting. Watch maximum after every completed/failed snapshot is 0 across 100 reads per create/reopen phase. This is deterministic handle-count evidence, not a heap/latency claim.
- Command from packages/coding-agent: node ../../node_modules/vitest/dist/cli.js --run test/harness-service.test.ts test/server/create-harness.test.ts
- Scoped Biome check --error-on-warnings and git diff --check passed for both owned files. Reviewed focused diff; no commits or plan/report changes.

Logs: /tmp/fix-service-red.log, /tmp/fix-service-green.log, /tmp/fix-service-green-final.log.
File SHA256: harness-service.ts = 0e909a6162b0b6df1a662285734f24380181c3130d251d58400137f28440a2ae; harness-service.test.ts = 0370b26b2aab6aae3e003213cd0d00a088d889737c20a3f652836d12c1c5b683.

Limitations: full root check/build/typecheck intentionally not run (coordinator owns serialization). No real APIs or credentials used. Backends such as InMemorySessionRepo that omit cwd continue using the documented fallback; their storage schema was not changed.
