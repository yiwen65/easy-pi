# 实施与验证回执快照

历史回执；最终接受状态见任务计划与 root 复查。

T-041 raw tool-name followup implemented and verified. Recommend ready for root review/serial checks; not root acceptance. Prior three production fixes preserved. Base remains f7606c3df763e4dcbc75261211346e67124ee628.

Exact incremental patch: /tmp/pi-review-tool-name-incremental.diff (SHA256 962532eb8f45ccb7a7153c7d6674c5439aea61af0f5b7fe1908ecfab13fb638e), generated against saved pre-followup files and reviewed completely.

Changed files (5):
- packages/coding-agent/src/modes/interactive/components/tool-execution.ts:4,145,407: existing sanitizeDisplayText at both raw-name display sinks, including generic unknown-tool and missing/throwing-renderer fallback headers.
- packages/coding-agent/src/modes/interactive-grok/components/grok-tool-execution.ts:127-130,185: display-only getter sanitizes the name; standalone overview uses it. Group name styling/width already consume that getter, so grok-tool-turn-group.ts needed no edit (byte-for-byte baseline match).
- packages/coding-agent/test/tool-execution-component.test.ts:255-329: OSC/C1/CSI/APC/control prefixes across unknown, missing, throwing, self-shell fallback paths; pending/error and collapsed/expanded states; Unicode; sanitized-name collision must NOT select built-in Bash rendering.
- packages/coding-agent/test/grok-display-safety.test.ts:183 onward: model-supplied unknown names in standalone/grouped/live/history states, virtual writes, trusted styling, raw message/definition/result identity retained, and raw edit/subagent names retain their original routing decisions.
- packages/coding-agent/test/suite/regressions/bash-cwd-breaker.test.ts:74 onward: corrected a test-only completion-order assumption discovered by neighbor validation. Parallel fake realpath reads finished in reverse order; denial and the exact allowed call set were already correct. Test now gates both completion orders deterministically and asserts exactly those two calls. No product scheduling or deletion behavior changed.

No raw identity mutation: constructor assignments, built-in lookup and Grok special-name comparisons retain original names. Only display sinks/getter sanitize. A name `bash` plus OSC does not inherit Bash rendering; polluted `edit`/`subagent` names do not acquire clean-name grouping behavior. Source messages, definitions, arguments and error strings remain unchanged. Host renderer output/styles are not globally stripped.

Red evidence before production edits:
- Safe probe: coding-agent cwd, `PI_OFFLINE=1 node --conditions=development /tmp/pi-review-boundaries-grok-name-probe.ts`. OSC52 occurrence counts standalone/grouped: 1/1 collapsed, 2/3 expanded. /tmp/pi-review-tool-name-probe-red.log.
- coding-agent cwd: `PI_OFFLINE=1 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/tool-execution-component.test.ts test/grok-display-safety.test.ts`: 10 failed, 51 passed. /tmp/pi-review-tool-name-red.log. Failures include raw partial ESC and OSC/C1/CSI in captured virtual writes.

Green/final verification:
- Same two-file command: 61/61 passed; /tmp/pi-review-tool-name-green.log.
- Same safe probe: 0/0 for both collapsed and expanded; /tmp/pi-review-tool-name-probe-green.log. Probe only counts returned strings; no terminal bytes sent.
- coding-agent cwd, same root Vitest CLI with `--run test/grok-display-safety.test.ts test/extensions-runner.test.ts test/suite/regressions/bash-cwd-breaker.test.ts test/grok-transcript-components.test.ts test/grok-visual-render.test.ts test/grok-thinking-mouse.test.ts test/live-line-scroller.test.ts test/assistant-message.test.ts test/tool-execution-component.test.ts test/extensions-mcp-api.test.ts test/extensions-discovery.test.ts test/bash-tool-contract.test.ts`: final 12 files, 250/250 passed, including both controlled fake-executor orders. /tmp/pi-review-tool-name-final-controlled.log.
- permissions cwd: `PI_OFFLINE=1 node --test test/permissions.test.ts`: 15/15 passed. /tmp/pi-review-tool-name-permissions.log.
- permissions cwd: same root Vitest CLI `--run test/external-mutation-journal.test.ts`: 3/3 passed. /tmp/pi-review-tool-name-journal.log.
- Scoped Biome check of all 5 changed files: clean, no fixes applied. /tmp/pi-review-tool-name-biome.log. Scoped tracked-file git diff --check clean.
- Intermediate neighbor run exposed the recorder assertion issue (1 failed, 248 passed), retained in /tmp/pi-review-tool-name-neighbors.log; final controlled schedule run above resolves it.

Preservation: permission source, extension loader, Grok thinking group and Grok assistant source hashes match the previous delivery exactly. No InteractiveMode, types, docs, dependencies or lockfile edits; no commits. Root check/build/full-suite remain intentionally unrun. No real provider, terminal/device effects or shell deletion. Trusted extension renderers still own their custom output; this result establishes the assigned name/thinking/argument boundaries, not a claim that every possible UI field has been audited.
