# Task Plan: Execute Pi Tools full roadmap

- Created: 2026-08-29
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: Confirmed conversation contract to implement the full corrected roadmap as opt-in staged deliveries, including authorized bounded real-model evaluation.

<!-- task-doc-section:background-goal -->
## Background and goal

Execute the corrected `docs/harness_tools/Pi Tools V2.1 完整增强方案.md` from Structured Search through Read Provider, Shared Mutation Core, experimental Journal/Overlay, Host ABI stabilization, and final A/B/C evaluation. Preserve the four model-visible tools, legacy compatibility, run result semantics, and the non-sandbox WorkspacePolicy boundary. Deliver each stage through an independently validated commit; do not switch the default profile.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope:

- Phase 0 contract freeze and repository topology recovery;
- V2.1 structured search using direct structured local backends, cursor/ranking semantics, and dedicated Search TUI;
- verified optional FFF integration when official API/license/platform evidence is acceptable, otherwise a documented external blocker;
- V2.2 ReadProvider, bounded fallback, stable/explicit directory continuation, opt-in external directory sorting, ResourceReader support, and dedicated Read TUI;
- V2.3 EditPlan, operations/replacement/patch dialects, observations, preservation/limits, and dedicated Edit TUI;
- V2.4 opt-in Darwin/Unix journaled mutation, failure injection, crash recovery, external-modification detection, quotas, and overlay backend;
- V2.5 provider ownership/lifecycle, minimal hooks, native adapters, and SSH/Memory reference providers;
- faux-provider tests plus an explicitly gated real A/B/C evaluation using at most 15 sessions.

Non-goals:

