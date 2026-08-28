# Task Plan: Implement Pi four-tool MVP v1.1

- Created: 2026-08-28
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: `docs/harness_tools/Pi Agent Tools MVP v1.1.md`; long-term context from `docs/harness_tools/Pi Agent Tools v2.md`

<!-- task-doc-section:background-goal -->
## Background and goal

Pi currently defaults to `read/bash/edit/write`, while discovery tools and a second tool implementation live in coding-agent. The confirmed MVP introduces an explicit, non-persistent `v2` profile exposing `search/read/edit/run` without changing legacy defaults. The goal is to implement the complete opt-in profile, shared execution semantics in `packages/agent`, coding-agent CLI/SDK integration, focused regression tests, and a reproducible evaluation scaffold.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope:

- v2 shared errors, workspace policy, SearchProvider contract, bounded text range capability, and v2 tool factories in `packages/agent`;
- literal/explicit-regex text search and deterministic substring file search;
- v2 read for bounded text, directories, images, and binary rejection;
- structured multi-operation edit with virtual prevalidation and partial-commit reporting;
- run with explicit cwd, nonzero normal results, timeout output preservation, and managed-process termination reporting;
- non-persistent `legacy|v2` profile selection in coding-agent CLI and SDK, including prompt/tool registry integration;
- focused agent and coding-agent tests, documentation, and a deterministic A/B evaluation manifest/runner scaffold.

Non-goals:

