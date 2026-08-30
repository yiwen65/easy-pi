# Task Plan: Shared process executor with Bash and Run facades

- Created: 2026-08-30
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User explicitly authorized implementation of comparison scheme C: one shared process executor with compatibility-preserving legacy Bash and structured v2 Run facades.

<!-- task-doc-section:background-goal -->
## Background and goal

The local Node execution paths behind legacy `bash` and v2 `run` independently implement shell spawning, timeout/abort handling, process-tree termination, output streaming, and post-exit pipe draining. Implement scheme C by extracting one Node process lifecycle executor in `@earendil-works/pi-agent-core/node`, adapting `NodeExecutionEnv` and coding-agent local `BashOperations` to it, and retaining the two public tool contracts. Improve shared termination/output metadata where it can be done without changing legacy Bash behavior. Keep the default profile and all remote/custom operations unchanged.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope: a shared one-shot foreground Node process executor; raw stdout/stderr events; shell-config input; timeout, abort, spawn/callback errors, signal/null exit, process-tree cleanup, and lifecycle callbacks; `NodeExecutionEnv` delegation; a legacy Bash adapter preserving its schema, session environment, prefix/spawn hook, streaming, truncation, full-output, error, renderer, and extension contracts; v2 Run termination metadata; bounded host capture; focused unit/integration/regression tests; relevant SDK documentation; root static checks; explicit commit.

