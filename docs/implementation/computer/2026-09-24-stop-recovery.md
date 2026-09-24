# Computer startup refusal and manual recovery — 2026-09-24

## Finding and code fix

The installed bridge reproduced the reported startup failure on the first
`discover`. Calling the same native constructor exposed
`ComputerError.Refused { reason: "desktop_lease_unavailable" }`.
The canonical desktop marker was dirty at generation `0309`; no open holder was
reported by `lsof`. The earlier event that left this generation dirty was not
established. Process exit alone is not native terminal proof.

The bridge classified every constructor failure as `renderer_creation_failed`.
Its synchronous stop notification revoked the session, replacing the useful
failure with `session_revoked`. Commit `ba20bb04c` preserves the known lease
refusal and exposes the latched reason on rejected tool calls and renewal.
It retains revocation, emergency-stop latching, existing result details and
fulfilled results; it does not retry ownership or replay input.

The new startup regression failed before the fix with `session_revoked` and
passed afterward. It and 69 existing Computer lifecycle/integration tests passed.
`npm run check` and the native desktop typecheck against the installed SDK passed.
Unrelated formatter changes were reverted, leaving pre-existing user work intact.

## Authorized operational recovery

After the user approved continuation of the proposed manual recovery, a one-time
script opened the existing lock without following a leaf symlink, acquired an
exclusive nonblocking kernel lock, checked owner/mode/inode and the exact dirty
generation, and durably backed up its bytes before writing `C` on the same inode.
This was an explicit operator override, not a claim about the previous owner's
terminal state. No lock was deleted and no live easy-pi process was killed.

Backup: `/Users/w/.pi-computer-desktop-v1/desktop.lock.before-manual-recovery-20260924-094922`.

The native packager validated existing pinned SDK/materials and generated a new
bridge and manifest. Product TypeScript compilation ran into a temporary output;
only the changed binding's compiled artifacts were installed with the bridge.
Previous artifacts and diagnostic scripts are retained temporarily under
`/tmp/easy-pi-computer-recovery.iiThob/`.

## Real installed-product verification

- Before recovery, the updated installed bridge reported `desktop_lease_unavailable`.
- After recovery, actual `discover` succeeded and renderer health was `ready`.
- A local AppKit fixture passed `discover → select → observe → segment(fill) → observe → capture`.
- Native condition status was `confirmed`, route was background accessibility,
  and both native observation and the fixture's independent checkpoint returned
  `easy-pi computer recovered 2026-09-24` in the Name field.
- The captured window image was visually inspected and showed the same value.
- Feature close returned the marker to `C`; a fresh feature then successfully
  acquired, discovered and closed again. Final observed generation: `030f`, clean,
  with no open lock holder reported.
- The fixture exited normally. No provider API or paid model call was used.

The fixture was a temporary normal-window variant of `P04GuiFixture.swift`.
The original floating standalone executable was omitted by the native accessory
surface identity gate because it lacked an application bundle identity; it was
not used as proof that ordinary-window control had failed.

## Remaining boundary

Already-stopped easy-pi processes keep their intentional host-lifetime stop latch.
Exit and restart the affected process; `/reload` or a new conversation cannot
revive that native feature. The prior unclean shutdown's cause remains unknown.
Recovery must not become an automatic dirty-marker cleanup on future failures.
