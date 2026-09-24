# Bounded browser scroll into view

This increment adds a separate `browser_scroll_into_view` route and generated
`ComputerOperation.startScrollIntoView(elementToken)` method. Agent input is
`{request:{op:"scroll_into_view",ref,target},observeAfter:true}`. Both references
must come from the current displayed observation, and the target must advertise
the scroll action. It is not a wheel, keyboard, focus or click operation.

The fixed native function calls `Element.prototype.scrollIntoView` with instant,
center/nearest alignment only after document, top-level page, exact DOM object,
visibility, inert, secure-element and single-HTML-dialog checks. Cross-frame,
personal-profile and arbitrary-script access remain unavailable. The dedicated
capability and R2/active browser-input authorization are mandatory. Cancellation,
real terminal drain and unknown-input non-replay remain unchanged. A submitted
action is not proof of task success; follow-up observation and the task's own
result must be checked.

## Reproducible source identity

- Increment base: qualified `browser-listener-click.patch`, SHA-256
  `e5e19061c12a5d8c326ff5dc71ea8ffd64474fcc0938cd5e4b54110650988df6`.
- Twelve-file increment SHA-256:
  `387af39ff3de1bf539efdc04757597137092c0b560aa6460b86a4af3ed2f175e`.
- SDK dylib SHA-256:
  `8f5fd2b42d02f7ab8f3ecf987216561dddfa684a54615293f01f6aedc4370a83`.
- N-API SHA-256:
  `20ffed5caccef6c44eff6ef9d39c127d49d9783b16e4aa9f0be0dfa3ba887056`.

Independent forward application, exact twelve-file byte comparison, and reverse
application passed. Generated UniFFI bindings, N-API staging and strict SDK/bridge
type checks passed. Matching source, build proof, licenses and binaries are
retained in the optional package materials; runtime hashes are pinned in
`desktop/pinned-inputs.json`. This is not a cold-cache or byte-reproducible build
claim.

## Qualification boundary

Evidence root: `/tmp/epi-browser-scroll.1dusJS` (local retained artifacts).

- `native-guards2` and `native-dialog-after`: ten actual SDK scenarios passed:
  page, nested scroller, dialog, hidden, transparent, inert, removed node, a newly
  opened dialog, stale observation, and pre-abort. Positive geometry changed;
  negatives had zero observed scrolling, clicks, text input or focus changes.
  All hosts closed normally. Some checked-DOM refusals occur after input admission;
  zero observed effects do not mean `inputCommitted:false`.
- Browser schema/tool tests: 24; context/desktop/segment regressions: 73;
  actual AgentSession faux-provider loop: 3; qualified package tests: 8.
- `bridge-scroll`: seven actual packaged tool calls completed Unicode fill,
  select, scroll, click and visible receipt; independent oracle recorded both
  scrolling and full target viewport containment. `bridge-form`: six-call
  non-scroll neighbor also passed. Both closed with clean leases.
- Adding scroll-only generic rows originally crowded meaningful text out of the
  bounded model view. A failing regression now passes: activation controls and
  meaningful text retain priority; scrollability alone does not promote blank
  structure.

Real-model task results and remaining broad benchmark gates are tracked in
`docs/tasks/2026-09-24-computer-e2e-speed-accuracy-task.md`. Primitive, fake-host and
packaging passes alone are not real-model or universal-app qualification.