- FFF, indexes, generations, barriers, fuzzy suggestions;
- ObservationStore, revisions, stale-file detection;
- transactional rollback, journaling, crash atomicity;
- path-aware scheduling or background process tools;
- changing the default profile or removing legacy tools;
- session profile persistence;
- claiming cwd/path checks are a sandbox or strong adversarial symlink protection;
- paid/real-model evaluation runs without separate explicit approval.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The user explicitly authorized implementation and selected the reviewed MVP v1.1 rather than full v2. | Conversation decision `execution_baseline: 实施 MVP v1.1`. |
| F-002 | The normative contract keeps legacy default and makes v2 explicit and non-persistent. | `docs/harness_tools/Pi Agent Tools MVP v1.1.md` §§3, 14.1. |
| F-003 | Shared harness tools currently include only read/bash/edit/write and duplicate coding-agent implementations exist. | `packages/agent/src/harness/tools/`; `packages/coding-agent/src/core/tools/`. |
| F-004 | `ExecutionEnv` already provides listDir, renameFile, remove, canonicalPath and cwd-aware exec; current `readTextLines` only supports `maxLines` and returns `string[]`. | `packages/agent/src/harness/types.ts`; `packages/agent/src/harness/env/nodejs.ts:513`. |
| F-005 | Current agent read loads complete binary content before text slicing, and current bash throws on nonzero and timeout. | `packages/agent/src/harness/tools/read.ts`; `packages/agent/src/harness/tools/bash.ts`. |
| F-006 | coding-agent SDK defaults to `read/bash/edit/write` and combines settings, allowlist, denylist, custom tools, and extension tools. | `packages/coding-agent/src/core/sdk.ts:247-257`; `packages/coding-agent/src/core/agent-session.ts:2868-2930`. |
| F-007 | CLI has no tool-profile argument. | `packages/coding-agent/src/cli/args.ts`. |
| F-008 | The low-level agent supports per-tool executionMode and Harness replay metadata; a sequential tool serializes its whole tool-call batch. | `packages/agent/src/types.ts`; `packages/agent/src/agent-loop.ts`; `packages/agent/src/harness/agent-harness.ts`. |
| F-009 | Root instructions require `npm run check` after code changes and targeted tests for modified test files; full `npm test` is prohibited unless requested. | `AGENTS.md`. |
| F-010 | The original v2 vision document remains an unrelated untracked user file and must not be staged or modified. | `git status --short --branch` on 2026-08-28. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: SearchProvider may use existing coding-agent rg/fd facilities through a local adapter; provider brands remain hidden from the model. Impact: adapter ownership is settled during T-006 after inspecting current operations interfaces.
- Assumption: The evaluation deliverable is a deterministic manifest/runner and faux-provider smoke coverage, not paid real-model execution. Impact: real comparative completion-rate evidence remains a post-MVP operational activity requiring explicit approval.
- Assumption: The bounded-read interface may be added as a new capability or a backward-compatible extension, whichever produces the smaller complete change after T-001 inspection. Impact: existing session header reads must retain their current behavior.
- Open question: None; the user confirmed execution against MVP v1.1.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Legacy CLI/SDK default behavior and existing public tool factories remain compatible.
- Explicit SDK and CLI v2 profile selects the v2 built-ins before existing allowlist/denylist/custom/extension rules.
- In the unmodified v2 baseline, active built-ins are exactly `search/read/edit/run`, each with one top-level required field and matching prompt guidance.
- Search, read, edit, run behavior and errors satisfy contract §§5-10 and focused automated tests.
- Restrictive policy tests cover outside paths and symlink rules without claiming sandbox guarantees.
- v2 tools declare contract executionMode/replay metadata where the runtime supports it.
- coding-agent consumes shared v2 execution semantics rather than copying them.
- Deterministic A/B scaffold records profile-specific prompt/schema identity and supports faux-provider smoke execution without real credentials.
- All modified targeted tests pass and `npm run check` completes with no errors, warnings, or infos.
- Original `docs/harness_tools/Pi Agent Tools v2.md` remains untouched and uncommitted.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> {T-002,T-003,T-004,T-005} -> T-006 -> T-007 -> T-008`.
- Parallel batches:
  - Batch 1: T-001 only, because it defines shared contracts used by all tools.
  - Batch 2: T-002, T-003, T-004, and T-005 in parallel after T-001; their owned implementation/test files must be disjoint and shared export integration is deferred.
  - Batch 3: T-006 only, because it integrates all tools into coding-agent registries, CLI, SDK, prompts, and renderers.
  - Batch 4: T-007 only, because evaluation depends on an integrated v2 profile.
  - Batch 5: T-008 only for cross-package verification, documentation reconciliation, and final status.
- Serialization constraints: `packages/agent/src/harness/tools/index.ts`, coding-agent tool registries, SDK/CLI files, system prompt files, task document, changelogs, and package exports are coordinator/integration-owned. Subagents must not edit this task document.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Establish shared v2 foundations

- Status: done
- Owner: coordinator
- Objective: Add the minimum shared types and runtime capabilities required by all four v2 tools without changing legacy tool contracts.
- Inputs and prerequisites: Confirmed MVP contract; current `ExecutionEnv`, `ExecutionToolContext`, NodeExecutionEnv, error and path utilities.
- Scope or files: `packages/agent/src/harness/types.ts`, `packages/agent/src/harness/env/nodejs.ts`, new v2 shared error/policy/context modules, focused agent tests, and the formatting defect in the normative contract.
- Expected output: Typed v2 errors, workspace policy/path checks, SearchProvider context contract, bounded UTF-8 text range capability, and tests preserving existing `readTextLines` consumers.
- Dependencies: None.
- Execution steps:
  1. Inspect all FileSystem/ExecutionEnv implementations and consumers.
  2. Choose a backward-compatible bounded-range capability.
  3. Implement typed errors, policy/path helpers, and v2 context types.
  4. Implement NodeExecutionEnv bounded text reading with line/byte continuation metadata.
  5. Add focused unit tests and fix the contract code-fence formatting defect.
- Acceptance criteria:
  - Existing `readTextLines(maxLines)` consumers remain valid.
  - New bounded range does not retain skipped lines, respects max bytes, and returns valid UTF-8 continuation metadata.
  - Policy distinguishes compatibility mode from explicit restrictions and applies the documented symlink truth table on supported local fixtures.
  - Typed errors carry stable code and details.
- Verification method:
  - Targeted agent harness/env tests for range reading, policy, and compatibility.
  - `npm run check` deferred to T-008; local type/test verification required here.
- Validation evidence: `cd packages/agent && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/v2-foundations.test.ts` passed 7/7 tests; `git diff --check` passed; contract Markdown fence check passed; root `npm run check` passed after one type-only test matcher correction. The first targeted run exposed invalid UTF-8 and macOS symlink fixture expectations; both were corrected before the passing run.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Implement shared v2 search

- Status: done
- Owner: coordinator
- Objective: Implement provider-agnostic v2 search schema, normalization, deterministic ranking, truncation, results, and errors.
- Inputs and prerequisites: T-001 shared context, errors, policy and SearchProvider contract.
- Scope or files: New search tool/provider modules under `packages/agent/src/harness/tools/`, dedicated agent search tests; no shared index export edits.
- Expected output: `createSearchTool`-equivalent v2 factory and conformance tests using a fake provider.
- Dependencies: T-001.
- Execution steps:
  1. Implement one-required-field schema and validation.
  2. Implement smart-case, literal/regex validation, file substring ranking, path normalization, and glob forwarding.
  3. Enforce approved scope before provider invocation.
  4. Format bounded content/details without claiming global top-N when provider truncates.
  5. Add deterministic fake-provider tests.
- Acceptance criteria:
  - Literal metacharacters remain literal unless regex is explicit.
  - File ranking exactly follows contract tiers and stable path tie-breaker.
  - Empty query, invalid regex, invalid options, provider failure, and restricted path have stable errors.
  - Provider branding is absent from model schema/content.
- Verification method:
  - Targeted new agent search test file.
- Validation evidence: Focused `search-v2.test.ts` passed 4/4; combined Batch 2 run passed 16/16; root `npm run check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Implement shared v2 read

