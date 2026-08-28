# Task Plan: Complete v2 run practical bash parity

- Created: 2026-08-29
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: Confirmed user contract in the current conversation: practical parity, not full host-extension parity.

<!-- task-doc-section:background-goal -->
## Background and goal

The v2 `run` tool intentionally improves shell-result semantics, but it currently lacks legacy `bash` streaming updates, configured command prefixes, Pi session environment exposure, and corresponding incremental UI evidence. The goal is to add those practical capabilities while preserving structured `cwd`, stable errors, bounded output, normal nonzero/timeout results, sequential scheduling, and replay-never semantics.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope:

- bounded, throttled incremental `run` output through the existing tool-update callback;
- `shellCommandPrefix` wiring from settings into v2 `run`;
- the same `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` environment semantics used by built-in `bash`;
- coding-agent prompt and renderer/update integration;
- focused core and coding-agent regressions for streaming, prefix, environment, timeout, nonzero, truncation, and cancellation behavior.

Non-goals:

- `BashOperations`, `spawnHook`, or a general public `prepare` hook for v2 `run`;
- changing the default profile, removing legacy `bash`, or persisting profiles;
- changing nonzero/timeout into tool errors;
- using `run` instead of `search`, `read`, or `edit`;
- claiming shell execution is sandboxed or requiring paid-provider validation.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The user selected practical parity and confirmed the requirements summary. | Current conversation structured choices `run_parity_scope` and `confirm_run_parity`. |
| F-002 | v2 `run` accepts command/cwd/timeout, ignores `_onUpdate`, and returns structured nonzero/timeout results. | `packages/agent/src/harness/tools/run-v2.ts`. |
| F-003 | Shared shell capture already supports bounded progress snapshots through `onChunk`. | `packages/agent/src/harness/utils/shell-output.ts#executeShellWithCapture`. |
| F-004 | legacy coding-agent `bash` exposes throttled progress, commandPrefix, and dynamic PI session variables. | `packages/coding-agent/src/core/tools/bash.ts#createBashToolDefinition`. |
| F-005 | v2 definitions currently receive shellPath and WorkspacePolicy but not shellCommandPrefix or session environment. | `packages/coding-agent/src/core/tools/tool-profile.ts`; `packages/coding-agent/src/core/sdk.ts`. |
| F-006 | repository rules require modified targeted tests and full `npm run check`, and prohibit the full Vitest suite. | `AGENTS.md`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Confirmed assumption: Session environment semantics reuse the existing legacy variable set and dynamic ExtensionContext values; no new environment protocol is introduced.
- Confirmed assumption: Existing generic v2 result rendering may be reused if streamed partial results visibly update it; a bash-specific renderer abstraction is added only if a focused test proves the generic renderer insufficient.
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- A running v2 command emits bounded partial output before command settlement and emits a final current snapshot.
- Streaming updates remain throttled and do not retain unbounded output.
- configured shellCommandPrefix executes before the user command.
- v2 `run` exposes the same current PI session/model/reasoning variables as built-in `bash` and removes stale inherited values.
- Explicit cwd, stable errors, nonzero/timeout normal results, truncation/full-output behavior, sequential execution, and replay-never remain covered.
- No new BashOperations/spawnHook/prepare API is introduced.
- Default tests require no credentials; modified targeted tests and root `npm run check` pass.
- The unrelated untracked `docs/harness_tools/Pi Agent Tools v2.md` remains untouched and uncommitted.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003`.
- Parallel batches: All tasks are serialized because the core context contract, coding-agent binding, and final integration modify a shared execution path.
- Serialization constraints: `run-v2.ts`, `tool-context.ts`, `tool-profile.ts`, SDK/AgentSession setup, shared shell environment logic, tests, and this authority document are coordinator-owned.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Define regressions and minimal execution contract

- Status: done
- Owner: coordinator
- Objective: Capture the missing practical behavior at the lowest stable seams and define the smallest context contract needed by run.
- Inputs and prerequisites: Confirmed scope; existing shell capture and bash environment behavior.
- Scope or files: Agent run tests, coding-agent v2 profile/session tests, and minimal shared type changes if required.
- Expected output: Red/green-capable tests for pre-settlement updates, prefix execution, and dynamic PI environment without public host hooks.
- Dependencies: None.
- Execution steps:
  1. Add a deterministic fake-exec streaming test around core run.
  2. Add coding-agent session tests for prefix and PI environment.
  3. Record the minimal context/config shape required by those tests.
- Acceptance criteria:
  - Tests observe behavior rather than implementation fields.
  - Streaming proof distinguishes an update before final settlement.
  - Environment proof uses current session values and checks stale inherited values do not leak.
- Verification method:
  - Targeted agent and coding-agent Vitest files.
- Validation evidence: Red phase: agent test failed because no update was emitted before settlement; coding-agent test showed prefix absent and stale inherited PI_* values. Green phase: targeted agent 7/7 and coding-agent 6/6 passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Implement practical run parity

- Status: done
- Owner: coordinator
- Objective: Implement bounded streaming, command prefix, and dynamic session environment while preserving v2 result semantics.
- Inputs and prerequisites: T-001 regressions and context contract.
- Scope or files: Agent execution context/run implementation and coding-agent bash environment helper, v2 binding, prompt/renderer integration.
- Expected output: A v2 run path that emits bounded updates and executes with resolved command/environment options.
- Dependencies: T-001.
- Execution steps:
  1. Reuse shell capture progress snapshots with bounded throttling.
  2. Apply host-provided command prefix and environment only at execution time.
  3. Reuse legacy session environment construction to prevent semantic drift.
  4. Bind settings and dynamic ExtensionContext in v2 definitions.
  5. Keep final result/error/replay contracts unchanged.
- Acceptance criteria:
  - All T-001 regressions pass.
  - Prefix/environment do not alter displayed user command or structured cwd.
  - No duplicate shell capture implementation or public prepare hook is added.
- Verification method:
  - Targeted core/coding-agent tests and diff inspection.
- Validation evidence: Core run and coding-agent integration regressions pass; `npm run check` passed after one lint/type correction cycle. Diff inspection confirms the original command remains in details while only the executed command is prefixed.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Complete integration validation and delivery

- Status: done
- Owner: coordinator
- Objective: Challenge the retained design, run required checks, update evidence, and commit only task-owned files.
- Inputs and prerequisites: T-002 implementation.
- Scope or files: Integration fixes, documentation if needed, this authority document, and explicit commit.
- Expected output: Verified practical parity with no unsupported extension surface or unrelated changes.
- Dependencies: T-002.
- Execution steps:
  1. Run modified targeted tests and neighboring timeout/truncation/cancellation tests.
  2. Run full `npm run check` and inspect automatic changes.
  3. Validate task document and git scope.
  4. Commit explicit task-owned paths.
- Acceptance criteria:
  - Overall acceptance criteria have current evidence.
  - Task validator, diff check, and repository checks pass.
  - User-owned untracked vision document remains untouched.
- Verification method:
  - Targeted Vitest, `npm run check`, task validator, and git status/diff.
- Validation evidence: Agent targeted test 9/9 passed; coding-agent targeted test 6/6 passed; root `npm run check` passed; `git diff --check` passed; task validator passed; git status showed only seven task code/test files, this task document, and the untouched unrelated untracked vision document.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Agent: targeted `test/harness/run-v2.test.ts` plus shell capture/foundation neighbors only if changed behavior reaches them.
- Coding-agent: targeted v2 profile/session and tool rendering/update tests that are modified.
- Static/integration: root `npm run check` after code changes.
- Documentation/process: `task_document.py validate`, `git diff --check`, and explicit-path status/staging inspection.
- No real-provider calls or full Vitest suite.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Streaming callbacks may outlive execution or emit stale snapshots. Mitigation: stop accepting updates after capture settlement, clear timers in finally, and force one final snapshot.
- Full inherited environment values cannot be represented by optional strings in core overrides. Mitigation: build a defined-string environment in coding-agent and execute with inheritance disabled, matching legacy stale-variable removal.
- Duplicating legacy PI environment construction could drift. Mitigation: extract and reuse one helper rather than copy it.
- Partial renderer updates may already work through the generic v2 renderer. Mitigation: test observable partial rendering and avoid a bash-sized renderer unless necessary.
- Current blocker: None for T-001; downstream tasks are dependency-blocked.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-29: User selected and confirmed practical parity: streaming, commandPrefix, session environment, and incremental UI, while excluding full host-extension APIs and preserving v2 result semantics.
- 2026-08-29: Task document created and T-001 moved to in_progress for deterministic regression seams.
- 2026-08-29: T-001 red tests isolated both gaps: no pre-settlement run update, and missing prefix/current PI environment with stale inherited values leaking.
- 2026-08-29: Minimal `ExecutionToolContext.run` contract established; targeted green tests passed (agent 7/7, coding-agent 6/6). T-001 done and T-002 started.
- 2026-08-29: T-002 implemented 100ms bounded streaming snapshots, final update flush, prefix forwarding, and a shared stale-safe PI environment resolver with inheritance disabled for v2 run.
- 2026-08-29: Focused regressions passed (agent 9/9, coding-agent 6/6); root `npm run check` passed. T-002 done and T-003 started.
- 2026-08-29: Final targeted rerun passed (agent 9/9, coding-agent 6/6); task validator and diff scope checks passed. T-003 done.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: All T-001 through T-003 acceptance criteria are covered by focused regressions, root static/integration checks, task validation, and explicit diff inspection.
- Limitations: No paid-provider evaluation was run or required. Practical parity intentionally excludes BashOperations, spawnHook, and a general prepare hook; initial cwd policy remains non-sandboxing.
