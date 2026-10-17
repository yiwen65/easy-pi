# 执行核心初审证据（实施前，只读）

历史初审证据；不是最终验收状态。最终状态见主报告与唯一任务计划。

T-002: read-only audit deliverable; no overall acceptance/remediation asserted. Supplied base f7606c3df/my-pi not independently verified. No edits, commands, tests or provider calls.
Path keys: A=packages/agent/src; H=packages/agent/src/harness; C=packages/coding-agent/src/core/tools. All certainty assessments below are static, not reproductions.

F01 Background launch ignores cancellation
- Severity: High
- Axis: Correctness
- Location: H/tools/bash.ts:execute; H/env/background-task-manager.ts:start; background-task-types.ts:start.
- Problem: Abort during prepare/cwd/stat/shell awaits does not prevent spawn; background start receives no signal.
- Impact: Cancelled calls launch persistent side-effecting processes.
- Recommended fix: Thread an admission signal and recheck immediately before spawn; retain independence after adoption. Test G1.
- Certainty: High confidence — full tool→manager→spawn trace.

F02 Concurrent durable admission
- Severity: High
- Axis: Correctness
- Location: H/agent-harness.ts:navigateTree,resume.
- Problem: Busy checks precede awaited getEntry/reduceCurrent with no reservation/recheck. Navigation/prompt or two resumes can both pass.
- Impact: Duplicate execution/multiple operations; reducer rejects the resulting log.
- Recommended fix: Reserve ownership synchronously through preparation. Test H1.
- Certainty: High confidence — corroborated by H/reducer.ts:validateRecordLog.

F03 Pause loses operation ownership
- Severity: High
- Axis: Correctness
- Location: H/agent-harness.ts:drive(op.pausing),prompt,abort.
- Problem: Pause clears activeOperation although the durable operation remains open.
- Impact: New prompt creates a second operation; abort incorrectly reports NoActiveOperation.
- Recommended fix: Retain operation ownership separately from driver activity. Test H2.
- Certainty: High confidence — existing pause test verifies the open suspended operation.

F04 Queue admission after abort/finish
- Severity: High
- Axis: Correctness
- Location: H/agent-harness.ts:enqueue,abort,finishRun.
- Problem: enqueue checks only activeOperation.kind before awaiting. With a pending provider, await abort(); await steer() still appends after cancellation.
- Impact: Accepted input creates queue_after_abort; a finish race creates record_after_finish corruption.
- Recommended fix: Serialize enqueue with abort/finish and recheck state at admission. Test H3.
- Certainty: High confidence — exact violations rejected by reducer.

F05 Cancelled queue items are still consumed
- Severity: High
- Axis: Correctness
- Location: H/agent-harness.ts:drainQueued,prompt initialMessages,drive missingInitialMessages.
- Problem: Cancellation can win after item capture; consumption checks entry existence but not cancellation. nextRun application bypasses the queue lock.
- Impact: Cancelled input is delivered, then reducer rejects invalid_queue_cancellation.
- Recommended fix: Revalidate pending state under serialized consumption/acceptance. Test H4.
- Certainty: High confidence — complete lock body inspected.

F06 Execution target changes after validation
- Severity: High
- Axis: Correctness
- Location: H/agent-harness.ts:advanceToolBatch→executeToolCall.
- Problem: After activation/approval/schema checks and awaited intent persistence, executeToolCall re-resolves by name only. setTools/setActiveTools can intervene.
- Impact: Revoked or approval-required replacement executes with differently validated arguments.
- Recommended fix: Carry validated binding; recheck current activation/approval before dispatch. Test H5.
- Certainty: High confidence — setters and second lookup inspected.

F07 Idempotent live timeout treated as settled
- Severity: High
- Axis: Correctness
- Location: H/agent-harness.ts:executeWithTimeout,executeToolCall; A/tool-outcome.ts:getToolErrorOutcome.
- Problem: A non-cooperative idempotent mutation stays pending after timeout, but idempotence classifies it confirmed and continuation proceeds.
- Impact: Later different writes race with the original; safe repetition of A does not imply safe concurrent A/B.
- Recommended fix: Keep live timed-out mutations uncertain/owned regardless of replay safety. Test H6.
- Certainty: High confidence — unsettledTools does not gate continuation.

F08 Provider dispatched after cancellation
- Severity: Medium
- Axis: Correctness
- Location: H/agent-harness.ts:runAssistantStep.
- Problem: Async branch/conversion/systemPrompt work follows the control check; streamFn is unconditional afterward.
- Impact: Abort/close during preparation still reaches provider dispatch.
- Recommended fix: Capture controller/operation and recheck immediately before streamFn. Test H7.
- Certainty: High confidence — server factory supplies async systemPrompt.

