# Task Plan: Subagent Read-Only MVP

- Created: 2026-08-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User request to implement the Phase 1 read-only MVP from `docs/Multi_agent/多 Agent 系统方法论.md` and the agreed Subagent design.

<!-- task-doc-section:background-goal -->
## Background and goal

Pi intentionally does not ship a built-in Subagent workflow. The existing example starts child Pi processes but does not provide a strict task contract, immutable repository snapshot, durable task ledger, bounded aggregate budget, or machine-validated handoff. The goal is to add a first-class, independently publishable Pi package that implements the agreed Phase 1 read-only MVP while preserving Pi core behavior.

The MVP must keep a single parent Agent as coordinator, run at most four independent read-only child Agents on one immutable repository snapshot, persist run/task state, enforce bounded execution and cancellation, and return structured evidence for parent verification.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope:

- Add `packages/subagent` as a publishable Pi Package and Extension.
- Add strict read-only task contracts for `scout`, `test-analyst`, `failure-analyst`, and `reviewer`.
- Materialize one immutable snapshot from tracked and untracked non-ignored files for every run.
- Persist run/task lifecycle events in a local SQLite ledger.
- Spawn child Pi processes in JSON mode with project resources disabled and a strict read-only tool allowlist.
- Limit tasks, concurrency, wall time, turns, tokens, cost, stderr, and model-visible output.
- Propagate cancellation, aggregate child usage, require a JSON handoff schema, and render progress/results through the Extension API.
- Add targeted unit/integration tests and workspace release/build integration.

Non-goals:

