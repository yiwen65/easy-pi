# Task Plan: Implement Pi four-tool MVP v1.1

- Created: 2026-08-28
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
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
- paid/real-model evaluation runs without separate explicit approval. The user subsequently authorized T-009 and then explicitly requested the full five-seed statistical A/B benchmark with `openai-codex/gpt-5.6-luna` at `max` thinking; T-010 and T-011 are covered by that authorization.

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
- Confirmed decision: The user explicitly authorized real-model testing using `openai-codex/gpt-5.6-luna` with `max` thinking, first as T-009 smoke coverage and then as a five-seed statistical A/B benchmark. Impact: T-010/T-011 may implement and run the gated 2-task × 5-seed × 2-profile matrix, while enforcing call/time/cost breakers and avoiding credential or response-content persistence.
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

- Dependency graph: `T-001 -> {T-002,T-003,T-004,T-005} -> T-006 -> T-007 -> T-008 -> T-009 -> T-010 -> T-012 -> T-013 -> T-011`.
- Parallel batches:
  - Batch 1: T-001 only, because it defines shared contracts used by all tools.
  - Batch 2: T-002, T-003, T-004, and T-005 in parallel after T-001; their owned implementation/test files must be disjoint and shared export integration is deferred.
  - Batch 3: T-006 only, because it integrates all tools into coding-agent registries, CLI, SDK, prompts, and renderers.
  - Batch 4: T-007 only, because evaluation depends on an integrated v2 profile.
  - Batch 5: T-008 only for cross-package verification, documentation reconciliation, and initial delivery.
  - Batch 6: T-009 only for the separately authorized bounded real-model paired smoke test.
  - Batch 7: T-010 only to implement and locally validate the gated real benchmark executor.
  - Batch 8: T-012 only to correct the empirically undersized turn breaker exposed by the first authorized run.
  - Batch 9: T-013 only to calibrate the multi-operation move workflow breaker exposed by the second run.
  - Batch 10: T-011 only to execute the authorized five-seed matrix and record results.
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
- Validation evidence: Final focused `edit-v2.test.ts` passed 5/5, including zero-mutation prevalidation with missing parents, implicit parent creation for create/move, and partial-failure `createdDirectories`; the final five-file agent run passed 26/26 and root `npm run check` passed.
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
- Validation evidence: Final focused `run-v2.test.ts` passed 6/6, including real local nonzero, timeout-output, replay metadata, and Unix managed-process-group termination fixtures; the final five-file agent run passed 26/26 and root `npm run check` passed.
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

### [x] T-007 — Add deterministic A/B evaluation scaffold

- Status: done
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
- Validation evidence: `packages/coding-agent/test/tool-profile-eval/runner.test.ts` passed 1/1 with the in-process faux provider and no external credentials. It executed all task×seed×profile pairs twice and proved byte-equivalent records/summary, balanced profile runs, distinct stable schema hashes, deterministic randomized pair order, and deterministic clustered bootstrap output. Root `tsgo --noEmit` passed. The scaffold documents that any future real-model executor requires explicit `PI_REAL_MODEL_EVAL=1`-style opt-in; none was implemented or run.
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — Complete cross-package validation and delivery

- Status: done
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
- Validation evidence: Final agent targeted command passed 26/26 across foundations and all four v2 tools; final coding-agent targeted command passed 98/98 across CLI args, legacy default tools, v2 profile/provider integration, and deterministic evaluation. Final root `npm run check` completed with no fixes or diagnostics, covering Biome, pinned dependencies, import policy, shrinkwrap/install lock, full typecheck, and browser smoke. `git diff --check` passed. Contract-gap review added exact replay metadata, implicit create/move parent creation with truthful partial-commit directory reporting, five evaluation seeds, and a Unix managed-process termination fixture. Git status contains only task-owned final changes plus the untouched untracked `docs/harness_tools/Pi Agent Tools v2.md`.
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — Run an authorized real-model paired profile smoke test

- Status: done
- Owner: coordinator
- Objective: Exercise one identical end-to-end coding fixture under legacy and v2 with `openai-codex/gpt-5.6-luna` at `max` thinking, then verify the resulting files and tests without exposing credentials.
- Inputs and prerequisites: T-008 complete; user authorization for this model and real-provider use; locally configured openai-codex credentials; source CLI via `pi-test.sh` so unbuilt v2 changes are exercised.
- Scope or files: Temporary fixtures and logs under `/tmp`; this authority document only. No production writes, credential output, or persistent session files.
- Expected output: One legacy run and one v2 run against byte-identical fixtures, with command exit status, elapsed time, final fixture verification, and concise comparison recorded.
- Dependencies: T-008.
- Execution steps:
  1. Create two byte-identical temporary fixtures containing a discover-edit-test task.
  2. Run the source CLI once per profile with `--no-session`, the specified model, and `--thinking max`.
  3. Capture non-secret stdout/stderr in temporary logs and record exit status/time.
  4. Independently run the fixture test and inspect the changed value for both profiles.
  5. Report limitations: one pair is connectivity/integration evidence, not a statistically powered A/B result.
