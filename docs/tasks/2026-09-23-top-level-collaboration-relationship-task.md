# Task Plan: Move collaboration relationship to top-level tool input

- Created: 2026-09-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User request to move `relationship` to the top level of both `spawn_agent` and `followup_task`.

<!-- task-doc-section:background-goal -->
## Background and goal

Both model-facing tools currently accept `task.relationship`, although callers repeatedly place it beside `task`. Make `{ task: { objective }, relationship? }` the only wire shape; keep the persisted canonical `delegation.task.relationship` to avoid rewriting historical team records.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- In scope: wire schemas and exported input types, parsing/normalization handoff, model and operator adapters, model-facing descriptions, tests/fixtures, active collaboration documentation.
- Out of scope: persisted canonical schema migration, controller semantics, automatic conversion of old tool calls, unrelated archived scripts/docs and real paid-provider trials.
- Preserve unrelated edits already present in `LEARNS.md`, another task document, and `native/computer/desktop/test/`.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Wire task schema currently owns optional relationship; both tools use it. | `packages/subagent/src/collaboration-contract.ts:318-344,603-622` |
| F-002 | Canonical persisted delegation still requires `task.relationship`; normalization derives context from it. | `packages/subagent/src/collaboration-contract.ts:212-242,417-477,492-505`; `packages/subagent/src/collaboration-store.ts:122,154` |
| F-003 | Model and operator followups separately construct canonical delegations. | `packages/coding-agent/src/extensions/pi-collaboration-tools.ts:239-286,353-362`; `packages/coding-agent/src/extensions/pi-collaboration-monitor.ts:380-386` |
| F-004 | Current worktree has unrelated modified files. | `git status --short`, 2026-09-23 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: "正式移到顶层" means old nested wire shape should be rejected; no dual wire API. Canonical stored records remain readable. Verify by negative/positive contract tests and retained-record tests.
- Open question: None blocking. External clients of the exported wire type must update; this is documented as a breaking change.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Both tools accept top-level `relationship` and reject `task.relationship`, including simultaneous placements; omission still defaults to `continue`.
- Top-level `verify`/`explore` derive isolated context for spawn; explicit invalid fork still fails; followup retains existing-history and independence restrictions.
- Persisted canonical `task.relationship` remains unchanged and existing records validate.
- Tool descriptions, operator JSON contract and active docs reflect the new shape; tests and typecheck pass or blockers are recorded.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: None; wire types/fixtures and downstream adapters depend on the same schema and are serialized.
- Serialization constraints: no concurrent edits to the contract schema or its consumers; one coordinator owns this document.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Wire schema and contract coverage

- Status: done
- Owner: coordinator
- Objective: Move relationship to top-level wire input without changing canonical storage shape.
- Inputs and prerequisites: Existing `collaboration-contract.ts` and contract tests; F-001/F-002.
- Scope or files: `packages/subagent/src/collaboration-contract.ts`, `packages/subagent/test/collaboration-contract.test.ts`.
- Expected output: Strict new wire validation with reliable canonical conversion and focused tests.
- Dependencies: None.
- Execution steps:
  1. Update wire-only task and tool schemas and parsing/normalization boundary.
  2. Test top-level, omitted, nested-invalid, context and canonical-record cases.
- Acceptance criteria:
  - Both tools accept only top-level relationship on wire; validated canonical delegation retains nested relationship.
- Verification method:
  - Targeted subagent contract tests and typecheck after adapters are updated.
- Validation evidence: Contract test failed before implementation (2 shape failures), then `packages/subagent/test/collaboration-contract.test.ts` passed 50/50 after schema changes. Full typecheck deferred to T-003.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Model/operator adapters and guidance

- Status: done
- Owner: coordinator
- Objective: Make every active adapter use top-level relationship and update active examples.
- Inputs and prerequisites: T-001 done.
- Scope or files: `packages/coding-agent/src/extensions/pi-collaboration-tools.ts`, `pi-collaboration-monitor.ts`, `packages/coding-agent/test/collaboration-fixture.ts`, `test/pi-collaboration-tools.test.ts`, `docs/collaboration.md`.
- Expected output: Spawn/followup/JSON operator paths and guidance reflect new wire format.
- Dependencies: T-001.
- Execution steps:
  1. Map wire relationship into canonical task at model and operator paths.
  2. Update fixtures, integrated assertions and docs.
- Acceptance criteria:
  - Top-level independent spawn derives correct context; model and operator followup retain prior semantics.
- Verification method:
  - Targeted coding-agent tool/panel tests and TypeScript check.
- Validation evidence: `test/pi-collaboration-tools.test.ts` 28/28 passed with new top-level verify spawn/followup; `test/grok-agents-panel.test.ts` 14/14 passed. Typecheck pending final T-003 after fixture type adjustment.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Final validation and delivery

- Status: done
- Owner: coordinator
- Objective: Review diff, run checks, disclose remaining risks, commit only owned files.
- Inputs and prerequisites: T-001/T-002 done.
- Scope or files: Only files in T-001/T-002 and this task document.
- Expected output: Verified focused commit and truthful report.
- Dependencies: T-001, T-002.
- Execution steps:
  1. Run targeted tests, repository check or scoped equivalent if pre-existing artifact configs block it.
  2. Check diff/status, record evidence, commit owned paths.
- Acceptance criteria:
  - No unrelated files staged and all runnable relevant checks pass.
- Verification method:
  - `git diff --check`, `git status`, targeted tests, `npm run check`.
- Validation evidence: Subagent 3 targeted files 94/94 passed; coding-agent tools 28/28 and panel 14/14 passed; `tsgo --noEmit`, scoped Biome on six changed code files, `git diff --check`, and task-document validator passed. `npm run check` attempted but failed at pre-existing nested `.artifacts/computer/**/biome.json` configurations before its later steps; no unrelated artifacts removed.
- Blocker: None for scoped verification; global check remains blocked by unrelated `.artifacts` state.
- Unblock condition: Remove/ignore nested artifact Biome roots in a separate authorized maintenance task and rerun full check.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

Use specific Vitest files under `packages/subagent` and `packages/coding-agent`, `npm run check` (known `.artifacts` nested-Biome risk), scoped Biome and `tsgo --noEmit` if blocked. No real-provider call or full test suite.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Breaking exported wire types and old model/operator JSON. Reject rather than silently translating; persisted canonical records remain compatible.
- Explicit fork paired with top-level `verify`/`explore` must still reject. Avoid defaulting to `continue` before copying relationship into canonical task.
- Existing `.artifacts/` nested Biome roots can block global `npm run check`; do not delete unrelated artifacts.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-23: Inspected current schemas, adapters, tests, and unrelated worktree state; created plan and started T-001.
- 2026-09-23: T-001 red/green contract test (2 shape failures before, 50/50 pass after); began T-002.
- 2026-09-23: Updated model/operator adapters, fixture, guide and integrated verify spawn/followup regression; 28/28 collaboration-tool and 14/14 panel tests passed. Started T-003.
- 2026-09-23: Scoped Vitest (subagent 94/94), Biome, TypeScript, diff and document checks passed; full `npm run check` failed on unrelated nested `.artifacts` Biome roots. Reviewed scoped diff and worktree; ready to commit owned paths only.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001/T-002/T-003 scoped tests and static checks above passed; top-level relationship accepted and old nested wire rejected while canonical records remain nested.
- Limitations: Full `npm run check` blocked by pre-existing `.artifacts` Biome configurations; no real paid-provider eval, build or full suite (not requested). External users of the breaking wire API must update old JSON calls.
