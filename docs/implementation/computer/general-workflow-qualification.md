# General Computer workflow qualification

Task/status authority: `docs/tasks/2026-09-18-computer-native-implementation-task.md` (T-053/T-078). Evidence paths below are relative to `.artifacts/computer/general/`. This is a functional support matrix, not final delivery or performance acceptance.

## Qualified scope

Node24.15.0/macOS arm64, existing application profiles, original AgentSession and shared scheduler. Latest popup candidate: SDK `b7e0ad95…`, N-API `93ffdcc7…`, renderer `1195e23e…`; matching installation and source are recorded in `installed-popup-click/` and `popup-click/source-verification.json`.

| Workflow | Actual evidence | Boundary |
|---|---|---|
| WF-01 TextEdit and VS Code | C462: thirteen named keys, real selection/viewport, Shift release,20 exact Unicode bytes saved. C461/C487: VS Code612 exact bytes; earlier C3351632-byte Unicode replacement. | Pinyin input source with ABC shortcut layout; not every keyboard layout. |
| WF-02 Terminal | C461/C487 GUI-entered checksum verified the editor file. C332 GUI command produced exact UTF-8 contents. | Dedicated task shell; setup uses UTF-8 locale, not a change to user configuration. |
| WF-03 existing Chrome | C460 Canvas one trusted click, fresh Computer readback, remaining cross-origin iframe Unicode/single submission, new-tab GUI navigation and task-tab closure. | Existing PID2162/profile retained. No CDP, browser restart, cookie export or personal screenshot upload. Native visual conditions remain unknown. |
| WF-04 Finder | C463 explicit inline-child rename; C464 delivered doubleclick then harness failure; C465 only remaining bounds/two-axis scrolling; C483 actual menu Duplicate; C486 one real cross-window file move. | Exact task folders/windows. Native dispatch is not the file/viewport oracle. C464 is not retrospectively a successful whole run. |
| WF-05 cross-app | C487 one original AgentSession: Chrome-read source → VS Code save → Finder observe/select → Terminal GUI checksum,612 bytes exact. | Setup opens dedicated content. Not autonomous initial app launch/navigation. |
| WF-06 input coexistence | C396 AX12 fields with5 remote key pairs; C397 background12 pixel clicks with17 remote key pairs; foreground/cursor stayed at receiver. Same-PID and automatic foreground preparation covered by T-062/T-072 and C486. | User-confirmed real remote-input scope. Local hardware untested and explicitly nonblocking. No arbitrary-app background guarantee; foreground delivery can interrupt the user. |
| WF-07 bounded recovery | C423/C424/C426–C429: shared attempt/time budgets, lost committed reply refusal, fresh reconciliation of only remaining work, activation-only drag continuation, stop during confirmation. C411–C413: modal parent refusal, unrelated sheet allowed, explicitly selected child. C460 reconciles actual Canvas effect before iframe. | Unknown non-idempotent inputs are never replayed. Whole-image changes may conservatively refuse despite a human-perceived stable target. |
| WF-08 cursor/stop/close | C433–C435 high layer/fullscreen Space/software click-through; C484 current named high-layer visible glyph and model-image exclusion; C485 current Shift/drag stop, matching release, no continuation, helper exit. T-051 preserves DPI/move/occlusion/helper-fault evidence. | Software stop/click-through stimuli are not local hardware proof. Owned close is not target-application event-consumption proof. |

## Real-model boundary

C482 sent exactly one `openai-codex/gpt-6-astra`, reasoning low request containing only the dedicated fixture PNG and paired capture exchange. The model selected(139,102); actual General background click satisfied Counter1, independently verified as one red-area down/up. C473 had previously sent one successful toolUse response but failed its GUI harness; this phase's two-request budget is exhausted. Historical five attempts/two successes remain separate. C482's zero-token aborted item is local budget termination, not another network response.

All broader workflows use a deterministic faux provider. Finder OCR and browser image analysis are local test-only oracles, not claims that a real model autonomously solved the entire workflow matrix.

## Evidence and retained failures

- `real-workflows/current-verification.json`: C461–C480,321 terminals/40 natural owner-fixture exits; failures remain failures.
- `real-workflows/verification-481-482.json`:21 terminals/4 natural exits; C481 failed/C482 passed. C481 foreground/hit snapshot was before the initial stale refusal, not at later PID dispatch.
- `discovery-query/installed-verification.json`: filtered discovery and C460 browser effects; earlier discovery failures retained.
- `popup-click/installed-verification.json`: C483–C486,63 terminals/8 natural exits. `popup-click-crossapp-verification.json`: C487,41 terminals/2 natural exits. Native visual unknown remains unknown; files prove menu/drag outcomes.
- `installed-popup-click-crossapp-01`: VS Code unavailable during setup, zero native owner. A later application launch and fresh setup passed; the old run is not overwritten.
- `remote-coexistence-verification.json`, `recovery-budget/final-core-verification.json`, `renderer-overhead/after-context/formal-verification.json` retain their exact version and coverage boundaries. Original renderer RSS gate failure is preserved separately; the later pass is narrow, not a leak/peak-memory guarantee.

No unknown lease was cleared, borrowed application killed, old unknown action replayed, or additional real-provider request sent for the popup candidate. Formal task timing, final production pins, relocation and final whole-suite audit remain T-054–T-056.