- switching v2 to the default profile or removing legacy tools;
- claiming Windows durable-journal support;
- treating WorkspacePolicy or run cwd as a shell sandbox;
- unbounded real-model evaluation or credential output;
- silently substituting an unverified FFF implementation;
- modifying or committing `docs/harness_tools/Pi Agent Tools v2.md`.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | User confirmed full-roadmap execution, all candidate abilities opt-in, no default switch, staged commits. | Structured choices `execution_scope`, `roadmap_gates`, `delivery_cadence`, and final confirmation. |
| F-002 | User authorized real evaluation with `openai-codex/gpt-5.6-luna`, thinking=max, five fixed seeds per A/B/C, maximum 15 sessions. | Structured choice `eval_budget` and confirmed summary. |
| F-003 | FFF may be added only after official API/license/platform verification; failure becomes an explicit external blocker. | Structured choice `fff_strategy`. |
| F-004 | Durable journal support is scoped to Darwin/Unix; Windows is excluded from the guarantee. | Structured choice `platform_validation`. |
| F-005 | Current local search calls native grep/find definitions and reparses formatted text. | `packages/coding-agent/src/core/tools/local-search-provider-v2.ts`. |
| F-006 | Current read requires `readTextRange`; directory listing loads and sorts all entries. | `packages/agent/src/harness/tools/read-v2.ts`. |
| F-007 | Current edit prevalidates but can return `EDIT_PARTIAL_COMMIT`; operations are not durable transactions. | `packages/agent/src/harness/tools/edit-v2.ts`. |
| F-008 | Current WorkspacePolicy is explicitly best-effort, and run timeout/nonzero are normal results. | `workspace-policy.ts`; `run-v2.ts`; corrected roadmap. |
| F-009 | Repository rules require targeted tests and root `npm run check`, prohibit full Vitest/build, and gate paid-provider tests behind explicit opt-in. | `AGENTS.md`. |
| F-010 | Search runtime types and validation belong in `packages/agent`; local `rg`/`fd` process providers and all dedicated renderers belong in `packages/coding-agent`. | `search-v2.ts`, `search-provider.ts`, `local-search-provider-v2.ts`, `tool-profile.ts`. |
| F-011 | Existing `rg` and `fd` acquisition is reusable through `ensureTool`; direct structured implementations must not call `createGrepTool`/`createFindTool`. | `packages/coding-agent/src/utils/tools-manager.ts`; native `grep.ts` and `find.ts`. |
| F-012 | The existing TUI lifecycle already supports stateful partial/expanded renderers; Search/Read/Edit should bind specialized `renderCall`/`renderResult` functions in `tool-profile.ts`. | `ToolDefinition` in `extensions/types.ts`; `ToolExecutionComponent`; existing run renderer. |
| F-013 | Current v2 definitions create one `NodeExecutionEnv` and provider set per session construction, but `AgentSession.dispose/reload` does not close those hidden resources. | `createV2ToolDefinitions`; `AgentSession.dispose`, `_buildRuntime`, and `reload`. |
| F-014 | Read seams are `ExecutionToolContext`, optional `ExecutionEnv.readTextRange`, `listDir`, image processing, and focused `read-v2.test.ts`; large-directory listing is currently eager and globally sorted. | `read-v2.ts`, `types.ts`, `read-v2.test.ts`. |
| F-015 | Mutation seams are `edit-v2.ts`, `withV2MutationCoordinator`, `ExecutionEnv` filesystem operations, native diff helpers, and `edit-v2.test.ts`; the current commit loop has an explicit partial-commit boundary. | cited source/tests. |
| F-016 | Host stabilization must add resource ownership outside `ToolDefinition`, because the current definition type has rendering/execution but no close hook. | `extensions/types.ts`, `sdk.ts`, `agent-session.ts`. |
| F-017 | Official FFF package `@ff-labs/fff-node@0.10.5` is MIT, publishes Darwin arm64/x64 and Linux/Windows native packages, has no package lifecycle install script, and exposes `FileFinder.create`, `waitForScan`, `fileSearch`, `glob`, `grep`, `watch`, and `destroy`. | Official GitHub LICENSE/README/release v0.10.5; npm registry metadata; published 0.10.5 `.d.ts` and tarball inspection. |
| F-018 | FFF does not expose a provider generation token; its grep cursor is native and file/glob pagination is page-index based. Any Pi integration must wrap it with Pi-owned generation/request/session cursor binding and invalidate on watcher rescan/recreation. | Published `fff-api.d.ts`/`finder.d.ts`; official watcher documentation. |
| F-019 | FFF is approved only as an exact-version, opt-in coding-agent optional dependency/provider; it is not the default Search backend or a V2.1 correctness dependency. | F-017/F-018 plus corrected roadmap routing and fallback requirements. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Confirmed assumption: “全部实现但不默认” means every in-repository capability is implemented and opt-in; an external FFF dependency can remain blocked only if official verification fails.
- Confirmed assumption: Darwin/Unix journal behavior may be considered complete with local failure/crash evidence plus platform guards; Windows support is explicitly out of scope.
- Confirmed assumption: Each stage may add necessary new tasks when repository evidence reveals a required boundary, but no task may bypass the dependency and validation gates.
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- The model-visible profile remains exactly `search/read/edit/run`, legacy remains available, and default profile remains legacy.
- Structured Search no longer reparses native tool text and has explicit exact/approximate/partial/cursor/ranking semantics plus dedicated TUI.
- Read has injectable providers, bounded compatibility behavior, explicit continuation consistency, opt-in large-directory strategy, resource readers, and dedicated TUI.
- Edit has one internal EditPlan, selectable single advertised dialect, observation conflict detection, preservation/limits, and dedicated TUI.
- Experimental Darwin/Unix journal and overlay backends have conditional guarantees, failure/crash tests, external-change detection, quotas, and indeterminate recovery.
- Provider ownership/close/reload and adapters/reference providers are tested; hooks remain minimal and specified.
- FFF is either a verified optional real integration or a task marked blocked with exact official evidence and unblock condition.
- Faux tests and bounded real A/B/C evaluation run under explicit opt-in; real usage never exceeds 15 sessions or prints credentials.
- Every implementation stage has targeted tests, root `npm run check`, task-document validation, diff inspection, and an explicit commit.
- `docs/harness_tools/Pi Agent Tools v2.md` remains untouched and uncommitted.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003 -> T-004 -> T-005 -> T-006 -> T-007 -> T-008 -> T-009 -> T-010 -> T-011 -> T-012`.
- Parallel batches: Product stages are serialized to preserve stage commits and stable contracts. Within T-001, bounded read-only analysts may investigate Search, Read, Mutation/Journal, Host/TUI, and FFF in parallel; the coordinator serially integrates their evidence.
- Serialization constraints: Shared exports, schemas, package boundaries, task document, root checks, real-eval budget, and final staging are coordinator-owned. No subagent may edit this task document.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Freeze contracts and recover implementation topology

- Status: done
- Owner: coordinator
- Objective: Turn the roadmap into concrete current-repository interfaces, file ownership, test seams, dependency decisions, and stage-level success or blocker criteria.
- Inputs and prerequisites: Confirmed execution contract, corrected roadmap, current source/tests/docs, official FFF evidence.
- Scope or files: Read-only repository and official dependency research; this authority document.
- Expected output: Evidence-backed implementation map for T-002 through T-011, including FFF decision and no hidden cross-stage contract conflicts.
- Dependencies: None.
- Execution steps:
  1. Trace current Search, Read, Edit, provider lifecycle, extension hooks, renderer, and session/profile construction.
  2. Inventory reusable native implementations and exact duplicate logic to extract.
  3. Verify FFF official API, license, package identity, and Darwin/Unix support.
  4. Define targeted test files, performance workloads, package exports, and stage file ownership.
- Acceptance criteria:
  - Every downstream task has concrete source/test seams and no unverified API assumptions.
  - FFF is approved with evidence or marked externally blocked with an exact unblock condition.
  - Current run and workspace policy semantics are preserved in the map.
- Verification method:
  - Repository citations, official FFF sources, dependency graph review, task validator.
- Validation evidence: Repository topology traced across the Search/Read/Mutation/Host source and focused tests listed in F-010–F-016. Official FFF LICENSE, README, release, npm metadata, published type declarations, and tarball inspected; decision recorded in F-017–F-019. Dependency graph reviewed and task document validator passed on 2026-08-29.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Implement V2.1 structured Search runtime

- Status: done
- Owner: coordinator
- Objective: Replace text-reparsing local search with structured providers and complete Search contract semantics.
- Inputs and prerequisites: T-001 approved interfaces and dependency decision.
- Scope or files: Agent Search schema/provider/runtime, coding-agent direct local providers, package exports, focused search tests.
- Expected output: text/files/glob, case/context/fileGlob, fast/global, opaque bound cursors, exact/approximate/partial details, direct rg/fd/fs paths, and optional verified FFF.
- Dependencies: T-001.
- Execution steps:
  1. Add structured types, validation, cursor binding, and provider capability checks.
  2. Implement direct `rg --json`, `fd --print0`, and ExecutionEnv/filesystem providers without native tool text parsing.
  3. Implement bounded fast/global semantics, deterministic ordering, cancellation, and lifecycle cleanup.
  4. Add differential, adversarial-path, cursor, partial, and performance regressions.
- Acceptance criteria:
  - No LocalSearchProviderV2 path invokes native ToolDefinition and parses final text.
  - Search contract and performance acceptance criteria from the roadmap pass.
  - FFF outcome is truthful and tested when integrated.
- Verification method:
  - Targeted agent/coding-agent search tests, component benchmark, root check.
- Validation evidence: Agent Search/Read/Edit focused tests passed 13/13; coding-agent local/FFF/profile/component tests passed 43/43. Direct providers use rg JSON and fd NUL output; adversarial colon/newline/non-ASCII paths, explicit case/regex/context, fuzzy/global/glob, cancellation, capability rejection, opaque request-bound continuation, and native FFF routing are covered. `npm run check` passed. Synthetic 5,000-file component benchmark on Node v24.15.0 / Darwin arm64 / Apple M5 (6 measured runs after 2 warmups): files-fast P50 13.634 ms, P95 13.902 ms; files-global P50 13.893 ms, P95 14.076 ms; text literal P50 45.923 ms, P95 47.620 ms; each returned the target with complete=true, approximate=false, partial=false.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Implement Search TUI and stage validation

- Status: done
- Owner: coordinator
- Objective: Render structured Search calls/results with ranges, context, grouping, continuation, and status without parsing content.
- Inputs and prerequisites: T-002 structured details.
- Scope or files: coding-agent v2 Search renderer, component tests, V2.1 docs/eval fixtures.
- Expected output: Dedicated width-aware Search TUI and completed V2.1 staged commit.
- Dependencies: T-002.
- Execution steps:
  1. Implement renderCall/renderResult using existing ToolDefinition lifecycle.
  2. Cover narrow width, ANSI, partial, approximate, cursor, expanded/collapsed, and large output.
  3. Run V2.1 targeted tests, root check, task validation, and explicit commit.
- Acceptance criteria:
  - Renderer consumes details only and meets roadmap TUI parity.
  - V2.1 is independently releasable and committed.
- Verification method:
  - Targeted TUI/profile tests, root check, git inspection.
- Validation evidence: Dedicated Search renderer consumes only `SearchV2Details.hits`, groups text matches by file, highlights ranges, distinguishes exact/approximate and complete/partial states, renders continuation, truncates to terminal width, and supports expanded/collapsed output. `tool-execution-component.test.ts` passed within the 43/43 coding-agent focused result; root `npm run check`, `git diff --check`, shrinkwrap, and install-lock checks passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Implement V2.2 ReadProvider and bounded continuations

- Status: done
- Owner: coordinator
- Objective: Route read through injectable providers with capability detection and bounded compatibility behavior.
- Inputs and prerequisites: Stable provider lifecycle conventions from V2.1.
- Scope or files: Agent ReadProvider/runtime/types, Node/ExecutionEnv providers, resource readers, focused read tests.
- Expected output: range reading, explicit unsupported degradation, cursor/offset semantics, page-only metadata, and provider injection.
- Dependencies: T-003.
- Execution steps:
  1. Add ReadProvider/capabilities and route read-v2 through it.
  2. Implement Node bounded range and safe legacy fallbacks.
  3. Add directory continuation and opt-in external-sort/snapshot backend with quotas/cleanup.
  4. Add ResourceReader injection and lifecycle tests.
- Acceptance criteria:
  - Old backends do not crash for missing capabilities and never load oversized files without a limit.
  - Large-file and directory memory/latency claims have measured evidence.
  - Snapshot/cursor consistency and stale recovery are deterministic.
- Verification method:
  - Targeted read/provider tests, stress benchmarks, root check.
- Validation evidence: Agent Read/Search/Edit focused tests passed 17/17. Coding-agent Node Read/provider/profile/component tests passed 41/41. Coverage includes missing range capability, oversized fallback rejection, stable request-bound cursors, generation checks, page-only metadata, external-sort entry/byte quotas, deterministic JS-equivalent ordering, special filenames, final-page cursor retry, immediate and close-time spool cleanup, and ResourceReader routing. A 1 GiB sparse UTF-8/NUL file benchmark on Node v24.15.0 / Darwin arm64 / Apple M5 returned a late `startLine=1000` range in 3172.672 ms with a 31,637,504-byte RSS delta and a near-EOF byte range in 0.479 ms; this confirms bounded memory and O(file-size) uncached line seeking. Root `npm run check` and `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Implement Read TUI and stage validation

