# Task Plan: Complete v2 run practical UX parity

- Created: 2026-08-29
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: Confirmed current-conversation contract selecting practical UX parity and excluding host-extension APIs and shell sandboxing.

<!-- task-doc-section:background-goal -->
## Background and goal

The previous v2 `run` work added bounded streaming, command prefixes, and current Pi session environment variables. Remaining practical UX gaps are a generic head-based renderer, no elapsed feedback for silent commands, incomplete call metadata, and a command prefix captured when v2 definitions are created. The goal is to match legacy `bash`'s useful interactive presentation while preserving v2 execution and recovery semantics.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope:

- a dedicated v2 `run` renderer that previews the latest width-aware visual lines and supports expansion;
- elapsed/took timing with periodic invalidation during partial execution, including silent commands;
- clear command, cwd, and timeout call presentation;
- command-prefix resolution at execution time so settings reload/change affects the next call;
- focused renderer, streaming-start, and prefix-refresh regressions.

Non-goals:

- `BashOperations`, `spawnHook`, a general `prepare` hook, or full host-extension parity;
- shell sandboxing or expanding WorkspacePolicy beyond initial cwd validation;
- changing the default profile, removing legacy `bash`, or changing v2 nonzero/timeout/error/replay semantics;
- paid-provider validation.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The user selected and confirmed practical UX parity while excluding host extensions and sandboxing. | Current conversation structured choices `remaining_scope` and `confirm_remaining_scope`. |
| F-002 | The generic v2 renderer shows the first 20 logical lines and does not maintain elapsed state. | `packages/coding-agent/src/core/tools/tool-profile.ts`. |
| F-003 | Legacy bash has width-aware latest-line preview, elapsed/took state, periodic invalidation, and timeout call display. | `packages/coding-agent/src/core/tools/bash.ts`. |
| F-004 | v2 commandPrefix is currently passed as a value from SDK settings into definitions and captured by the run binding. | `packages/coding-agent/src/core/sdk.ts`; `packages/coding-agent/src/core/tools/tool-profile.ts`. |
| F-005 | Repository rules require modified targeted tests and root `npm run check`; full Vitest and paid providers are prohibited by default. | `AGENTS.md`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Confirmed assumption: Reuse legacy bash's established visual truncation and timing patterns where they fit v2 details, without introducing a new public renderer framework.
- Confirmed assumption: A narrow zero-argument command-prefix resolver is configuration plumbing, not a general execution hook.
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Collapsed run output shows the latest width-aware visual lines, with an earlier-lines expansion hint; expanded mode shows all bounded result text.
- A run call displays command plus explicit cwd and timeout when present.
- Partial rendering displays elapsed time and invalidates periodically even before output arrives; final rendering displays a stable took duration and clears the interval.
- The execution path emits an initial empty partial update so silent commands enter partial-result rendering immediately.
- Changing/reloading shellCommandPrefix affects the next v2 run execution without recreating the session.
- Structured cwd, bounded streaming, final snapshots, stable errors, normal nonzero/timeout results, sequential execution, and replay-never remain unchanged.
- Targeted tests, root `npm run check`, task validation, and diff checks pass; `docs/harness_tools/Pi Agent Tools v2.md` remains untouched and uncommitted.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003`.
- Parallel batches: Tasks are serialized because renderer state, v2 binding, session settings, and their tests share `tool-profile.ts` and one integration path.
- Serialization constraints: The coordinator owns all task code, tests, this authority document, and final staging.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Establish observable UX regressions

- Status: done
- Owner: coordinator
- Objective: Capture latest-tail rendering, timing lifecycle, silent-start updates, call metadata, and dynamic prefix behavior at stable seams.
- Inputs and prerequisites: Confirmed contract; existing bash renderer and v2 profile tests.
- Scope or files: Focused coding-agent renderer/profile tests and agent run tests only where silent-start behavior belongs.
- Expected output: Deterministic red/green tests that prove each remaining UX gap without requiring a real provider.
- Dependencies: None.
- Execution steps:
  1. Identify existing component-render test helpers and context construction conventions.
  2. Add dedicated run call/result renderer tests for tail, metadata, elapsed, and interval cleanup.
  3. Add a silent-start update assertion and a same-session prefix-change regression.
- Acceptance criteria:
  - Assertions observe rendered output/callback behavior, not private implementation fields unless lifecycle cleanup requires state evidence.
  - Width-aware tests use ANSI-safe themes or the real theme rather than visible-width marker wrappers.
  - Prefix regression executes twice in one session around a settings change.
- Verification method:
  - Modified targeted Vitest files.
- Validation evidence: Red phase reproduced all gaps: agent 8/9 because the first update contained output instead of being empty; profile 5/6 because the second same-session execution retained the first prefix; renderer 25/27 because call metadata/tail and elapsed timing were absent.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Implement dedicated run UX and dynamic configuration

- Status: done
- Owner: coordinator
- Objective: Implement the smallest dedicated run presentation and execution-time prefix resolution that satisfies T-001.
- Inputs and prerequisites: T-001 regressions.
- Scope or files: `packages/agent/src/harness/tools/run-v2.ts`, coding-agent v2 tool profile/rendering, SDK configuration plumbing, and focused tests.
- Expected output: Tail-based timed run renderer, initial partial update, and current-prefix execution.
- Dependencies: T-001.
- Execution steps:
  1. Reuse existing TUI primitives and bash visual-preview conventions in a run-specific renderer/state.
  2. Emit one initial empty run update before shell execution.
  3. Replace captured prefix value with a narrow execution-time resolver backed by SettingsManager.
  4. Preserve all final result and execution metadata semantics.
- Acceptance criteria:
  - T-001 regressions pass.
  - Non-run v2 tools retain the generic renderer.
  - No host operation or sandbox API is added.
- Verification method:
  - Focused Vitest and diff inspection.
- Validation evidence: Focused green tests passed after implementation: agent 9/9, profile 6/6, tool execution component 28/28. Root `npm run check` passed. Adversarial inspection found and fixed a truncation-footer bug that would have removed the final `exit` status; a renderer regression now covers it.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Validate integration and deliver

- Status: done
- Owner: coordinator
- Objective: Adversarially inspect lifecycle/configuration behavior, run required checks, and commit only task-owned files.
- Inputs and prerequisites: T-002 implementation.
- Scope or files: Integration corrections, task document, explicit commit.
- Expected output: Verified practical UX parity without scope expansion or unrelated changes.
- Dependencies: T-002.
- Execution steps:
  1. Run modified targeted tests and relevant neighboring run/profile tests.
  2. Run root `npm run check` and inspect all automatic changes.
  3. Validate the task document, diff, status, and explicit staging scope.
  4. Commit task-owned paths.
- Acceptance criteria:
  - All overall acceptance criteria have current evidence.
  - No timer survives final/error rendering and no stale prefix survives a settings change.
  - The unrelated vision document remains untouched and unstaged.
- Verification method:
  - Targeted Vitest, root check, task validator, git diff/status.
- Validation evidence: Final targeted rerun passed: agent 9/9, profile 6/6, tool execution component 28/28. Root `npm run check` passed. Task validator and `git diff --check` passed; status contained only six task code/test files, this task document, and the untouched unrelated vision document.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Agent: targeted `test/harness/run-v2.test.ts` for the initial partial update and retained execution semantics.
- Coding-agent: a focused v2 renderer test plus `test/tool-profile-v2.test.ts` for same-session prefix refresh and existing profile integration.
- Static/integration: root `npm run check` after code changes.
- Process: `task_document.py validate`, `git diff --check`, and explicit status/staging inspection.
- No full suite, build, or real-provider calls.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- A copied bash renderer could create drift or excessive duplication. Mitigation: reuse small visual-truncation primitives and implement only run-specific state/presentation.
- Timer lifecycle can leak intervals after completion or errors. Mitigation: tests cover transition from partial to final/error and assert interval cleanup.
- SettingsManager changes may not propagate through the existing base-definition override. Mitigation: pass a resolver closure from SDK and invoke it per run execution.
- Initial empty updates must not alter final tool content or model-visible results. Mitigation: callback-only regression plus retained final-result tests.
- Current blocker: None for T-001; downstream tasks are dependency-blocked.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-29: User confirmed practical UX scope: dedicated tail/elapsed renderer, silent feedback, full call metadata, and dynamic prefix; host APIs and sandbox remain excluded.
- 2026-08-29: Task document created and T-001 started.
- 2026-08-29: T-001 deterministic red tests reproduced initial-update, stale-prefix, and renderer/timing gaps; T-001 done and T-002 started.
- 2026-08-29: T-002 added initial empty updates, execution-time prefix resolution, and a dedicated width-aware tail/metadata/timing renderer. Focused tests and root check passed.
- 2026-08-29: Adversarial inspection caught truncation-footer removal swallowing the final exit status; implementation and regression were corrected. T-002 done and T-003 started.
- 2026-08-29: Final targeted tests passed (9/9, 6/6, 28/28); root check, task validation, and diff scope checks passed. T-003 done.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: All tasks and acceptance criteria have focused behavioral coverage plus root static/integration validation and explicit diff inspection.
- Limitations: Host-extension APIs and shell sandboxing remain intentionally excluded; WorkspacePolicy still validates only the initial cwd. No paid-provider evaluation was run or required.