- Status: done
- Owner: coordinator
- Objective: Implement v2 read for bounded text, directories, images, and unsupported binary detection without regressing legacy read.
- Inputs and prerequisites: T-001 bounded range and policy capabilities; current image helpers.
- Scope or files: New v2 read tool module under `packages/agent/src/harness/tools/`, dedicated read-v2 tests; no shared index export edits.
- Expected output: v2 read factory with line/byte continuation, stable directory paging, image preservation, and binary error.
- Dependencies: T-001.
- Execution steps:
  1. Define schema and kind dispatch from fileInfo.
  2. Use bounded range for text and listDir for directories.
  3. Preserve existing image processor behavior.
  4. Detect unsupported non-image binary content without complete text decoding.
  5. Add large offset, long line, directory, image, and binary tests.
- Acceptance criteria:
  - Text range never calls full text/binary read.
  - Large offset memory is bounded by output, and byte continuation is lossless on UTF-8 fixtures.
  - Directories sort and page deterministically, preserving symlink kind.
  - Existing image behavior remains available.
- Verification method:
  - Targeted new agent read-v2 test file.
- Validation evidence: Focused `read-v2.test.ts` passed 4/4; combined Batch 2 run passed 16/16; root `npm run check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Implement shared structured v2 edit

- Status: done
- Owner: coordinator
- Objective: Implement file-only structured create/update/move/delete with sequential virtual prevalidation and truthful partial-commit reporting.
- Inputs and prerequisites: T-001 errors, policy/path identity and context; existing diff helpers.
- Scope or files: New edit-v2 planner/tool/coordinator modules under `packages/agent/src/harness/tools/`, dedicated edit-v2 tests; no shared index export edits.
- Expected output: v2 edit factory and pure planner with all prevalidation before first mutation.
- Dependencies: T-001.
- Execution steps:
  1. Define discriminated operation schema and runtime validation.
  2. Build virtual file state with ordered operations and exact unique update matching.
  3. Detect source/destination, kind, alias, policy and provider capability conflicts.
  4. Commit under a per-env global coordinator and report success diff/details.
  5. Convert commit failures into `EDIT_PARTIAL_COMMIT` with completed/failed/pending, changed/unknown paths and created directories.
  6. Add prevalidation-zero-mutation and partial-failure tests.
- Acceptance criteria:
  - All contract operation sequences and rejection cases are tested.
  - Every prevalidation failure performs zero mutating ExecutionEnv calls.
  - Runtime move failure is reported as partial commit rather than claimed prevalidated.
  - No rollback, transaction, stale or fuzzy behavior is introduced.
- Verification method:
  - Targeted new agent edit-v2 test file.
- Validation evidence: Focused `edit-v2.test.ts` passed 4/4, including zero-mutation prevalidation and partial failure; combined Batch 2 run passed 16/16; root `npm run check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Implement shared v2 run

