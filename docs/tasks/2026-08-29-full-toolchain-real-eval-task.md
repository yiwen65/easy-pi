# Task Plan: Full Toolchain P0 P1 P2 Real-Model Closure

- Created: 2026-08-29
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: Confirmed conversation contract plus read-only `docs/harness_tools/Agent 代码检索与安全编辑工具改造方案.md`

<!-- task-doc-section:background-goal -->
## Background and goal

Close the source design's P0/P1/P2 search → read → edit → verify requirements with production JS/TS structured retrieval, opt-in OpenAI-compatible semantic candidate retrieval, bounded context/state handling, transactional or explicitly partial multi-file editing, measurable quality/safety evidence, and complex real-model validation. Use objective failure oracles to debug every issue exposed by calibration, then run a held-out comparative evaluation within the newly authorized 48-session/$5 hard budget. Preserve the current default/profile/schema safety boundaries.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope: all P0/P1/P2 rows and Chapters 13, 14, and 16 of the source design; JS/TS definition/reference/assignment/call Search and symbol/AST-node Read; stable same-file grouping, task/path ranking, query templates, remote semantic candidates, locator/view/patch state and existing compaction integration; Search/Read/Edit/Run success and recovery paths; all 16 acceptance scenario classes; deterministic/faux tests; sanitized real-model calibration and held-out metrics; causal debugging and minimal fixes; docs and commit.

Production semantic retrieval must be explicit opt-in. This run may send only generated temporary fixture content to the configured embedding endpoint; easy-pi source, credentials, prompts, paths, commands, tool/model output, and session files must not be uploaded or persisted in evaluation artifacts. JS/TS is the only language promised a production structured backend; other languages must report exact unsupported capabilities. The overall default remains `legacy`, v2 exposes exactly `search`, `read`, `edit`, and `run`, and Edit's default dialect remains `operations`.

