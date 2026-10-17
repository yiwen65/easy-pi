# 扩展与 UI 初审证据（实施前，只读）

历史初审证据；不是最终验收状态。最终状态见主报告与唯一任务计划。

T-006 — read-only audit report, not overall acceptance.
Root /Users/w/Projects/easy-pi/pi. Supplied baseline f7606c3df / my-pi; not git-verified. No edits or tests executed.
Paths: CA = packages/coding-agent; T = packages/tui; IM = CA/src/modes/interactive/interactive-mode.ts; RPC = CA/src/modes/rpc/rpc-mode.ts. Unqualified test paths below are under CA. Every recommended test remains NOT RUN.

## Findings

### F1. Escape terminal titles
- Severity: High
- Axis: Security
- Location: `T/src/terminal.ts::ProcessTerminal.setTitle`; `IM::updateTerminalTitle`
- Problem: setTitle interpolates text into OSC 0; its caller passes cwd basename unchanged. A POSIX directory name containing BEL followed by another OSC terminates the title and injects a terminal command, without project extensions.
- Impact: Opening that directory can alter clipboard/title/terminal state on supporting terminals; no shell-execution claim.
- Recommended fix: Strip title controls/delimiters. Extend `T/test/terminal.test.ts`: BEL, ESC-ST, OSC 52 and CR/LF cannot emit another command; Unicode survives.
- Certainty: High confidence — direct caller/output trace; terminal effects capability-dependent.

### F2. Sanitize untrusted transcript text
- Severity: High
- Axis: Security
- Location: `CA/src/modes/interactive/components/assistant-message.ts::updateContent`; `CA/src/core/tools/bash.ts::formatBashCall`; `T/src/utils.ts::normalizeTerminalOutput`
- Problem: Assistant text/thinking/errors and bash argument previews enter Markdown/Text unsanitized. Wrapping preserves escapes; final normalization removes only DEC private modes, retaining OSC 52 and cursor/erase controls. Grok delegates to this renderer.
- Impact: Model/provider text or arguments can overwrite clipboard or spoof the display. Ordinary tool-result text is already sanitized and is not this gap.
- Recommended fix: Sanitize untrusted inputs before host styling. Extend `test/assistant-message.test.ts`, `test/tool-execution-component.test.ts`, `T/test/terminal-output-safety.test.ts`: malicious controls absent from terminal writes; host styles/images/links preserved.
- Certainty: High confidence — complete rendering/write paths inspected, not executed.

### F3. Roll back failed factory registrations
- Severity: Medium
- Axis: Correctness
- Location: `CA/src/core/extensions/loader.ts::runExtensionFactory/createExtensionRuntime/createExtensionAPI`
- Problem: Failure rollback restores only MCP registrations. Provider queues, flag defaults and event-bus subscriptions survive a factory throwing. bindCore flushes that failed extension's provider; bus listeners remain; its flag default can win over a later valid factory.
- Impact: An extension reported as unloaded still influences the session without normal lifecycle handlers.
- Recommended fix: Undo factory-owned shared mutations/subscriptions. Extend `test/extensions-runner.test.ts`: failed provider/default/listener absent, previous successful state preserved, subsequent factory works. Keep MCP rollback coverage.
- Certainty: High confidence — loader/runner/event-bus chain inspected.

### F4. Catch synchronous shortcut exceptions
- Severity: Medium
- Axis: Correctness
- Location: `IM::setupExtensionShortcuts`
- Problem: `Promise.resolve(shortcut.handler(createContext())).catch(...)` invokes before Promise.resolve; synchronous throws escape through CustomEditor/TuiBase input dispatch.
- Impact: uncaughtCrash exits the application and kills tracked children rather than reporting the intended shortcut error. Terminal restoration exists.
- Recommended fix: Guard invocation or invoke in `.then(...)`. New `test/interactive-extension-ui.test.ts`: sync throw and async rejection each display one error; further input works.
- Certainty: High confidence — invocation and crash paths inspected.