- Status: done
- Owner: coordinator
- Objective: Add dedicated text/directory/image rendering and complete V2.2 staged delivery.
- Inputs and prerequisites: T-004 structured Read details.
- Scope or files: coding-agent Read renderer, component/profile tests, stage docs.
- Expected output: Syntax/range/continuation/resource-aware TUI and V2.2 commit.
- Dependencies: T-004.
- Execution steps:
  1. Reuse native highlighting/resource behavior through shared helpers.
  2. Render text, directories, images, stale cursors, and degraded capabilities.
  3. Validate and commit V2.2.
- Acceptance criteria:
  - TUI parity and bounded rendering tests pass.
  - V2.2 is independently releasable and committed.
- Verification method:
  - Targeted renderer/profile tests, root check, git inspection.
- Validation evidence: Dedicated Read renderer consumes only structured details, renders line-numbered syntax-highlighted text, bounded collapsed text/directory previews, directory kind/size and stable/partial status, image/resource MIME and size, and all continuation forms. The 41/41 coding-agent focused result covers expanded/collapsed output, width bounds, content-sentinel non-parsing, and directory preview truncation. Root `npm run check` and `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Implement V2.3 Shared Mutation Core and dialects

- Status: done
- Owner: coordinator
- Objective: Introduce one EditPlan runtime with observations, preservation, limits, and separately advertised operations/replacement/patch dialects.
- Inputs and prerequisites: Stable provider/lifecycle patterns through V2.2.
- Scope or files: Agent mutation core/backend/types, edit-v2 adapters, native shared edit helpers, focused mutation tests.
- Expected output: EditPlan, stale-file zero-write checks, grammar-versioned patch parser, preservation scope, limits, and selectable dialect.
- Dependencies: T-005.
- Execution steps:
  1. Extract shared byte/text preservation and diff helpers.
  2. Define EditPlan and normalize each dialect before backend execution.
  3. Add observation identity/hash checks and pre-write budgets.
  4. Differentially test dialects and preservation across files/line endings/modes.
- Acceptance criteria:
  - Mutation backend accepts one internal representation only.
  - Stale observations and over-budget plans perform zero writes.
  - No default dialect switch occurs.
- Verification method:
  - Targeted agent/coding-agent mutation tests, root check.
- Validation evidence: Agent Edit/Read/Search focused tests passed 23/23. The shared MutationBackend accepts only canonical EditPlan operations with initial existence/content hash/size/mtime/identity/mode observations and centralized operation/file/byte limits. Default operations, native-style replacement, and versioned JSON-line Pi Edit Patch v1 dialects produced equivalent updates while only one selected schema was advertised per session. Tests cover stale-file zero-write rejection, pre-write limits, exact uniqueness/overlap behavior, BOM/CRLF/executable-mode preservation, mixed-ending and non-UTF-8 rejection, special patch paths/content markers, move/create/update/delete sequencing, and explicit partial commits. Root `npm run check` and `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — Implement Edit TUI and stage validation

