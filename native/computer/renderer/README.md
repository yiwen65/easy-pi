# Computer renderer (T-057)

Standalone rendering-only macOS AppKit helper. Swift 6, Apple frameworks only.
It draws a cyan outlined arrow at native dispatch coordinates, an orange ring
while down/dragging, and a short green release or cyan click ring. It does not
execute input, inspect model text, activate applications, read the hardware
cursor, request accessibility permission, suppress events, record, or replay.
It observes a trusted emergency chord using AppKit's listen-only global monitor
and reports a fixed stop signal to its native owner.
Native integration and actual GUI qualification belong to T-051.

## Build and headless checks

From the repository root:

```sh
sh native/computer/renderer/build.sh .artifacts/computer/general/renderer-worker/build
python3 native/computer/renderer/test.py .artifacts/computer/general/renderer-worker/build/computer-renderer .artifacts/computer/general/renderer-worker
```

The build invokes `/usr/bin/swiftc -swift-version 6
-strict-concurrency=complete -warnings-as-errors -O`, using an output-local
module cache. No packages, dependency resolution, Cargo, Node, or external
toolchain. The optional build argument selects an output directory; its default
is the ignored `native/computer/renderer/build/`. Ship the resulting matching
`computer-renderer` executable as a native resource; do not build at runtime or
commit the binary. No application bundle is required by these foundations.

`--self-test` exercises parsing, geometry, state reduction and real AF_UNIX
socketpair draining without creating NSApplication or windows. `--headless`
(`--validate` also accepted) exercises the control-pipe lifecycle; `--headless --socket /absolute/path`
additionally runs the production named-socket transport without any GUI APIs.
Tests explicitly skip named-socket cases only if an independent bind probe gets
EPERM; such a run does **not** qualify named transport. Original failures must
be preserved. Production invocation always requires `--socket`.

Coordinator rerun outside the worker sandbox passed all 16 process tests with
zero skips and 187 pure/socketpair checks. The first full rerun exposed two
harness assumptions: 4 KiB exceeded Darwin's default datagram limit, and a full
queue returned ENOBUFS rather than EAGAIN. The oversized-input case now sends
513 bytes (one over the protocol limit), and the test sender treats only the
known nonblocking queue-full codes as drops. Both failed logs are retained under
`.artifacts/computer/general/`; no rendering/input behavior was weakened.

## Protocol v1 (frozen)

One UTF-8 JSON object per AF_UNIX `SOCK_DGRAM` datagram, at most **512 bytes**,
including whitespace. Exactly these seven fields are required for every kind:

```json
{"version":1,"sequence":0,"target_pid":123,"window_id":456,"x":12.5,"y":30,"kind":"down"}
```

| Field | Meaning and accepted range |
| --- | --- |
| `version` | Literal JSON integer `1` |
| `sequence` | UInt64 `0...18446744073709551615`, strictly increasing across the helper lifetime, no wrap; gaps allowed |
| `target_pid` | Positive signed 32-bit native target process ID; the helper's own PID is rejected |
| `window_id` | Positive UInt32 exact CGWindowID, paired with target PID |
| `x`, `y` | Finite JSON numbers in `0...1000000`, **window-local logical points**, measured right/down from the outer window bounds' Quartz top-left; not content-local or screenshot pixels |
| `kind` | `move`, `down`, `up`, `click`, `hide` |

Unsigned/integer fields use decimal integer tokens, with no fractional/exponent
form. Coordinate numbers may use JSON fractions/exponents. Negative coordinates
are rejected; negative global desktop positions come from native window bounds.
Keys and kind values use literal ASCII strings without JSON escapes. Unknown,
duplicate or missing fields; unknown kinds; escaped strings; nested values;
NaN/infinity/overflow; reflection/label/path/script payloads; trailing JSON; and
oversized datagrams are rejected in full. Invalid or stale messages do not
advance the sequence or change state. No body is echoed or sent back.

Send cues **after actual native dispatch**, including intermediate drag positions
and down/up transitions. A click cue means dispatched input, not verified
application success. The renderer cannot authenticate that fact on behalf of
the native dispatcher. It maintains one current target/point, one pressed bit,
and one expiring feedback cue; moves preserve pressed/feedback state, target
changes clear it, and hide clears it immediately. There is no path history,
arrival acknowledgement, animation queue, or replay. The 350ms feedback timer
does not delay input or impose a runtime limit. Off-window points are hidden,
not clamped to another location. Hide still requires all protocol fields.