### F5. Settle displaced extension dialogs
- Severity: Medium
- Axis: Correctness
- Location: `IM::showExtensionSelector/showExtensionInput/showExtensionEditor/resetExtensionUI`
- Problem: A second dialog overwrites shared fields/editor content without settling the first promise. disposeActiveSelector owns a separate built-in-selector token. Old timeout/abort callbacks hide the newer dialog; reset also hides without settling.
- Impact: Concurrent extension tools hang on invisible questions or dismiss unrelated questions.
- Recommended fix: Serialize or explicitly cancel displaced dialogs; instance-bound cleanup and exactly-once settlement. `test/interactive-extension-ui.test.ts`: open A/B, abort/timeout A, reset; B is not accidentally hidden and no promise hangs.
- Certainty: High confidence — complete show/hide/component-disposal paths inspected.

### F6. Retain custom-overlay ownership
- Severity: Medium
- Axis: Correctness
- Location: `IM::showExtensionCustom/resetExtensionUI`; `T/src/tui.ts::showOverlay/hideOverlay`
- Problem: custom() discards its specific handle; done() pops the global stack. Closing A after B opens removes B and disposes still-mounted A. Reset removes only one overlay. done-before-async-factory-resolution also abandons the returned component without disposal.
- Impact: Wrong focus/dialog removal, mounted stale components and leaked component resources.
- Recommended fix: Keep each invocation's handle/settlement/disposal state; dispose late factory results and all owned UI on reset. `test/interactive-extension-ui.test.ts`: non-LIFO closure, two-overlay reset, early done, exactly-once disposal.
- Certainty: High confidence — complete adapter/stack inspected.

### F7. Ignore stale clipboard completion
- Severity: Medium
- Axis: Correctness
- Location: `IM::handleClipboardPaste`
- Problem: After asynchronous clipboard retrieval, insertion targets the current this.editor without captured editor/draft/session generation. /new, submission or editor replacement during retrieval redirects the old paste. CustomEditor's file-image paste already has a generation guard.
- Impact: Unexpected images/text enter another prompt/session and may be transmitted unintentionally.
- Recommended fix: Guard completion by editor and draft/session generation. New `test/interactive-mode-clipboard.test.ts`: deferred retrieval followed by replacement/clear/submission must not insert; unchanged draft succeeds.
- Certainty: High confidence — asynchronous clipboard and both paste paths inspected.

### F8. Cache converted images by identity
- Severity: Medium
- Axis: Correctness
- Location: `CA/src/modes/interactive/components/tool-execution.ts::updateResult/maybeConvertImagesForKitty/updateDisplay`
- Problem: convertedImages is keyed only by index across updates. Partial JPEG A starts conversion; final PNG B replaces index 0; A's late completion caches A and updateDisplay renders it over B. Existing cache also prevents changed JPEG conversion.
- Impact: Kitty displays obsolete rather than authoritative final imagery.
- Recommended fix: Bind cache/conversion to content identity/generation; ignore stale completion. Extend `test/tool-execution-component.test.ts`: deferred A conversion followed by PNG B and JPEG B, latest image wins.
- Certainty: High confidence — complete component/converter inspected.

### F9. Install RPC plumbing before startup hooks
- Severity: Medium
- Axis: Correctness
- Location: `RPC::runRpcMode/rebindSession`; `CA/src/modes/print-mode.ts::rebindSession`; `CA/src/core/agent-session.ts::bindExtensions`
- Problem: RPC awaits bindExtensions before installing JSONL reader/signals. bindExtensions awaits startup/discovery hooks: a startup UI dialog emits a request whose response cannot be read. RPC/print event/backpressure subscriptions also start after binding, although binding can execute task recovery.
- Impact: Startup-dialog deadlock, lost startup/recovery events, unavailable RPC abort during startup recovery.
- Recommended fix: Install transport/signals/subscriptions first; allow UI responses/abort while gating ordinary commands until ready. New `test/rpc-mode-lifecycle.test.ts`: startup-confirm round trip and faux recovery event capture. Extend `test/print-mode.test.ts` for events emitted during binding.
- Certainty: High confidence — complete modes and binding flow inspected.

