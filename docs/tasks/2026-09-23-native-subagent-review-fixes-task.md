# Task Plan: Native subagent review fixes

- Created: 2026-09-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: User requested `$best-practice 执行修复` after the read-only native subagent review.

<!-- task-doc-section:background-goal -->
## Background and goal

Fix the concrete product-path defects identified in the preceding review without altering authority, retained history, or another session's changes. A slow-start performance concern is conditional: establish a reproducible impact and assess the synchronization tradeoff before changing lifecycle concurrency.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- Scope: native collaboration transcript and `/agents` TUI, team admission/error diagnostics, current collaboration documentation, targeted tests. Preserve closed records, non-reusable names, and existing quotas other than making exhaustion recoverable.
- Non-goals: dormant legacy DAG/worktree source, paid provider tests, full test suite/build, destructive cleanup or silently changing retention guarantees. Do not touch other sessions' modified files.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Native collaboration is the shipped default; old DAG is not exported or built. | `packages/coding-agent/src/extensions/easy-pi.ts`, `packages/subagent/src/index.ts`, `packages/subagent/tsconfig.build.json`. |
| F-002 | Transcript objective extractor reads obsolete nested wire args and followup/interrupt/close optimistic states ignore errors. | `packages/coding-agent/src/modes/interactive/components/subagent-group.ts:70-78,180-211`; `packages/subagent/src/collaboration-contract.ts:613-622`. |
| F-003 | `/agents` selects all rows but renders only the first viewport lines. | `packages/coding-agent/src/modes/interactive-grok/components/grok-agents-panel.ts:263-294,379-388`. |
| F-004 | Stored agent records are capped at 2048, closed records retained, and persistence failure poisons the controller. Limit errors collapse distinct resources. | `packages/subagent/src/collaboration-store.ts:96-115`; `collaboration-controller.ts:253-280,553-565`; `collaboration-contract.ts:30-40`. |
| F-005 | Creation is globally serialized, including an await of host load; this is intentional for safe idle eviction. | `packages/subagent/src/collaboration-controller.ts:443-500`; `packages/coding-agent/docs/collaboration.md:129`. |
| F-006 | Documentation describes obsolete six-field output and three child slots. | `packages/coding-agent/docs/collaboration.md:77-87,129`; current result schema `packages/subagent/src/collaboration-contract.ts:537-553` and `maxActiveSessions:16`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 'execute fixes' covers confirmed UI, diagnostics, history-cap failure, documentation, and a bounded assessment of conditional startup performance; it does not authorize deleting retained audit history or changing name uniqueness. A graceful history-cap rejection prevents poisoning but does not enable >2048 historical children; durable archival would be a separate policy/storage decision.
- Open question: None required to perform the bounded repairs; if the startup tradeoff demands an intrusive concurrency redesign, document evidence and residual risk rather than improvise one.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Flat spawn args show the task preview; rejected followup/interrupt/close preserve truthful display state and successful operations still update it.
- A selected row among 15+ children remains visible in `/agents` at a 24-row viewport; action/notice/draft remains visible and prior focused-panel behavior survives.
- History exhaustion returns an actionable, non-poisoning limit error before persistence; capacity errors identify the actual resource without exposing arbitrary exception contents. History and name uniqueness remain intact.
- Documentation matches the current output schema and 15-child capacity.
- Conditional startup liveness has a deterministic oracle; either a safe tested fix is made or the reason to retain the serialized lifecycle and its operational impact is explicitly recorded.
- Focused tests, TypeScript, targeted Biome and an attempted root check are reported accurately; only our paths are committed.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001, T-002, T-003, T-004 independent; T-005 depends on T-003 because both touch controller; T-006 depends on T-001 through T-005.
- Parallel batches: Batch A T-001/T-002/T-003/T-004 on disjoint files; Batch B T-005; Batch C T-006 integration/commit.
- Serialization constraints: Coordinator alone edits this task document and performs staging/commit; T-003 and T-005 share controller files and must serialize. Avoid concurrent repository-wide formatting.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Correct transcript previews and control states

- Status: done
- Owner: /root/fix-group
- Objective: Use current spawn wire schema and update control states only on successful tool results.
- Inputs and prerequisites: F-002 and existing group/component tests.
- Scope or files: `packages/coding-agent/src/modes/interactive/components/subagent-group.ts`, `packages/coding-agent/test/subagent-group.test.ts` only.
- Expected output: Minimal patch plus regressions failing before and passing after.
- Dependencies: None.
- Execution steps:
  1. Write focused failing cases; fix the source; run modified test.
