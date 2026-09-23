# G03 selected-parent modal boundary

Apply `g03-modal-surface.patch` after `g03-condition-confirmation.patch`.
SHA256: `358051c8278a73abaf5c9cb7db9225e13a5de924dfc38fc43b2776f837a17585`.

## Failure and fix

C408 and C410 used a current parent-field ref after an attached sheet appeared.
Both actually wrote the blocked parent and reported the value confirmed.
C410 independently established the `AXWindow → AXSheet` relation **before**
input, excluding an AppKit-ready acknowledgement race.

`AXSheets` returned unsupported both before and after the sheet appeared.
The selected parent's immediate `AXChildren` instead exposed the `AXSheet`,
with its own CG window ID. The General resolver intentionally does not use
legacy's blanket rejection of other same-PID surfaces; retained element
membership alone missed this new dependency.

The four-file increment checks the selected root's attached-surface metadata
before semantic Focus/Fill/Window, direct AX selected-text writes and structural
postconditions. It uses `AXSheets` plus immediate-child role/subrole/modal
metadata, not a full-tree scan or another window's contents. Unknown reads
remain failures. The explicitly selected root's own modal role is not a blocker.

Observation remains available. Image-only actions do not gain optional AX
preparation, and owned releases, cancellation and native drain are unchanged.
This is not atomic protection against every possible concurrent UI change.

## Verified evidence

Under `.artifacts/computer/general/modal-boundary/`:

- `before-verification.json`: C408/C410 reproduce the write; C409 is a separate
  **read-only harness failure**, not product evidence. Eleven native terminals,
  six natural exits, plus two passive fixture exits. `visibility-01/02` reject
  the AXSheets-only hypothesis and establish the immediate-child relation.
- `surface-before.log`: three expected assertion failures; after: four surface
  tests, Computer62, SDK92, core98 passed, zero skips. Inherited warnings retained.
- `source-verification.json`: strict patch apply/bytes/reverse; genuine
  generation/`--check`, N-API staging, header and TS emission passed. No generated
  text or lock changes; earlier qualified candidate and stale General libraries
  remain untouched.
- `after-verification.json`: C411–C416, 32 terminals/twelve natural exits.
  Parent is refused before input; an unrelated same-PID sheet does not block
  the selected window; explicitly selecting the sheet allows its field write.
  Long segments, delayed confirmation and keyboard→semantic boundary still pass.
- `general/modal-crossapp-verification.json`: C417 original installed
  AgentSession reads the existing Chrome task page, saves the exact 612 UTF-8
  bytes in VSCode, selects the file in Finder, and enters a checksum command
  through Terminal GUI. Forty-one terminals/two natural exits; borrowed apps
  retained. Setup opened the task page/file/folder/shell; this is faux, not a
  real-provider evaluation or full autonomous navigation claim.
- Root targeted53 and original AgentSession context/compaction/drag10 passed;
  loader-based loop3 passed with matching snapshot pins. `general/g03mb/check.log`
  and final `general/g03mf/check.log` passed full isolated checks: 1459 files,
  no fixes, source/live drift zero.
  Both type layers, offline build and independent installation passed: 1426
  asset files, twelve workspace packages, 135 installed packages and 132
  unchanged external lock entries.

Candidate: `general/modal-boundary/candidate`.
Installed: `/private/tmp/epi-computer-install-EbpqcV/product`.

| Asset | SHA256 |
| --- | --- |
| SDK | `754f0ad0bc695e7ea9dffb453e6bdf4202d1e161e1436c5ac68fc9038cef7e3a` |
| N-API | `aa67bea99a3900bd32c1a456e1b24a420bfc73240de5ff72a1a3eb519d31a1bd` |
| Renderer | `e17ff560525e2908b684da706cc8c5f1a4cf540e09ace34f054cdd3593cacecc` |

Production pins remain unpromoted. No new real-provider calls, borrowed-app
termination, unknown input replay or lease recovery. Recovery budgets, full
renderer/workflow/performance qualification and final delivery remain separate
requirements in the sole task authority.
