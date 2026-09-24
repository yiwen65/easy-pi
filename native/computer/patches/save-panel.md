# Hosted save panels and verified replacement

Apply `save-panel.patch` **after** `general-desktop.patch` and its qualified
P06 predecessors, not against bare upstream. Seven Rust paths; existing Cua
MIT notice in `LICENSE.cua.md` applies. No ABI/schema change.

- Patch SHA256: `aac2d326fd77b52c9462e5517308b00e3ec91b82136d5924314be1472dc1f20f`.
- SDK: `b3ac211594001c05c5020f87e753a64f44fd5786b3701f6117eb9422b377e7d0`.
- N-API retained: `93ffdcc7fbba3437af84c61d60d5d6a8cbf231129f5b1ad4c947abeb8a5aed5a`.
- Renderer retained: `1195e23ecdad946a7090f338357e41042ceaa1333daa18203ea7bfc0ee8c2fa3`.

The selected host AXSheet is resolved beneath its AXWindow. Host-side proxy
children must have a bounded, bidirectional AXParent/AXChildren chain to that
nearest sheet, consistent host PID and remote CG window ID, and a stable remote
process incarnation/owner. Normal sibling windows, application/web boundaries,
missing ownership and foreign AX PIDs are refused. Titles/rectangles never
authorize merging. A parent selection still excludes the child sheet.

Semantic AXValue replacement is used when positively supported. Hosted-sheet
keyboard input uses a private non-suppressing foreground HID source only after
exact focus/ownership proof, with per-primary rechecks and owned matching-up
cleanup even after cancellation or sheet closure. Other input retains its
existing route. No retry, lock reset or automatic ownership recovery is added.

Synthetic Fill must read back the exact unchanged old AXValue, equal
AXSelectedText, and exact focused element after Command+A, before text/Delete.
It permits up to 200ms of read-only settling inside the existing operation
budget. Unknown, partial, changed or wrong-focus selection stops with
`replacement_selection_unproved`; the already dispatched selection prefix
remains an uncertain committed effect, not a false zero-input result.

Built with retained Rust1.97.1 locked/offline inputs. Genuine UniFFI generation
`--check` passed; unchanged generated declarations/runtime justify retaining
the qualified N-API. Independent Git-root apply, exact seven-file comparison,
and reverse verification passed. Full source/license material accompanies the
1432-file package, including `sources/save-panel-build.json`. Byte-reproducible
builds and cold-checkout bootstrap are not claimed.

Reproducible GUI fixture: `../desktop/fixtures/save-panel/README.md`.
Evidence and remaining scope: `../../../docs/implementation/computer/2026-09-24-save-panel-failure.md`.
Local build/probes/backups: `/tmp/easy-pi-native-save.rkAaFu`.