- Acceptance criteria:
  - Flat objective visible; rejected followup/interrupt/close preserve state; success remains correct.
- Verification method:
  - Run target Vitest file from coding-agent package.
- Validation evidence: Focused source/test diff reviewed; flat wire, rejected control, settled interrupt and rejected duplicate spawn covered. Coordinator reran coding-agent 3-file integration subset (68/68 passed); child reported pre-fix focused regression failure.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Keep long `/agents` lists and actions visible

- Status: done
- Owner: /root/fix-panel
- Objective: Render a selection-following list viewport without clipping action/draft/notice.
- Inputs and prerequisites: F-003; existing panel virtual terminal tests.
- Scope or files: `packages/coding-agent/src/modes/interactive-grok/components/grok-agents-panel.ts`, `packages/coding-agent/test/grok-agents-panel.test.ts` only.
- Expected output: Minimal list layout patch and 15+ child short-terminal regression.
- Dependencies: None.
- Execution steps:
  1. Reproduce invisible selection; implement bounded visible list; test selection, notice, composition and resize.
- Acceptance criteria:
  - Selected row and footer remain visible; watch mode and focus behavior unaffected.
- Verification method:
  - Run target Vitest file from coding-agent package.
- Validation evidence: Focused diff reviewed; virtual-panel regression covers 15 children, selection, notice/draft, 24→16→9→6 rows, watch and focus. `Input.render` checked to always return one horizontally scrolling line; coordinator reran coding-agent 3-file subset (68/68 passed) and host focus regression (2/2 passed); child reported pre-fix focused failure.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Recoverable history limit and specific diagnostics

- Status: done
- Owner: coordinator
- Objective: Reject before hitting snapshot history cap and give whitelisted, resource-specific limit hints.
- Inputs and prerequisites: F-004; existing controller/contract tests.
- Scope or files: `packages/subagent/src/collaboration-controller.ts`, `packages/subagent/src/collaboration-contract.ts`, `packages/subagent/src/collaboration-store.ts` (only if necessary), and corresponding subagent tests.
- Expected output: No poison on historical boundary, retained names, distinct safe diagnostics.
- Dependencies: None.
- Execution steps:
  1. Reproduce boundary/error messages with targeted regression; add early guard and reasons; verify persisted state and next operations.
- Acceptance criteria:
  - Exhausted history reports explicit limit without controller failure; unrelated control remains responsive.
- Verification method:
  - Run targeted subagent Vitest files.
- Validation evidence: Pre-fix `vitest -t 'retained history exhaustion'` failed with `storage_error` as predicted; after fix, targeted `collaboration-contract.test.ts` + `collaboration-controller.test.ts` passed 90/90, targeted Biome and diff check passed. Preserves 2048 archived records but rejects a 2049th before commit; new root session needed for further unique child names.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Synchronize product documentation

- Status: done
- Owner: /root/fix-docs
- Objective: Correct only obsolete result-schema and execution-slot statements.
- Inputs and prerequisites: F-006 and live schema.
- Scope or files: `packages/coding-agent/docs/collaboration.md` only.
- Expected output: Current two-field example/semantics and 15 child slots.
- Dependencies: None.
- Execution steps:
  1. Compare live contract/host instructions; edit obsolete statements; inspect focused diff.
- Acceptance criteria:
  - Example is valid, no stale six-field/three-slot claim remains in affected section.
- Verification method:
  - Targeted doc diff and source comparison.
- Validation evidence: Focused diff and `git diff --check -- packages/coding-agent/docs/collaboration.md` passed; compared two-field schema, optional legacy acceptance, 15 slots and new 2048 historical guard to source.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Test startup liveness and bound the design decision

- Status: done
- Owner: coordinator
- Objective: Determine whether head-of-line blocking is an actionable product defect versus accepted resource lifecycle serialization.
- Inputs and prerequisites: F-005, current tests and T-003 settled.
- Scope or files: Read-only assessment first; if warranted, controller and relevant tests after T-003.
- Expected output: Reproducible oracle and justified tested fix, or documented reason not to change behavior.
- Dependencies: T-003.
- Execution steps:
  1. Test/adversarially assess a stalled load against second admission, cleanup and eviction; avoid speculative unbounded concurrency.
- Acceptance criteria:
  - Behavior and design tradeoff have recorded evidence; no unsafe lifecycle rewrite.
- Verification method:
  - Targeted test if implementation changes; otherwise static trace/existing deterministic test evidence.
