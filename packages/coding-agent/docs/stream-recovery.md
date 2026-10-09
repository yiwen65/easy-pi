# Interrupted model responses

OpenAI Responses, Azure Responses, and OpenAI Codex responses can recover completed output items after a retryable stream failure. Their adapters explicitly identify completed upstream items; local text-segment endings and best-effort JSON parsing do not authorize recovery.

When a response is interrupted:

1. Persist each confirmed complete output item while receiving the stream. After interruption, publish those items as an assistant response checkpoint.
2. Execute complete tool calls using the existing sequential or parallel batch policy, after the stream has ended. Save the checkpoint before admitting tool effects, and await tool results before retrying.
3. In native sessions, save the remaining incomplete content and original failure as a separate assistant message. Its usage accounts for the request; the checkpoint has zero usage.
4. If retry is enabled and its budget remains, remove the failure from active context and request another response using the checkpoint and tool results. Failure artifacts remain in the session transcript.

Checkpoints carry `isResponseCheckpoint: true`. They record completed progress, not a successful model response, and do not reset the retry budget. A text-only checkpoint can be continued without adding another user message. Completed reasoning is retained only with a following completed message or tool call; isolated reasoning remains in the failure artifact.

In the TUI, retry errors appear in the temporary retry status and clear when the next attempt starts or retry ends. Partial content remains visible, and a terminal failure is shown once. Replaying history hides retryable error notices superseded by a later assistant response in the same user turn. Diagnostic failure records remain in the session file and JSON events.

Calls with incomplete status or invalid final JSON are not recovered, even if a partial argument object can be parsed. Cancellation, quota/billing failures, and output-limit truncation do not execute recovery tools. Output-limit truncation retains its existing error-tool-result handling. Tool admission hooks and batch termination continue to apply.

Providers without an explicit trustworthy item-completion marker retain their existing whole-response retry behavior. There is no token-level stream resumption.

## Native task recovery

Native sessions persist accepted task intent, queued inputs, complete output items, tool dispatch intent, individual completed results, retry state, and task status. Initial and queued inputs carry provisioned entry IDs: reopening delivers only missing targets, and cancelled queues remain cancelled. Request acceptance is acknowledged after intent commits. Next-turn context stays queued until the next user turn. These internal records do not appear in the transcript or model context. A fast parallel tool's result is committed immediately; normal message artifacts and recovered results retain assistant call order.

Task records now use schema version 2. Version 1 records are upgraded in memory on read: existing input receipts are retained, provably undelivered inputs receive deterministic targets, and absent legacy queue data is not invented. Cancelled and unknown-effect states stay unchanged. Opening a session does not rewrite its history; the next task mutation writes the upgraded record. Ambiguous legacy input receipts still require inspection.

Reopening a running task resumes it after extensions bind. Explicitly cancelled tasks stay paused. Use `/resume-task` or `session.resumeTask()` to continue from committed progress without adding a user message. Completed tasks are not executed again.

A dispatched tool with no committed result has an unknown outcome. Only an unchanged tool declared read-only, idempotent, or without side effects may replay automatically. Unsafe execution failures pause the affected task; diagnostic errors do not masquerade as confirmed tool results.

New prompts remain available. Starting another task durably retains the paused task, dependent queues, and dispatch facts in `session.suspendedTaskRecovery`; this survives restart. Dependent queued inputs remain with their original task; next-turn context accompanies the new prompt. Provider requests project the incomplete old tool exchange as explicit execution facts, including the original request, tool identity, arguments, and known results. The original transcript remains intact. Identical unresolved operations are rejected even if the model generates a new call ID; other tools and tasks remain available. This compares structured arguments, not semantic equivalence between different shell commands.

The model can inspect external state with read-only tools, then call `reconcile_task` with recorded inspection call IDs, a terminal outcome (`succeeded` or `failed`), and its explanation. The runtime requires successful read-only evidence from the current task and persists both that evidence and the model's interpretation. Evidence relevance and the outcome's meaning remain model judgments; this is not a transactional proof of an arbitrary external effect. A running process or inconclusive evidence must remain unresolved. The model cannot authorize a retry through this tool. Users need to decide only when relevant inspection cannot establish the outcome and subsequent work depends on it.

For a manual override after verifying external state, resolve a call with either:

- `/reconcile-task <callId> result <verified result>` to supply its observed result;
- `/reconcile-task <callId> retry` to authorize one new execution.

Then use `/resume-task` for the current task. For a task suspended by a newer prompt, use `/resume-task <taskId>` or `session.resumeTask(taskId)` after its unknown effects have been resolved. This explicitly switches back to the old task's history branch; newer work remains in the session tree and can be reached with `/tree`. SDK callers can use `session.reconcileTool(callId, { kind: "result", result })` or `{ kind: "retry" }` for current or suspended calls. Verified results must name the original tool and call ID. Manual reconciliation is rejected while the session's tools are still running.

## Durable Harness

`AgentHarness` consumes the same upstream completion markers and persists checkpoint records before dispatch. Tools run after the response has ended, or after reopening an interrupted attempt. Retry classification and persisted retry budgets apply to continuation.

The reference remote harness service accepts the same `/resume-task` and `/reconcile-task` text commands. It broadcasts a fresh snapshot when recovery pauses and reads catalog names without taking another writer claim.

Unknown effects return `kind: "needs_reconciliation"` with the tool identity and reason. Use `await harness.reconcileTool(callId, resolution)` after verification, then `await harness.resume()`. The same result/retry resolution forms apply.

Timeout and cancellation propagate through a dedicated tool AbortSignal. An uncooperative tool can still produce effects after cancellation; the run remains paused and its writer ownership is retained. Reconciliation and close are rejected until the physical tool exits. `harness.close()` durably pauses accepted work, drains execution, and releases storage ownership; reopening can resume that work.

## Storage guarantees and limits

Native JSONL commits synchronize files before advancing memory, repair torn final records before append, and reject interior corruption or stale writers. Atomic replacements synchronize the file and directory. Task ownership serializes cooperating native drivers.

V4 JSONL repositories require `FileSystem.durableFiles`: an explicit backend capability for exclusive writer claims, synchronized append, atomic synchronized replacement, and release. `NodeExecutionEnv` provides it. Release sessions with `await session.release()` when finished; callers cannot open a second writer until the first has released or its process is confirmed dead.

Invalid ownership metadata or an interrupted claim guard stops automatic recovery. Verify the owner before manually repairing a lock; never remove a live writer's lock. Backends lacking the required synchronization capability fail closed. Multiple hard links to the same session file are unsupported; use an independent copied file instead.

These guarantees concern committed local task state. They cannot make arbitrary Bash commands or external APIs transactional with a local log. If a process exits after an effect but before its result is committed, verification is required rather than assuming success or repeating the effect. Hardware power-loss behavior is not tested by the offline process-crash regressions.
