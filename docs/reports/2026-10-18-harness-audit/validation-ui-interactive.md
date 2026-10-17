# 实施与验证回执快照

实现方回执，最终接受状态见任务计划与 root 复查。

Implemented T-043/T-044/T-045/T-046/T-053 (F4/F5/F6/F7/F14); recommended status: fixed, awaiting coordinator review/acceptance. Base HEAD observed: f7606c3df763e4dcbc75261211346e67124ee628. Fully read the actual 7,439-line InteractiveMode before editing.

Changed files only:
- packages/coding-agent/src/modes/interactive/interactive-mode.ts
- packages/coding-agent/test/interactive-extension-ui.test.ts (new)
- packages/coding-agent/test/interactive-mode-clipboard.test.ts (new)
- packages/coding-agent/test/interactive-mode-status.test.ts (fixture now inherits actual selector lifecycle)

Per-task findings/fixes:
- T-043/F4: synchronous shortcut throws escaped input dispatch; asynchronous rejection was already handled. Invocation now runs inside the Promise chain, reporting one error and permitting subsequent input.
- T-053/F14: idle shortcut shutdown did not call shutdown; active deferral already worked. Shortcuts now use ExtensionRunner.createContext(), including the existing bound shutdown/liveness behavior (source ~2267–2285).
- T-044/F5: concurrent dialogs left displaced promises unresolved; reset and stale callbacks could settle wrong values or replace current UI. Reused showSelector token/disposer lifecycle; select/input/editor now cancel displaced requests exactly once, detach abort handlers, and dispose timers (~2685–2800).
- T-045/F6: non-LIFO close removed another overlay; reset left promises/resources alive; early done leaked late factory results. Each invocation now retains its handle, cancellation closure, closed/disposal state; reset closes all owned UI including pending factories, not foreign overlays (~2443–2446, ~2894–3011). Async non-overlay factories claim the existing selector slot before awaiting. Failure and early-completion cleanup covered.
- T-046/F7: image/text completion inserted into replaced/cleared/submitted drafts and sessions. Editor identity + session identity + generation are checked after each clipboard await; explicit mutation/submission/reset/editor-swap boundaries invalidate old reads (~3098–3154 plus generation updates). Also independently reproduced and fixed the same stale right-click paste with unchanged focus.

Evidence:
- Initial regression run: 37 failed | 12 passed (49), 2.75s, exit 1. No import/setup failures; expected failures included sync throw, idle shutdown count 0, unresolved dialog callbacks, wrong overlay focus/disposal, and unwanted clipboard insertion. /tmp/pi-ui-interactive-red.log (key summaries at lines 38294–38297).
- Intermediate adversarial checks exposed closing from overlayOptions still mounting disposed UI (1 failed, /tmp/pi-ui-interactive-options-red.log) and dialog focus returning prematurely to an existing overlay (1 failed, /tmp/pi-ui-interactive-focus-red.log). An existing overlay/non-overlay neighbor also caught the focus issue. Fixed by checking closed after options resolution and transferring focus before unmounting the previous overlay-blocking component (~5212).
- Right-click race: 3 failed, expected empty draft but got clipboard text, /tmp/pi-ui-interactive-right-click-red.log.
- Final: 17 passed files, 161 passed tests, 8.12s, exit 0; /tmp/pi-ui-interactive-green.log.
- Scoped Biome check on all four changed files: Checked 4 files; No fixes applied. Scoped git diff --check passed. Production SHA256 after checks: bbb5663c4aa35e63ad6e5ecdbda91160c2802d82cf543eefdc332088390db553.

Exact final test command (cwd packages/coding-agent):
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/interactive-extension-ui.test.ts test/interactive-mode-clipboard.test.ts test/interactive-mode-status.test.ts test/interactive-tui.test.ts test/grok-agents-host.test.ts test/custom-editor-image-path.test.ts test/custom-editor-history-keybindings.test.ts test/interactive-mode-startup-input.test.ts test/interactive-mode-startup-ready.test.ts test/interactive-session-storage-wiring.test.ts test/subagent-settings-host.test.ts test/interactive-mode-fast-command.test.ts test/transcript-interaction.test.ts test/suite/regressions/5943-session-start-notify.test.ts test/suite/regressions/6949-unavailable-scoped-model.test.ts test/suite/regressions/7153-scoped-models-refresh.test.ts test/suite/regressions/startup-session-rebind-duplicate-subscription.test.ts

Limitations/coordination:
- No root npm check/build, full-suite/typecheck, real APIs, native clipboard or desktop effects, dependency/lockfile changes, commits, or documentation/report edits. Root type/system checks remain pending.
- Clipboard reads are not cancelled at OS level: stale results are discarded, including when a draft changes during the read.
- Documentation recommendation for coordinator: docs/extensions.md should state editor-slot replacement/reset cancellation results (undefined for select/input/editor/custom; false for confirm), instance-owned overlays, and disposal of late factory results. Editor clipboard docs can note stale completion is discarded after draft/session changes.
- LEARNS.md was not edited due ownership restrictions. Verified reusable lesson: when handing an overlay-blocking temporary component to another component, transfer focus before unmounting the previous blocker; otherwise TUI intentionally restores overlay focus. Covered by new transfer-focus regression and existing interactive-mode-status neighbor.