- Acceptance criteria:
  - Both calls resolve `openai-codex/gpt-5.6-luna` and use `max` thinking.
  - Legacy and v2 receive identical fixture bytes and task text.
  - Each successful run leaves the fixture test passing with the requested value.
  - No credential is printed or persisted, and no repository file other than this task document is changed.
- Verification method:
  - CLI exit codes and bounded temporary logs; `node test.js` in each fixture; direct content/hash inspection; repository `git status`.
- Validation evidence: Local catalog lookup resolved `openai-codex/gpt-5.6-luna` with thinking support. Two source-CLI runs used the identical prompt and byte-identical fixtures under `/tmp/pi-tool-profile-real-eval-20260828`, with `--no-session --provider openai-codex --model gpt-5.6-luna --thinking max`: legacy exited 0 in 19 seconds and v2 exited 0 in 18 seconds. Both independently changed `src/value.js` from `answer = 1` to `answer = 42`, reported `PASS answer=42`, passed an independent `node test.js`, and produced identical final fixture SHA-256 hashes (`58d578b...` for the changed file). Temporary logs were 89/90 bytes and contained only final task summaries. Repository status after execution showed only this task-document update plus the untouched untracked vision document.
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — Implement the gated five-seed real benchmark executor

- Status: done
- Owner: coordinator
- Objective: Add a manual-only executor that runs the existing paired benchmark runner against real profile sessions with deterministic fixtures, automatic grading, usage metrics, and hard safety breakers.
- Inputs and prerequisites: T-009 successful connectivity smoke; existing `tool-profile-eval` manifest/runner; repository real-provider test patterns.
- Scope or files: `packages/coding-agent/test/tool-profile-eval/` real benchmark test/executor, manifest task wording, focused credential-free tests as needed, and this authority document.
- Expected output: A `PI_REAL_TOOL_PROFILE_BENCHMARK=1`-gated test pinned by default to `openai-codex/gpt-5.6-luna`, `max` thinking, 2 tasks × 5 seeds × 2 profiles, with deterministic file grading and machine-readable aggregate metrics.
- Dependencies: T-009.
- Execution steps:
  1. Define two deterministic coding fixtures that exercise discovery, bounded read/edit, move, and test execution.
  2. Bind real sessions to the requested model/profile/thinking level and fresh reset fixture path.
  3. Record profile prompt/schema hashes, completion score, model turns, token usage, reported cost, and elapsed time.
  4. Enforce explicit opt-in, exactly 20 sessions, per-session timeout, model-turn limit, and reported-cost breaker.
  5. Run typecheck and the default skipped test path before real execution.
- Acceptance criteria:
  - Without the opt-in flag, no provider call occurs.
  - Matrix contains exactly 10 paired task×seed clusters and 20 profile sessions.
  - Pair order is deterministic and each profile receives identical fixture bytes and prompt within a cluster.
  - Grading depends on filesystem state and local tests, not model self-report.
  - Credentials and full response content are never printed or written.
- Verification method:
  - Targeted Vitest without opt-in, root typecheck, and code inspection of gates/breakers.
- Validation evidence: Added `real-benchmark.test.ts` with explicit `PI_REAL_TOOL_PROFILE_BENCHMARK=1` gating, pinned provider/model defaults, `max` thinking assertion, reset same-path fixtures, filesystem/local-test grading, exactly 20 sessions, 4-turn/session, 80-turn/global, 120-second/session, and $20 reported-cost breakers. The default targeted run passed the faux runner 1/1 and skipped the real test 1/1 without provider calls; root `tsgo --noEmit` and full `npm run check` passed. Manifest now defines 2 deterministic coding tasks × 5 seeds and 5,000 clustered bootstrap samples.
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — Execute and report the five-seed real statistical A/B benchmark

- Status: done
- Owner: coordinator
- Objective: Run the authorized T-010 matrix with `openai-codex/gpt-5.6-luna` at `max`, verify the aggregate, and report completion-rate uncertainty plus descriptive efficiency metrics.
- Inputs and prerequisites: T-010 done; configured openai-codex credentials; real-provider authorization.
- Scope or files: Temporary fixture/result paths and this authority document; no production or persistent session writes.
- Expected output: Twenty bounded real profile sessions, ten paired cluster deltas, deterministic bootstrap 95% interval, per-profile completion/turn/token/latency/cost summary, and truthful failure diagnostics.
- Dependencies: T-010, T-012, T-013.
- Execution steps:
  1. Run only the targeted gated real benchmark file with the explicit environment flag.
  2. Monitor hard breakers and stop on authorization, credential, cost, or systemic provider failure.
  3. Independently inspect machine-readable aggregate output and repository status.
  4. Record results and limitations; do not infer superiority when the interval includes zero.
