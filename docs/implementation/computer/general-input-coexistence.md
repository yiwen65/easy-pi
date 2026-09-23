# User-input coexistence qualification

Task authority: `docs/tasks/2026-09-18-computer-native-implementation-task.md`.

## Confirmed boundary

The user confirmed that keyboard input comes through remote desktop software, then explicitly approved this acceptance change: qualify the real remote-user input path; keep directly connected local hardware **untested and not a delivery blocker**. The prohibition on suppressing input and all other General Computer requirements remain unchanged.

A receiving application counts down/up events without recording characters or key codes. Those counts demonstrate application receipt, **not local physical-device provenance**. The independent non-seizing IOHID observer counts recognized OS-reported USB/Bluetooth/BLE/SPI callbacks. It returned zero during remote typing; this is not evidence that no user input occurred, nor proof of a hardware-observer defect. No positive local hardware qualification is claimed.

## Actual installed product

Installation: `/private/tmp/epi-computer-install-FkRS0d/product`.
SDK `4578225b0dc57196f58b4c3b6ab3963e333fd6e12ff496e273ac6eabc6490840`;
N-API `0f44e2858db5482356f753e549f7479d0740249e99f9925a86732a9001108405`.

Both arms used the original AgentSession, computer tool and faux provider. The user supplied the remote key presses; no software keyboard stimulus substituted for them. All application contents were dedicated test data. Qualification pacing is harness-only, not a product input delay.

| Arm | Independent effect | Concurrent user input | Focus/cursor |
| --- | --- | --- | --- |
| C396 AX | 12 exact field values, native-confirmed and separately read from the fixture | 5 additional down/up pairs received in the foreground application | Foreground/key window retained; every sampled system-cursor position unchanged |
| C397 directed pixel | 12 actual background clicks, 12 matched down/up pairs and counter `0 → 12` | 17 additional down/up pairs received in the foreground application | Foreground/input responder retained; every sampled cursor position unchanged |

The native routes were respectively `Accessibility/Background` and `SyntheticEvents/Background`. The pixel target stayed inactive/non-key; an automatic foreground takeover would have failed this arm. Across these two evidence sets: **66 distinct terminals, seven natural exits, no forced cleanup**, clean C396/C397. Real-provider calls: zero.

`general/remote-coexistence-verification.json`, relative to `.artifacts/computer/`, independently checks raw hashes, exact effects, route/mode, receiving counters, focus/cursor, mapped installed libraries, TCC evidence, terminal/close/destroy ordering and clean markers.

## Retained failures and limits

- C394 timed out waiting for keys. The user later reported accidentally pressing STOP; raw target Stop and owner Stopped events agree. Only three read-only native operations ran; three natural exits and clean close.
- C395 again received no keys. The user reported not focusing the receiver. Only three read-only native operations ran; three natural exits and clean close.
- The receiver was then centered, explicitly assigned first responder on activation/click, and reported `inputFocused`.
- C396's **whole run remains failed** under its original positive-IOHID gate: the manager opened, observed for 5.016659 seconds, closed naturally, and reported zero callbacks. Its proven AX/application-receipt facts are accepted only as the remote arm under the subsequently confirmed contract. The pixel arm had not started.
- C397 separately completed the previously untested pixel arm. It did not open IOHID or relabel zero callbacks as positive hardware evidence.

Local-HID pure tests still reject zero/incomplete evidence. The explicit remote test uses a separate positive receiving-counter/focus/cursor gate. Neither is hostile-driver-resistant attestation. This is not formal performance evidence, universal application compatibility or completion of the entire General delivery.

Foreground preparation and interruption qualification is documented in `native/computer/patches/g02-cross-window-drag.md`; it is deliberately separate from these background arms. Production pins remain unpromoted.
