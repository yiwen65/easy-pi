# Shared native recovery budget

Apply `g03-recovery-budget.patch` after `g03-modal-surface.patch`.
SHA256: `7bbab6480aaf70efecb0ad6a930738b2a9b1bd13a60158bb48e3ee0f790326df`.

## Behavior

Previously, the same unresolved intent could acquire a fresh deadline and retry
allowance in every operation. Now its first configured duration is the total
native-work allowance. Each operation consumes time from configuration through
actual terminal settlement; outstanding work or quarantine cannot refund it.
Time between operations, including model/user judgement and separate captures,
is neither charged nor a way to replenish the allowance.

New operations and internal route changes share two recovery attempts. Successful
activation-only cross-window preparation grants one continuation for the same
immutable destination; activation is not recorded as requested drag input.
The existing single native lane, cancellation, owned releases and drain remain.

`remaining_duration_ms` is a genuine generated result field, sampled at result
construction. This patch contains ten authored Rust paths and three regenerated
Python/TypeScript files. Regenerate and rebuild matching SDK/N-API assets; do not
combine this bridge with older bindings.

The host retains the intent across no-input retargeting, refuses silent renewal
on reselection, and stops automatic reads at exhaustion. Unknown committed or
partially completed input still requires newer evidence and explicit judgement.
A satisfied condition alone no longer reconciles an incomplete delivered prefix.

## Evidence and limits

Evidence below is relative to `.artifacts/computer/general/`:

- `recovery-budget/recovery-before.log`: three original budget/drain failures.
- `recovery-budget/late-budget-before.log`: expiry before first worker binding
  also spent no budget; fixed without reopening cancelled input admission.
- Final native checks: core106, SDK93, Computer62, controlled input17; genuine
  generation/check, staging, ABI header and TypeScript emission passed.
- `recovery-intent-before-fixed.log`: eight host/intent failures, then targeted
  regression success. Two additional target-return failures were subsequently
  fixed by consulting the bounded target ledger, not only the current window.
- `recovery-budget/source-verification.json`: strict apply/byte/reverse proof.
- `recovery-budget/after-verification.json`: installed original AgentSession,
  C420–C422, 22 distinct terminals, six natural exits. Modal retries0/1/2 then
  exhaustion had zero input and no read after exhaustion. A trusted SDK-only
  200ms fault budget expired before the actual delayed effect; a same-intent
  direct SDK request for30s was refused without another key. Lost reply after
  genuine success/terminal produced unknown, blocked replay before native, and
  allowed only remaining work after fresh explicit reconciliation.

Final matching installation: `/private/tmp/epi-computer-install-wvTeFE/product`,
SDK `c2a7877622f23028e14f6a5103bc8346f72eb3d07eafa5288bc4b351a0eae26f`,
N-API `7dea58f3d6e83896c26cc10e55f16bb0b6c6b20a49b7003bed8ad6d2b5a9cdb9`.
It includes the subsequent discovery-capacity repair. Final evidence:

- `recovery-budget/final-core-verification.json`: the three recovery cases rerun.
- `recovery-budget/neighbors-verification.json`: incomplete-prefix reconciliation,
  Stop without continuation, and preserved failed read-only C425 selection.
- `recovery-drag-verification.json`: real cross-PID activation-only preparation,
  fresh images/changed coordinates, same intent, retry count1→1 and exactly one
  drop; owned helper and all four children exited.
- `recovery-crossapp-verification.json`: original single AgentSession, Chrome
  source→VSCode save→Finder selection→GUI Terminal checksum, exact612 UTF-8 bytes.
- Seven successful final runs:87 terminals/16 natural exits. The separate C425
  stale-selection failure has two read-only terminals/two natural exits and is
  not reclassified as success. Final root64, original AgentSession13, both type
  layers and `g03rf` complete check passed;1459 files, no fixes/source drift.

These are faux provider requests, not new real-provider evaluation. They do not
establish performance or completion of the General Computer delivery. Production
pins remain unpromoted. The authority document owns final task status.
