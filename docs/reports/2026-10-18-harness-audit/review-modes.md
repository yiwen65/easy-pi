# 复查与后续验证证据

历史回执；最终状态见任务计划与主报告。

Two actionable findings from static review of `/tmp/pi-harness-modes-review.diff`.

### Recheck deferred RPC shutdown when standalone compaction finishes
- Severity: Medium
- Axis: Correctness
- Location: `packages/coding-agent/src/modes/rpc/rpc-mode.ts:747–758`, event subscription at `326–331`.
- Problem: An RPC-invoked extension command can call `ctx.compact(); ctx.shutdown();` and return while compaction remains active. The prompt response drains and `pendingPrompts` reaches zero, but the new `isCompacting` guard defers shutdown. When compaction finishes, only `compaction_end` is emitted; this subscription rechecks shutdown only on `agent_settled`. There is no subsequent check unless another command arrives.
- Impact: With stdin kept open, the process remains alive indefinitely after the requested work completes instead of honoring shutdown.
- Recommended fix: Reevaluate deferred shutdown after the standalone compaction lifecycle finishes, retaining the command/prompt/backpressure guards. Add a regression invoking an extension command that starts a blocked `ctx.compact()` and requests shutdown, returns its prompt response, then completes compaction without further input; assert one disposal/exit. Cover failure completion too.
- Certainty: High confidence — `ExtensionContext.compact` explicitly returns void (`core/extensions/types.ts:355–361`); its fire-and-forget binding is in `core/agent-session.ts:4237–4249`; `compact()` clears its controller and emits `compaction_end`, not `agent_settled` (`3425–3570`). Existing lifecycle tests cover an active faux tool and pending commands, not this path.

### Prevent superseded tree-dialog continuations from replacing newer UI
- Severity: Medium
- Axis: Correctness
- Location: `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2696–2714`, enclosing caller at `5830–5850`.
- Problem: Replacement/reset now resolves a displaced selector/editor with `undefined`. The tree-navigation workflow treats every `undefined` as a user Escape: it reopens the tree after the summary selector, or loops to another summary selector after the custom-instructions editor. Thus, opening an extension input/confirmation while “Summarize branch?” is pending first cancels that old dialog, then its awaited continuation opens a tree selector and cancels the newer dialog. This is reachable while an ongoing agent/tool requests UI, since the tree workflow aborts streaming only after these questions.
- Impact: The newer dialog unexpectedly resolves as cancelled and loses focus; reset can likewise revive UI from an abandoned workflow. Component-level stale-callback guards do not prevent this caller-level continuation.
- Recommended fix: Distinguish supersession/reset from explicit user cancellation internally, or guard the tree workflow with an ownership/invalidation token before reopening UI after either await. Preserve explicit Escape navigation. Add a regression replacing the pending summary selector/custom editor with `ui.input()`, flush microtasks, and verify the new input stays mounted and pending; also verify reset does not reopen the tree.
- Certainty: High confidence — source trace through the new disposer settlement, `showSelector` ownership replacement (`5177–5218`), and the unconditional reopen/loop branches. New dialog tests cover direct pairwise replacement, not this enclosing workflow.

Validation gaps and residual risks:
- Read all four changed production modules, relevant lifecycle dependencies/callers, new RPC/UI/clipboard tests, and relevant changed status-test fixture. No additional actionable issue identified in the reviewed startup gating, subscription ownership, envelope validation, prompt collector disposal, or clipboard-generation paths.
- No files changed and no tests or commands executed. Native signals, terminal rendering, and OS clipboard behavior remain unverified. Validation-report pass counts/hashes were not accepted as independent evidence.
- Target was the supplied stable diff plus live source reads; critical finding locations were reread. Base HEAD and file hashes were not independently checked. Other changing modules were consulted only for necessary call-path evidence, not audited.