- Status: done
- Owner: coordinator
- Objective: Implement run with explicit cwd, nonzero normal results, timeout output retention, and managed-process termination status.
- Inputs and prerequisites: T-001 errors, policy and context; current shell output capture.
- Scope or files: New run tool module and any narrowly required shell result capability under `packages/agent/src/harness/`, dedicated run-v2 tests; no shared index export edits.
- Expected output: v2 run factory whose command outcomes and infrastructure failures use distinct channels.
- Dependencies: T-001.
- Execution steps:
  1. Define schema, cwd validation and policy checks.
  2. Reuse bounded output capture and preserve full artifact behavior.
  3. Return exit 0, nonzero and timeout as normal details.
  4. Keep spawn/shell/policy/cwd/abort as typed failures.
  5. Report whether the backend confirmed managed child/group termination.
  6. Add nonzero, timeout-output, cwd, infrastructure and truncation tests.
- Acceptance criteria:
  - Exit 1 does not throw and details contain exitCode 1.
  - Timeout does not throw, retains bounded output and reports timedOut/termination status.
  - Managed timeout fixture does not remain alive after return on supported local platforms.
  - cwd is explicit but never described as sandbox containment.
- Verification method:
  - Targeted new agent run-v2 test file.
- Validation evidence: Focused `run-v2.test.ts` passed 4/4, including real local nonzero and timeout fixtures; combined Batch 2 run passed 16/16; root `npm run check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Integrate the v2 profile into packages and coding-agent

- Status: done
- Owner: coordinator
- Objective: Export a coherent v2 tool factory and connect it to coding-agent CLI, SDK, local provider, prompts, registries, filtering and renderers while preserving legacy defaults.
- Inputs and prerequisites: T-002 through T-005 completed and verified.
- Scope or files: agent tool exports/factory; coding-agent tools/definitions or adapters; SDK, CLI args/help/main wiring, AgentSession registry, system prompt, server harness where applicable, focused coding-agent tests and public docs.
- Expected output: `--tool-profile=v2` and SDK `toolProfile:"v2"` work in fresh and resumed invocations without profile persistence; baseline v2 exposes shared search/read/edit/run.
- Dependencies: T-002, T-003, T-004, T-005.
- Execution steps:
  1. Export v2 factories and bind context/replay/execution metadata.
  2. Implement a local rg/fd SearchProvider adapter using existing operations where practical.
  3. Add ToolProfile to SDK and CLI parsing/help, then pass it through creation paths.
  4. Make profile select built-in definitions before existing allowlist/denylist/custom/extension processing.
  5. Add v2 prompt snippets/guidelines and lightweight renderers that do not duplicate execution semantics.
  6. Update README/CLI docs and add profile/compatibility/snapshot/integration tests.
- Acceptance criteria:
  - No-option behavior stays legacy.
  - Baseline v2 has exactly four built-ins and no legacy mutation tool.
  - Existing modifiers and extension override behavior remain covered.
  - Resume without explicit v2 is legacy; resume with explicit v2 is v2.
  - coding-agent does not copy v2 planner or execution semantics.
- Verification method:
  - Targeted SDK, args, tools, prompt and AgentSession tests.
  - Focused server harness tests if its public creation path receives profile support.
- Validation evidence: `packages/coding-agent` targeted Vitest run passed 97/97 tests across `args.test.ts`, `tool-profile-v2.test.ts`, `local-search-provider-v2.test.ts`, and legacy `default-tools-setting.test.ts`; root `tsgo --noEmit` passed; root `npm run check` passed all formatting, dependency, import, shrinkwrap, type, and browser-smoke checks. Tests verify legacy default, exact v2 baseline, one-required-field schemas, prompt/renderer binding, allowlist/denylist and extension override precedence, non-persistence on session recreation, unknown profile rejection, and local literal/file search. The server Harness remains on its existing explicit `tools` override seam because the server protocol has no CLI/SDK profile input; no implicit server profile state was added.
- Blocker: None.
- Unblock condition: None.

### [ ] T-007 — Add deterministic A/B evaluation scaffold

- Status: in_progress
- Owner: coordinator
- Objective: Add a credential-free evaluation manifest and runner scaffold comparing legacy and v2 profile wiring under fixed conditions.
- Inputs and prerequisites: T-006 integrated profile.
- Scope or files: A bounded evaluation directory under coding-agent tests or scripts, fixtures/manifest, focused smoke test, and evaluation documentation.
- Expected output: deterministic profile metadata/hash capture, fresh-fixture execution hooks, paired result records, and bootstrap reporting implementation or documented command.
- Dependencies: T-006.
- Execution steps:
  1. Define a small versioned manifest schema with task, profile, prompt/schema hashes, budgets and seeds.
  2. Implement credential-free faux-provider smoke execution and machine-readable records.
  3. Implement paired task×seed summary and deterministic clustered bootstrap.
  4. Document explicit real-model opt-in without executing it.
- Acceptance criteria:
  - Default tests require no network or credentials.
  - A/C profile identity and hashes are recorded separately.
  - Repeated run with the same fixture and seed yields identical summary output.
  - Real-model path is gated and not run in this task.
- Verification method:
  - Targeted evaluation scaffold test and deterministic output comparison.
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-008 — Complete cross-package validation and delivery

- Status: pending
- Owner: coordinator
- Objective: Reconcile all outputs, run required checks, update durable evidence, and deliver only after all acceptance criteria pass.
- Inputs and prerequisites: T-001 through T-007 implementation reports and diffs.
- Scope or files: Integration fixes, this task document, relevant changelogs/docs, and explicit git staging/commit of only task-owned files.
- Expected output: Verified implementation, truthful task statuses, final validation record, and commit(s) that exclude the user's untracked v2 vision file.
- Dependencies: T-001, T-002, T-003, T-004, T-005, T-006, T-007.
- Execution steps:
  1. Inspect all diffs and subagent reports.
  2. Run every modified targeted test and dependency-path integration test.
  3. Run `npm run check` with full output and fix all diagnostics.
  4. Verify legacy defaults, v2 baseline, profile modifiers, no real API use, and untouched untracked user file.
  5. Update changelogs only if required by repository branch rules.
  6. Validate this task document, mark tasks done only with evidence, and commit explicit task-owned paths.
- Acceptance criteria:
  - Every preceding task is done with current evidence.
  - Overall acceptance criteria are demonstrated.
  - Task document validator passes.
  - Git status contains no unintended staged or modified paths.
- Verification method:
  - Targeted tests listed below, `npm run check`, task-document validator, and git diff/status inspection.
- Validation evidence: Not run.
- Blocker: T-001 through T-007 not done.
- Unblock condition: All dependencies pass their verification.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Agent foundations/tools: run each newly added focused Vitest file from `packages/agent` with the repository-local Vitest CLI.
- Coding-agent profile integration: run modified/new args, SDK, default-tools, tools, prompt contribution and AgentSession tests from `packages/coding-agent`.
- Evaluation scaffold: run only its credential-free faux-provider test; do not run real-model evaluation.
- Cross-package static validation: run `npm run check` from repository root after all code changes.
- Repository-wide non-e2e suite: use `./test.sh` only if targeted and static checks indicate broader integration risk or root instructions require it; never invoke the full Vitest suite directly.
- Contract/task docs: validate Markdown fence/headings and run `task_document.py validate` after each material task status update and before final reporting.
- Git safety: inspect `git status --short` and staged diff; never stage `docs/harness_tools/Pi Agent Tools v2.md`.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- R-001: The complete MVP is cross-package and may expose undocumented tool registry assumptions. Mitigation: isolate shared tool tasks, defer exports/integration to T-006, and preserve legacy factories.
- R-002: Bounded UTF-8 byte continuation can break existing FileSystem consumers if implemented as a signature replacement. Mitigation: prefer a backward-compatible capability and test session header reads.
- R-003: Structured edit can partially mutate after commit begins. Mitigation: prove zero mutations only for prevalidation failures and require truthful failed/unknown path reporting.
- R-004: Process-tree termination differs across platforms. Mitigation: test managed local fixtures, report confirmation status, and retain documented non-guarantees for detached processes.
- R-005: coding-agent extension overrides and allowlist order may conflict with profile selection. Mitigation: encode current precedence in focused tests before modifying registry code.
- R-006: Real A/B model runs require credentials, money, network and explicit approval. Mitigation: deliver only the deterministic scaffold and faux-provider verification in this task.
- Current blocker: None for T-001; downstream tasks are dependency-blocked by design.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-28: Task document created in execute mode.
- 2026-08-28: User confirmed MVP v1.1 as the normative implementation baseline; full v2 remains non-goal.
- 2026-08-28: Repository status refreshed; original `docs/harness_tools/Pi Agent Tools v2.md` is untracked user content and excluded from task ownership.
- 2026-08-28: Initial dependency graph and verification plan recorded; no implementation task started yet.
- 2026-08-28: T-001 moved to in_progress and assigned to foundations; authority document validated before delegation.
- 2026-08-28: T-001 writer delegation returned inconclusive with no workspace changes; coordinator inspected clean task-owned paths, retained in_progress state, and took ownership for direct implementation.
- 2026-08-28: T-001 completed after 7/7 focused tests, diff check, and contract Markdown check passed; shared bounded range, errors, policy, provider context, and contract formatting are present.
- 2026-08-28: T-002, T-003, T-004, and T-005 moved to in_progress as parallel-ready Batch 2 tasks; authority document validated before delegation.
- 2026-08-28: Initial Batch 2 writer DAG rejected/inconclusive with no workspace changes. Root `npm run check` then found only test matcher type arguments in T-001; coordinator corrected them, reran 7/7 tests, and completed a clean full check. Batch 2 will be retried from a committed foundation snapshot.
- 2026-08-28: Second Batch 2 writer DAG also rejected/inconclusive without workspace changes; coordinator retained the planned boundaries and implemented the four disjoint tools directly.
- 2026-08-28: T-002 through T-005 completed; four focused files passed 16/16 tests and root `npm run check` passed after explicit type fixes. T-006 moved to in_progress for integration.
- 2026-08-28: A read-only T-006/T-007 analyst DAG could not access the delegated repository snapshot and returned no usable changes; coordinator continued from direct repository evidence.
- 2026-08-28: T-006 completed after 97/97 focused coding-agent tests, root typecheck, and full `npm run check` passed. The opt-in SDK/CLI profile, shared v2 definitions, prompts, renderers, local search adapter, filtering, override, and non-persistence behavior are integrated. T-007 moved to in_progress.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: not_run
- Evidence: Implementation and validation have not started.
- Limitations: Downstream tasks remain pending until shared foundations are implemented and verified.
