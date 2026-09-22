# Installed Finder pointer effects

Partial T-047 evidence; the task authority remains `docs/tasks/2026-09-18-computer-native-implementation-task.md`.

The popup-qualified installation `/private/tmp/epi-computer-install-zY7eqM/product` ran these actions through the original AgentSession and computer tool, with a faux provider. Setup created only a dedicated directory and 120 test files. Finder PID463 was borrowed and retained.

| Effect | Independent evidence |
| --- | --- |
| Double-click opens a folder | C385 selected and image-clicked the sole test subfolder; exact child title appeared on window11385. Initial stale-image refusal had no input; one newly inspected image supplied a fresh point. |
| Window move/resize | Actual subsequent capture geometry changed from `[58,63,920,464]` to `[80,120,660,420]`. |
| Vertical pixel scroll | C386 dispatched one background scroll; content scrollbar changed `0 → 0.11220196353436185`, and the fresh image showed later file rows. |
| Horizontal pixel scroll | One background scroll changed the horizontal scrollbar `0 → 1`. |
| Close and preservation | Only the task window closed. Finder remained, all 120 file hashes were unchanged, native host/fixture exited naturally. |

C385's overall harness **failed** while waiting 180 seconds for the next image judgement. Its double-click/bounds effects are preserved, but the whole run is not reported as successful. No scroll had been dispatched. C386 explicitly reselected that surviving task window with fresh evidence and performed only the remaining scroll actions; it did not repeat the double-click.

`general/finder-pointer-installed-verification.json` independently seals both runs: 25 distinct native terminals, four natural exits, no forced cleanup, clean C385/C386 and matching installed assets. The read-only scrollbar oracle reports its 1024-node truncation and skips known foreign-window branches. Positive values are evidence of these specific scrollbars, not a completeness/absence claim for the whole AX tree.

This does not prove physical-input coexistence, global-drag production support, performance or autonomous real-provider planning. Cross-window mechanism evidence is separate in `cross-window-drag-mechanism.md`; the installed product still requires T-072 integration.