- Writer Agents, shared-workspace writes, worktrees, branches, commits, merge coordination, or automatic conflict resolution.
- General DAG execution beyond one independent fan-out/fan-in batch.
- Recursive Subagents, chain interpolation, project-local Agent definitions, arbitrary child tools, arbitrary child cwd, or arbitrary child model selection.
- OS/container sandboxing, network policy brokers, credential brokers, long-running daemon recovery, learning-based routing, or automatic human approval.
- Modifying the existing `packages/coding-agent/examples/extensions/subagent` implementation.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The user selected Phase 1 read-only MVP and a new independent Pi package. | Interactive requirement confirmation in this session. |
| F-002 | Pi intentionally leaves Subagents to extensions/packages. | `packages/coding-agent/README.md:15-17,494-500`; `packages/coding-agent/docs/packages.md`. |
| F-003 | Extension tools support cancellation, progress updates, custom rendering, nested usage, and lifecycle cleanup. | `packages/coding-agent/src/core/extensions/types.ts`; `packages/coding-agent/docs/extensions.md`. |
| F-004 | Child Pi can disable extensions, skills, prompt templates, context files, and project approval through CLI flags. | `packages/coding-agent/src/cli/args.ts:161-186,225-227`. |
| F-005 | Pi has no built-in sandbox; project trust is not an execution boundary. | `packages/coding-agent/docs/security.md`. |
| F-006 | Node in the current workspace exposes `node:sqlite` `DatabaseSync`. | `node -e "import('node:sqlite')..."` completed successfully on 2026-08-23. |
| F-007 | The repository contains unrelated modified and untracked files that must be preserved. | `git status --short` recorded before planning; changes include compaction and harness files outside this task. |
| F-008 | Root TypeScript configuration automatically includes `packages/*/src` and `packages/*/test`. | `tsconfig.json`. |
| F-009 | Public workspace packages are discovered for release, while local release and root build order use explicit lists. | `scripts/release-packages.mjs`, `scripts/local-release.mjs`, root `package.json`. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: Phase 1 may use a host-side process boundary and strict Pi tool allowlist, but this is not an OS sandbox. Impact: repository prompts cannot grant write tools, yet host-level read confinement and network denial are not claimed. Verification: tests assert CLI resource/tool flags and documentation states the residual boundary.
- Assumption: The immutable snapshot includes tracked files and untracked non-ignored files, materializes safe in-repository symlink targets, and excludes ignored files such as `node_modules`. Impact: child analysis reflects the invocation-time workspace without copying ignored build/cache content. Verification: snapshot tests cover dirty files, untracked files, ignored files, and escaping symlinks.
- Assumption: A SQLite ledger plus append-only task events is sufficient durability for Phase 1; restart/resume of active child processes remains out of scope. Impact: completed/interrupted evidence persists, but interrupted runs are not automatically resumed. Verification: reopen-ledger tests.
- Assumption: Real-provider end-to-end calls are unnecessary and not authorized. Impact: child protocol behavior is validated with fake child processes, not paid model calls.
- Open question: None. Scope and target were explicitly confirmed.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `packages/subagent` is a buildable, publishable Pi Package with an Extension manifest and no new third-party runtime dependency.
- The public tool accepts 1-4 independent tasks with unique IDs and only the four read-only roles.
- Contract compilation rejects invalid/duplicate tasks and clamps caller budgets so they cannot exceed policy maxima.
- One immutable snapshot is created per run from tracked and untracked non-ignored files; children use only that snapshot cwd; cleanup occurs after success, failure, or cancellation.
- The SQLite ledger persists run/task contracts, state transitions, usage, terminal reason, and handoff/error data across reopen.
- Every child invocation disables extensions, skills, prompt templates, context files, and project approval; enables only `read,grep,find,ls`; uses `--no-session`; and cannot recursively load this package.
- Scheduler concurrency never exceeds four; timeout, parent cancellation, output/stderr caps, aggregate turns/tokens/cost limits, and failure propagation are enforced.
- A child is successful only when exit/stop status is successful and its final output validates as a structured handoff with evidence and verification status; natural-language self-claims are insufficient.
- Partial required-task failure makes the overall tool execution fail closed.
- Aggregated nested model usage is returned through `AgentToolResult.usage` and progress is exposed through `onUpdate` details.
- Targeted tests pass, the package builds, task-document validation passes, and repository-wide `npm run check` introduces no unreviewed changes.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> {T-002, T-003} -> T-004 -> T-005`.
- Parallel batches: after T-001, T-002 and T-003 may run in parallel because they own disjoint modules and tests. All other work is serialized.
- Serialization constraints: root package/release metadata, public exports, Extension wiring, package lockfile, and final validation are coordinator-owned. Subagents must not edit this authority document.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Scaffold package and define contracts

- Status: done
- Owner: coordinator
- Objective: Create the package boundary, public schemas, internal task/run types, role policy, budget defaults, and handoff validation.
- Inputs and prerequisites: Confirmed design; Pi package conventions; F-001 through F-009.
- Scope or files: `packages/subagent/package.json`, `packages/subagent/tsconfig.build.json`, `packages/subagent/README.md`, `packages/subagent/src/contracts.ts`, `packages/subagent/src/types.ts`, `packages/subagent/src/handoff.ts`.
- Expected output: A compilable package scaffold with strict Phase 1 contracts and validators.
- Dependencies: None.
- Execution steps:
  1. Add package metadata and Pi Extension manifest.
  2. Define model-facing task/budget schemas and internal immutable contracts.
  3. Implement task validation, role policy, budget clamping, and structured handoff parsing.
  4. Add focused contract/handoff tests.
- Acceptance criteria:
  - Only four read-only roles and 1-4 unique tasks are accepted.
  - Budget overrides cannot exceed system maxima.
  - Handoffs require task identity, summary, evidence, verification, assumptions, risks, and next actions.
- Verification method:
  - Run package contract/handoff tests and TypeScript check for the package.
- Validation evidence: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/contracts-handoff.test.ts` passed 6 tests; `./node_modules/.bin/tsgo --noEmit --pretty false -p packages/subagent/tsconfig.build.json` passed with no diagnostics on 2026-08-23.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Implement immutable snapshot and durable ledger

- Status: done
- Owner: worker-snapshot-ledger
- Objective: Provide one invocation-time repository snapshot and durable run/task state without modifying the source workspace.
- Inputs and prerequisites: T-001 contract and state types.
- Scope or files: `packages/subagent/src/snapshot.ts`, `packages/subagent/src/ledger.ts`, `packages/subagent/test/snapshot-ledger.test.ts`.
- Expected output: Snapshot manager and SQLite ledger with deterministic cleanup/reopen behavior.
- Dependencies: T-001.
- Execution steps:
  1. Enumerate tracked and untracked non-ignored files through Git.
  2. Copy regular files into a temporary snapshot, safely handling or rejecting escaping symlinks.
  3. Compute a content-addressed manifest and baseline metadata.
  4. Persist run/task state and append-only events in SQLite with guarded transitions.
  5. Add snapshot and persistence tests.
- Acceptance criteria:
  - Snapshot content remains unchanged after source workspace mutation.
  - Ignored content and escaping symlinks are excluded/rejected.
  - Ledger records survive close/reopen and reject invalid state transitions.
- Verification method:
  - Run `snapshot-ledger.test.ts` and inspect temporary-directory cleanup.
- Validation evidence: Coordinator inspected all T-002 files; `snapshot-ledger.test.ts` passed 5 tests and package TypeScript check passed with no diagnostics on 2026-08-23.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Implement bounded child process runner