### F10. Remove duplicate RPC replacement binding
- Severity: Medium
- Axis: Correctness
- Location: `RPC::handleCommand(new_session/switch_session/fork/clone)`; `CA/src/core/agent-session-runtime.ts::finishSessionReplacement`
- Problem: Replacement internally invokes the registered rebind callback, then RPC's command handler calls rebind again. Each bindExtensions emits session_start/resources_discover.
- Impact: Duplicate initialization side effects: watchers/processes/messages/dialogs. Replacing subscriptions cannot undo these.
- Recommended fix: Runtime callback is sole rebind owner. `test/rpc-mode-lifecycle.test.ts`: host invokes its registered callback; exactly one start/discover per successful replacement, none on cancellation.
- Certainty: High confidence — full replacement chain inspected. Existing interactive duplicate-subscription test does not cover RPC.

### F11. Validate RPC envelopes
- Severity: Medium
- Axis: Correctness
- Location: `RPC::handleInputLine`
- Problem: JSON null is cast to RpcCommand. handleCommand throws reading id; catch reads command.id/type again and throws outside error-response handling. JSONL callback ignores the rejected promise.
- Impact: Malformed input causes unhandled rejection/process termination instead of a protocol error.
- Recommended fix: Validate object/type metadata before dispatch and use validated metadata in catch. New `test/rpc-input-validation.test.ts`: null/scalars/arrays/malformed objects yield errors; next get_state succeeds; unknown-command ID preserved.
- Certainty: High confidence — direct control-flow trace.

### F12. Respect deferred RPC shutdown
- Severity: Medium
- Axis: Correctness
- Location: `RPC::checkShutdownRequested/handleInputLine/handleCommand(prompt)`
- Problem: Shutdown checks only the flag after every command. A tool requests shutdown while active; get_state polling immediately disposes it. Fire-and-forget prompt dispatch can also reach the check before an extension command's acceptance response.
- Impact: ctx.shutdown interrupts active/queued work or exits before its response, contrary to documented deferral.
- Recommended fix: Require settlement and completed/flushed initiating response; external signals stay immediate. `test/rpc-mode-lifecycle.test.ts`: shutdown from blocked faux tool plus polling does not dispose until settled; shutdown command receives success before exit.
- Certainty: High confidence — unconditional check/async response ordering inspected.

### F13. Reject errors in void RpcClient methods
- Severity: Medium
- Axis: Correctness
- Location: `CA/src/modes/rpc/rpc-client.ts::send/prompt/steer/followUp/setThinkingLevel/setSessionName`
- Problem: send resolves every response; only getData checks success. Void methods discard success:false, including realistic missing-auth or streaming prompt rejection.
- Impact: False success; promptAndWait can await nonexistent settlement and mask the server error.
- Recommended fix: Enforce success centrally/all public methods; cancel collector on prompt rejection. New `test/rpc-client-errors.test.ts`: fake-child failed prompt/steer/set_session_name/promptAndWait immediately reject with original error, no dangling timer.
- Certainty: High confidence — full client and server-response tests inspected.

### F14. Route shortcut shutdown through the bound handler
- Severity: Low
- Axis: Correctness
- Location: `IM::setupExtensionShortcuts`
- Problem: Its manual ctx.shutdown only sets a flag, unlike the normal binding which immediately shuts down when idle. Next check is agent_settled.
- Impact: Idle shutdown shortcut does nothing until a later run finishes.
- Recommended fix: Reuse runner context/bound shutdown. `test/interactive-extension-ui.test.ts`: idle request initiates shutdown; active request defers until settled.
- Certainty: High confidence — context, binding and settlement paths inspected.

