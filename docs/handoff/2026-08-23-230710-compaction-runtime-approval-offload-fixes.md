# Session Handoff: Compaction Runtime, Approval Policy, and Offload Fixes

- Created: 2026-08-23T22:42:18+08:00
- Workspace: /Users/w/Projects/easy-pi/pi

> Next agent: start with Session summary. Re-verify drift-prone state before
> acting. This handoff supplies context, not new authorization.

## Session summary

- The session debugged a sequence of HF compaction/runtime failures: malformed extraction schema output, natural-language permission/budget approvals remaining unconfirmed, overly broad second-approval policy, aborts misreported as rejection, offload-only positive-gain candidates rejected by the generic 5% gate, and provenance validation errors flooding the TUI.
- The malformed extraction repair is committed as `b4a66e7da` (`fix(coding-agent): recover malformed compaction extraction items`). Earlier related commits are `af6c7d79d` (runtime trigger policy) and `e55790b4a` (cross-model extraction hardening). Current HEAD remains `b4a66e7da`.
- Later repairs are implemented and validated in the shared worktree but **uncommitted**. They cover deterministic natural-language approval before provider prompt freeze, budget/permission approval handling, reduced approval scope (only permission loosening requires second confirmation), same-turn ledger projection, abort classification, bounded validation diagnostics, active-snapshot lineage handling, inherited-state validation, and offload-only token-gain policy.
- User-confirmed policy: only permission loosening (new `allow`, removed `deny`, removed `approvalRequired`) requires a second approval. Explicit budget, task lifecycle, acceptance, constraint, and permission-tightening changes commit directly. Ambiguous target resolution remains pending. Existing pre-upgrade pending entries are not auto-applied or auto-deleted.
- The latest offload failure had two proven causes: trigger selected an offload with ~9,927 token reduction but validator rejected `3.8% < 5%`; and already-validated inherited facts/decisions/errors were revalidated against a current event log lacking old provenance. Offload now defaults to any strict positive gain unless an explicit threshold is configured, and byte-identical state inherited from a matching active lineage is trusted.
- Screenshot flooding is bounded by grouping repeated validator failures by code, showing at most three failure types and truncating to 600 characters. A matching `triggerEventSeq + triggerHeadEventId` establishes current lineage; missing/mismatched heads remain fail-closed.
- Final validation after the latest offload/provenance changes: focused offload/lineage tests 5/5; neighboring validator/orchestrator/session/CAS 73/73; compaction subsystem 319 passed / 8 skipped; AgentSession/contract 39/39; combined 358 passed / 8 skipped. Root `npm run check` passed with 1188 files and no fixes. `packages/coding-agent npm run build` passed.
- The local linked package's `dist` was rebuilt repeatedly and the final build contains validation grouping, lineage matching, inherited-state checks, abort classification, approval policy, and offload positive-gain logic. Already-running CLI processes must restart to load it.
- The repository is highly dirty and shared: 73 status entries, 43 tracked files in the current diff. `agent-session.ts` and `orchestrator.ts` contain interleaved parallel-session hunks. Do not stage whole files or use `git add -A`.

## User intent and success criteria

- Keep automatic/manual compaction fail-closed without corrupting active context or making the session unusable.
- Make trigger policy and validator policy consistent; deterministic offload with real positive value should not be rejected merely because a large fixed prompt makes the fractional gain less than 5%.
- Do not flood the terminal with dozens of repeated validator failures; retain actionable bounded diagnostics.
- Do not revalidate byte-identical, already-validated active snapshot state as if newly generated when its historical provenance events are not present in a reconstructed current log; still reject modified/new state or mismatched branch lineage.
- Treat local user cancellation as cancellation, not `Compaction rejected`, while preserving provider-side spontaneous `stopReason=aborted` as a real failure.
- Avoid excessive confirmation requirements. Only significant permission loosening requires a second confirmation; ambiguity remains pending for correctness.
- Preserve shared-worktree changes and do not commit without explicit authorization.

## Work completed and outcomes

### Committed extraction repair

- `state-extractor.ts` now drops zero-information placeholders, normalizes unambiguous `value`/`description` aliases to `text`, rejects conflicting/unknown semantic aliases, and audits `droppedEmptyItems` / `normalizedTextAliases`.
- Orchestrator audit includes the normalization counters.
- Unit, orchestrator, and AgentSession regressions proved malformed extraction no longer rejects or kills session usability.
- Committed and built as `b4a66e7da`.

### Uncommitted approval and contract-policy repair