- Status: done
- Owner: worker-process-runner
- Objective: Execute one read-only child Pi process under strict flags and return bounded structured results and usage.
- Inputs and prerequisites: T-001 contract, handoff, and usage types; Pi JSON event protocol.
- Scope or files: `packages/subagent/src/process-runner.ts`, `packages/subagent/test/process-runner.test.ts`, test fixtures under `packages/subagent/test/fixtures/`.
- Expected output: Abort-aware JSONL runner with correct Pi invocation, event parsing, budgets, caps, and diagnostics.
- Dependencies: T-001.
- Execution steps:
  1. Resolve the current Pi invocation without shell interpolation.
  2. Build strict resource-disable and read-only tool arguments.
  3. Parse authoritative `message_end` and tool lifecycle events.
  4. Enforce timeout, turns/tokens/cost/output/stderr caps and terminate the child on violation.
  5. Validate the final handoff and add fake-process protocol tests.
- Acceptance criteria:
  - No project/global extension, skill, prompt, context, session, approval, arbitrary cwd, or write tool is enabled.
  - Abort/timeout/budget exhaustion produce explicit terminal reasons.
  - Malformed protocol or handoff cannot be reported as success.
- Verification method:
  - Run `process-runner.test.ts` using fake child scripts only.
- Validation evidence: Coordinator inspected all T-003 files, corrected the child prompt flag to `--append-system-prompt`, and `process-runner.test.ts` passed 15 tests; package TypeScript check passed with no diagnostics on 2026-08-23. No real provider was called.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Implement scheduler and Pi Extension adapter

- Status: done
- Owner: coordinator
- Objective: Compile a request, create one snapshot, fan out at bounded concurrency, persist lifecycle state, fail closed, aggregate usage, and expose progress/results through Pi.
- Inputs and prerequisites: T-002 and T-003 completed APIs.
- Scope or files: `packages/subagent/src/orchestrator.ts`, `packages/subagent/src/extension.ts`, `packages/subagent/src/index.ts`, `packages/subagent/test/orchestrator.test.ts`, `packages/subagent/test/extension.test.ts`.
- Expected output: Usable `subagent` extension tool and deterministic orchestration tests.
- Dependencies: T-002, T-003.
- Execution steps:
  1. Add a concurrency-limited fan-out/fan-in scheduler.
  2. Persist every lifecycle transition and terminal reason.
  3. Aggregate usage and structured handoffs in input order.
  4. Throw on any required-task failure and always clean up snapshots/processes.
  5. Register the tool, wire cancellation/session shutdown, and implement concise rendering.
- Acceptance criteria:
  - No more than four children run concurrently.
  - All tasks use the same snapshot ID.
  - Partial failure cannot return a successful tool result.
  - Final details contain contracts, states, handoffs, usage, and terminal reasons.
- Verification method:
  - Run orchestrator and Extension tests with injected fake runner/snapshot/ledger implementations.
- Validation evidence: Coordinator implementation and two adversarial read-only reviews completed. The second review drove fixes for streaming usage, exact aggregate budget allocation, failed-run usage patching, snapshot open/size races, SQLite CAS transitions, pre-cancel snapshot checks, worker rejection cancellation, cleanup retry, and shutdown waiting. All five package test files passed 35 tests and package TypeScript validation passed on 2026-08-23; no real provider was called.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Integrate workspace metadata and run final validation

- Status: done
- Owner: coordinator
- Objective: Integrate the package into workspace build/release paths, refresh lock metadata, and verify the complete MVP without disturbing unrelated changes.
- Inputs and prerequisites: T-004 complete; clean task-owned diff identified.
- Scope or files: root `package.json`, `package-lock.json`, `scripts/local-release.mjs`, package files, and this task document only.
- Expected output: Workspace-aware package with passing targeted tests, package build, root checks, and documented residual limitations.
- Dependencies: T-004.
- Execution steps:
  1. Add the package to explicit root build and local-release order.
  2. Refresh package-lock metadata with lifecycle scripts disabled.
  3. Run package tests and build.
  4. Run repository `npm run check`, inspect every resulting diff, and revert only task-owned automatic formatting mistakes if necessary without touching unrelated work.
  5. Validate the authority document and record exact evidence.
- Acceptance criteria:
  - Package build and targeted tests pass.
  - Root check passes or a concrete unrelated blocker is recorded.
  - No pre-existing unrelated file is overwritten or included in task completion claims.
- Verification method:
  - `npm run test --workspace=@earendil-works/pi-subagent`
  - `npm run build --workspace=@earendil-works/pi-subagent`
  - `npm run check`
  - Task-document validator.