- Validation evidence: No lifecycle code changed. `collaboration-controller.ts:443-473,477-499` confirms host load and eviction share one serial lifecycle, so a noncooperative create blocks later startups but not control admission. Existing targeted suite passed 90/90 including `a stalled child load does not block another child's interrupt, messages or completion` and cancellation/reservation tests. No measured product startup latency or safe evidence for a bounded parallel-eviction redesign; retain intentional serialized lifetime invariant, report conditional liveness limitation and revisit only with measured latency/stalls.
- Blocker: None.
- Unblock condition: None.

### [ ] T-006 — Integrate, validate and commit own files

- Status: blocked
- Owner: coordinator
- Objective: Inspect all diffs and run cross-component checks; commit only this task's paths.
- Inputs and prerequisites: T-001 through T-005.
- Scope or files: This task document plus patches from preceding tasks.
- Expected output: Verified commit and honest validation summary.
- Dependencies: T-001, T-002, T-003, T-004, T-005.
- Execution steps:
  1. Review every patch, run targeted tests/static checks, attempt root check, validate task document, stage explicit paths and commit.
- Acceptance criteria:
  - All executable acceptance checks pass or exact blocker is documented; unrelated files untouched.
- Verification method:
  - Targeted Vitest, tsgo, Biome, diff/status and task-document validator.
- Validation evidence: Re-reviewed own 10-file diff. Coding-agent 3 targeted files 68/68 passed and Grok host 2/2 passed; subagent 2 targeted files 90/90 passed; `tsgo --noEmit`, scoped Biome and `git diff --check` passed. Root `npm run check` attempted but failed before lint/type phases at existing `.artifacts/computer/**/biome.json` nested root configs; unrelated files' pre/post SHA256 unchanged. Only own 10 paths staged and committed as `a75c7b71c`; plan recorded in a follow-up docs-only commit.
- Blocker: Full repository check cannot pass while unrelated nested Biome root configurations remain in `.artifacts/computer/**`.
- Unblock condition: Owner of the artifact workspaces resolves/isolates their nested Biome roots and reruns `npm run check`; do not delete unrelated artifacts silently.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- New regression should fail against old behavior where practical. Run each modified test file and selected adjacent contract/controller tests. Run `tsgo --noEmit` and targeted `biome check --error-on-warnings`.
- `npm run check` is required after code changes; it uses `biome check --write .` and can touch other sessions' work, so snapshot pre/post status and diffs. Existing `.artifacts/computer/**/biome.json` nested roots may block it; do not remove artifacts.
- No paid APIs, build, or full test suite; report what remains unverified.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Other sessions already own unrelated `LEARNS.md`, docs and computer/edit-tool files: preserve their work exactly.
- Historical snapshots are audited and names never reused; do not delete, rewrite or relax the limit without a retention decision. A graceful limit is a bounded mitigation, not unbounded archiving.
- Parallel startup could violate idle-eviction/session bounds; use evidence and test before widening.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-23: Created execution document from reviewed source evidence; no implementation begun.
- 2026-09-23: Started independent Batch A T-001 (/root/fix-group), T-002 (/root/fix-panel), T-003 (coordinator), T-004 (/root/fix-docs); document and commit coordinator-owned.
- 2026-09-23: T-003 regression reproduced existing poison (`storage_error`) at 2049th child; 90/90 targeted tests and scoped Biome/diff passed after reasoned pre-admission rejection. T-003 done; T-005 assessment started after T-003.
- 2026-09-23: T-005 traced serial startup and checked existing stall/cancellation coverage. No production latency measurement or safe justification to relax LRU eviction concurrency; documented known conditional limitation rather than speculative refactor.
- 2026-09-23: Integrated T-004 docs; verified live schema and scoped diff. T-004 done.
- 2026-09-23: Reviewed T-001/T-002 patches and requested regression for rejected duplicate spawn plus short viewport/long draft; completed tests and changes inspected. T-001/T-002 done; T-006 integration started.
- 2026-09-23: Integration checks passed (coding-agent 68+2, subagent 90, tsgo, scoped Biome); root check failed on existing nested `.artifacts` configs; unrelated working files unchanged by checksum. Commit `a75c7b71c` contains only ten owned product/test/doc files. T-006 blocked only on full repository check, overall verification partial.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: Five implementation/assessment tasks complete; product patch `a75c7b71c` verified by coding-agent 68+2 tests, subagent 90 tests, tsgo, scoped Biome, diff check. Task document validator passes. Root check attempted and failed on existing nested Biome configs.
- Limitations: Full `npm run check` could not advance past unrelated `.artifacts` configs; no paid-provider, full-suite, build or production startup-latency measurements. Historical cap is safely diagnosed, not removed; a new root session is required after 2048 records. Serial startup remains intentional pending real performance evidence.
