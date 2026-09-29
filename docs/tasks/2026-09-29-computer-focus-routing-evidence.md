# Computer input routing: focused experiments

Status: unresolved product defect; no production or installed-package change.

## Contract and current implementation

Input must affect the selected target, not merely the selected process. Delivery
acknowledgement is not evidence of the receiving window or business completion.
Do not replay uncertain input. Preserve target checks, permission boundaries,
owned-input release, native close and desktop-lease safety.

Installed bridge SHA-256:
`b7e5a5a776add72063fb6b25d7ba65f859bca9f3c468b3f3e7414bf6d479e8a5`.

The installed source materials contain the current native implementation under
`packages/coding-agent/computer/materials/sources/cua-driver/rust/`.
`platform-macos/src/tools/computer/segment.rs` checks the keyboard target before
dispatch. `input/controlled/general.rs` posts keyboard events to a PID. These
operations do not provide an atomic window-bound consumption acknowledgement.

## September 29 experiments

Only disposable owned AppKit windows were used. No personal application input,
model API, production changes or new permission grants were involved.

Evidence directory: `/tmp/epi-focus-recheck.n91T0K`. Temporary artifacts are not
durable and may disappear; results and essential reproduction details follow.

| Experiment | Independent outcome | Cleanup |
| --- | --- | --- |
| Unmodified native-batch fixture | Both original-window fields have exact requested values; both actions use accessibility; segment 58.14 ms | Closed, fixture exit 0, clean C07d9 |
| Click plus type in one segment | Wrong window contains `untouchedMUST NOT REACH OTHER`; original canvas received no keys | Closed, exit 0, clean C07da |
| Custom AX field, focus shift disabled, corrected setter | Both original fields correct; sibling untouched; segment 57.79 ms | Closed, exit 0, clean C07dd |
| Custom AX field shifts focus during first write | Both original fields correct while sibling remains key window and untouched; segment 75.70 ms | Closed, exit 0, clean C07de |
| Split after fixture-confirmed transition | Original canvas receives full text exactly once, sibling untouched; observe 18.37 ms; total task including bridge load 720.39 ms | Closed, exit 0, clean C07df |

These are single samples, not estimates of production reliability or comparative
speed. The split measurement excludes model latency and includes additional
fixture-oracle reads. Correct refusal is not counted as completed input.

### Reproduce the keyboard defect

Start from `native/computer/desktop/fixtures/general/GeneralFixture.swift` and
`probe.mjs`, using the existing `pointer-click` scenario in isolated copies:

1. Give Canvas a click callback and a `keyDown` accumulator.
2. In its actual mouse-down callback, schedule a main-queue callback after 5 ms.
3. That callback makes the owned second window key and its NSTextView first
   responder; emit the actual key-window title as `focus-shifted`.
4. Select/capture the original window through the installed tool. Submit one
   segment containing the image-bound canvas click and `type_text` with
   `MUST NOT REACH OTHER`.
5. Await `focus-shifted`, read fixture state, and check that the sibling's initial
   `untouched` value is unchanged. Record original-window key delivery separately.
6. Await native close, fixture quit/exit and clean lease before another sample.

This failed on the current installation (`focus.log`). Original input checks
remain enabled. Earlier September 25 evidence also recorded 2/4 failures at the
same nominal delay; do not combine different runs into a claimed failure rate.

### AX experiment and discarded fixture failures

The first original-window text field subclasses NSTextField. Its AX value setter
assigns `stringValue`, then makes the sibling window key and its editor first
responder. The second original-window field is an ordinary NSTextField. A single
real tool segment fills both original fields. Independent state checks require
both exact values, the sibling key-window title, and unchanged sibling contents.

An initial override that called only `super.setAccessibilityValue` did not update
the first field even with focus switching disabled. Both failed samples are
retained (`ax-focus.log`, `ax-control.log`, clean C07db/C07dc). They are fixture
implementation failures, not evidence of a production focus bug. After explicitly
implementing the custom setter's value semantics, the no-shift control and
shifted case passed (`ax-control-fixed.log`, `ax-focus-fixed.log`). This proves
only this supported AX-write case, not arbitrary NSTextView or third-party apps.

### Split experiment and its limit

`split-probe.mjs` issues the click alone, then awaits the fixture's actual
`focus-shifted` and `pointer-released` events. It checks one click, one release,
empty original key accumulator and untouched sibling. Only then does it observe
the selected window and submit a new text-only segment with
`previousEffect: "observed"`. It asserts full original-window delivery and no
sibling mutation (`split.log`). No click or text is replayed.

The existing executor reactivates the selected original window in this case.
The fixture receipts supply stronger evidence than arbitrary applications expose.
Therefore this is a best-case synchronization experiment, not a deployable
generic synchronization policy or proof that refreshing an observation eliminates
future focus races.

## Public notification/counter follow-up

Read-only follow-up on September 29 rejected two proposed generic completion
signals; no new observer, queue or product code was introduced.

- AX focused-element notifications report that focus changed. Their callback
  identifies the affected accessibility element, not an acknowledgement of a
  particular submitted click or its future asynchronous effects. Registration
  can also return `kAXErrorNotificationUnsupported`. Notifications may help wake
  a waiter for an explicit condition; they do not by themselves prove that the
  input queue is drained or that subsequent keyboard input cannot be redirected.
  See [AX notifications](https://developer.apple.com/documentation/applicationservices/axnotificationconstants_h)
  and [observer registration](https://developer.apple.com/documentation/applicationservices/1462089-axobserveraddnotification).
- `CGEventSourceCounterForEventType` counts events seen since Window Server
  startup. It does not return a target-window handler completion receipt. The
  SDK also warns that unequal key-down/up counts do not necessarily imply a held
  key. See [Quartz event source](https://developer.apple.com/documentation/coregraphics/cgeventsource).
  In current installed materials, `input/controlled.rs::hardware_stamp` uses
  these counters for interference detection, not business completion. Do not
  repurpose this guard as an input acknowledgement.

These conclusions follow from the documented contracts and local SDK headers
(`AXUIElement.h`, `CGEventSource.h`), not from a new runtime notification test.
They do not prove that every possible platform-specific delivery approach is
impossible. Adding observers solely to claim atomic routing is not justified.

## Decision boundary and next work

- Preserve working element-bound AX batching; broad batch removal is unjustified.
- A fresh reference alone cannot promise window-bound keyboard consumption.
- Investigate a real application-observable completion condition or stronger
  target-bound delivery for the synthetic-input fallback before promoting local
  waiting into production. Fixed sleep is not a consumption acknowledgement.
- A pointer-to-keyboard segment boundary remains a possible limited mitigation,
  not an approved or complete fix. User approval for removing that intentional
  batch combination remains outstanding.
- Do not claim AX property writes preserve every application's keyboard handlers,
  editor semantics or IME behavior. Those require separate qualification.
- Preserve the adversarial reproducer as durable executable coverage when the
  repair contract is settled; do not convert the known unsafe result into a pass.

The full Computer Use goal remains incomplete. Select/navigation-alert prior
qualification is independent of this new focus-race evidence.