Non-goals: changing the default `legacy` profile; removing or renaming Bash; changing the public Bash schema or extension `BashOperations`; adding background Job, PTY, stdin, resize, reattach, or durable-process APIs; claiming Run/Bash is a sandbox; restricting arbitrary shell side effects; changing SSH/Memory host behavior beyond structural compatibility; paid or real-model evaluation; rerunning the large-repository evaluation.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The user selected scheme C after independent Run, Bash, and adversarial-review subagents recommended a shared executor with two thin facades. | Subagent run `ab484ea1-89df-4781-a175-c775bea70c86`, all three tasks succeeded. |
| F-002 | v2 Run currently accepts `command`, optional `cwd`, and optional `timeout`; it is sequential/non-replayable and already provides bounded updates and structured details. | `packages/agent/src/harness/tools/run-v2.ts`; `packages/agent/test/harness/run-v2.test.ts`. |
| F-003 | `NodeExecutionEnv.exec` and coding-agent `createLocalBashOperations` duplicate shell spawning, timeout/abort, kill-tree, stream, and post-exit pipe logic. | `packages/agent/src/harness/env/nodejs.ts`; `packages/coding-agent/src/core/tools/bash.ts`; `packages/coding-agent/src/utils/child-process.ts`. |
| F-004 | Legacy Bash has compatibility-sensitive `BashOperations`, `PI_*` environment, command prefix, spawn hook, partial updates, output spooling, renderer, extension, user-Bash, and RPC behavior. | `packages/coding-agent/src/core/tools/bash.ts`; `packages/coding-agent/src/core/bash-executor.ts`; `packages/coding-agent/docs/environment-variables.md`; `packages/coding-agent/docs/extensions.md`. |
| F-005 | Neither tool name is a security boundary; Pi has no built-in sandbox. | `packages/coding-agent/docs/security.md`; Run description explicitly says `cwd is not a sandbox`. |
| F-006 | The completed real large-repository validation made zero Run calls, so it does not validate process execution or Bash-vs-Run model preference. | `docs/tasks/2026-08-30-real-large-repo-v2-validation-task.md`, sanitized five-call trace. |
| F-007 | The worktree contains unrelated untracked user files under `docs/harness_tools/`, `docs/permission/`, and `docs/tasks/2026-08-30-linux-permission-runner-task.md`; they are outside this task and protected. | Current `git status --short`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “Execute scheme C” authorizes the shared one-shot foreground executor and both adapters, but not optional Job/PTY work that the comparison explicitly separated into later capabilities.
- Assumption: Compatibility means preserving legacy Bash tool name/schema, `BashOperations`, hook/environment ordering, streamed/raw output projection, nonzero/timeout/abort error behavior, and renderer; shared internal implementation may change.
- Assumption: v2 Run may add optional/structured termination fields while retaining existing fields and behavior; the ambiguous `managedProcessesTerminated` field will not be silently reinterpreted.
- Assumption: The shared executor belongs in the Node export of `pi-agent-core`; generic `ExecutionEnv` remains usable by Memory, SSH, and custom hosts without new mandatory methods.
- Open question: None blocking. The exact Job/PTY API and whether either facade becomes the future default remain deferred until parity and controlled LLM A/B evidence exist.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- One Node process lifecycle implementation owns spawn, raw stdout/stderr callbacks, timeout/abort, callback failure, post-exit pipe grace, process-tree termination, signal/null exit, active-process cleanup, and optional lifecycle notifications.
- `NodeExecutionEnv.exec` delegates to that implementation, preserves existing shell/environment behavior, exposes signal metadata without misreporting a signal exit as an ordinary Run success, and avoids retaining a second full stdout/stderr copy when the caller already captures output.
- Default local legacy Bash delegates to the same implementation while preserving its public schema, `BashOperations`, prefix/spawn hook, `PI_*`, output, errors, extension reuse, detached-child shutdown tracking, and current tests.
- v2 Run retains `command/cwd/timeout`, sequential/non-replay semantics, current output/error behavior, and adds unambiguous termination metadata without flipping the existing ambiguous field.
- No default-profile, remote-operations, Job/PTY, sandbox, dependency, lockfile, or unrelated user-file change occurs.
- Focused Agent and coding-agent suites, relevant regression tests, `npm run check`, task validation, diff/content audit, explicit staging, and a task-owned commit pass.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003 -> T-004 -> T-005`.
- Parallel batches: None. Shared types/Node lifecycle, NodeExecutionEnv, Bash adapter, Run metadata/tests, and final integration touch dependent contracts and must be serialized.
- Serialization constraints: The coordinator owns this task document. Agent-core changes must pass focused tests before coding-agent adopts them. Legacy Bash compatibility must pass before documentation/final checks. Unrelated untracked paths are never staged or modified.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Freeze the shared contract and compatibility matrix

- Status: done
- Owner: coordinator
- Objective: Convert scheme C and repository evidence into an executable one-shot-process contract before code changes.
- Inputs and prerequisites: User authorization; subagent comparison; current Run/Bash/ExecutionEnv implementations and tests.
- Scope or files: Read-only source/tests/docs; this task document.
- Expected output: Frozen boundaries, facade invariants, risk list, task graph, and targeted validation set.
- Dependencies: None.
- Execution steps:
  1. Recover current Node, Run, Bash, output, environment, hook, and cleanup behavior.
  2. Define the smallest shared executor and adapter boundaries.
  3. Record deferred Job/PTY and sandbox non-goals.
- Acceptance criteria:
  - Every compatibility-sensitive behavior has a cited source/test and verification target.
  - No implementation begins before task validation passes.
- Verification method:
  - Task-document validator and focused source/test inspection.
- Validation evidence: Primary inspection confirmed the duplicate lifecycle paths and frozen their facade differences: Agent `Shell.exec` uses separate stdout/stderr string callbacks and Result errors; legacy `BashOperations` uses raw combined Buffer callbacks and throws timeout/abort; both use equivalent shell transport, timeout, kill-tree, and post-exit pipe grace. Run schema/scheduling, Bash schema/hooks/environment/renderer, custom operations, shell-less hosts, and protected paths are recorded above. The task-document validator passed before implementation.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Implement the shared Node process executor

- Status: done
- Owner: coordinator
- Objective: Centralize the duplicated one-shot Node process lifecycle and make `NodeExecutionEnv` delegate to it.
- Inputs and prerequisites: T-001 done.
- Scope or files: `packages/agent/src/harness/env/`, `packages/agent/src/harness/types.ts`, Node exports, Agent harness tests.
- Expected output: Shared executor, raw stream/result contract, NodeExecutionEnv adapter, bounded capture option, termination metadata, focused passing tests.
- Dependencies: T-001.
- Execution steps:
  1. Extract shell-agnostic Node spawn/lifecycle handling behind a typed executor that receives resolved shell configuration.
  2. Adapt `NodeExecutionEnv.exec` without changing generic host requirements.
  3. Add characterization/regression tests for streams, signal/null exit, timeout/abort, cleanup, callback failure, and capture suppression.
- Acceptance criteria:
  - There is one Node spawn/wait/kill lifecycle implementation for Run and future Bash use.
  - Existing NodeExecutionEnv behavior remains compatible except for additive signal metadata and reduced duplicate capture.
- Verification method:
  - Focused Agent harness tests for NodeExecutionEnv, shell capture, and v2 Run.
- Validation evidence: Added `NodeProcessExecutor` with raw per-channel bytes, timeout/abort/callback handling, signal/null exit preservation, process-tree cleanup, inherited-pipe grace, and balanced lifecycle notifications; `NodeExecutionEnv` delegates to it, preserves text callbacks, and supports capture suppression. `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/node-process-executor.test.ts test/harness/nodejs-env.test.ts test/harness/run-v2.test.ts` from `packages/agent` passed 46 tests with 1 Windows-only skip. Root `./node_modules/.bin/tsgo --noEmit` passed. `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Adapt legacy Bash to the shared executor