- Acceptance criteria:
  - All planned 20 sessions either complete or a breaker records why execution stopped.
  - Summary uses the manifest's deterministic clustered bootstrap over paired task×seed deltas.
  - Report distinguishes completion-rate inference from descriptive latency/token observations.
  - Repository contains no credentials, response transcripts, or unintended fixture changes.
- Verification method:
  - Targeted real Vitest output, aggregate consistency checks, task-document validator, and git status.
- Validation evidence: After two breaker-calibration attempts (recorded below), the final targeted real Vitest completed all 20 sessions in 439.56 seconds. Both profiles succeeded on 10/10 runs: paired completion-score delta v2−legacy was 0 with deterministic clustered-bootstrap 95% interval `[0, 0]`. Legacy means/totals: 5.5 turns, 17,324.1 ms, 65,369 input tokens, 3,304 output tokens, $0.01728436 reported cost. V2: 7.2 turns, 26,359.7 ms, 76,371 input tokens, 7,086 output tokens, $0.02429964. Relative to legacy, v2 used 30.9% more turns, took 52.2% longer, used 16.8% more input and 114.5% more output tokens, and reported 40.6% higher cost on these fixtures. Total reported final-run cost was $0.041584. Distinct stable prompt/schema hashes were recorded per profile; pair ordering varied deterministically across the ten task×seed clusters. Repository status after cleanup contained only the untouched untracked vision document.
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — Calibrate the real benchmark turn breaker

- Status: done
- Owner: coordinator
- Objective: Correct the initial four-turn assumption using the observed first real run while retaining a hard bounded session/global limit.
- Inputs and prerequisites: T-010 executor; T-011 first-run evidence showing the v2 locate/edit/test workflow requires 5 turns.
- Scope or files: Benchmark manifest, real benchmark breaker constants/assertions, focused tests, and this authority document.
- Expected output: A minimally increased per-session turn budget that admits normal search/read/edit/run/final workflows and a matching global cap, with all other session/time/cost limits unchanged.
- Dependencies: T-010.
- Execution steps:
  1. Raise the per-session limit from 4 to the smallest safe bound above the observed five turns.
  2. Derive the global cap from sessions × per-session limit rather than a divergent literal.
  3. Rerun the default skipped path, typecheck, and full static check.
  4. Return T-011 to in_progress only after validation passes.
- Acceptance criteria:
  - The observed five-turn workflow no longer trips the breaker.
  - Per-session and global turn limits remain explicit and bounded.
  - No provider call occurs during default validation.
- Verification method:
  - Targeted non-real Vitest, root typecheck/check, and task-document validator.
- Validation evidence: Raised the per-session budget from 4 to 6 turns, the smallest bound above the observed 5-turn workflow with one bounded spare turn, and derived the global cap as `20 × maxTurns` instead of a divergent literal. Targeted default Vitest passed 1 faux test and skipped 1 real test with no provider calls; root typecheck and full `npm run check` passed with no fixes.
- Blocker: None.
- Unblock condition: None.

### [x] T-013 — Calibrate the multi-operation benchmark breaker

- Status: done
- Owner: coordinator
- Objective: Set a final bounded turn budget that covers the observed move/edit/test workflow variability under `max` thinking without weakening session, timeout, or cost controls.
- Inputs and prerequisites: T-012; second T-011 attempt showing the v2 move workflow exceeds 6 turns after eleven successful sessions.
- Scope or files: Benchmark manifest, breaker diagnostic, focused validation, and this authority document.
- Expected output: A 10-turn/session cap, derived 200-turn global cap, and diagnostics that report observed turns on any future breach.
- Dependencies: T-012.
- Execution steps:
  1. Raise the session cap to 10, covering the observed at-least-seven-turn move workflow with bounded headroom.
  2. Include observed turn count in breaker errors.
  3. Rerun targeted skipped-path validation, typecheck, and full static check.
  4. Return T-011 to in_progress only after validation passes.
- Acceptance criteria:
  - Locate and move workflows observed so far fit below the cap.
  - Global cap remains mechanically derived as sessions × per-session turns.
  - Other timeout/session/cost breakers remain unchanged.
- Verification method:
  - Targeted non-real Vitest, root typecheck/check, and task-document validator.
