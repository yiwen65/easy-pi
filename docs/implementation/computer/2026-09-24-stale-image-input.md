# Computer stale-image and unfinished-input diagnosis

## Captured failure

User-confirmed AgentPort session: `ses_01M38GJ1VTSGWCNY`, 2026-09-24
10:00–10:03 Asia/Shanghai, Google Chrome. Sensitive input contents omitted.

- `Cmd+t` and later `Cmd+l` dispatched, but the subsequent `type_text` did
  not: `physical_input_held_at_target`. Return was not attempted. The segment
  terminal correctly retained `inputCommitted: true` for the earlier shortcut.
- A keyboard segment based on the returned image stopped before dispatch with
  `stale_image_observation`. Later coordinate clicks also hit this check.
- A click followed by scroll using the same image dispatched the click, then
  refused the scroll after the screen changed.
- Fresh `observe` followed by `fill` using an exact field ref and Return
  succeeded in this same captured session.

## Evidence boundaries

Native image freshness compares window identity, geometry and the entire PNG
digest; it is not a time-to-live. The first refused-image pair in the transcript
differs at 517,396 of 2,259,423 pixels (22.9%). The later returned screenshot is
not the internal rejection-time capture, so this is evidence of substantial
screen change, not a reconstruction of the exact rejected frame.

Outside diagnostic input posting, a read-only CoreGraphics query reported key
code 0 (A) held in both HID and combined session state. The native Unicode input
carrier uses key code 0 and refuses to press a key already held. This supports
the refusal but does not establish why the key is held. A remote-client stuck
key or synthetic-input contamination remains unproved; no releases were forged.

## Bounded repair

The tool previously buried the unfinished action in generic segment JSON and
gave no cause-specific recovery guidance. It now leads with the unfinished
action, distinguishes non-dispatch from uncertain delivery, preserves earlier
effects, and tells the model how to refresh evidence or request physical-input
release. The tool contract now explains pixel freshness and observation-based
keyboard/field input. Native input guards, screenshot equality, intent budgets,
and no-replay behavior are unchanged. This repairs feedback, not the unresolved
OS-held-key cause.

## Verification

- Two focused regression tests failed before the repair for missing guidance
  and passed afterward, using validated genuine SDK result values without GUI
  dispatch. They also check no automatic replay and preserved prefix uncertainty.
- Desktop test group: 110 passed, 1 GUI test skipped, 0 failed.
- Desktop typecheck and `npm run check`: passed. Unrelated formatter-only
  changes from the repository check were reverted.
- Current real GUI rerun blocked: desktop lease generation `0310` is dirty
  with no holder found by `lsof`. No marker was cleared. The earlier clean
  GUI run documented in `2026-09-24-stop-recovery.md` predates this patch and
  does not verify this repair.

## Remaining gate

Obtain explicit operator recovery approval for the abandoned dirty lease;
verify no owner and recover with backup and exact-generation checks, not by
deleting the lock. Have the user release any held A key through their actual
keyboard/remote client, re-read key state, then test text entry and readback
in an isolated native fixture through the installed bridge. Reproduce changed
image rejection and fresh-evidence recovery there. Do not claim full repair
until these real-action gates pass.
