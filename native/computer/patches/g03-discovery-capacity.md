# Count selectable windows after metadata classification

Apply `g03-discovery-capacity.patch` after `g03-recovery-budget.patch`.
SHA256: `e5f5e92eed9ceb82adb4c2d7e875b399de222f14dd9b924670cc35f0fd9a1441`.

The old256-row guard ran before eligibility checks. WindowServer can return
hundreds of cached/accessory rows with absent visibility metadata; General
correctly retains unknown rows until classification, but then refused the entire
catalog before rejecting those unselectable entries.

The patch bounds **selectable rows** at256, retaining the existing refusal for257
valid rows. Invalid/unknown metadata receives no reference and contributes only
to the explicit u32 omission count. SDK decoding bounds rows and omissions
separately. Per-row cancellation and exact identity, geometry and Space checks
remain; no windows are closed and no missing visibility is promoted to visible.

## Evidence

Under `.artifacts/computer/general/`:

- C418/C419: discovery refusal before input, two read-only terminals/four natural
  exits. C419 captured `discovery_limit_exceeded`.
- Passive aggregate:328 raw rows,301 missing visibility flags;239 metadata-eligible
  upper bound,10 invalid geometries and79 unselectable accessory rows. This is
  not a process-stamp/Space qualification of every row.
- `discovery-capacity/{platform,sdk}-before.log`: both production seams failed.
  After repair: Computer63, SDK94, core106 and genuine generation/check/staging/
  header/TypeScript passed. Generated text and dependency locks did not change.
- `discovery-capacity/source-verification.json`: two authored paths, strict
  apply/byte/reverse proof; frozen budget candidate unchanged.
- `recovery-budget/after-verification.json`: same installed original AgentSession
  now discovered/selected the dedicated target and completed all three recovery
  cases, 22 terminals/six natural exits through clean C422.

Matching candidate SDK:
`c2a7877622f23028e14f6a5103bc8346f72eb3d07eafa5288bc4b351a0eae26f`.
N-API:
`7dea58f3d6e83896c26cc10e55f16bb0b6c6b20a49b7003bed8ad6d2b5a9cdb9`.
The existing256-selectable-window bound remains a reported limit, not an unlimited
catalog claim. No production pin promotion or overall delivery claim is made.
