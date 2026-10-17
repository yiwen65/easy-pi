# 复查与后续验证证据

历史回执；最终状态见任务计划与主报告。

### Block replay while a timed-out physical invocation is still live
- Severity: High
- Axis: Correctness
- Location: `packages/agent/src/harness/agent-harness.ts:2212–2233` (`executeToolCall`), with replay at `2070–2116` and admission at `649–710`.
- Problem: The new live-mutation protection depends on successfully appending `tool_reconciliation`. If a non-cooperative idempotent mutation times out and that append rejects, the driver exits but the physical invocation remains in `unsettledTools`. Calling `resume()` on the same harness is allowed; the durable prefix contains only `tool_started` with replay `safe`, so `advanceToolBatch()` executes it again without checking the live set. This also applies to JSONL append failure: replay of an already-started safe call performs no new journal write before invoking the tool.
- Impact: Concurrent mutations can run despite the timeout safeguard. If the second invocation settles first, its `unsettledTools.delete(toolCallId)` removes tracking for the still-live first invocation, potentially allowing close/release and later conflicting work.
- Recommended fix: Gate resume/replay against live physical execution independently of whether reconciliation persistence succeeded; leave the operation suspended and ownership retained. Minimal regression: hold the first idempotent filesystem invocation behind a gate, time it out, reject the first reconciliation append, then resume while the gate remains closed. Assert execution count stays one and close cannot release ownership; release the gate afterward for cleanup.
- Certainty: High confidence — complete timeout, reconciliation, resume, replay, and physical-settlement paths inspected; not executed.

### Honor a pause that wins the terminal control lock
- Severity: Medium
- Axis: Correctness
- Location: `packages/agent/src/harness/agent-harness.ts:1737–1759` (`finishRun`).
- Problem: After the driver captures an unpaused reduction but before it calls `finishRun`, `pause()` can acquire the control lock, durably append `pause_requested`, and return success. `finishRun` then freshly reduces the operation but checks only `op.aborting` and pending input, ignoring `op.pausing`; with no queued input it writes `operation_finished` and returns completed.
- Impact: An acknowledged pause loses operation ownership instead of suspending the run; `resume()` then reports NothingToResume. This contradicts the existing `drive()` ordering, where pause preserves the open operation even after the final assistant response is committed.
- Recommended fix: Revalidate pause alongside abort before terminal publication, returning to the driver's pause path without finishing when pause won. Minimal regression: use the final-assistant `getEntry` barrier already used by the queue-before-finish regression, await `pause()`, release the barrier, and assert paused/open operation followed by successful resume and exactly one terminal record.
- Certainty: High confidence — pause admission, terminal helper, and existing pause/finish race tests inspected; not executed.

### Permit shutdown cleanup to recover from a failed close
- Severity: Medium
- Axis: Correctness
- Location: `packages/session-backends/sqlite-node/src/sqlite/repo.ts:869–880` (`close`/`finishClose`).
- Problem: `closePromise` permanently caches rejection. If releasing the first of multiple storages fails—for example, `BEGIN IMMEDIATE` encounters a busy database—`finishClose()` stops before releasing subsequent storages or closing the connection. Every later `close()` returns the same rejected promise even after the contention clears.
- Impact: Remaining storages keep heartbeat timers and continue renewing their writer leases, and the database connection remains open. Retrying shutdown could previously progress; the new memoization prevents it indefinitely for that repository instance.
- Recommended fix: Keep admission permanently sealed, but make failed cleanup retryable and attempt remaining releases rather than stopping at the first failure. Retain enough state to retry failed lease cleanup. Minimal regression: create two sessions, fail the first lease-release transaction once, then retry close; assert the connection closes, no heartbeat timers remain, and leases are released.
- Certainty: High confidence — close, storage release/heartbeat, lease deletion, and Node SQLite transaction implementations inspected; not executed.

### Validation gaps and residual risks
Read-only patch review of `/tmp/pi-harness-durable-storage-review.diff`, the complete new `packages/agent/src/harness/session/validation.ts`, relevant enclosing implementations/contracts, and targeted regression tests. Covered AgentHarness control/driver/tool/usage paths; Session cloning and JSONL decode/repair/release; SQLite decode/fork/migration/close/leases. Implementation reports were treated as untrusted, not test evidence. No commands, tests, typechecks, writes, or independent base/hash verification were performed; only read capability was available. This is not exhaustive audit coverage or final acceptance.