- Status: done
- Owner: coordinator
- Objective: Add structured multi-file call/result/error rendering and complete V2.3 delivery.
- Inputs and prerequisites: T-006 EditPlan/details.
- Scope or files: coding-agent Edit renderer, profile/component tests, stage docs.
- Expected output: File status summary, highlighted/foldable diff, navigation, rollback/indeterminate states, and V2.3 commit.
- Dependencies: T-006.
- Execution steps:
  1. Render structured operations and bounded per-file hunks.
  2. Cover create/update/move/delete, stale, over-budget, and partial states.
  3. Validate and commit V2.3.
- Acceptance criteria:
  - Renderer does not parse model content and meets native parity.
  - V2.3 is independently releasable and committed.
- Verification method:
  - Targeted TUI/profile tests, root check, git inspection.
- Validation evidence: Dedicated Edit renderer consumes structured call/result/error details, summarizes all three dialects, renders per-file status and colored bounded diffs with first-change navigation hints, supports expanded/collapsed folding and a 2,000-line hard render cap, and reports stale/split/partial recovery states without parsing model-visible content. Coding-agent component/profile tests passed 39/39, including narrow-width, control-sequence/path sanitization, structured error sentinels, dialect schema selection, and expanded output. Root `npm run check` and `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — Implement opt-in Darwin/Unix journaled mutation

- Status: done
- Owner: coordinator
- Objective: Add durable conditional recovery with explicit capability gates and failure/crash coverage.
- Inputs and prerequisites: T-006 stable MutationBackend and observations; T-007 committed UI states.
- Scope or files: Journal backend/store/recovery scanner, Unix capability implementation, fault/crash tests.
- Expected output: Journal state machine, staging/rollback/trash, fsync gates, external-change detection, quotas, recovery locking, and EDIT_INDETERMINATE semantics.
- Dependencies: T-007.
- Execution steps:
  1. Implement persisted state machine and platform capability checks.
  2. Implement install/rollback/recovery without overwriting unknown external state.
  3. Add per-transition failure injection and independent-process crash tests.
  4. Keep feature opt-in and explicitly reject unsupported Windows durable mode.
- Acceptance criteria:
  - Every persisted transition has failure coverage.
  - Darwin/Unix crash recovery passes; unknown external state is never auto-overwritten.
  - No strict multi-file external atomicity claim is made.
- Verification method:
  - Targeted fault/crash tests, Unix filesystem checks, root check.
- Validation evidence: `node-journaled-mutation-backend.test.ts` passed 16/16 on Node v24.15.0 / Darwin arm64, including unchanged-schema integration, durable success and mode preservation, every persisted state transition (`planned`, `staged`, `originals_secured`, `installing`, `committed`, `cleanup_complete`, `rollback_started`, `rollback_complete`, and fail-closed `indeterminate`), injected payload-write/fsync/directory-fsync/rename/cleanup failures, private 0700/0600 journal permissions, byte quotas, active/stale process locks, manifest path tampering, external modification preservation, and an actual child process exiting after the first file install followed by scanner rollback. Agent Edit tests passed 11/11; combined journal/profile/component tests passed 55/55. Root `npm run check` and `git diff --check` passed. The backend is explicit opt-in, rejects Windows construction, persists an expiry bound, and documents that it does not provide cross-file atomic visibility.
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — Implement opt-in Overlay backend

- Status: done
- Owner: coordinator
- Objective: Provide isolated mutation execution and explicit accept/discard semantics without changing the model schema.
- Inputs and prerequisites: T-008 backend contract and recovery semantics.
- Scope or files: Overlay backend, host acceptance API, focused tests and docs.
- Expected output: Copy-on-write/temp-worktree reference implementation, validation hooks, diff acceptance, cleanup, and quotas.
- Dependencies: T-008.
- Execution steps:
  1. Select the smallest Darwin/Unix-compatible overlay strategy supported by repository evidence.
  2. Implement accept/discard and crash-safe cleanup.
  3. Test isolation, external modifications, quotas, and cancellation.
- Acceptance criteria:
  - Base workspace is unchanged before explicit accept.
  - Accept/discard states are deterministic and opt-in.
- Verification method:
  - Targeted overlay/integration tests, root check.
- Validation evidence: `node-overlay-mutation-backend.test.ts` passed 6/6 and combined Overlay/Edit-renderer tests passed 37/37; Agent Edit tests passed 11/11. Coverage proves the base workspace remains byte-unchanged before host acceptance, explicit accept applies the observed plan, discard removes the private copy, validation failure/cancel/file-byte/pending-count quotas cleanly discard, base changes cause STALE_FILE while retaining the pending overlay, expired/interrupted preparation is cleaned, interrupted/partial acceptance becomes indeterminate and blocks automatic discard/new overlays, and 0700 private-root permissions are enforced. The TUI and model-visible result explicitly say that host accept/discard is pending. Root `npm run check` and `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — Stabilize Host ABI, adapters, hooks, and reference providers