F09 Idle waiter ignores preparation
- Severity: Medium
- Axis: Correctness
- Location: H/agent-harness.ts:prompt,waitForIdle,runWhenIdle.
- Problem: driverPromise is installed after intent persistence; idle waiting observes only driverPromise.
- Impact: Idle callbacks run during accepted preparation.
- Recommended fix: Install settlement promise at reservation. Test H8.
- Certainty: High confidence — direct await ordering.

F10 Progress counters cross user boundaries
- Severity: Medium
- Axis: Correctness
- Location: H/agent-harness.ts:detectNoProgress,drive; A/agent-loop.ts:runLoop.
- Problem: Harness counters never reset per drive and fingerprint text-only assistants. Agent counters survive new queued inputs/non-tool turns.
- Impact: Legitimate repeated requests stop; four identical independent text prompts trigger the harness guard.
- Recommended fix: Reset at run/explicit-input boundaries; count uninterrupted tool continuations. Tests H9/A1.
- Certainty: High confidence — full modules inspected.

F11 Image progress discarded
- Severity: Medium
- Axis: Correctness
- Location: A/no-progress.ts:fingerprintToolResult.
- Problem: Fingerprint includes image MIME/type but not data; changing screenshots at one path compare equal.
- Impact: Visual workflows stop after three different observations.
- Recommended fix: Include deterministic image digest/identity. Test A2.
- Certainty: High confidence — read tools emit the relevant shape.

F12 Retry/checkpoint usage lost
- Severity: Medium
- Axis: Correctness
- Location: H/agent-harness.ts:runAssistantStep,checkBudgets.
- Problem: Retry continues/checkpoint returns precede the sole usage append.
- Impact: Ledger/maxTokens undercount consumed provider work.
- Recommended fix: Persist each settled attempt's usage once before branching. Test H10.
- Certainty: High confidence — retry fixtures report nonzero usage on both attempts.

F13 Late search spawn after abort
- Severity: Medium
- Axis: Correctness
- Location: C/grep.ts:execute; C/find.ts:execute.
- Problem: grep does not recheck after ensureTool/isDirectory; find does not recheck after ancestor traversal/fd probe. Cancellation may already have fired/detached.
- Impact: Cancelled searches spawn; find can leave an unowned child.
- Recommended fix: Check current signal/settled state immediately before spawn. Test C1.
- Certainty: High confidence — full execution paths inspected.

F14 Missing-target aliases bypass mutation queue
- Severity: Medium
- Axis: Correctness
- Location: H/tools/file-mutation-queue.ts:getMutationQueueKey; C/file-mutation-queue.ts:getMutationQueueKey.
- Problem: realpath failure falls back to lexical path; real/symlink-parent aliases of a new file get different queues.
- Impact: Mutations of one physical file overlap; key also changes after creation.
- Recommended fix: Canonicalize nearest existing ancestor plus missing suffix. Tests G2/C2.
- Certainty: High confidence — existing alias test covers existing files only.

F15 Shutdown claims completion before log close
- Severity: Medium
- Axis: Correctness
- Location: H/env/background-task-manager.ts:finalize,shutdown,cleanup.
- Problem: Task becomes terminal before writer close. Deadline reporting uses terminal status, not settledPromise.
- Impact: complete:true allows cleanup to drop ownership while writer/lease remains live.
- Recommended fix: Track process-plus-writer settlement in report. Test G3.
- Certainty: High confidence — close gates resolveSettled, not reporting.

F16 Incomplete shutdown report stays cached
- Severity: Medium
- Axis: Correctness
- Location: H/env/background-task-manager.ts:shutdownPromise,shutdown,cleanup.
- Problem: Deadline's incomplete report is cached even after tasks settle; only complete:true clears it.
- Impact: Retry cleanup cannot complete/reuse the manager.
- Recommended fix: Cache in-flight join only, or refresh/rejoin on retry. Test G4.
- Certainty: High confidence — no terminal invalidation exists.

F17 Background UTF-8 chunk corruption
- Severity: Medium
- Axis: Correctness
- Location: H/env/background-task-manager.ts:attach drain.
- Problem: Per-buffer toString corrupts multibyte characters split between chunks.
- Impact: task_output/wait_for preview and byte accounting diverge from correct raw log.
- Recommended fix: Independent streaming stdout/stderr decoders; flush on settlement. Test G5.
- Certainty: High confidence — foreground paths already use streaming decoders.

F18 Promotion wins after abort/callback failure
- Severity: Medium
- Axis: Correctness
- Location: H/env/node-process-executor.ts:execute timeout callback.
- Problem: Kill is requested but promotion stays enabled until asynchronous exit. Timer adoption can win; promotedTaskId overrides failure/abort handling.
- Impact: Failed/cancelled execution reports successful background promotion.
- Recommended fix: Disable adoption after abort/callbackError; retain ownership until exit. Test G6.
- Certainty: High confidence — static kill/timeout/exit interleaving.