- Status: done
- Owner: coordinator
- Objective: Route default local `BashOperations` through the Agent shared executor without changing the legacy facade.
- Inputs and prerequisites: T-002 done; frozen Bash compatibility matrix.
- Scope or files: `packages/coding-agent/src/core/tools/bash.ts`, the existing process-tree compatibility wrapper in `packages/coding-agent/src/utils/shell.ts`, and focused Bash tests only.
- Expected output: Shared local backend with preserved remote/custom operations, environment/hook order, raw stream, error shape, shutdown tracking, and renderer behavior.
- Dependencies: T-002.
- Execution steps:
  1. Replace only the default local spawn lifecycle with the shared executor adapter.
  2. Preserve coding-agent shell resolution, PATH/session environment, lifecycle tracking, and `BashOperations` surface.
  3. Run focused legacy Bash, user/RPC executor, late-output, truncation, persistence, and Windows-close tests.
- Acceptance criteria:
  - Existing external/custom `BashOperations` require no changes.
  - Existing Bash tests pass without weakening assertions or changing user-visible error behavior.
- Verification method:
  - Targeted coding-agent Vitest suites and diff inspection.
- Validation evidence: Default `createLocalBashOperations` now delegates spawn, stdin transport, raw channel streaming, timeout/abort, signal/null exit, inherited-pipe grace, and lifecycle tracking to `NodeProcessExecutor`; the legacy `killProcessTree` export delegates to the same shared primitive. Shell resolution, exact environment input, `BashOperations`, error strings, command prefix/spawn hook, renderer, and custom operations remain at the facade. The targeted coding-agent command covering `test/tools.test.ts`, Windows close handling, regressions #5208/#5303, and AgentSession Bash persistence passed 90 tests with 2 platform skips across 4 passed files and 1 skipped file. Root `./node_modules/.bin/tsgo --noEmit` and `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Finalize Run metadata, documentation, and integration

- Status: done
- Owner: coordinator
- Objective: Expose unambiguous Run termination facts and document the shared-kernel/two-facade boundary.
- Inputs and prerequisites: T-003 done.
- Scope or files: v2 Run types/tests, `packages/coding-agent/docs/sdk.md`, integration tests.
- Expected output: Additive Run metadata, compatibility coverage, and accurate documentation that does not claim sandbox or Bash removal.
- Dependencies: T-003.
- Execution steps:
  1. Propagate signal/termination information through shell capture into Run details.
  2. Keep the old ambiguous field unchanged/deprecated and add unambiguous fields.
  3. Document shared local execution and explicit Job/PTY deferral.
- Acceptance criteria:
  - Signal/null exit cannot be represented as a normal exit in new Run metadata.
  - Documentation accurately separates executor, facade, and isolation boundaries.
- Verification method:
  - Focused Run/tool-profile tests and documentation diff review.
