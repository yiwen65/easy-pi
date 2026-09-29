# Computer input routing: focused experiments

Status: approved limited mitigation implemented and tested in an isolated
candidate; installation withheld pending unexplained broader GUI failures.

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
- The user approved the limited pointer-to-keyboard segment boundary. The
  candidate below implements it; this is not a complete focus-race fix.
- Do not claim AX property writes preserve every application's keyboard handlers,
  editor semantics or IME behavior. Those require separate qualification.
- Preserve the adversarial reproducer as durable executable coverage when the
  repair contract is settled; do not convert the known unsafe result into a pass.

The full Computer Use goal remains incomplete. Select/navigation-alert prior
qualification is independent of this new focus-race evidence.

## Approved boundary candidate

The native segment loop now refuses TypeText, Key and KeyDown after an explicit
Click, Drag or ButtonDown in the same segment, before target activation or new
input dispatch. It reports `segment_boundary_required` and preserves the known
dispatched prefix. KeyUp and ButtonUp are not blocked by this new rule; existing
owned-input draining remains enabled. Internal focus routes, direct AX fills,
pointer movement and scrolling are unchanged. No new scheduler or persistent
state was introduced.

Patch: `native/computer/patches/pointer-keyboard-boundary.patch`, SHA-256
`eb77ee730b5a78eb0be8168dcdf582c30c1c36d8e29667606dd898837f470efe`.
Candidate native library SHA-256:
`b5ab897ec0f8d724436d42c93b6b41fc81f38218266cef699ca61a46985807cb`.
NAPI remains
`1f3296c11bc25b1586670678f59297dbca425a6173b0151df7f8aee85de71b52`.
Pinned inputs identify this as a candidate, not a qualified release. The installed
package above was not replaced. The isolated package is currently
`/tmp/epi-pointer-boundary.PFHOUz/candidate-package`; to execute it, place it next
to coding-agent's `dist` under a distinct candidate directory, not over the install.

Build used the installed source materials as its baseline, the existing reviewed
offline environment, `cargo build --release --locked --offline -p cua-driver-sdk`,
and unchanged Cargo.lock. Forward patch validation against installed sources and
reverse validation against candidate sources passed. Existing upstream Rust
warnings about unused shutdown/unsafe and duplicate rpaths remain; they were not
silently repaired as part of this patch.

### Verification and failures retained

Evidence directory: `/tmp/epi-pointer-boundary.PFHOUz` (temporary).

| Check | Result |
| --- | --- |
| Original isolated focus reproducer with new guard assertion | Installed version fails; candidate passes; both close cleanly |
| Native segment ordering tests | 3/3 pass |
| Targeted desktop recovery/segment/tool tests | 39/39 pass |
| Package qualification tests | 8/8 pass |
| Strict desktop typecheck and root `npm run check` | Pass; unrelated automatic formatter changes restored |
| Initial existing general fixture suite | Candidate 13/13 pass |
| Expanded durable suite, two rounds | Candidate 23/28 pass; all cleanup checks pass |
| Same expanded suite, installed baseline | 13/14 pass; only new boundary rule fails as expected |
| Alternating candidate/baseline on five affected modes, three rounds | 15/15 candidate and 15/15 baseline pass with temporary activation/resign-key logging |
| Durable boundary plus complete fresh-target recovery | Pass, 744.61 ms including bridge load; no model latency; clean C083f |

The expanded suite's five candidate failures are not discarded:
`pointer-drag` was refused before dispatch with `stale_image_observation`;
`stale-reference`, `stale-image`, `unicode-edit` and `continuous-edit` encountered
`foreground_target_changed` during synthetic editing. No automatic replay was
attempted. The boundary rule cannot directly reject these first-action fills or
drags, but that source fact does not establish the failures' cause. The installed
baseline did not reproduce them; subsequent alternating runs also did not.
There is no evidence yet to blame external user input or to claim these failures
are fixed. Installation remains withheld.

The new durable `pointer-focus-boundary` scenario waits for actual fixture
focus-shift and release receipts, verifies neither window received the blocked
text, observes and reconciles the prefix, selects the sibling window and fills
it through the real tool. Exact fixture and AX readback prove completion; the
original canvas receives no keys and its click/release counts stay at one.
This proves a supported recovery path, not merely successful refusal.

Next discriminating work: capture focus/window/image identity at the first
divergence when one of the five broader failures recurs, using alternating
artifacts and a fixed fixture. Do not remove the guards or add blind retries.
Real-model qualification, arbitrary third-party async focus shifts, IME and
cross-window cancellation remain separate, unqualified work.