F19 Raw streams hang on producer rejection
- Severity: Medium
- Axis: Correctness
- Location: A/agent-loop.ts:agentLoop,agentLoopContinue; packages/ai/src/utils/event-stream.ts:EventStream.
- Problem: Wrappers attach only success handling; allowed prepareRequest/persistence rejection leaves the stream open.
- Impact: Iterator/result hangs and detached promise rejects unhandled.
- Recommended fix: Define failure termination for iterator/result; wire rejection handlers. Test A3.
- Certainty: High confidence — callback and stream contracts inspected.

RECOMMENDED TESTS — NOT RUN
Prefixes: AT=packages/agent/test; HT=packages/agent/test/harness; CT=packages/coding-agent/test.
G1: HT/bash.test.ts, HT/background-task-manager.test.ts, CT/bash-tool-contract.test.ts: gate prepare/shell resolution, abort then release; zero launches/tasks, not_started.
G2: HT/tools.test.ts: absent target under symlinked parent must share queue.
G3–G6: HT/background-task-lifecycle-regression.test.ts: withhold log close past deadline; retry after eventual settlement; split UTF-8 across both pipes; delay exit after cancellation/callback error then fire promotion timer.
H1–H4/H8: HT/agent-harness-controls.test.ts: concurrent resume/navigation barriers; prompt rejection/abort after pause; steer-after-abort and enqueue-vs-finish; cancel-vs-consume/nextRun capture both orders; idle waiter during intent persistence. Reopen/reduce resulting logs.
H5/H6: HT/agent-harness-tool-gateway.test.ts: revoke/replace during tool_started append; non-cooperative idempotent timed-out write must not overlap later conflicting write.
H7: HT/agent-harness-faults.test.ts: abort/close during async prompt/conversion preparation; provider uncalled.
H9/H10: HT/agent-harness-budgets.test.ts: four independent identical text prompts; retry/checkpoint usage sum and token budget.
A1–A3: AT/agent-loop.test.ts: separate follow-ups repeating read; distinct versus identical images; rejecting preparation/persistence settles stream without unhandled rejection.
C1: new CT/search-tool-cancellation.test.ts: abort during ensureTool/isDirectory/fd probe, then release; no spawn.
C2: CT/file-mutation-queue.test.ts: missing real/alias target and absent→created key change; maximum active mutation callbacks one.

COVERAGE
Full reads: agent README and harness.md; coding-agent sdk.md; AGENTS/review/best-practice. Sources: A/{agent,agent-loop,resource-scheduler,run-scope,step-snapshot,tool-plan,tool-schema,tool-outcome,no-progress,types}; H/{agent-harness,reducer}; H/env/{node-process-executor,background-task-manager,background-task-types,nodejs}; H/tools/{read,write,edit,bash,background-tasks,index,file-mutation-queue,path-utils,workspace-policy,tool-context,execution-tool-error,bash-outcome}; H/utils/shell-output; C/{read,write,edit,bash,find,grep,ls,background-tasks,output-accumulator,file-mutation-queue,tool-definition-wrapper}; coding-agent server/create-harness and core/nested-tool-calls; AI EventStream. Focused tests read for admission/scheduler/run scope/tool plans/outcomes; harness controls/budgets/gateway/faults/operations/process/background/log admission/wait; coding mutation queues and recovery-driver regression. Inventory paged. Bounded boundary review, not exhaustive assessment of every dependency/test.
Chains traced: Agent→RunScope→snapshot→preflight→policy→scheduler→dispatch→persistence/events; durable controls→reducer→provider/tool; server→bound tools; coding Bash→core Bash→capture/process→promotion/background→shutdown/log close; mutations→canonical queue.

GAPS / OPPORTUNITIES
No executable validation; regression confirmation remains required. Excluded harness/session implementation, full AgentSession/provider audit, TUI rendering, edit-matching algorithms and OS reproduction. No independent baseline test claim.
Both read implementations load whole files before offset/limit: output cap is not a memory/I/O cap. readTextRange is a starting point; no measured optimization claim. Scheduler fairness is unspecified, so reader overtaking is not a confirmed starvation defect. Log writes ignore backpressure but default persisted-byte caps bound output queues; profile first.
Explicit scaffold gaps (hooks/multilane/manual APIs, ignored async projectors, unused toolContext/toolExecution options) are capability/documentation opportunities. harness.md describes future replacement; findings rely on current source/tests. Ordinary settled replay-safe failures, late acknowledged writes, known Bash nonzero exits, ordered results and wait cancellation without killing tasks are intentional.

IMPLEMENTATION OWNERSHIP
A/{agent-loop,no-progress}.ts; H/agent-harness.ts; H/env/{background-task-manager,background-task-types,node-process-executor}.ts; H/tools/{bash,file-mutation-queue}.ts; C/{find,grep,file-mutation-queue}.ts; listed regression files. Coordinate EventStream or durable-session API changes with their owners. Root task/report and session backends remain excluded.
