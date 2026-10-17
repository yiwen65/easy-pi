# 实施与验证回执快照

实现方回执，最终接受状态见任务计划与 root 复查。

Implemented T-048–T-052 (F9–F13), independently reproduced before fixes. Recommended status: ready for coordinator review/check, not root acceptance. Baseline HEAD: f7606c3df763e4dcbc75261211346e67124ee628.

Per-task evidence/fix:
- T-048: Red startup reader count 0, missing recovery agent_start, missing signal handler, print startup listener absent. RPC now installs transport/signals before binding, subscribes before startup/recovery, gates ordinary commands while allowing UI responses and abort commands. Print subscribes before binding. Green includes actual AgentSession + faux-provider automatic task recovery after a startup confirmation round-trip, startup abort/backpressure, replacement gating, failed-startup listener cleanup.
- T-049: All four successful replacement paths bound twice in red; removed RPC's redundant binds so runtime callback is sole owner. Green covers new_session/switch_session/fork/clone exactly once, cancellation, old subscription removal.
- T-050: Red null envelope caused unhandled rejection at command.id; scalar/array/invalid metadata also returned malformed responses. Validates object/type/id and UI response metadata before dispatch; catch uses validated metadata. Green malformed inputs return protocol errors and subsequent get_state succeeds; unknown-command ID preserved.
- T-051: Red polling disposed active work; shutdown command disposed before acceptance. Tracks active commands/prompt completion and checks session idle/compaction/binding readiness; waits for response backpressure. Signals/EOF retain immediate shutdown. Green includes blocked real faux tool reaching final assistant response, polling, deferred/rejected command responses, and immediate SIGTERM.
- T-052: All 12 void client methods falsely resolved errors in red; promptAndWait remained pending. send now rejects success:false centrally; cancellable event collector is released on prompt failure. Green checks original errors, zero dangling collector timers/listeners, and events arriving before success response.

Changed files (only these seven; no docs, dependencies, commits, plans/reports, or cross-owner edits):
1. packages/coding-agent/src/modes/rpc/rpc-mode.ts (binding 320–382, prompt tracking 414–435, shutdown/input 747–875)
2. packages/coding-agent/src/modes/rpc/rpc-client.ts (collector 477–516; response rejection 586)
3. packages/coding-agent/src/modes/print-mode.ts (subscriptions before bind, from 80)
4. packages/coding-agent/test/print-mode.test.ts (startup regression from 168)
5. packages/coding-agent/test/rpc-mode-lifecycle.test.ts (new)
6. packages/coding-agent/test/rpc-input-validation.test.ts (new)
7. packages/coding-agent/test/rpc-client-errors.test.ts (new)

Verification:
RED, cwd packages/coding-agent:
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/rpc-mode-lifecycle.test.ts test/rpc-input-validation.test.ts test/rpc-client-errors.test.ts test/print-mode.test.ts
Exit 1: Test Files 4 failed; Tests 37 failed | 9 passed (46); Errors 1 unhandled rejection. Log /tmp/pi-fix-rpc-red.log.

FINAL GREEN, same cwd:
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/rpc-mode-lifecycle.test.ts test/rpc-input-validation.test.ts test/rpc-client-errors.test.ts test/print-mode.test.ts test/rpc-prompt-response-semantics.test.ts test/rpc-client-process-exit.test.ts test/rpc-client-clone.test.ts test/rpc-jsonl.test.ts test/suite/regressions/5868-rpc-unknown-command-id.test.ts test/suite/regressions/7150-rpc-prompt-during-compaction.test.ts test/suite/regressions/7290-json-stream-linear.test.ts test/suite/regressions/7911-json-stream-usage.test.ts
Exit 0: Test Files 12 passed; Tests 67 passed (67), no unhandled errors; duration 4.27s. Log /tmp/pi-fix-rpc-green.log.

Scoped Biome check on all seven owned files: exit 0, “Checked 7 files in 36ms. No fixes applied.” Owned-file git diff --check: exit 0. Reviewed production diff. Earlier initial green: 46/46; added faux integration run: 13/13.

Coordinator documentation recommendations (not edited): docs/rpc.md Protocol Overview/Error Handling should specify non-empty string type, optional string id, malformed-envelope parse errors, startup/replacement readiness gating with UI/abort available; Error Handling can note all typed RpcClient methods reject server failures and promptAndWait releases its collector. Existing docs/extensions.md ctx.shutdown contract now matches implementation; no wording change required.

Limits: root npm check/typecheck/build and full suites intentionally not run; rpc.test.ts is real-provider gated and was not executed. No real APIs, native signals/process exits, desktop or clipboard actions. Envelope validation intentionally is not a full schema validator for every command payload. Signal tests invoke registered callbacks with process.exit mocked. Root should run its serialized check and review shared-tree integration.