- Validation evidence: Run now reports `signal`, `terminationReason`, and `terminationRequested`, keeps `managedProcessesTerminated` unchanged and deprecated, uses `exitCode: null` plus signal text for signal exits, and keeps normal/timeout behavior covered. SDK documentation records the shared local executor, dual facades, Job/PTY deferral, and no-sandbox boundary. The first focused run exposed a duplicate local `signal` identifier before tests loaded; renaming it to `exitSignal` resolved the parse/type error. The rerun of the three Agent files passed 47 tests with 1 Windows-only skip; `test/tool-profile-v2.test.ts` passed 19 tests; root `./node_modules/.bin/tsgo --noEmit` and `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Validate, audit, and commit

- Status: done
- Owner: coordinator
- Objective: Prove the integrated change, preserve unrelated work, and commit only task-owned files.
- Inputs and prerequisites: T-004 done.
- Scope or files: Task-owned code/tests/docs and this task document.
- Expected output: Passing focused/full required checks, clean scoped diff, validated task record, and explicit commit.
- Dependencies: T-004.
- Execution steps:
  1. Run focused suites and root `npm run check`; inspect any automatic rewrites immediately.
  2. Validate task document, diff, status, staged names, and absence of unrelated/protected changes.
  3. Commit task-owned files with the required message format.
- Acceptance criteria:
  - All required checks pass with exact recorded results.
  - Only task-owned files are staged and committed; protected untracked files remain untouched.
- Verification method:
  - Vitest commands, `npm run check`, task validator, `git diff --check`, staged-name/content audit, commit inspection.
- Validation evidence: Final focused validation from the package roots passed: Agent `node-process-executor`, `nodejs-env`, `run-v2`, and harness `tools` files reported 71 passed and 1 Windows-only skip; coding-agent Bash/tools/profile/late-output/truncation/persistence files reported 109 passed and 2 platform skips across 5 passed files and 1 skipped file. Root `npm run check` exited 0, including Biome, dependency/import/shrinkwrap/install-lock checks, root typechecking, and browser smoke. Biome formatted 5 files; before/after status sets were identical and SHA-256 comparison confirmed every protected unrelated file was unchanged, so rewrites were confined to task-owned paths. Post-format focused reruns produced the same passing counts. Cached diff checks and the explicit 14-file staged-name/content audit passed; implementation commit `4daedceed` contains only task-owned code, tests, and SDK documentation. The final task-document validator passed before the task record commit.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

Before code, validate this document. For Agent core, run `packages/agent/test/harness/nodejs-env.test.ts`, `packages/agent/test/harness/run-v2.test.ts`, and shell-output coverage. For coding-agent, run `test/tools.test.ts`, `test/tool-profile-v2.test.ts`, `test/bash-close-hang-windows.test.ts`, `test/suite/regressions/5208-late-bash-output.test.ts`, `test/suite/regressions/5303-bash-output-truncation.test.ts`, and `test/suite/agent-session-bash-persistence.test.ts`; add the smallest new tests needed for the shared adapter and termination metadata. Then run root `npm run check` as required for code changes and immediately audit automatic rewrites. Do not run the full test suite, build, real Provider tests, or paid evaluation. Finish with task validation, diff check, status/protected-path audit, explicit staging, and commit inspection.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

A shared implementation can still break facade contracts through exit/error mapping, stdout/stderr ordering, UTF-8 chunking, raw-versus-sanitized output, post-exit pipe grace, shell selection, PATH/session environment, or process-shutdown tracking. NodeExecutionEnv currently maps null signal exits to zero and Run exposes an ambiguous managed-process field; correcting them must be additive and tested. Adding mandatory methods to `ExecutionEnv` would break custom hosts, so Job/PTY remain separate non-goals. Unrestricted shell remains outside a sandbox regardless of facade. Root checks can auto-rewrite shared-worktree files; status must be compared immediately. Existing untracked user paths must remain untouched and unstaged.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-30: User authorized scheme C. Current worktree/protected paths were recorded. The successful three-subagent comparison `ab484ea1-89df-4781-a175-c775bea70c86` was reconciled with primary source evidence; T-001 started. No code change, test, network call, or paid evaluation has occurred for this implementation task.
- 2026-08-30: T-001 completed after the shared contract, facade invariants, non-goals, risks, and focused validation matrix were frozen and the task validator passed. T-002 started.
- 2026-08-30: T-002 completed. The shared executor and `NodeExecutionEnv` adapter passed 46 focused tests (1 platform skip), root typechecking, and diff checks. T-003 started to adapt only the default local legacy Bash backend.
- 2026-08-30: T-003 completed. Local Bash and its shutdown process-tree wrapper now use the shared executor primitives while retaining the legacy facade; 90 targeted coding-agent tests passed with 2 platform skips, followed by root typechecking and diff checks. T-004 started.
- 2026-08-30: T-004's first test/typecheck attempt found a duplicate `signal` identifier in Run metadata projection before any tests loaded. It was renamed to `exitSignal`; reruns passed 47 Agent tests (1 platform skip), 19 coding-agent integration tests, root typechecking, and diff checks. T-004 completed and T-005 started.
- 2026-08-30: T-005 completed. Final focused suites passed 180 tests with 3 platform skips; root `npm run check` passed, its 5 formatter rewrites were audited as task-owned, and protected-file hashes were unchanged. Post-format reruns passed. Explicit staging/diff audits passed and implementation commit `4daedceed` was inspected.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: All tasks are done. The shared executor, both facade adapters, termination metadata, compatibility tests, SDK documentation, root checks, protected-path audit, and implementation commit `4daedceed` satisfy the acceptance criteria. The final task-document validator passed.
- Limitations: This task implements only the shared foreground one-shot executor and dual facades. Background Job, PTY, sandboxing, default-profile changes, and LLM Bash-vs-Run A/B remain deferred.