- Status: done
- Owner: coordinator
- Objective: Complete V2.5 lifecycle/extension surface without duplicating execution semantics.
- Inputs and prerequisites: Search, Read, Mutation, Journal, and Overlay contracts.
- Scope or files: Public factories/options/exports, lifecycle, native adapters, minimal hooks, Memory/SSH reference implementations, docs/tests.
- Expected output: Tested session/host ownership, close/reload behavior, truthful capability degradation, reference providers, and minimal approval/notification hooks.
- Dependencies: T-009.
- Execution steps:
  1. Finalize factory-vs-instance ownership and reload/close semantics.
  2. Implement native Operations adapters with accurate capabilities.
  3. Add Memory and SSH reference providers/backends.
  4. Add only beforeCommit/afterCommit/afterRollback hooks unless evidence requires more.
- Acceptance criteria:
  - No resource double-close/leak across session reload/disposal.
  - Adapters never claim unsupported capabilities.
  - Model schemas remain unchanged across local/SSH/Memory hosts.
- Verification method:
  - Targeted lifecycle/adapter/reference tests, root check.
- Validation evidence: Factory and direct-instance lifecycle tests prove per-session/reload creation, host ownership, idempotent close, continued cleanup after failures, and independently inspectable lifecycle errors through `AgentSession`; hook tests prove approval ordering, zero backend calls on rejection, live rollback notification, and outcome preservation when notification/error observers throw. `MemoryExecutionEnv` executes structured search/read/edit; `SshExecutionEnv` delegates a remote read without changing any of the four model schemas. Native Find/Read/Edit adapters declare and test glob-only, no-range, and update-only degradation. Agent mutation tests passed 13/13; coding-agent profile/host/reload tests passed 20/20; root `npm run check` and `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — Run faux and bounded real A/B/C evaluation

- Status: done
- Owner: coordinator
- Objective: Compare native, current V2, and full opt-in candidate without switching defaults.
- Inputs and prerequisites: T-010 complete implementation; existing sanitized eval harness; authorized model/budget.
- Scope or files: Evaluation manifests/harness/results/docs, no credential files.
- Expected output: Faux regression evidence and at most 15 real sessions with completion, selection, schema, tool-count, ranking, misuse, edit, token, latency, and cost metrics.
- Dependencies: T-010.
- Execution steps:
  1. Define fixed held-out five-seed A/B/C manifest and grading.
  2. Run faux/default tests without network.
  3. Run explicit opt-in real evaluation using `openai-codex/gpt-5.6-luna`, thinking=max, stopping at 15 sessions or first systemic failure.
  4. Sanitize/persist only approved aggregate traces and compare against gates.
- Acceptance criteria:
  - No credentials or content-sensitive traces are persisted.
  - Session budget is enforced and actual usage recorded.
  - Results are reported truthfully; candidate remains opt-in regardless of outcome.
- Verification method:
  - Targeted faux and real eval files, manifest graders, aggregate consistency checks.
- Validation evidence: Credential-free runner/trace/prompt tests passed 6/6. The explicitly gated real test ran exactly 15 sessions (A/B/C × five fixed seeds) on `openai-codex/gpt-5.6-luna` with thinking=max in 284.43s: every variant completed 5/5, with zero tool/schema errors and first-edit success 5/5. Mean turns were A=6.0, B=5.6, C=5.2; mean tool calls A=10.6, B=7.4, C=6.2; run misuse A=6, B=0, C=0; B/C ranked the target first in 5/5 searches. Mean elapsed milliseconds were A=20,305.4, B=19,215.0, C=16,959.6; reported total cost was $0.03241452. B/C schema hashes matched and differed from A. Only sanitized aggregate behavior metrics/hashes were persisted in `RESULTS.md`; no credentials or content traces were stored. Root `npm run check` and `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — Complete full-roadmap validation and delivery