## Parent ownership and transport

1. Native parent creates a fresh private directory, owned by its real UID,
   permissions exactly `0700`. Pass a trusted absolute socket path inside it:
   `computer-renderer --socket /private/.../new-private-directory/s`.
   Full UTF-8 path must be under 104 bytes. Every component must be real (no
   symlinks, `.` or `..`); `/tmp` is a symlink on macOS, so use `/private/tmp`.
   No preexisting socket pathname is accepted or removed. The helper validates
   ownership/mode and walks ancestors with `openat(O_NOFOLLOW|O_DIRECTORY)`.
2. Launch directly with an anonymous pipe as stdin. Keep only the owning parent
   write end open; close all inherited copies in unrelated children. Stdin is
   solely a lifetime pipe: any byte is an error, not a command. EOF closes the
   panel/socket and exits normally. The parent owns reaping and any escalation
   for a genuinely hung helper; no daemonization or artificial maximum runtime.
3. The helper binds in the verified directory using a directory descriptor,
   makes the socket `0600`, and uses a nonblocking descriptor with requested
   32KiB receive buffer. Cleanup checks socket type, device and inode through
   that directory descriptor and unlinks only the originally created name.
   It never recursively removes a directory or removes a substituted file.
   The parent removes its private directory after reaping.
4. Stdout lifetime protocol **v3** produces readiness only after socket, AppKit
   panel and global emergency monitor allocation:
   `{"ready":true,"version":3,"window_id":789,"emergency_stop":true}`.
   Register that owned window ID with native exclusions. Headless validation
   uses ID **0** and `emergency_stop:false`; native rejects it for product use.
   Startup failure has no ready line; stderr contains only a fixed error code.
   Native retains stdout after readiness. Subsequent messages are the exact lines
   `{"event":"heartbeat","version":3}` at most once per 250 ms, and
   `{"event":"emergency_stop","version":3}` once. Each ends in LF.
   Heartbeats run only at the end of the actual AppKit tick, after trust checks,
   bounded datagram drain and rendering; no independent thread produces them.
   Headless mode sends no heartbeats and cannot qualify GUI availability.
   Native allows three seconds for startup, then one second from accepted
   readiness or the last verified heartbeat. It polls every 16 ms with at most
   128 one-byte nonblocking reads, matches fixed strings without retaining a
   body, and rejects a full read budget as a flood. Incomplete messages never
   extend the deadline; queued heartbeats cannot revive an expired deadline.
   A complete emergency signal takes priority within that bounded read batch.
   Protocol 1/2 lifetime assets are rejected; datagram protocol v1 is unchanged.
   There are no action acknowledgements, arbitrary bodies or reflected fields.
5. Parent sends with `O_NONBLOCK`/`MSG_DONTWAIT`; EAGAIN/EWOULDBLOCK or Darwin
   ENOBUFS means drop/coalesce visual
   state, never wait for animation or retry system input. Keep any parent-side
   pending state bounded and supersede stale moves. Preserve/reconcile the last
   down/up/hide cue if send fails; lost release cues otherwise leave a pressed
   visual until the next up/click/hide/target change. This best-effort visual
   channel is not a reliable action log. Renderer consumes at most 64 datagrams
   per 60Hz tick, applies transitions in sequence, then paints only latest state.
   Pipe EOF is checked before draining, including during floods.

The socket directory is a same-user trust boundary, not protection against a
malicious process already running as that UID. Native parent launch, cue wiring,
nonblocking sender and lifecycle registry are deliberately outside this folder.

## Global emergency stop

Default: **Control+Option+Escape**. Trusted native renderer configuration accepts
an optional `ComputerEmergencyChord { key, modifiers }`; absent means default.
Key names reuse the native Events mapping. Names represent macOS physical key
positions, not layout-dependent Unicode text. Supported modifiers are Control,
Option, Command and Shift; empty/duplicate modifiers, Function, modifier-only
keys and unknown names are rejected before spawn. Configuration is not part of
any model action or datagram. Native launches the helper with bounded decimal
`--emergency-keycode <code> --emergency-modifiers <flags>` before `--socket`.

The GUI branch checks existing accessibility trust without prompting and rejects
secure-event-input mode. It installs only
`NSEvent.addGlobalMonitorForEvents(matching: .keyDown)`, whose handler returns
Void and cannot change or prevent foreground delivery. Extra Shift/Control/
Option/Command/Function flags do not match; Caps Lock, numeric-pad and device
flags are ignored. Repeats and duplicate matches do not emit another stop.
The helper hides its panel on stop and continues owning its lifetime until
native EOF. It never releases keys/buttons itself. No local monitor, event tap,
input posting or global device-blocking facility is installed.