- Validation evidence: `npm install --package-lock-only --ignore-scripts` completed with zero vulnerabilities; package tests passed 35 tests; package build passed; `npm run check` passed all Biome, pinned-dependency, relative-import, shrinkwrap, install-lock, full TypeScript, and browser-smoke checks; `npm pack --dry-run --ignore-scripts --json` reported the expected `@earendil-works/pi-subagent@0.84.2` package with 38 files; built Extension import smoke check returned two functions; `git diff --check` passed. A pre-check tar/rsync comparison confirmed that files already dirty at task start were not changed by this task's check run.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Contract unit tests: role/task limits, duplicate IDs, budget clamps, malformed handoffs.
- Snapshot tests: tracked dirty files, untracked files, ignored files, immutable copy, safe symlinks, escaping symlinks, cleanup.
- Ledger tests: creation, guarded transitions, event ordering, terminal data, close/reopen persistence.
- Runner tests: exact child flags, JSONL framing, usage aggregation, malformed output, nonzero exit, timeout, cancellation, token/turn/cost/output/stderr limits.
- Orchestrator tests: concurrency cap, one snapshot per run, deterministic result ordering, fail-closed partial failure, cleanup on all paths.
- Extension tests: strict TypeBox schema, progress details, aggregated top-level usage, thrown failure semantics, shutdown cancellation.
- Static/build checks: package build, root TypeScript/Biome/pinned-dependency/install-lock/shrinkwrap/browser checks through `npm run check`.
- No real model/provider calls will be run.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- The host process and child process are not OS-sandboxed in Phase 1. Tool/resource restrictions reduce the exposed Pi capability set but do not prove host filesystem or network confinement; this must remain explicit in README and final limitations.
- Snapshotting a large repository can be expensive. The MVP excludes ignored files and caps file count/bytes; exceeding limits must fail before child launch.
- Child model JSON compliance is probabilistic. Invalid handoffs fail closed and return diagnostics rather than silently accepting natural language.
- `npm run check` rewrites files and the repository already contains unrelated changes. The final diff must be inspected path-by-path, following the project learning that check can mutate the shared worktree.
- New public package metadata may expose release-script assumptions. Explicit build/local-release lists and lockstep versioning must be checked.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: User selected execute mode, Phase 1 read-only MVP, and a new independent Pi Package.
- 2026-08-23: Repository instructions, methodology, Pi Extension/SDK/security/package references, existing Subagent example, workspace metadata, and dirty status inspected.
- 2026-08-23: Task document created and filled; implementation has not started.
- 2026-08-23: T-001 moved to in_progress and assigned to coordinator.
- 2026-08-23: T-001 completed after contract/handoff tests (6 passed) and package TypeScript check passed.
- 2026-08-23: T-002 and T-003 moved to in_progress as a parallel batch with disjoint file ownership.
- 2026-08-23: T-002 completed after coordinator review, 5 snapshot/ledger tests, and package TypeScript validation passed.
- 2026-08-23: T-003 completed after coordinator review, a prompt-flag correction, 15 fake-process tests, and package TypeScript validation passed.
- 2026-08-23: T-004 moved to in_progress and assigned to coordinator.
- 2026-08-23: T-004 completed after targeted tests, TypeScript validation, and two adversarial reviews; concrete budget, usage, cancellation, cleanup, CAS, and snapshot issues were corrected. A hostile concurrent host-filesystem race remains explicitly outside the Phase 1 security boundary.
- 2026-08-23: T-005 moved to in_progress and assigned to coordinator.
- 2026-08-23: Added root build/offline-build and local-release integration; refreshed `package-lock.json` with lifecycle scripts disabled.
- 2026-08-23: Initial root check exposed the repository rule requiring relative `.ts` imports; imports were corrected and targeted tests/build rerun.
- 2026-08-23: Final package tests passed 35 tests, package build and pack/import smoke checks passed, and full `npm run check` passed. Pre-existing dirty files were compared against a pre-check backup and were unchanged by this task.
- 2026-08-23: T-005 completed; all acceptance criteria within the Phase 1 boundary are met.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: All T-001 through T-005 are done. Package tests passed 35/35; package build, full repository check, pack dry-run, built-extension import smoke check, diff check, and task-document validation passed. No real model/provider call was used.
- Limitations: Phase 1 is read-only and does not provide an OS sandbox, host network isolation, writer/worktree support, long-running daemon recovery, or protection against a malicious concurrent host process racing snapshot construction. Subagent model behavior was validated through fake child protocol tests rather than paid real-provider evaluation.
