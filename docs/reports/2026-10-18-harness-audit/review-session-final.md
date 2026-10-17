# 独立会话边界复查

静态复查证据；最终接受状态见任务计划。

## Findings

### Recheck cancellation before post-compaction continuation
- Severity: Medium
- Axis: Correctness
- Location: `packages/coding-agent/src/core/agent-session.ts:2616–2619`, with `_tryHfAutoCompaction():3884–3894`, `_runAgentPrompt():2558–2562`, and `abort():3164–3173`.
- Problem: The cancellation fix still permits a new provider request if `abort()` occurs after an automatic overflow checkpoint commits but while the awaited `session_compact` hook is running. `abort()` marks the task cancelled and aborts the compaction controller, but the original Agent run has already settled. `_tryHfAutoCompaction()` subsequently returns `true` for `willRetry` without checking cancellation. `_handlePostAgentRun()` checks task cancellation only on entry, returns that `true` immediately, and `_runAgentPrompt()` calls `agent.continue()`.
- Impact: A cancelled root turn starts another inference, and `abort()` can wait on that new request. The already-committed checkpoint is valid and need not be rolled back; the unwanted continuation is the defect. This is incomplete cancellation coverage, not a claim that the awaited-summary cancellation regression still fails.
- Recommended fix: Recheck the current task cancellation/stop state after awaited continuation decisions and before admitting `agent.continue()` (including the `resumeTask` continuation path). Add a deterministic regression: trigger overflow recovery, gate an asynchronous `session_compact` hook after publication, call `session.abort()`, release the hook, and assert prompt/abort settle with no third provider call and the existing checkpoint retained. A `compaction_end` subscriber that requests abort is another useful boundary.
- Certainty: High confidence — static control-flow trace. `packages/agent/src/agent.ts:464–466` aborts only the active run; `runWithLifecycle():709–737` creates a fresh run scope, so a subsequent continuation does not inherit the old cancellation. The inspected `harness-audit-compaction-execution.test.ts` tests cancellation while the summary is pending, not this post-publication hook boundary. No reproduction executed.

### Do not retain a startup AbortSignal as permanent child-turn cancellation
- Severity: Medium
- Axis: Correctness
- Location: `packages/coding-agent/src/extensions/pi-child-session-host.ts:420–423`.
- Problem: The new long-lived stream guard checks `request.signal?.aborted` on every later run, although `ChildSessionCreateOptions.signal` is explicitly startup-only (`packages/subagent/src/session-host.ts:38–40`). There is a supported controller path that leaves a reusable native session holding an aborted startup signal: `load()` caches the session; cancellation at the loaded/running notification boundary prevents the initial execution, but does not evict it. `start()` explicitly handles cancellation caused by its running notification (`collaboration-controller.ts:963–975`). A later followup reuses that session (`:828–838`) and resets `interrupted`, but cannot reset the captured AbortSignal.
- Impact: Every subsequent warm followup fails before reaching the provider until the child is unloaded/recreated. Normal active-turn abort/reuse tests do not catch this because they do not abort the startup signal.
- Recommended fix: Limit startup-signal checks to the creation/admission phase; use current-turn `interrupted`/`closed` and active admission thereafter, or reliably dispose/evict a session whose startup is cancelled before execution. Review the same captured startup signal in `report_progress` so correcting inference does not leave later progress permanently rejected. Add a native-controller test: supply a startup AbortController, abort it synchronously from a one-shot controller subscriber when the first child becomes loaded/running, wait for settlement, then explicitly follow up on the retained child; require exactly one new intended provider call (and successful current-turn progress if used).
- Certainty: High confidence — static caller/host lifetime trace. `schedule():789–823` removes the caller abort listener when startup completes, but the host closure retains its already-aborted internal signal. No reproduction executed.

## Reviewed scope and validation gaps
Read `/tmp/pi-harness-session-review.diff`, applicable AGENTS/review-code/best-practice guidance, relevant documentation, and the supplied initial/validation reports as untrusted claims. Traced changed enclosing paths and directly relevant callers/tests for sticky host-controlled recovery and all three queues, delivery stop, fork provenance, migration/cycle validation, import collision handling, native task-lock scanning, final-model cache binding, compaction cancellation/hooks/full usage, and unsuccessful diagnostic accounting. No additional actionable issue found in those inspected paths.

Read-only review completed: no edits, commands, tests, builds, network/provider calls, or independently computed revision hashes. Supporting reports' red/green results were not independently executed or accepted. The two findings need targeted offline confirmation by root; root's parallel checks are not claimed here. This is a boundary-focused review, not an exhaustive repository audit; real-provider behavior, power-loss durability, hostile concurrent filesystem replacement and cross-platform execution remain unverified. Root alone accepts completion.