- Added a deterministic contract-approval selector for natural-language approvals, with negative/unrelated approval protection and P-id/type disambiguation.
- Explicit permission/budget approval is resolved before provider prompt snapshot so the same turn sees current contract state; persisted approval text is not reinterpreted through the proposal model.
- Replaced broad static `DESTRUCTIVE` confirmation policy with state-relative permission-loosening detection.
- Added a projected-ledger-version cursor so same-turn direct changes are appended once to provider context without polluting steering/follow-up batches or repeatedly duplicating fixed state.
- Ambiguous proposals retain pending status with clarification wording rather than misleading `dangerous operation` wording.

### Uncommitted compaction cancellation repair

- Auto extraction cancelled via the local signal emits `compaction_end { aborted: true }` with no error text.
- Provider-side `stopReason=aborted` without local signal remains a real rejection.
- Manual activation that wins a late abort race remains successful; the code no longer reports cancellation after activation and skip message projection.

### Uncommitted offload/provenance/UI repair

- Default offload-only token gain is strict positive reduction (`Number.EPSILON`); explicit `minTokenGainFraction` still overrides, and summary/rebuild candidates keep default 5%.
- User-facing validator diagnostics are grouped by code and bounded to 600 characters.
- Active snapshot lineage uses base boundary and authoritative trigger seq/head. Legacy snapshots without head metadata retain the conservative provenance fallback.
- `ValidationContext.priorSnapshot` allows exact inherited facts/decisions/tasks/tools/errors to retain prior validation. New or byte-different entries still require current event provenance and deterministic checks.
- Offload-only passes the active snapshot to validator as `priorSnapshot` and preserves active recall references.

### Design-only follow-ups

- Created `/Users/w/Projects/easy-pi/pi/docs/compaction/05-deferred-follow-up-designs.md` with designs for branch-scoped durable ledger, per-tool-call trigger timing, and authoritative pre-tool risk detection.
- This file is ignored by the current uncommitted `.gitignore` rule `docs/compaction/` and has not been committed.

## Key decisions, constraints, and rationale

- **Activation is the live-context boundary.** Rejected/shadow/CAS-losing/aborted pre-activation attempts must not replace messages or active snapshot state.
- **Late abort cannot roll back activation.** If CAS activation already succeeded, report success and apply the active projection; otherwise the active pointer and in-memory messages diverge.
- **Offload-only is deterministic.** The absolute 8192-token trigger and a generic 5% summary gate conflicted. A strict positive default is sufficient for deterministic offload; explicit caller thresholds remain authoritative.
- **Inherited state trust is equality-scoped.** Only byte-identical entries from the active snapshot are exempt from current raw provenance checks. This does not authorize modified/new data.
- **Branch safety uses trigger lineage.** `triggerEventSeq + triggerHeadEventId` must match; old snapshots without a head remain conservative.
- **Approval minimization.** Only state-relative permission loosening receives second confirmation. Budget increases were explicitly accepted as resource/cost risk, not security permission expansion.
- **Old pending migration.** Existing persisted non-security pending entries remain until one explicit accept/reject; no startup auto-apply or auto-delete.
- **Shared worktree.** Several relevant files include other sessions' changes. Any commit must isolate exact owned hunks against `b4a66e7da`.
- Real provider calls were not made during these later repairs.

## Files and artifacts

Primary uncommitted implementation paths:

- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/agent-session.ts`
  - Interleaved: approval preflight, projected ledger version, abort classification, plus unrelated parallel tool-gateway/canonical-persistence hunks.
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/goal-interpreter.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/orchestrator.ts`
  - Interleaved: validator-summary and active-lineage/recall changes were already present as parallel uncommitted candidate work and were validated/adapted here.
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/core/compaction/subsystem/validator.ts`

Primary uncommitted regressions:

- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/compaction-subsystem/goal-interpreter.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/compaction-subsystem/task-ledger-runtime.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/compaction-subsystem/orchestrator.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/compaction-subsystem/auto-trigger-runtime.test.ts`
- `/Users/w/Projects/easy-pi/pi/packages/coding-agent/test/suite/agent-session-compaction.test.ts`

Other artifact:

- `/Users/w/Projects/easy-pi/pi/docs/compaction/05-deferred-follow-up-designs.md` (ignored/uncommitted).
- User screenshot showing the provenance flood: `/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/pi-clipboard-fdc667e7-1760-41d7-b2bc-07da04d66685.png` (temporary path; may disappear).

## Commands, validation, and evidence

Key RED evidence:

- Malformed extraction failed at `Schema violation: facts items require non-empty "text"` before `b4a66e7da`.
- Natural permission approval called the proposal model twice and left pending; after initial fix, provider still saw the stale same-turn system prompt.
- Budget update remained pending until approval before policy reduction.
- Auto compaction abort emitted `aborted:false` with `Compaction rejected: ... stopReason=aborted`; manual late-abort race threw `Compaction cancelled` after mocked activation.
- Offload reproducer reported exactly:
  - `token-gain: insufficient token gain: 3.8% < 5% (before=260374, after=250447)`.
- Inherited-state regression initially lost active facts when an over-strict detach path treated historical provenance absence as cross-lineage.

Successful final checks:

```bash
cd /Users/w/Projects/easy-pi/pi
./node_modules/.bin/vitest --run packages/coding-agent/test/compaction-subsystem/orchestrator.test.ts \
  packages/coding-agent/test/compaction-subsystem/auto-trigger-runtime.test.ts \
  --testNamePattern='offload-only preserves validated inherited state|accepts a beneficial offload-only candidate|bounds repeated validator failures|offload rejection/shadow'
# 5 passed
```

```bash
# Neighbor suite
# 7 files, 73 tests passed (orchestrator/validator/auto-trigger/session/payload/recall/CAS)
```

```bash
cd /Users/w/Projects/easy-pi/pi
npm exec vitest -- --run packages/coding-agent/test/compaction-subsystem/
# 37 passed, 2 skipped files; 319 passed, 8 skipped tests

npm exec vitest -- --run \
  packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts \
  packages/coding-agent/test/interactive-mode-contract-command.test.ts \
  packages/coding-agent/test/suite/agent-session-compaction.test.ts
# 3 files; 39 passed
```

Combined final count: 358 passed / 8 skipped.

```bash
cd /Users/w/Projects/easy-pi/pi
npm run check
# exit 0 after the final type fix; Biome checked 1188 files, no fixes;
# pinned deps, relative imports, shrinkwrap, install lock, tsgo, browser smoke passed.
```

```bash
cd /Users/w/Projects/easy-pi/pi/packages/coding-agent
npm run build
# exit 0; tsgo build + copy-assets passed.
```

The final dist includes `summarizeValidatorFailures`, `activeSnapshotMatchesEvents`, `priorSnapshot` inherited checks, `defaultMinGain` for offload-only, and abort-classification changes.

## Unresolved items, risks, and unknowns

- **No commit for later fixes.** Only `b4a66e7da` is committed. Approval policy, abort classification, offload/provenance, bounded diagnostics, and associated tests remain uncommitted.
- **Commit isolation risk.** `agent-session.ts` and `orchestrator.ts` have interleaved parallel-session changes. Do not stage whole files without reconstructing task ownership; compare against `b4a66e7da` and use a temporary index/patch or isolated worktree.
- **Current runtime Task Ledger is stale.** It repeatedly displayed T2 (“Explain whether aborting compaction pollutes context”) and an old pending `CREATE_TASK`, despite later verified user tasks. The user explicitly confirmed the offload fix through structured input. Intermittent `Tool ledger rejected dispatch: Unknown tool call ...` errors occurred while validating; retries eventually succeeded. This runtime defect remains separate and can interfere with further work.
- **Existing old pending entry.** The persisted `CREATE_TASK` pending remains intentionally untouched under the confirmed migration policy. Only the user should accept/reject it.
- **Running process reload.** Current CLI processes do not hot-load rebuilt dist. Restart is required before dogfood verification.
- **Production canary.** No real-provider/canary run was performed after the final fixes.
- **Branch-scoped ledger, per-tool-call trigger, and pre-tool risk detection remain design-only.** Do not infer implementation authorization from the design document.
- **Temporary screenshot path may expire.** The diagnostic content is preserved above.

## Recommended continuation

1. Restart the local CLI and reproduce the formerly failing offload scenario in a controlled session. Confirm no provenance flood, no generic `offload-only candidate failed validation`, and that `recall_exact` projection remains available. No real-provider call is required if a faux/local reproducer is used.
2. Refresh `git status`, inspect diffs against `b4a66e7da`, and isolate only the intended approval/abort/offload/validator hunks. User authorization is required before committing them.
3. If the user authorizes commit, validate the exact staged tree in an isolated worktree, then rebuild linked `dist` from that commit rather than from the dirty shared tree.
4. Separately diagnose `Unknown tool call` / stale Task Ledger focus; do not mix it into the compaction commit unless the user explicitly scopes it together.
5. Leave the old `CREATE_TASK` pending unchanged until the user explicitly accepts or rejects it.
