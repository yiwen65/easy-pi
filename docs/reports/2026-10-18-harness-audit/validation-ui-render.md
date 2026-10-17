# 实施与验证回执快照

这是实现 worker 的证据回执，不是最终接受声明。最终状态由唯一任务计划及 root 复查记录决定。

Implemented T-040, T-041, T-042, T-047, T-054. Recommended status: ready for coordinator review/check, not root acceptance. Baseline HEAD f7606c3df763e4dcbc75261211346e67124ee628.

Per-task evidence and fixes:
- T-040/F1: mocked ProcessTerminal stdout reproduced BEL/OSC title injection. terminal.ts:544-548 now removes C0/C1/DEL from title payload only, preserving Unicode and legitimate host protocol writes. Regression covers BEL, ESC-ST, OSC52, C1-ST/OSC, CR/LF/tab/NUL/backspace/DEL.
- T-041/F2: cumulative partial assistant text/thinking/error/abort and bash command/cwd strings reproduced escaping controls; captured TuiAltScreen writes contained injected OSC52. render-utils.ts:39-45 sanitizes untrusted display text before host styling; assistant-message.ts:138,155,223,226 and bash.ts:283-285 use it. Existing tool-result sanitization now also removes residual C1/DEL. Tests exercise every prefix of adversarial OSC/CSI/APC/C0/C1 inputs, unchanged source messages/arguments, Unicode, host styling, hyperlinks, image protocol preservation. No global output stripping or tui/utils.ts changes.
- T-042/F3: focused pre-fix tests reproduced failed provider queue mutation, leaked flag default, and leaked event listener (3 expected failures). loader.ts:254-259,333-359,439-487,566-595 stages factory provider additions/removals and flag defaults until success, cleans failed factory subscriptions, retains existing MCP rollback. Tests preserve earlier successful/default/CLI state, later factories, same-factory getFlag, interleaved successful loading, post-bind provider/flag behavior, normal unsubscribe and lifecycle cleanup. No types.ts changes.
- T-047/F8: deferred conversion A overwrote final PNG B and JPEG B; repeated identical partial images also converted twice. tool-execution.ts:188-235,373-378 associates pending/completed conversion with source data+MIME and per-entry identity; replacement/removal invalidates stale work before display. Tests cover PNG/JPEG replacement, deduplication, completed-cache replacement, removal, stale rejection and preserved Kitty output.
- T-054/F15: reproduced both stale Full output: assertion failures. Tests now require Output log: and the path exactly once, retain final status/spacing/truncation/footer-deduplication checks, and cover Truncated output log: with capped-log wording. No renderer label change.

Red logs:
- /tmp/pi-fix-ui-terminal-red.log: node:test 23 passed, 1 failed; title payload retained BEL/ESC.
- /tmp/pi-fix-ui-render-red.log: initial mixed run 15 failed, 100 passed. One failure was my native-provider fixture missing an API implementation, not product evidence; fixed fixture and reran the factory group.
- /tmp/pi-fix-ui-factory-red.log: 3 failed, 63 skipped, all expected rollback assertions.

Final verification (all exit 0):
1. From packages/coding-agent: node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/assistant-message.test.ts test/tool-execution-component.test.ts test/extensions-runner.test.ts test/extensions-mcp-api.test.ts test/extensions-discovery.test.ts test/resource-loader.test.ts test/ansi-utils.test.ts test/bash-tool-contract.test.ts test/grok-visual-render.test.ts test/suite/regressions/7193-event-bus-lifecycle.test.ts test/suite/regressions/4167-thinking-toggle-pending-tool-render.test.ts
   Output: Test Files 11 passed (11); Tests 243 passed (243). /tmp/pi-fix-ui-render-green.log.
2. From packages/tui: node --test test/terminal.test.ts test/terminal-output-safety.test.ts test/tui-alt-screen.test.ts test/terminal-image.test.ts
   Output: tests 146; pass 146; fail 0. /tmp/pi-fix-ui-terminal-neighbors.log.
3. Explicit-owned-file Biome check --write --error-on-warnings: Checked 11 files; fixed formatting in 7. /tmp/pi-fix-ui-render-biome.log. Subsequent scoped git diff --check passed and production diff reviewed.

Complete changed-file list (relative to pi/):
packages/tui/src/terminal.ts
packages/tui/test/terminal.test.ts
packages/tui/test/terminal-output-safety.test.ts
packages/coding-agent/src/core/extensions/loader.ts
packages/coding-agent/src/core/tools/bash.ts
packages/coding-agent/src/core/tools/render-utils.ts
packages/coding-agent/src/modes/interactive/components/assistant-message.ts
packages/coding-agent/src/modes/interactive/components/tool-execution.ts
packages/coding-agent/test/assistant-message.test.ts
packages/coding-agent/test/tool-execution-component.test.ts
packages/coding-agent/test/extensions-runner.test.ts

Ownership: bash.ts is released; only sanitizer import and formatBashCall changed. No docs/plans/reports, types.ts, dependencies/lockfiles, or commits changed. Shared unrelated edits left intact.

Coordinator doc recommendations: extensions.md Async factory functions should state unsuccessful factories discard provider registrations/removals and flag defaults and unsubscribe their event listeners, without promising rollback of arbitrary external side effects. tui.md can document built-in untrusted assistant/errors/bash previews being sanitized before styling, trusted extension-rendered output remaining intact, and setTitle accepting plain text with controls removed.

Limits: root npm run check/typecheck/build intentionally not run; no real provider APIs, clipboard/native desktop effects, or real terminal GUI validation. Tests use byte capture, virtual terminals, mocked conversions/providers and faux lifecycle harness. Scope does not establish safety of every other widget or trusted extension renderer.