- Status: done
- Owner: coordinator
- Objective: Verify every phase, document external blockers/limits, run final checks, and deliver a clean opt-in implementation.
- Inputs and prerequisites: T-011 results and all stage commits.
- Scope or files: Final integration fixes, changelogs/docs where applicable, authority document, final explicit commit.
- Expected output: Completed or truthfully partially blocked roadmap with current evidence and untouched user-owned file.
- Dependencies: T-011.
- Execution steps:
  1. Verify all task outputs and cross-stage dependency paths.
  2. Run modified targeted tests, root `npm run check`, task validator, diff/status review.
  3. Confirm default profile and legacy behavior remain unchanged.
  4. Record residual platform/FFF/eval limits and commit explicit paths.
- Acceptance criteria:
  - All non-blocked tasks are done with current evidence; any blocker has exact official evidence and unblock condition.
  - Final repository and task validations pass.
- Verification method:
  - Cross-stage targeted tests, root check, task validator, git log/status/diff.
- Validation evidence: Final cross-stage agent Search/Read/Edit tests passed 25/25. Coding-agent local/FFF Search, Node Read, Journal, Overlay, Host adapters/lifecycle, profile/TUI, and faux evaluation tests passed 86/86. Root `npm run check` passed with no auto-fixes; `git diff --check` passed. Static contract checks confirmed `toolProfile` still defaults to `legacy` and the v2 edit dialect still defaults to `operations`. The task validator passed, the staged roadmap commits are present, and the only remaining untracked file is the untouched user-owned `docs/harness_tools/Pi Agent Tools v2.md`.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Per stage: modified targeted Vitest files only, no full suite or `npm test`.
- Search: differential rg/glob tests, cursor/partial/ranking/adversarial paths, component performance, Search TUI.
- Read: range/large-file memory, long line, cursor/stale directory, external-sort quotas/cleanup, ResourceReader, Read TUI.
- Mutation: dialect parser/property cases, observation zero-write, BOM/CRLF/mode, budgets, Edit TUI.
- Journal/Overlay: every state transition failure injection, independent-process crash, external modification, quota/disk/permission/rename/fsync/cancel, isolation accept/discard.
- Host: ownership/reload/close, adapters, Memory/SSH schema equivalence, minimal hook ordering/errors.
- Evaluation: default faux tests; real model only via explicit opt-in, maximum 15 sessions, sanitized aggregates.
- Every code stage: root `npm run check` and post-check status inspection.
- Process: task validator after material state changes, `git diff --check`, explicit staging and stage commits.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Full roadmap spans multiple public contracts and may reveal necessary intermediate tasks. Mitigation: add stable task IDs with explicit dependencies; never hide scope in logs.
- FFF may lack a verifiable official distributable or acceptable license/platform support. Mitigation: official research in T-001; block truthful real integration rather than invent it.
- External-sort directories and durable transactions can create disk/time/resource amplification. Mitigation: opt-in, quotas, cleanup, benchmarks, and failure tests.
- Journal recovery can overwrite external changes if observations are weak. Mitigation: identity/hash checks and EDIT_INDETERMINATE fail-closed behavior.
- Patch schema may underperform operations. Mitigation: implement selectable dialects and evaluate without changing defaults.
- Real evaluation can spend paid tokens or leak sensitive content. Mitigation: explicit flag, exact model/budget, fixed fixtures, sanitized aggregates, stop at 15 sessions.
- Darwin/Unix-only guarantee can be misread as cross-platform. Mitigation: runtime platform guards, docs, and explicit Windows rejection for durable mode.
- Root check auto-fixes can touch shared-worktree files. Mitigation: inspect status/diff immediately after every root check and preserve the unrelated untracked user file.
- Current blocker: None; T-010 through T-012 remain dependency-ordered.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-29: User selected full-roadmap implementation, all candidate capabilities opt-in, no default switch, staged commits.
- 2026-08-29: User authorized a maximum 15-session real A/B/C evaluation on `openai-codex/gpt-5.6-luna` with thinking=max.
- 2026-08-29: User selected verified optional FFF dependency strategy and Darwin/Unix-only durable journal support.
- 2026-08-29: Shared execution contract confirmed; authority document created and T-001 started.
- 2026-08-29: Prior delegated T-001 repository snapshots were invalid (all paths ENOENT); coordinator discarded those reports and recovered topology from the real worktree.
- 2026-08-29: T-001 completed. FFF 0.10.5 approved only as an exact-version opt-in optional provider with Pi-owned generation/cursor binding; core Search remains direct rg/fd/fs. Task validator passed.
- 2026-08-29: T-002 started by coordinator; first implementation slice is the agent Search contract plus direct local structured providers and focused red/green tests.
- 2026-08-29: T-002 completed with structured contracts, Pi-owned cursor binding, direct rg/fd/fs providers, and exact-version FFF 0.10.5 opt-in provider. Security review found MIT licensing, no package lifecycle install script, signed/provenance npm artifacts, and `npm install --ignore-scripts` reported 0 vulnerabilities.
- 2026-08-29: T-003 completed with details-only Search TUI, 13/13 agent tests, 43/43 coding-agent tests, 5,000-file component measurements, root check, generated shrinkwrap/install lock, and clean diff checks.
- 2026-08-29: V2.1 committed as `63326d57d`; protected user-owned `Pi Agent Tools v2.md` remained untracked and untouched.
- 2026-08-29: T-004 started by coordinator after the V2.1 commit.
- 2026-08-29: T-004 completed with injectable ReadProvider/ResourceReader contracts, bounded legacy degradation, stable Pi-owned directory cursors, Node streaming directory pages, and opt-in Unix external sorting with quotas and cleanup. The 1 GiB benchmark confirmed bounded memory while documenting the uncached line-seek cost.
- 2026-08-29: T-005 completed with a details-only, width-aware Read renderer and bounded collapsed previews. Agent focused tests passed 17/17, coding-agent focused tests passed 41/41, root `npm run check` passed with no auto-fixes, and diff checks passed.
- 2026-08-29: V2.2 committed as `bde2807b9`; protected user-owned `Pi Agent Tools v2.md` remained untracked and untouched. T-006 started by coordinator.
- 2026-08-29: T-006 completed with one canonical EditPlan/MutationBackend path, pre-commit observations, pre-write budgets, UTF-8/BOM/line-ending/mode preservation boundaries, and explicitly selectable operations/replacement/Pi Edit Patch v1 schemas; operations remains the default.
- 2026-08-29: T-007 completed with a details-only multi-file Edit renderer, bounded highlighted diffs, structured stale/split/partial error states, and control-sequence-safe inline paths. Agent focused tests passed 23/23, coding-agent focused tests passed 39/39, and root `npm run check` passed after formatting with no remaining warnings.
- 2026-08-29: V2.3 committed as `44b10bd1e`; operations remains the v2 edit default and the overall default profile remains legacy. T-008 started by coordinator. A read-only journal analyst again received an empty delegated snapshot, so its inconclusive report was discarded and implementation investigation remains coordinator-owned in the real worktree.
- 2026-08-29: T-008 completed with an opt-in private Darwin/Unix journal, durable state transitions, same-directory staged installs, verified rollback payloads, recovery locking/scanning, quotas/expiry, external-state fail-closed handling, and explicit no-cross-file-atomicity scope. An independent child-process crash after one installed file recovered to both originals; focused tests passed 16/16, related agent tests 11/11, combined coding-agent tests 55/55, and root checks passed.
- 2026-08-29: V2.4 journal stage committed as `5e74f3999`; T-009 started by coordinator with a bounded private workspace-copy reference backend and explicit host accept/discard API.
- 2026-08-29: T-009 completed with a private quota-bounded workspace copy, validation callback, unchanged model schema, pending-acceptance result state, explicit host accept/discard/list APIs, stale-base protection, expiry cleanup, and fail-closed interrupted acceptance. Overlay tests passed 6/6, combined coding-agent tests 37/37, Agent Edit tests 11/11, and root checks passed.
- 2026-08-29: Overlay stage committed as `3aaee2ee9`; T-010 started with session-vs-host ownership, reload/dispose lifecycle, minimal mutation hooks, capability-accurate adapters, and Memory/SSH reference hosts as the remaining scope.
- 2026-08-29: T-010 completed with a reloadable owned runtime, factory-vs-instance lifecycle and error isolation, minimal approval/notification hooks, capability-narrow native Operations adapters, Memory/SSH execution environments, unchanged four-tool schemas, and SDK migration guidance. Focused tests passed 13/13 agent and 20/20 coding-agent; root checks passed.
- 2026-08-29: V2.5 Host ABI stage committed as `d4ba3372f`; T-011 started with the fixed faux manifest/grader and explicit opt-in 15-session A/B/C real-model budget.
- 2026-08-29: T-011 completed. Faux evaluation tests passed 6/6; the gated real A/B/C run consumed exactly the authorized 15 sessions, completed 15/15, emitted no tool/schema errors, and persisted only aggregate sanitized results. C retained the same four schemas as B, used fewer mean turns/tool calls in this bounded sample, and remains opt-in.
- 2026-08-29: Evaluation stage committed as `e52af32a4`; T-012 started with cross-stage regression checks, default/profile contract verification, final task validation, and delivery review.
- 2026-08-29: T-012 completed. Cross-stage focused tests passed 25/25 agent and 86/86 coding-agent; root checks, task validation, default-profile/default-dialect checks, commit-chain review, and protected-file status review all passed.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 through T-012 are all done with per-stage commits and recorded focused checks. Final evidence: 25/25 agent cross-stage tests, 86/86 coding-agent cross-stage tests, 6/6 faux evaluation tests within that coding-agent set, 15/15 authorized real A/B/C sessions, root `npm run check`, `git diff --check`, task-document validation, default/profile contract scans, and explicit Git status/log review.
- Limitations: Overlay is an opt-in bounded workspace copy rather than an OS sandbox; the durable journal is Darwin/Unix-only and opt-in; cross-file changes are not atomically visible; the real evaluation had only five sessions per variant and did not exercise recovery, approximate, or truncation paths; the operations edit dialect remains the v2 default; and the overall default profile remains legacy.