- Validation evidence: Raised the per-session cap to 10 turns, yielding a mechanically derived 200-turn global cap while preserving 20-session, 120-second/session, and $20 reported-cost limits. Breaker diagnostics now include the observed turn count. Targeted default Vitest passed 1 faux test and skipped 1 real test without provider calls; root typecheck and full `npm run check` passed with no fixes.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Agent foundations/tools: run each newly added focused Vitest file from `packages/agent` with the repository-local Vitest CLI.
- Coding-agent profile integration: run modified/new args, SDK, default-tools, tools, prompt contribution and AgentSession tests from `packages/coding-agent`.
- Evaluation scaffold: default automated coverage remains credential-free; T-009 is the separately authorized targeted real-model smoke run.
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
- R-006: Real model runs require credentials, money, and network. Mitigation: T-010/T-011 are explicitly authorized, fixed at 20 sessions with timeout/turn/cost breakers, use ephemeral fixtures/sessions, and do not persist responses or credentials.
- Current blocker: None. All planned and authorized benchmark tasks are complete.

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
- 2026-08-28: T-007 completed after its faux-provider test passed twice-run deterministic records, profile-specific hashes, paired ordering, and clustered bootstrap checks; root typecheck passed. T-008 moved to in_progress for contract-gap review and final cross-package validation.
- 2026-08-28: T-008 contract-gap review added replay metadata, create/move parent-directory creation and partial reporting, five evaluation seeds, and managed-process termination coverage. Final agent tests passed 26/26, coding-agent tests passed 98/98, `npm run check` passed with no fixes, and `git diff --check` passed. T-008 and the overall task moved to done.
- 2026-08-28: User separately authorized real-provider testing with `openai-codex/gpt-5.6-luna` at `max` thinking. Local model listing confirmed that exact provider/model. T-009 was added and moved to in_progress for one bounded paired profile smoke test.
- 2026-08-28: T-009 completed. Legacy and v2 source-CLI sessions ran against identical temporary fixtures and prompt; both exited 0, made the requested edit, and passed independent fixture verification. Legacy elapsed 19 seconds and v2 elapsed 18 seconds. No credentials or response internals were persisted, and repository source remained unchanged.
- 2026-08-28: User explicitly requested the five-seed statistical A/B benchmark. T-010 was added and moved to in_progress; T-011 is pending behind its gated executor and safety validation.
- 2026-08-28: T-010 completed after the gated executor's default path passed 1 faux test and skipped 1 real test, root typecheck passed, and full `npm run check` passed. T-011 moved to in_progress for the authorized 20-session run.
- 2026-08-28: T-011 first real attempt stopped correctly after 19.94 seconds: `locate-edit-test/17/v2` used 5 turns and exceeded the assumed 4-turn/session breaker. T-011 moved to blocked, T-012 was added and moved to in_progress, and no aggregate claim was made.
- 2026-08-28: T-012 completed after calibrating the session breaker to 6 turns and deriving the global 120-turn cap; targeted skipped-path validation, root typecheck, and full `npm run check` passed. T-011 returned to in_progress.
- 2026-08-28: T-011 second attempt emitted eleven successful records over 267.44 seconds, then stopped at `move-edit-test/17/v2` because the move workflow exceeded 6 turns. T-011 moved to blocked, T-013 was added and moved to in_progress, and no incomplete aggregate was reported.
- 2026-08-28: T-013 completed after setting a 10-turn/session and derived 200-turn global cap plus observed-turn diagnostics; targeted skipped-path validation, root typecheck, and full `npm run check` passed. T-011 returned to in_progress for the final rerun.
- 2026-08-28: T-011 final run completed all 20 authorized sessions over 439.56 seconds. Both profiles passed 10/10; paired completion delta was 0 with bootstrap 95% `[0,0]`. V2 was descriptively heavier on these fixtures: +30.9% turns, +52.2% elapsed time, +16.8% input tokens, +114.5% output tokens, and +40.6% reported cost. T-011 and the overall task moved to done.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 through T-010, T-012, and T-013 retain their recorded implementation/static evidence. T-011 completed the authorized 2-task × 5-seed × 2-profile real benchmark with `openai-codex/gpt-5.6-luna` at `max`: 20/20 sessions completed, both profiles scored 10/10, paired delta was 0, clustered-bootstrap 95% interval was `[0,0]`, and bounded usage/latency/cost metrics were recorded. The authority-document validator passed after recording results; repository status showed no benchmark fixture/session residue.
- Limitations: With all ten paired clusters succeeding, completion-rate data cannot distinguish the profiles; `[0,0]` is a degenerate interval caused by identical binary scores, not proof of general equivalence. Efficiency differences are descriptive for two small synthetic tasks and may not generalize. Two earlier authorized attempts consumed additional provider usage before their safety breakers stopped them; their partial records were not mixed into the final statistical aggregate.