### F15. Fix stale bash-renderer assertions
- Severity: Low
- Axis: Correctness
- Location: `CA/test/tool-execution-component.test.ts:239,309-312`; `CA/src/core/tools/bash.ts::rebuildBashResultRenderComponent`
- Problem: Two baseline tests require Full output:, but renderer emits Output log: or Truncated output log: after removing provider footer. Persisted logs can be capped; old universal wording is misleading.
- Impact: Two failing tests despite the current annotation being present.
- Recommended fix: Assert current label/path once, retain spacing/truncation checks, add capped-log wording case. Run this targeted test file.
- Certainty: Confirmed — observed `/tmp/pi-harness-baseline-tests.log:340-370` and full tests/renderer; baseline not executed by me.

## Coverage
Full production reads under CA/src: core/extensions/{loader,runner,wrapper}.ts; core/{resource-loader,event-bus,agent-session-runtime}.ts; core/tools/{bash,render-utils}.ts; modes/{print-mode,json-event}.ts; modes/rpc/{rpc-mode,rpc-client,jsonl}.ts; modes/interactive/components/{assistant-message,custom-editor,extension-selector,extension-input,markdown-transform,tool-execution}.ts; modes/interactive-grok/{pi-session-port,pi-session-events,grok-interactive-view}.ts and components/grok-assistant-message.ts; utils/{clipboard-image,image-convert}.ts.
Full T/src reads: {terminal,stdin-buffer,tui,tui-main-screen,tui-alt-screen,utils}.ts and components/{markdown,text}.ts. Full grok-tui source: index, actions, state, reducer, runtime-controller, action-terminal, grok-tui-runtime. Full compat entrypoint.
Partial reads: IM lines 1–5499 and 6800–end (complete relevant startup/binding/dialog/input/event/shutdown functions); AgentSession hook installation/binding/reload excerpts; extension types UI/context declarations; ModelRuntime composition excerpt. NOT per-file exhaustive review of these large modules.
Contracts fully read: CA README and docs/{extensions,tui,rpc,json}.md; tui README; compat README; root AGENTS and review/best-practice skills. Inventory paged throughout.
Tests fully read: CA resource-loader, extensions-runner, extensions-mcp-api, print-mode, rpc, rpc-prompt-response-semantics, rpc-client-process-exit, assistant-message, tool-execution-component, grok-pi-session-port; regressions 7193-event-bus-lifecycle, 5868-rpc-unknown-command-id, startup-session-rebind-duplicate-subscription; T terminal-output-safety; grok runtime; compat exports.
Chains traced: factory→shared runtime→runner; replacement→mode rebind→hooks; RPC input→command/response/dialog; keyboard→CustomEditor→callback; model/result→components→normalization→terminal; ActionTerminal→controller/reducer→renderer; session→PiSessionPort.

## Exclusions / validation gaps
- Full extension permissions are intentional, not a sandbox defect. tool_call exceptions remain fail-closed through AgentSession. Existing sanitized tool-result rendering and per-overlay hide handles should be reused.
- No actionable issue established in reviewed Grok reducer/runtime or compat contracts; no speculative rewrite proposed.
- JSON print mode checks assistant failure exit status only in text mode. Confirm intended JSON automation contract before labeling that a defect.
- Other widgets, editor/autocomplete/key parsing, layout internals, remaining selectors, native helpers, CLI/packaging and nested execution internals are not exhaustively reviewed. No performance claims.
- No recommended test, PTY/terminal, Windows/SSH, clipboard, loader or provider execution performed. Validate terminal bytes first, then controlled terminal behavior. No paid provider required.

## Proposed implementation ownership
CA/src/core/extensions/loader.ts (types.ts if necessary); modes/rpc/{rpc-mode,rpc-client}.ts; modes/print-mode.ts; IM; modes/interactive/components/{assistant-message,tool-execution}.ts; core/tools/{bash,render-utils}.ts; T/src/{terminal,utils}.ts; named tests above. Coordinate AgentSession/runtime changes with their owner. Root decides reproduction, remediation and acceptance.
