# 复查与后续验证证据

历史回执；最终状态见任务计划与主报告。

Implemented all three assigned review followups for T-020/T-041/T-042; independently reproduced each before production edits. Recommended status: ready for root review/serial checks, not accepted. T-041 has a NEW related tool-name ingress finding below requiring root planning before claiming comprehensive UI safety.

Base: f7606c3df763e4dcbc75261211346e67124ee628. Preserved inherited changes; no commits, shared-doc/type/InteractiveMode changes, dependency changes, root check/build, real APIs, terminal interaction, or shell deletion.

Changed files (9):
1. packages/permissions/src/permissions.ts:782-788 — canonicalize normalized invocation cwd physically before interpreting command-relative targets; session/inherited/root/home protections stay unchanged.
2. packages/permissions/test/permissions.test.ts:89 onward — exact outside/entry -> workspace/sub symlink trace; absolute/relative/file-URL cwd, rm/find/git/nested-shell cases, scratch allowance and execution's lexical cwd normalization.
3. packages/coding-agent/test/suite/regressions/bash-cwd-breaker.test.ts:74 onward — faux-provider harness with an injected recording executor. Dangerous parent cleanup is denied; harmless scratch cleanup/pwd reach the fake executor in the expected physical directory. No shell runs.
4. packages/coding-agent/src/core/extensions/loader.ts:256,274-280,590-592 — factory-local failed state; every API guard checks it, set before cleanup. Already-running callbacks cannot regain access after factory rejection; shared successful runtime remains live.
5. packages/coding-agent/test/extensions-runner.test.ts:992 onward — emit start before factory throw; release suspended handler only after rejected load/cleanup. Six API actions rejected; three controlled repetitions both before and after bindCore. Previous successful extension remains usable.
6. packages/coding-agent/src/modes/interactive-grok/components/grok-thinking-turn-group.ts:52 — sanitize before Map storage/Markdown/scroller.
7. packages/coding-agent/src/modes/interactive-grok/components/grok-assistant-message.ts:33 — sanitize standalone live thinking before flattening/storage.
8. packages/coding-agent/src/modes/interactive-grok/components/grok-tool-execution.ts:13,33 — sanitize string and JSON-fallback summaries before styling/group scroller ingress. Group component needed no edit.
9. packages/coding-agent/test/grok-display-safety.test.ts — grouped/standalone, collapsed/expanded, all prefixes of OSC/C1/CSI/APC/control payloads, final/history, virtual-terminal write capture, host style/hyperlink preservation, and unchanged raw messages/args.

Red evidence:
- permissions cwd: `PI_OFFLINE=1 node --test test/permissions.test.ts` — 14 passed/1 failed; exact rm -rf ../* decision was allow, expected deny. /tmp/pi-review-boundaries-permissions-red.log.
- coding-agent cwd: `PI_OFFLINE=1 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/grok-display-safety.test.ts test/extensions-runner.test.ts test/suite/regressions/bash-cwd-breaker.test.ts` — 70 passed/14 failed. /tmp/pi-review-boundaries-coding-red.log.
- Repeated exact OSC/gated cases with named files and `-t 'virtual-terminal writes|in-flight listener'`: 6 failed/75 skipped. /tmp/pi-review-boundaries-exact-red.log. Suspended failed-factory handler accepted all 6 calls; flag map grew 1 -> 2 and leaked listener ran once. After fix: all 6 reject, flag map remains 1, leaked-listener deliveries 0, successful API still works. OSC52 reproduced in collapsed and expanded group/tool virtual writes; expanded standalone assistant was already safe via base renderer.

Final verification:
- permissions cwd: `PI_OFFLINE=1 node --test test/permissions.test.ts` — 15/15 passed; /tmp/pi-review-boundaries-permissions-final.log.
- permissions cwd: `PI_OFFLINE=1 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/external-mutation-journal.test.ts` — 3/3 passed; /tmp/pi-review-boundaries-permissions-neighbor-green.log.
- coding-agent cwd: same root Vitest CLI, `--run test/grok-display-safety.test.ts test/extensions-runner.test.ts test/suite/regressions/bash-cwd-breaker.test.ts test/grok-transcript-components.test.ts test/grok-visual-render.test.ts test/grok-thinking-mouse.test.ts test/live-line-scroller.test.ts test/assistant-message.test.ts test/tool-execution-component.test.ts test/extensions-mcp-api.test.ts test/extensions-discovery.test.ts test/bash-tool-contract.test.ts` — 12 files, 237/237 passed, repeated after final test edits. /tmp/pi-review-boundaries-coding-final.log.
- Scoped Biome check of all 9 owned files: clean, no fixes applied; /tmp/pi-review-boundaries-biome.log. Scoped tracked-file git diff --check: clean.
- One validation invocation initially mixed permissions' node:test file with its Vitest journal neighbor; journal failed to find a Vitest suite. Corrected runners above both pass. Original log retained: /tmp/pi-review-boundaries-permissions-runner-mismatch.log.

NEW related finding (reported via progress; not patched due ownership/scope): raw provider tool names still carry OSC52 through Grok name headers and base fallback. InteractiveMode message_update passes content.name directly to component creation before tool dispatch (interactive-mode.ts:3525 onward); sinks include grok-tool-execution.ts:67,185, grok-tool-turn-group.ts:141, and unowned interactive/components/tool-execution.ts:145,407. Safe source-runtime probe `/tmp/pi-review-boundaries-grok-name-probe.ts`, run from coding-agent with `PI_OFFLINE=1 node --conditions=development /tmp/pi-review-boundaries-grok-name-probe.ts`, reports OSC52 counts standalone/grouped = 1/1 collapsed, 2/3 expanded. It only counts returned strings, never sends terminal bytes. Root should plan a display-only name fix across Grok and base fallback without altering raw dispatch identity. This does not reopen the three exact reviewed traces, but blocks any broader claim that every untrusted transcript field is sanitized.

Limits: root typecheck/build/full-suite validation not run as instructed; no real-terminal/device effects tested. Breaker remains best-effort shell recognition, not containment. Factory revocation prevents later API calls, not arbitrary extension-owned external effects. No shared LEARNS.md/report/task edits within this file-scoped assignment.