The GUI tick exits on lost trust or secure-input mode; native treats unexpected
stdout EOF/helper death as failure and revokes the host. These checks cannot
provide atomic OS guarantees, observe keys while secure input is enabled, or
prove physical provenance of an event copy. Real permission, secure-input,
foreground chord forwarding and timing remain GUI qualification gates.

Native latches early stop, invokes a callback holding only a weak host reference,
revokes sessions/operations and starts native-owned close independently of
foreign waiters. Status is sticky `EmergencyStopped`; input admission stays
revoked until an explicitly created new product host/session. Helper EOF/reap
is independent of operation terminal and release proof. No automatic restart,
input replay or lease recovery follows a stop.

Missing main-loop progress produces sticky `Failed` with fixed code
`renderer_heartbeat_timeout` and invokes that same weak-host revoke/close path.
It cancels admitted operations and lets their existing owned release guards
unwind. No per-input heartbeat acknowledgement, waiting mutex or input replay
is added. Timeout is not an operation terminal, release or process-exit receipt:
native still owns stdin EOF, escalation of its waitable child, actual wait/reap,
operation drain and sticky quarantine when cleanup proof is unavailable.
Physical keyboard/mouse delivery remains unaffected by the listen-only monitor.

## Drawing and visibility boundaries

AppKit runs on the main thread with accessory activation policy; it never
calls application activation. Prohibited policy forbids windows and was rejected
by the real GUI startup test, despite passing headless tests. The panel is
borderless, nonactivating, cannot become key/main, ignores mouse events, has no
shadow and stays at normal window level. Drawing is a small vector view and
adapts to AppKit backing scale; no screenshot-to-point scale guesses.

Each render tick re-reads onscreen window metadata and display frames. Exact
PID/window ID must match a visible normal-layer window. Conversion uses the
primary screen's top edge: `appKitY = primaryTop - (windowQuartzY + localY)`;
X is `windowQuartzX + localX`. This handles negative monitor origins and window
movement without using the focus-following `NSScreen.main`. The panel frame is
the cursor footprint intersected with target bounds; drawing also clips to the
display union. Invisible/minimized/missing/wrong-PID/unsupported-layer targets
and off-display points hide the panel.

The panel orders immediately above the exact target window, never globally
frontmost. As a conservative second protection, any higher onscreen window
whose bounds intersect the cursor footprint hides the whole cursor. This can
hide feedback unnecessarily for transparent, irregular, or partially overlapping
windows; it does not attempt pixel-level occlusion or assume relative ordering
works on every macOS release. Rounded/nonrectangular target edges and transient
window/Space transitions require GUI qualification. Metadata/drawing can lag by
a frame; there is no atomic WindowServer snapshot-and-order operation here.

`sharingType = .readOnly` keeps this content-free cue independently capturable
for actual pixel verification. Model-image exclusion relies on the native
exact-target window filter and owned-ID exclusions, **not a sharing hint**.
The helper is a separate process/window; actual capture behavior and owned-ID
filtering still require qualification. Earlier `.none` candidates below remain
historical evidence, not the current sharing policy. Headless tests establish
neither visible rendering, actual click-through, focus/cursor noninterference,
multi-DPI appearance, occlusion correctness, GUI EOF close, nor packaging. Those
are required T-051/native/GUI integration gates, with performance measured there.

## Initial GUI evidence (not T-051 acceptance)

Coordinator evidence is under `.artifacts/computer/general/renderer-verified/`.
The real startup failure with prohibited policy is preserved; accessory policy
then created a genuine nonactive panel. The first test point was occluded, and a
diagnostic build correctly reported `occluded`. A dedicated fixture using
`orderFrontRegardless()` provided an unobscured target without activating it.
WindowServer then reported the helper above that exact target at the expected
64-point footprint, unchanged foreground app, and normal EOF/socket cleanup.
No key or pointer input was synthesized in these helper tests.

The default `.none` sharing policy produced no glyph pixels in an explicit
ScreenCaptureKit inclusion capture. A diagnostic binary differing only in
`.readOnly` sharing metadata produced the actual cyan arrow at the requested
point; fixture-only captures omitted it. This comparison verifies the drawing
path, but does not replace final native-owned cue, physical click-through,
movement/DPI, screenshot-exclusion and installed-product qualification.
