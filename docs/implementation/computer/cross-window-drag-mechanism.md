# Cross-window drag mechanism qualification

This is T-070 evidence, **not production cross-window drag delivery**. Task status is governed only by `docs/tasks/2026-09-18-computer-native-implementation-task.md`.

## Boundary

Current production segments still bind one selected window and one image. The standalone Swift diagnostic has no `ComputerOperation`, does not acquire the canonical lease, and cannot supply driver-owned terminal evidence. Its explicit foreground route moves the system cursor; it is not a background route.

The fixture uses real `NSDraggingSession` / `NSDraggingDestination`, a fresh UUID and a private drag pasteboard type (`org.easy-pi.t070.private-drag`). No general clipboard replacement or borrowed file is involved. Child process parent/start/executable, window identity, visibility and geometry are checked. Borrowed applications are not signaled or reconfigured.

## Results

Artifacts below are relative to `.artifacts/computer/general/cross-drag-prototype-parent/`.

| Run | Real destination result | Real source result |
| --- | --- | --- |
| `same-global-hit-drop-01` | Exactly one matching fresh payload | Ended with copy operation `1` |
| `separate-global-hit-drop-01` | Exactly one matching fresh payload in separate PID | Ended with copy operation `1` |
| `same-global-hit-cancel-01` | No accepted payload | Ended with operation `0` |
| `separate-global-hit-cancel-01` | No accepted payload | Ended with operation `0` |

The `cancel` arms end inside the source window, where no destination accepts the payload. They are unaccepted-drop controls, **not injected mid-gesture Stop/revocation tests**; those remain a production gate.

Each run posted 14 events, including one owned matching mouse-up. Each observed 14 tagged own CGEvents and zero external events through a **listen-only** tap. The four senders and six fixture processes exited naturally. Each run has independently checked `independent-verification.json`, source/binary `inputs/hashes.json`, raw receipts, commands and exits. The canonical marker remained C384; no generation was created by these diagnostics.

The callback counter is not physical-device attestation, complete user-input coverage or a hostile-local-producer security boundary. Global-source suppression interval is explicitly zero and both suppression-state filter masks permit all local input. No physical-input blocking is used.

## Hit testing and retained failures

`same-passive-hit-controls-01` posted no input. Default `SLSFindWindowAndOwner` queries identified both exact endpoints, then distinguished an owned intercepting panel from the **same** panel after `ignoresMouseEvents=true`: the rectangle still overlapped, but the hit result named the underlying source. The closed-panel control also passed. The diagnostic never queries below an external surface or skips a process by name/layer. Every subsequent primary drag position was checked against the retained source or destination. The successful fixture windows were adjacent; arbitrary paths through unrelated windows are not qualified.

Earlier `same-global-adjacent-drop-01` stopped before posting because rectangle ordering showed UURemoteServer window11254 over both endpoints. That overlay was not present at these endpoints during the later control, so its earlier hit behavior remains unknown. It was not killed, hidden or reconfigured.

Earlier source-stamped public PID transport, explicit destination hover fields, timestamp/delta variants, verified foreground PID transport and private `SLEventPostToPid` produced no successful drop in the recorded attempts. They remain failures; the global route is an explicitly selected fresh experiment, not an automatic second delivery of an uncertain action. Earlier overlapping-window global drop also failed; source auto-raising is not uniquely proven as its cause.

All original preparation, geometry, receipt-bound, module-cache and compile failures remain. `same-foreground-01` had zero posts but lacks its original natural-exit proof; later PID absence does not repair that evidence.

## Checks and sources

- Swift 6 strict concurrency / warnings-as-errors compilation passed (`hit-gated-build.log`).
- 44 pure argument, geometry, protocol and hit-identity checks passed.
- `general/verify-cross-drag-diagnostic.py` independently checked all four effect runs and the passive overlay control, including input hashes and unchanged canonical identity.
- Public ABI/call reference: [yabai extern.h](https://raw.githubusercontent.com/koekeishiya/yabai/master/src/misc/extern.h) and [window_manager.c](https://raw.githubusercontent.com/koekeishiya/yabai/master/src/window_manager.c), retrieved anonymously into `general/cross-drag-public-ref/`. Only the default topmost query was used; yabai-specific overlay exclusions were not copied. These are untrusted implementation references, not a public SPI stability guarantee.
- Browser retrieval failed with `ERR_TUNNEL_CONNECTION_FAILED`; no successful `scan_complete` or whole-page capture is claimed. The subsequent raw HTTP retrieval supplied source text, not an executed program.

T-072 must still implement dual live capabilities, both current model-visible images, bounded foreground transport, cancellation/revocation/close integration and genuine generated bindings. Installed original AgentSession and real Finder file-operation qualification remain required under T-047.