Non-goals: Python/Go/Rust structured backends; claiming universal semantic quality; changing the default profile; adding model-visible tools; OS sandboxing; claiming cross-file atomic visibility; full `npm test` or build; modifying or committing either user-owned file under `docs/harness_tools/`.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The source design requires search quality, context cost, call-efficiency, and edit-safety metrics plus 16 named acceptance scenario classes and P0/P1/P2 capabilities. | Source design Chapters 13–16. |
| F-002 | The current committed chain already has locator-only Search, bounded/versioned Read, view/hash/range prepare/commit Edit, compact renderers, deterministic safety evidence, and explicit unsupported structured intents. | Commit `7b35138f7`; `docs/tasks/2026-08-29-locator-safe-edit-task.md`; current source/tests. |
| F-003 | Current structured modes fail closed because no AST/LSP/semantic provider exists in the SearchProvider contract. | `packages/agent/src/harness/tools/search-v2.ts`; provider implementations. |
| F-004 | TypeScript 5.9.3 is already a root development dependency and exposes compiler/language-service APIs; no embedding/vector dependency is present. | Root `package.json`/`package-lock.json`; repository search. |
| F-005 | Existing opt-in journal/overlay mutation backends provide rollback/isolation properties but do not claim cross-file atomic visibility or an OS sandbox. | Existing backend source/tests/docs and prior task evidence. |
| F-006 | The prior authorized 15 real sessions were fully consumed by the happy-path A/B/C run; it produced 15/15 success but did not exercise recovery, incomplete coverage, or truncation. | `tool-profile-eval/README.md`, `RESULTS.md`, and `docs/tasks/2026-08-29-execute-pi-tools-roadmap-task.md`. |
| F-007 | The user has now explicitly authorized up to 48 additional real sessions and $5 total, using `openai-codex/gpt-5.6-luna`, thinking=max, with a maximum 18 turns per session and stop-on-systemic-failure behavior. | Confirmed structured requirements contract in this conversation. |
| F-008 | The user selected a generic OpenAI-compatible embedding contract and restricted all remote embedding data in this run to synthetic temporary fixtures. | Confirmed structured requirements contract. |
| F-009 | Repository rules require an explicit real-eval flag, targeted test files, no credential persistence, focused tests, root `npm run check` after code changes, explicit staging, and automatic commit. | `AGENTS.md`. |
| F-010 | Prior real tool evaluation showed complex tool chains can vary up to 14 turns and requires bounded headroom, calibration, observed-turn reporting, and exclusion of partial calibration records from final aggregates. | Relevant `LEARNS.md` real tool A/B lesson. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: the embedding endpoint is provided at execution time through `PI_EMBEDDING_BASE_URL`, `PI_EMBEDDING_MODEL`, and `PI_EMBEDDING_API_KEY`; no value is printed or persisted.
- Assumption: `PI_EMBEDDING_USD_PER_MILLION_TOKENS` is provided for the combined $5 breaker. If endpoint usage is absent, deterministic local token estimation times that configured price is authoritative; if the price or required connection input is absent, paid evaluation fails closed before a remote embedding call.
- Assumption: P2 context compression reuses the repository's existing compaction path and shared locator ledger rather than creating a second state system.
- Assumption: production semantic retrieval remains opt-in because enabling it can transmit selected workspace content; only synthetic fixtures are authorized in this run.
- Open question: None. The scope, language, remote data boundary, provider contract, model, and budget were explicitly confirmed.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Every P0/P1/P2 row and each Chapter 16 bullet has a passing implementation/evidence mapping or an exact JS/TS/language boundary explicitly permitted by this contract; no shipped capability is inferred from a prompt-only claim.
- JS/TS Search verifies definition, reference, assignment, call, and semantic-candidate result kinds; Read resolves symbols/AST nodes progressively with real source ranges and version evidence. Unsupported languages fail closed without text hits mislabeled as structured.
- Semantic retrieval is opt-in, bounded, cancellable, scope/filter aware, cache/version bound, secret-safe, and exercised only on synthetic fixtures in this run. Task/path ranking and query templates are deterministic and measurable independently of embeddings.
- Search coverage, budgets, grouping, stable order, skipped/truncated relationships, long-line slices, and zero-result absence semantics remain truthful across text, structured, and semantic providers.
- Context handling retains only bounded locator/view/patch evidence after compaction, does not duplicate obsolete snippets, and exposes measurable search/read/edit/full-chain pollution, amplification, and repetition.
- Edit preserves view/hash/range CAS, exactly-one-in-range, prepare/commit, minimal diff, no implicit replace-all, stale/preimage rejection, and transaction/rollback or exact partial-failure status. Run supports focused post-edit verification and recovery.
- Deterministic tests cover all 16 source scenarios with declared target set, scope, coverage, mutation range, and expected error/status. Safety rates are: ambiguity rejection 100%, stale rejection 100%, truncation disclosure 100%, wrong-location writes 0, silent replace-all 0, and unversioned unsafe writes 0.
- Metrics report Precision@K, IRR@K, Hit@K, target rank, completeness, phase/full-chain pollution, amplification, repetition, calls to locate/safe-edit/verify, returned bytes/tokens, p50/p95, broad-query retries, ambiguity relocations, tool/schema errors, latency, and cost against legacy/text-v2 baselines.
- Real execution uses at most 6 calibration sessions plus at most 42 held-out sessions, never exceeds 48 total, 18 turns/session, or $5 combined estimated/reported cost. Systemic provider/infrastructure failures stop immediately; calibration records never enter held-out aggregates.
- Focused tests, root `npm run check`, type/static checks included by it, `git diff --check`, task validation, protected-file review, explicit staging, and final commit pass.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> {T-002, T-005}`; `T-002 -> T-003`; `{T-002, T-003} -> T-004`; `{T-003, T-004, T-005} -> T-006`; `T-006 -> T-012 -> T-007 -> T-008 -> T-009 -> T-010 -> T-011`.
- Parallel batches: T-001 attempted one five-way read-only analyst batch for structured-provider, context/state, edit, evaluation, and requirements-matrix audits. The delegated snapshots omitted every requested repository path and shell access was disabled, so their reports were rejected and no implementation claim relies on them. The coordinator therefore performs the serial contract/integration path; T-002 and T-005 remain logically parallel-ready but will be integrated serially unless a later writer receives a verifiable snapshot.
- Serialization constraints: the authority document, shared Search/Read contracts, tool-profile integration, real-call counters/cost breaker, aggregate results, root checks, and Git staging remain coordinator-owned. No subagent may edit either harness source document or this task document.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Freeze full requirement matrix and executable architecture

- Status: done
- Owner: coordinator
- Objective: Map every P0/P1/P2 and Chapter 13/14/16 requirement to current evidence, a concrete implementation delta, or the confirmed JS/TS boundary; freeze provider/state/evaluation contracts before edits.
- Inputs and prerequisites: Confirmed requirements contract, source design, commit `7b35138f7`, current source/tests/dependencies.
- Scope or files: Read-only repository analysis plus this authority document.
- Expected output: Traceable requirement matrix, exact module ownership, test oracles, cost/data-flow threat boundaries, and dependency-safe implementation plan.
- Dependencies: None.
- Execution steps:
  1. Audit current Search/Read/Edit/Run/provider/compaction/evaluation seams in parallel read-only workstreams.
  2. Specify JS/TS structured index and semantic provider contracts, lifecycle, cache/version, coverage, cancellation, and error semantics.
  3. Specify all 16 deterministic fixtures, complex real tasks, baselines, metrics, sanitization, session/cost breakers, and failure oracles.
  4. Reconcile findings into this document and validate it.
- Acceptance criteria:
  - Every requirement has one owner and objective evidence method.
  - No remote data, cost, unsupported-language, or atomicity claim is ambiguous.
- Verification method:
  - Source/dependency inspection, analyst reports, requirement-matrix review, and task-document validation.
- Validation evidence: The source design was read completely and mapped against current contracts/tests. Current P0 locator/view/prepare safety is preserved; `search-v2.ts` currently rejects every structured mode before provider dispatch, `SearchRequest` carries only a regex boolean and no verified result metadata, `ReadProvider` has no symbol-range seam, and `tool-profile.ts`/SDK expose only one text Search and one range Read provider. TypeScript 5.9.3 is available only as a coding-agent dev dependency, so production AST use requires an exact runtime dependency and regenerated lock artifacts. Existing ToolStateLedger is already bounded/scope/TTL-bound; the compaction prompt already removes raw/obsolete tool traffic, so T-004 will integrate evidence rather than create a second state system. Edit/Run/journal/overlay tests already cover ambiguity, stale/preimage/range, multi-file prevalidation, rollback/partial/indeterminate, output truncation, and nonzero verification results; T-005 is primarily full-scenario evidence unless a red oracle finds a product gap. Existing `context-stress.test.ts` covers only five scenarios/two prompt variants and lacks Chapter 13 metrics or the confirmed 6+42 budget contract. The attempted five-way delegated audit run `9f4f2aa2-b2e3-4e83-bbd9-506cbc86fe7d` was rejected because all target paths were absent from its snapshots. The task document validator passed after these contracts were frozen.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Implement production JS/TS structured Search and AST Read

- Status: done
- Owner: coordinator
- Objective: Add real JS/TS definition/reference/assignment/call Search and symbol/AST-node Read with truthful ranges, coverage, snapshots, and bounded lifecycle.
- Inputs and prerequisites: T-001 frozen contracts; existing locator/view state and TypeScript dependency.
- Scope or files: Agent Search/Read provider contracts and tools; coding-agent JS/TS provider, ownership/lifecycle, focused tests.
- Expected output: Structured providers that verify target kinds and produce locators/views without changing the four model-visible tool names.
- Dependencies: T-001.
- Execution steps:
  1. Add capability/result contracts and stable structured request binding.
  2. Build a bounded JS/TS project/index service using compiler/language-service APIs with invalidation and cancellation.
  3. Classify definitions, references, assignments, and calls from AST evidence; resolve symbol/AST-node reads.
  4. Add same-name, overload/import, generated/ignored, stale-index, unsupported-language, long-line, and lifecycle tests.
- Acceptance criteria:
  - Structured labels are AST-backed and source ranges map to correct bytes/lines.
  - Unsupported languages and incomplete projects disclose capability/coverage exactly.
- Verification method:
  - Focused Agent/coding-agent provider, Search, Read, lifecycle, and adversarial fixture tests.
- Validation evidence: Added the bounded `TypeScriptCodeIndexProvider` using the production TypeScript 5.9.3 compiler/checker, exact runtime dependency, ignore/include/exclude filtering, file/byte/snapshot/node-handle quotas, stable cursors, content-hash invalidation, cancellation, and AST-backed definition/reference/implementation/assignment/call/string/comment modes. Search provider contracts now carry verified mode/range/enclosing/node/rank metadata; Read accepts JS/TS `symbol_body` and opaque `ast_node` ranges through the same provider with workspace re-resolution and stale/ambiguity mapping. Alias/import, overload, same-name, ignore, quota, unsupported-language, cancellation, stale-node, locator-read, direct-symbol-read, default-runtime ownership, FFF fallback, and Node Read integration passed: Agent 3 files / 30 tests; coding-agent 5 files / 36 tests. Root `tsgo --noEmit` passed. Dependency metadata was regenerated with `npm install --package-lock-only --ignore-scripts`, coding-agent shrinkwrap, and install-lock generators; npm reported 0 vulnerabilities.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Implement opt-in semantic retrieval, ranking, path priors, and templates

- Status: done
- Owner: coordinator
- Objective: Complete P2 retrieval with a privacy-explicit OpenAI-compatible embedding provider plus deterministic ranking, path priors, and reusable query templates.
- Inputs and prerequisites: T-001 contracts and T-002 structured candidate ranges.
- Scope or files: Search provider contracts, coding-agent semantic/ranking/index modules, configuration/docs, focused tests.
- Expected output: Bounded synthetic-validated semantic candidate retrieval and independently testable deterministic ranking features.
- Dependencies: T-002.
- Execution steps:
  1. Implement explicit opt-in connection/config, batching, filtering, cancellation, cache/version binding, byte/token/call/cost budgets, and sanitized errors.
  2. Build candidate documents from JS/TS symbols, identifier segments, comments, and paths without exposing out-of-scope files.
  3. Add task-aware ranking, repository path priors, and versioned query-template routing with ablation controls.
  4. Test endpoint failures, malformed vectors, dimensions, stale cache, ignored files, cancellation, budget breakers, redaction, and deterministic ordering.
- Acceptance criteria:
  - No network call occurs without explicit semantic config and eval opt-in.
  - Search completeness never claims full semantic coverage when indexing/filtering is partial.
  - Secret values and source content never enter committed logs/results.
- Verification method:
  - Local fake endpoint integration, deterministic ranking/ablation tests, and later authorized synthetic real endpoint evaluation.
- Validation evidence: Added explicit `semanticSearchProvider` routing and SDK injection, query-template conflict/target validation, task/global/scope/cursor capability gates, deterministic JS/TS production/preferred-path ranking, bounded semantic documents including leading comments, and the exported `OpenAICompatibleEmbeddingSearchProvider`. The remote provider is opt-in through `PI_SEMANTIC_SEARCH=1`, filters before send, validates options/vectors/batch dimensions, rejects stale source-bound cursors, caches by model/content, preflights request/byte/token-cost budgets, avoids empty-scope calls, and sanitizes network/HTTP/JSON failures. SDK/environment docs state exact variables and data-egress boundaries. Fake-endpoint and integration evidence passed: Agent Search 14/14; coding-agent semantic/index/profile 32/32; root `tsgo --noEmit`; `git diff --check`. No remote endpoint call was made.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Close grouping, context compression, and state-flow P2 gaps

- Status: done
- Owner: coordinator
- Objective: Complete same-file result grouping and integrate locator/view/patch summaries with existing compaction so obsolete snippets do not amplify context.
- Inputs and prerequisites: T-002 and T-003 outputs; existing ToolStateLedger and compaction subsystem.
- Scope or files: Agent state/formatting contracts; coding-agent prompt/context projection, compaction adapters, renderers, focused tests.
- Expected output: One bounded state flow with progressive expansion, grouping, deduplication, invalidation, and measurable context retention.
- Dependencies: T-002, T-003.
- Execution steps:
  1. Define grouped result expansion without duplicating locators or breaking cursors/budgets.
  2. Project only live locator/view/patch summaries across compaction and retire superseded snippets.
  3. Preserve runtime/session/scope/TTL isolation and prompt guidance.
  4. Add long-chain, compaction, stale-handle, repetition, and output-size regressions.
- Acceptance criteria:
  - Compaction does not revive stale locators or retain redundant code blocks.
  - Grouping preserves truthful per-result coverage and stable continuation.
- Verification method:
  - Focused state/Search/profile/compaction/provider-context tests and deterministic byte/token measurements.
- Validation evidence: Search now groups same-file locators in stable first-hit order for both model output and TUI rendering while preserving individual opaque IDs and exact coverage. The shared ledger deduplicates superseded locator/view evidence, removes non-visible budget-overflow locators, exposes no-source bounded evidence, and invalidates path/identity-bound locators, views, and prepared patches after base-workspace commits. The v2 runtime projects at most 4 KiB of grouped handle-only evidence into the existing compaction checkpoint; the compactor prompt omits raw Search/Read/Edit snippets and history-copied opaque IDs, and every handle remains TTL/scope/version revalidated. Focused evidence passed: Agent Search/state/Edit/Read 51/51; coding-agent profile/compaction narrative/session integration 30/30; root `tsgo --noEmit`.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Close transactional Edit and focused Run verification gaps

- Status: done
- Owner: coordinator
- Objective: Audit and fill remaining P0/P1 Edit/Run requirements, including multi-file validation failure, rollback/partial state, syntax failure recovery, and exact post-edit verification.
- Inputs and prerequisites: T-001 contract; current prepare/commit, mutation, journal, overlay, and Run implementations.
- Scope or files: Edit/Run/mutation backends and focused Agent/coding-agent tests/docs where evidence reveals a gap.
- Expected output: Proven zero-write rejection, minimal diff, safe transaction/rollback or explicit partial failure, and focused verification/recovery behavior.
- Dependencies: T-001.
- Execution steps:
  1. Establish deterministic bad baselines for every uncovered acceptance case before product edits.
  2. Locate first divergence and apply only causal fixes.
  3. Verify journal/overlay/default backend behavior, addressed-vs-canonical path boundaries, and Run result semantics.
- Acceptance criteria:
  - Ambiguous/stale/range/preimage failures mutate nothing.
  - Multi-file validation/commit outcomes are rollback-safe where promised and otherwise explicitly partial/indeterminate.
  - Syntax/test failure after edit is visible and recoverable through the four-tool workflow.
- Verification method:
  - Focused Edit/Run/journal/overlay/mutation/property tests with before/after failure oracles.
- Validation evidence: Existing Edit tests prove ambiguity/preimage/range/stale/limit/UTF-8 failures make zero writes, prepared multi-file plans prevalidate every observation, default-backend I/O failures report completed/pending/changed/unknown paths, and create never overwrites. Journal tests prove rollback, indeterminate recovery, crash recovery, durability, tamper rejection, and external-write preservation; overlay tests prove base isolation, validation rollback, stale accept, quota, discard, and indeterminate accept behavior. Run tests prove nonzero/timeout/truncation/cancellation semantics; a new deterministic read → bad edit → `node --check` failure → reread → repair → passing Run test closes syntax-failure recovery. Focused evidence passed: Agent Edit/Run 27/27 plus workspace/path foundations 7/7; coding-agent journal/overlay/file-queue 29/29.
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Integrate Agent policy, schemas, lifecycle, TUI, and SDK

- Status: done
- Owner: coordinator
- Objective: Wire structured/semantic discovery and full recovery policy into the four-tool runtime without schema/default regressions or unsafe output.
- Inputs and prerequisites: T-003, T-004, and T-005 complete contracts.
- Scope or files: tool profile/runtime ownership, prompt contributions, renderers, SDK docs, profile/lifecycle tests.
- Expected output: Capability-aware Search → Read → prepare → commit → Run/Read verification guidance and compact sanitized UI.
- Dependencies: T-003, T-004, T-005.
- Execution steps:
  1. Route providers/config/lifecycle with idempotent close/reload and no hidden network enablement.
  2. Teach intent distinction, narrowing, coverage inspection, progressive AST/locator reads, safe edit, and recovery.
  3. Render structured/semantic/grouped/coverage/view/patch states without content duplication or control-sequence injection.
  4. Document data egress, budgets, language boundaries, failures, and opt-in examples.
- Acceptance criteria:
  - Model-visible tools remain exactly four and defaults remain unchanged.
  - Runtime never enables remote semantic indexing implicitly.
- Verification method:
  - Tool-profile, renderer, lifecycle/reload, prompt, SDK contract, and control-sequence tests.
- Validation evidence: The v2 prompt now distinguishes literal/regex/JS/TS templates, opt-in semantic candidates, grouped locator reads, coverage narrowing, safe prepare/commit verification, partial/indeterminate recovery, and nonzero Run recovery. Search call/result renderers expose template/ranking/grouped match-kind and coverage state through control-sequence-safe displays. SDK/runtime wiring keeps exactly four tools, default `legacy`, default operations Edit, implicit local JS/TS index, explicit-only semantic injection, host/factory ownership, reload/close error collection, and no hidden network enablement. SDK and environment docs define provider creation, data egress, variables, cost budget, and language boundaries. Focused integration passed: Agent 6 files / 68 tests; coding-agent 8 files / 61 tests; root `tsgo --noEmit`.
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — Reject unversioned v2 updates

- Status: done
- Owner: coordinator
- Objective: Close the deterministic safety-gate gap found during T-007 design: v2 update operations currently still accept an unbound whole-file unique match, contrary to the final view/hash/range contract.
- Inputs and prerequisites: T-005 Edit implementation and T-006 policy; Chapter 16 Edit requirements and the exact unversioned-write safety target.
- Scope or files: Agent Edit validation and focused tests; coding-agent tool consumers/tests that must provide fresh view/hash/range evidence.
- Expected output: Every v2 update requires a fresh view or expected file hash plus an exact permitted range; unbound unique matches fail before backend mutation.
- Dependencies: T-006.
- Execution steps:
  1. Add a red zero-write regression for a unique but unversioned update.
  2. Enforce view/hash plus exact-range binding at the earliest shared update-validation seam.
  3. Update intentional backend/tool tests to obtain fresh evidence without weakening their original oracles.
  4. Rerun Edit/Run/journal/overlay/profile and type checks.
- Acceptance criteria:
  - Unversioned unsafe writes are rejected 100% before mutation.
  - Existing ambiguity, stale, prepare/commit, rollback, partial, and overlay semantics remain intact.
- Verification method:
  - Focused Agent and coding-agent Edit/backend tests with mutation counters and before/after file assertions.
- Validation evidence: Every update dialect now requires a fresh `viewId` or `expectedFileHash` plus an exact permitted range, with range-local uniqueness enforced before backend mutation. Operations, replacement, and patch regressions prove unversioned unique whole-file updates and same-batch create→unbound-update fail with zero writes; intentional ordered, ambiguity, stale-preimage, BOM/CRLF/mode, dialect-equivalence, malformed-patch, and backend tests were migrated to fresh Read evidence. Focused verification passed: Agent Edit/Run 28/28; broader Agent Search/Read/Edit/Run/state 62/62; coding-agent backend/profile/provider suites 59/59; root `npx tsgo --noEmit`; `git diff --check`.
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — Build deterministic full-requirement evidence and metric pipeline

- Status: done
- Owner: coordinator
- Objective: Cover all 16 acceptance scenarios and compute every Chapter 13 metric without provider calls.
- Inputs and prerequisites: T-006 integrated chain.
- Scope or files: `packages/coding-agent/test/tool-profile-eval/` fixtures, graders, trace/metrics, deterministic tests/docs.
- Expected output: Content-safe evidence matrix with declared targets/scope/coverage/range/error and baseline/ablation metrics.
- Dependencies: T-006, T-012.
- Execution steps:
  1. Create fixed fixtures spanning all source scenario classes and JS/TS structured/semantic cases.
  2. Execute actual tool definitions and fault injection for stale, ambiguity, truncation, ignore, partial scan, transaction, and syntax failure.
  3. Compute search/context/call/safety metrics, p50/p95, baselines, and ablations with non-vacuous activation gates.
  4. Prove sanitizer and no-content persistence contracts.
- Acceptance criteria:
  - All safety targets pass exactly and no metric passes vacuously.
  - Every numerator/denominator and baseline is reproducible from sanitized traces.
- Verification method:
  - Targeted Vitest files using faux/local endpoints only.
- Validation evidence: Added `full-requirement-evidence.ts` and its test, which declare and execute scenarios 1–16 exactly once against generated temporary fixtures and actual legacy/v2 definitions. Non-vacuous gates require all tool phases, retrieval baselines/ablations, safety denominators, partial coverage, overflow, semantic/template/path-prior activation, and content-free numeric summaries. Latest evidence passed 16/16 scenarios with ambiguity 1/1, stale 3/3, truncation 3/3, wrong-location protection 3/3, replace-all prevention 1/1, unversioned-write prevention 3/3, and syntax-failure disclosure 1/1; preferred-path rank improved 3→1 at $0 deterministic cost. The matrix found and drove the T-012 closure plus a real FFF long-line locator defect: missing native coordinates now fall back to `LocalSearchProviderV2` on the first page and fail closed on continuation, with regression evidence for column 16001, byte offset 16000, and range `[16000,16016]`. Trace regressions now classify current recovery codes and `details.coverage.truncated` without retaining sensitive fields. Package-root evaluation/FFF suites passed 18/18; broader Agent tool/state suites passed 62/62; coding-agent backend/profile/structured/semantic suites passed 59/59; root `npx tsgo --noEmit`; `git diff --check`.
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — Run bounded real-model calibration

- Status: done
- Owner: coordinator
- Objective: Use at most six authorized real sessions on complex synthetic tasks to expose tool/model integration failures before held-out evaluation.
- Inputs and prerequisites: T-007 passing; required chat and embedding credentials/config; cost price; explicit eval flags.
- Scope or files: Temporary fixtures and sanitized calibration output only; authority/evidence updates.
- Expected output: Repeatable failure records or a clean calibration, with observed turns/cost and remaining budget.
- Dependencies: T-007.
- Execution steps:
  1. Preflight model/embedding availability and breakers without printing secrets or sending easy-pi content.
  2. Run fixed candidate calibration scenarios with 18-turn/session, timeout, call/token/byte, $5, and systemic-failure breakers.
  3. Exclude all calibration records from final aggregate and preserve only sanitized diagnostics needed for causal debugging.
- Acceptance criteria:
  - At most six sessions are consumed and exact usage is recorded.
  - Any failure has an objective oracle and a replayable synthetic fixture.
- Verification method:
  - Gated targeted real-eval test and post-run sanitized counter review.
- Validation evidence: The replacement gated evaluator, pure budget/sanitization runner, and generated-fixture matrix passed their 6/6 credential-free contract tests before execution. The exact real calibration then completed 6/6 sessions and every hidden oracle at score 1 across two recovery tasks × legacy/text-v2/structured-semantic-v2. Usage was 6 sessions, $0.03481999 combined, 4 Google embedding requests / 277 embedding tokens, and a maximum observed 16/18 turns; all wrong-location and external-change preservation rates were 100%, with no systemic provider/infrastructure failure. Calibration remains excluded from held-out aggregates. Sanitized traces exposed actionable nonfatal integration failures for T-009: structured/semantic-v2 had 8 tool errors including 6 schema errors across two sessions; text-v2 had 16 tool errors including 6 schema errors and repeated unavailable-capability attempts; legacy had 2 recoverable edit errors and no schema errors.
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — Debug calibration failures and prove fixes

- Status: done
- Owner: coordinator
- Objective: For each calibration failure, prove the root cause, encode a failing regression, apply the smallest fix, and rerun deterministic neighbors before final real evaluation.
- Inputs and prerequisites: T-008 evidence.
- Scope or files: Only modules causally implicated by captured failures plus regression tests/docs.
- Expected output: Verified fixes or a bounded blocked diagnosis; no symptom patches or unrelated refactors.
- Dependencies: T-008.
- Execution steps:
  1. Reproduce with the saved synthetic fixture and define expected/observed delta.
  2. Trace the first divergence and run falsifiable experiments against leading alternatives.
  3. Add red regression, implement minimal fix, rerun original and neighboring oracles.
  4. If calibration is clean, record that no product fix was required and still run the deterministic gate.
- Acceptance criteria:
  - Every observed failure is fixed with causal evidence or blocks T-010 with an exact condition.
- Verification method:
  - Before/after regression, focused neighbors, and T-007 deterministic aggregate.
- Validation evidence: Calibration arguments were intentionally not persisted, so the exact three historical Search `INVALID_INPUT` combinations cannot be reconstructed and no stronger causal claim is made. The retained failure sequence did prove two earlier divergences: Read advertised both `path` and `locatorId` in each union branch although runtime required exactly one, and text-only sessions advertised unavailable structured/semantic modes. Red deterministic regressions now prove Read's two model-visible branches are exclusive and custom text-only sessions advertise only text/path Search plus path/locator Read. Search's model-visible schema and capability-aware prompt now state the runtime's selector, `kind`, `context`, `targetKind`, and `ranking` constraints; actual faux structured and semantic executions prove one selector produces `kind=text`, `context=0`, exact-or-omitted `targetKind`, and task ranking. Stale locator/view/patch errors remain intentional CAS recovery, not correctness failures, and the 16-scenario matrix re-proved exact stale rejection and recovery. Verification passed: Agent Search/Read focused 32/32 and broader Search/Read/Edit/Run/state 64/64; coding-agent profile/trace focused 24/24 and deterministic/provider/backend neighbors 75/75; root `npx tsgo --noEmit`; targeted Biome; `git diff --check`. No extra real calibration session was run.
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — Run held-out comparative real evaluation and close metrics

- Status: done
- Owner: coordinator
- Objective: Run up to 42 remaining held-out sessions across legacy, text-v2, and structured/semantic-v2 and publish only sanitized aggregate metrics.
- Inputs and prerequisites: T-009 complete; unspent session/cost budget; frozen unseen fixtures/seeds.
- Scope or files: Gated evaluator, temporary synthetic fixtures, sanitized `README.md`/`RESULTS.md` aggregate updates.
- Expected output: Comparative completion, retrieval, context, safety, calls, tokens, latency, p50/p95, recovery, and cost evidence with limitations.
- Dependencies: T-009.
- Execution steps:
  1. Freeze seven complex task families × two seeds × three variants, randomized within seed, without inspecting model outputs for grading.
  2. Run with remaining global session/turn/cost breakers and immediate systemic-failure stop.
  3. Grade hidden filesystem/test oracles and compute sanitized metrics/intervals/ablations.
  4. Map results to every requirement and report failures honestly; do not rerun held-out records to improve scores.
- Acceptance criteria:
  - Total calibration + held-out usage stays within 48 sessions and $5.
  - Required safety rates meet exact targets; other metrics are compared truthfully without unsupported universal claims.
- Verification method:
  - Targeted gated real-eval test, aggregate consistency tests, and manual sanitized artifact review.
- Validation evidence: The held-out stage was invoked exactly once with the frozen matrix and prior usage. Four records completed at score 1 with 100% wrong-location and external-change preservation; then the fifth attempt, legacy on the second seed of the first family, stopped the sequential run with `model_turn_budget_exceeded`. The remaining 37 cases were never started and no held-out case was rerun. Partial completed records were: legacy 1/1 success, mean 8 turns / 9 calls / 0 errors; text-v2 1/1, 8 turns / 12 calls / 2 capability errors / 0 schema errors; structured/semantic-v2 2/2, mean 7.5 turns / 7 calls / 0 errors, 4 guarded embedding requests / 554 synthetic-fixture tokens. Known held-out completed cost was $0.01524374 and known combined cost was $0.05006373; the aborted legacy call's finalized usage was unavailable, but the observed combined cost breaker did not fire and remained below $5. Total usage was 6 calibration completions plus 5 held-out attempts = 11/48 authorized session starts. The run also proved the turn guard was reactive: it observed turn 19 before aborting. A deterministic red/green regression now wires `Agent.shouldStopAfterTurn` to stop after turn 18 only when tool results would otherwise cause another provider call, while allowing a final answer on turn 18; the real stage was not rerun after this fix. `RESULTS.md` contains only the sanitized partial aggregate and limitations, and the local held-out opt-in is disabled.
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — Final validation, protected-file review, and delivery

- Status: done
- Owner: coordinator
- Objective: Validate dependency paths, finalize traceability and limitations, and commit only task-owned files.
- Inputs and prerequisites: T-010 final evidence.
- Scope or files: Task-owned implementation/tests/docs/authority document; explicit commit.
- Expected output: Valid task document, passed or truthfully partial final result, and repository commit.
- Dependencies: T-010.
- Execution steps:
  1. Run modified focused suites, cross-stage integration, root `npm run check`, `git diff --check`, task validator, and default/schema scans.
  2. Inspect all diffs and confirm both `docs/harness_tools/` files remain unstaged/uncommitted.
  3. Stage explicit task-owned paths, inspect staged diff, commit, and verify final status/hash.
- Acceptance criteria:
  - Every completed claim has current command/artifact evidence and remaining limits are explicit.
  - No credential, source fixture content, protected document, or unrelated work is committed.
- Verification method:
  - Exact command results, diff/status review, task validator, and commit inspection.
- Validation evidence: Root `npm run check` passed with no fixes on its final run, including Biome, pinned-dependency/import checks, shrinkwrap/install-lock verification, `tsgo --noEmit`, and browser smoke. Post-check focused suites passed Agent 5 files / 64 tests and coding-agent 13 files / 95 tests, including the 16-scenario matrix, evaluator contracts, providers, profile, backends, host adapters, and compaction integration. Default/schema scans confirmed default `legacy`, exactly four v2 tools, default operations Edit, and exclusive Read branches. `git diff --check`, task validation, explicit 50-path staging, staged secret scan, and protected-path review passed; the two user-owned harness documents and ignored local environment were not staged. Delivery commit `589b718f0` (`feat(agent): complete structured v2 toolchain`) contains the task-owned implementation/tests/docs and no protected path. Final result remains partial solely because the one-shot held-out run stopped after four completed records and one aborted attempt.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

Use red/green focused Vitest at the package seams changed, local fake embedding HTTP integration, structured-provider and lifecycle tests, Search/Read/Edit/Run/journal/overlay/compaction/profile neighbors, deterministic 16-scenario evidence, then explicitly gated real calibration and held-out files only. Real tests require both their dedicated opt-in flags and all configured breakers. After code changes run root `npm run check` with full output and immediately audit auto-fixes, then `git diff --check`, task validation, default/schema scans, explicit staging, and protected-file review. Do not run full `npm test` or build.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

Remote embeddings can exfiltrate code, leak credentials, cost money, or produce nondeterministic dimensions/usage; mitigate with explicit config, synthetic-only evaluation, filter-before-send, redaction, endpoint validation, byte/token/call/cost breakers, and no persisted content. TypeScript LanguageService can consume unbounded memory or follow files outside scope; enforce roots, include/exclude, file/byte/project quotas, cancellation, generation invalidation, and lifecycle close. Ranking can create false completeness; preserve provider coverage separately from rank. Structured labels can be wrong around aliases/overloads/dynamic calls; classify only from AST evidence and disclose partial cases. Context compaction changes can perturb provider message order; reuse existing seams and run provider-context neighbors. Real-model behavior is stochastic; calibrate, freeze held-out inputs, use hidden deterministic grading, and never rerun failures into success. Journal/overlay cannot provide cross-file atomic visibility; document rollback/partial/indeterminate states precisely. Shared-worktree formatting can touch unrelated files; inspect status before and after root check and stage explicit paths only.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-29: User requested full real-model tools validation/debug and selected P0/P1/P2 full implementation, JS/TS structured support, remote OpenAI-compatible embeddings, synthetic-only remote data, and an additional 48-session/$5 budget.
- 2026-08-29: Shared requirements contract confirmed. Task document created; T-001 started with repository/requirements audit.
- 2026-08-29: Five delegated read-only audits were attempted in run `9f4f2aa2-b2e3-4e83-bbd9-506cbc86fe7d`; every snapshot omitted the requested repository paths, so all reports were rejected and no delegated evidence was used.
- 2026-08-29: T-001 completed by coordinator inspection. Structured Search/Read provider seams, TypeScript runtime dependency, semantic opt-in boundaries, existing compaction/ledger behavior, Edit/Run evidence, and the real-eval redesign were frozen; T-002 started.
- 2026-08-29: T-002 completed with production JS/TS AST/checker search and symbol/node Read, bounded lifecycle/invalidation, default v2 runtime wiring, exact TypeScript runtime dependency, 30 Agent + 36 coding-agent focused tests, and passing `tsgo --noEmit`; T-003 started.
- 2026-08-29: T-003 completed with explicit semantic routing/configuration, bounded OpenAI-compatible embeddings, deterministic task/path ranking and templates, source-bound cursors/cache, sanitized failures, SDK documentation/exports, 14 Agent Search tests, 32 coding-agent semantic/index/profile tests, and passing `tsgo --noEmit`; no remote call was made. T-004 started.
- 2026-08-29: Started parallel read-only T-004 state/compaction and T-005 Edit/Run gap audits; authority-document writes remain coordinator-owned.
- 2026-08-29: Rejected delegated run `e380e212-7040-402b-8b4f-477ba371e160`: both tasks again received snapshots without any requested path and had no shell access. T-004/T-005 returned to coordinator ownership; no implementation claim uses those reports.
- 2026-08-29: T-004 completed with grouped locator output/TUI, deduplicated and commit-invalidated ledger state, and bounded handle-only compaction evidence. T-005 completed from focused safety/backend evidence plus deterministic syntax-failure recovery. T-006 started.
- 2026-08-29: T-006 completed with capability-aware policy, compact grouped/safe TUI rendering, explicit semantic SDK lifecycle, and egress/config documentation; 68 Agent and 61 coding-agent focused tests plus `tsgo --noEmit` passed. T-007 started.
- 2026-08-29: T-007 safety-matrix design found that unique whole-file updates could still succeed without a view/hash/range. Added T-012 as a blocking corrective task before deterministic aggregate closure.
- 2026-08-29: T-012 completed. All three v2 update dialects now require fresh view/hash and exact-range evidence before mutation; focused Agent and coding-agent Edit/backend/profile suites plus type and diff checks passed.
- 2026-08-29: T-007 completed with the non-vacuous 16-scenario deterministic matrix and metrics pipeline. It also exposed and closed FFF long-line coordinate loss and corrected current trace recovery/truncation classification; evaluation/FFF 18/18, broader Agent 62/62, and coding-agent 59/59 checks passed. T-008 preflight started with zero real-model sessions and zero remote embedding calls consumed.
- 2026-08-29: Replaced the historical real evaluators for the current run with a frozen 6+42-session calibration/held-out matrix, content-free aggregate runner, generated hidden-oracle fixtures, combined chat/embedding breakers, immediate systemic stop, and pre-fetch synthetic-only embedding guard. Credential-free evaluator tests passed 6/6; type, targeted Biome, and diff checks passed.
- 2026-08-29: T-008 blocked during value-free preflight: the required chat model and configured credentials are available, but all four embedding connection/model/key/price variables are absent. Dedicated opt-in flags were not enabled; zero real-model sessions, remote embedding requests, or paid/network calls were consumed.
- 2026-08-29: User filled the ignored local Google API `.env` template and requested continuation. T-008 resumed; evaluator preflight remains fail-closed and no credential value will be printed or persisted.
- 2026-08-29: The Pi credential circuit breaker rejected the targeted `--env-file` calibration invocation before process execution. No session or network call occurred. T-008 is blocked until Pi inherits the variables from its parent environment or the user runs the exact targeted evaluator outside the harness.
- 2026-08-29: Corrected the WJ Harness overbroad env-file refusal in the sibling Harness repository with an exact red/green permission regression (17/17 green) while retaining direct-disclosure denials. User requested continuation after the extension reload/restart boundary; T-008 resumed.
- 2026-08-29: T-008 real calibration completed 6/6 sessions and all hidden safety/correctness oracles. Total cost was $0.03481999; structured/semantic-v2 made 4 guarded Google embedding requests for 277 tokens; maximum turns were 16/18. Sanitized traces showed no systemic failure but exposed repeated unavailable-capability and schema/tool recovery errors. T-009 started without rerunning calibration.
- 2026-08-29: T-009 completed deterministically. Read schema branches are exclusive, prompts are provider-capability-aware, and Search schema/prompt constraints plus valid faux structured/semantic requests are covered. The exact historical Search invalid arguments were not persisted, so their individual conflict class remains intentionally unclaimed. Agent 64/64 and coding-agent 75/75 neighboring tests, `tsgo`, targeted Biome, and diff checks passed. T-010 started; calibration remains capped at 6 sessions.
- 2026-08-29: T-010 invoked held-out exactly once. Four sessions completed at score 1 before the fifth attempt stopped on the assistant-turn breaker; 37 sessions were never started and none were rerun. The run exposed one-turn-late breaker enforcement, which received a deterministic red/green pre-provider-stop regression without another real call. Sanitized partial metrics were recorded, the held-out flag was disabled, and T-011 started with an obligatorily partial final outcome.
- 2026-08-29: T-011 completed. Final root checks, 64 Agent tests, 95 coding-agent tests, default/schema scans, diff/task validation, staged secret/protected-path review, and explicit staging passed. Commit `589b718f0` delivered 50 task-owned implementation/test/doc paths; the final task status is partial because held-out coverage stopped at 4 completed plus 1 aborted attempt.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: All implementation and deterministic tasks are done. Calibration completed 6/6; the one-shot held-out run completed 4/4 graded records at score 1 with full wrong-location/external-change protection before its fifth attempt stopped on the turn breaker. The one-turn-late breaker defect has a deterministic fix and was not rerun against the paid stage. Root checks, 64 Agent tests, 95 coding-agent tests, task/diff/default/schema scans, staged secret/protected-path review, and delivery commit `589b718f0` passed.
- Limitations: Thirty-seven held-out cases did not start, so no seven-family or 14-runs-per-variant comparison is claimed. The aborted legacy attempt has no grade or finalized cost record, and three historical calibration Search invalid-input arguments were intentionally not persisted. Usage is 11/48 session starts; known cost is $0.05006373 and exact total remained below the observed $5 breaker but is unavailable.
