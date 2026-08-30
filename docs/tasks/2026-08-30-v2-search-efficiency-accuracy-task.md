# Task Plan: Optimize v2 Search Efficiency and Accuracy

- Created: 2026-08-30
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User-authorized implementation of the concrete optimization findings from the post-toolchain review

<!-- task-doc-section:background-goal -->
## Background and goal

Reduce avoidable Search/Read retries, model-visible illegal states, repeated JS/TS indexing work, semantic-candidate recall loss, embedding round trips, and real-evaluator accounting gaps without weakening locator/view/edit safety or privacy boundaries. Correct the text-v2 evaluation baseline so it actually provides text search, make structured `implementation` labels relationship-backed where they claim IDE-style semantics, and establish deterministic before/after evidence rather than extrapolating from the incomplete paid held-out run.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope: provider-capability-derived v2 Search guidance/schema; mutually exclusive Read schemas; a text-v2 baseline that keeps FFF/local literal and regex search while disabling structured/semantic providers; JS/TS structured query reuse and implementation-relation accuracy; bounded semantic candidate diversification and query/document embedding batching; sanitized accounting for aborted evaluator attempts and pre-provider turn stopping; focused deterministic measurements, docs, validation, and commit.

Non-goals: rerunning calibration or held-out paid sessions; claiming universal latency or recall improvements; introducing an external vector database or new dependency; weakening exact coverage/partial disclosures, source-hash/view/edit CAS, synthetic-only real-eval egress, provider budgets, or the four-tool/default-profile contracts; modifying or committing either user-owned file under `docs/harness_tools/`.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The current real evaluator's `text_v2` injects a custom `NodeExecutionEnv`, which selects `ExecutionEnvSearchProvider`; that provider advertises and enforces no literal/regex text support, while the prompt says literal/regex are available. | `full-real-eval.real.test.ts:307-312`; `tool-profile.ts:994-1006`; `execution-env-search-provider.ts:77-99`; `RESULTS.md:81-87`. |
| F-002 | Search exposes one static superset schema for every provider combination, and Read shares symbol/range fields across both path and locator branches even though runtime rejects several combinations. | `search-v2.ts:72-154,513-529`; `tool-profile.ts:825-837`; `read-v2.ts:42-78,355-391`. |
| F-003 | JS/TS `implementation` currently means a same-name declaration with a body, not a checker-proven implementation relationship. | `typescript-code-index-provider.ts:451-480`; existing tests cover overload bodies but not unrelated same-name methods. |
| F-004 | Every structured query rescans and rereads scoped source before cache lookup, then traverses every AST again; the cached `Program` alone does not remove those repeated costs. | `typescript-code-index-provider.ts:434-565,725-821`. |
| F-005 | Semantic retrieval truncates by lexical/path score before embeddings and embeds the query in a separate request from documents. | `openai-compatible-embedding-search-provider.ts:241-307`; partial held-out used two embedding requests per structured session. |
| F-006 | A systemic evaluator stop throws before recording session stats, making the aborted held-out attempt's exact cost and trace unavailable. | `full-real-eval.real.test.ts:330-376`; `RESULTS.md:87-91`. |
| F-007 | Default profile must remain `legacy`, model-visible v2 tools exactly `search/read/edit/run`, Edit default `operations`, remote semantic search explicit-only, and no paid evaluator rerun is authorized. | Completed full-toolchain task contract and current source/tests. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “Execute optimization” authorizes all concrete review findings, but the least-complex bounded intervention is preferred over a new ANN/vector subsystem.
- Assumption: performance claims require deterministic work counters or comparable local fixtures; wall-clock-only deltas remain descriptive.
- Assumption: provider capability narrowing may remove unsupported schema enum values but must retain runtime defensive validation for direct callers.
- Open question: None. The requested findings, safety boundaries, and no-paid-rerun constraint are sufficiently specific.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Text-v2 uses real literal/regex/path Search while structured and semantic modes remain disabled; prompt and model-visible schema exactly reflect provider capabilities, and deterministic faux execution produces no capability retry.
- Search schema omits unavailable kinds/modes/templates/ranking options; Read schema has mutually exclusive locator, path/range, symbol-body, and AST-node branches that cannot express runtime-forbidden cross-mode fields.
- JS/TS `implementation` results are backed by an overload/interface/abstract implementation relationship or are not labeled `implementation`; unrelated same-name concrete methods are excluded.
- Repeated unchanged structured queries reuse snapshot-derived candidate data and avoid repeated full AST traversal; any filesystem reuse preserves invalidation and stale-snapshot safety. Deterministic counters prove the intended work reduction.
- Semantic preselection preserves lexical leaders while adding deterministic corpus diversity when bounded, reports partial coverage truthfully, and has a regression where a zero-overlap target beyond the lexical prefix remains eligible. Query plus first missing-document batch uses one embedding request when byte/batch budgets permit.
- Aborted evaluator attempts produce a content-free sanitized usage/trace record before the sequential stop, count against session/cost usage, and the 18-turn gate prevents a nineteenth provider request in a faux integration test.
- Existing 16-scenario safety evidence, provider privacy/budget tests, Search/Read/profile/backend neighbors, root `npm run check`, task validation, `git diff --check`, protected-file review, explicit staging, and commit pass. No paid model or embedding call is made.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> {T-002, T-003, T-005}`; `T-003 -> T-004`; `{T-002, T-004, T-005} -> T-007 -> T-006`.
- Parallel batches: T-002, T-003, and T-005 are logically parallel after baseline freeze, but T-002/T-003 share tool-profile/provider contracts and T-005 shares evaluator contracts used for final metrics. Coordinator integrates them serially to preserve the shared worktree and one authority document; T-007 is the bounded closure for concrete integration/adversarial findings discovered before final validation.
- Serialization constraints: Search/Read schemas, `tool-profile.ts`, TypeScript provider snapshots, evaluator summaries, root formatting, staging, and this authority document are coordinator-owned. The two untracked harness design documents are read-only and excluded from every Git operation.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Freeze reproducible bad baselines and bounded designs

- Status: done
- Owner: coordinator
- Objective: Turn each review finding into a failing deterministic oracle or a bounded measurement before product edits.
- Inputs and prerequisites: Current committed implementation, review evidence, existing focused tests and synthetic fixtures.
- Scope or files: Read-only source/test analysis plus targeted red tests and this task document.
- Expected output: Red oracles for text-v2 capability mismatch, illegal schemas, implementation false positives, repeated structured work, semantic cutoff/request count, and aborted evaluator accounting.
- Dependencies: None.
- Execution steps:
  1. Trace each provider/schema/evaluator path and reject alternative explanations.
  2. Add the smallest stable red regression at each owning seam.
  3. Record baseline counts without real provider calls.
- Acceptance criteria:
  - Each planned intervention has an observable fail/pass condition.
  - No performance bottleneck is claimed from source shape alone; deterministic work counts identify repeated work.
- Verification method:
  - Focused Vitest files with faux/local providers and generated temporary fixtures only.
- Validation evidence: Focused red regressions reproduced every owning seam without provider calls: Agent Read exposed 2 branches instead of 4 legal branches (15 passing / 1 failing); coding-agent profile showed a generic execution environment advertised unavailable literal/regex and explicit `codeIndexProvider:false` still looked structured (17 passing / 2 failing); TypeScript provider returned no qualified interface implementation and had no reusable-catalog diagnostic (8 passing / 2 failing); embedding provider used 2 requests where one batch fit and dropped the zero-overlap tail target (8 passing / 2 failing); evaluator runner propagated a systemic error without an aborted summary (7 passing / 1 failing). Source tracing confirmed repeated full AST traversal; deterministic catalog-build counts are the bounded performance oracle. No real or paid call occurred.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Make v2 schemas and text baseline capability-accurate

- Status: done
- Owner: coordinator
- Objective: Remove unsupported and contradictory model-visible Search/Read states and restore a true text-v2 baseline.
- Inputs and prerequisites: T-001 red schema/capability oracles.
- Scope or files: Agent Search/Read schema factories; coding-agent tool-profile/runtime/SDK/evaluator wiring and focused tests.
- Expected output: Capability-derived Search schema/prompt, four exclusive Read branches, and explicit local text-only runtime selection.
- Dependencies: T-001.
- Execution steps:
  1. Decouple default local text provider selection from default code-index enablement.
  2. Derive Search enums/options and guidance from actual provider capabilities.
  3. Replace shared Read superset branches with legal discriminated branches while retaining runtime guards.
  4. Update evaluator text-v2 wiring and deterministic tests without running it remotely.
- Acceptance criteria:
  - Literal/regex text-v2 execution succeeds locally; structured/semantic schema values are absent.
  - No Read schema branch exposes fields that its runtime mode forbids.
- Verification method:
  - Agent Search/Read schema tests; coding-agent profile/evaluator contract tests.
- Validation evidence: Agent Search/Read focused suites passed 32/32; coding-agent v2 profile suite passed 19/19, including path-only generic environments and literal/regex local text Search with `codeIndexProvider:false`; targeted Biome and `git diff --check` passed for all T-002 paths. Root `npx tsgo --noEmit` reached only the two deliberately red, pending T-005 evaluator-test API errors and reported no T-002 error; the root type gate remains reserved for T-006 after downstream implementation.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Correct and reuse JS/TS structured index work

- Status: done
- Owner: coordinator
- Objective: Prevent false implementation labels and avoid repeated AST candidate reconstruction for unchanged snapshots.
- Inputs and prerequisites: T-001 implementation and work-count baselines.
- Scope or files: `typescript-code-index-provider.ts` and focused provider tests.
- Expected output: Relationship-backed implementation results plus snapshot-bound reusable candidate catalogs and deterministic work diagnostics.
- Dependencies: T-001.
- Execution steps:
  1. Separate snapshot construction from query filtering and cache source-derived candidate metadata.
  2. Resolve implementation relationships through TypeScript checker/program evidence.
  3. Preserve content-generation invalidation, quotas, cancellation, cursors, node handles, and coverage.
- Acceptance criteria:
  - Unrelated same-name methods are not implementations; overload and interface implementations remain discoverable.
  - A second unchanged query reuses candidate extraction, while a source change invalidates it.
- Verification method:
  - Focused provider correctness and deterministic extraction-count tests.
- Validation evidence: `typescript-code-index-provider.test.ts` passed 11/11 after adding interface, abstract, overload, reuse, and source-invalidation oracles. Repeated unchanged definition/call queries report one candidate-catalog build; a content change reports two. The source-generation cache comparison now uses the same `ts-`-prefixed generation on both sides, allowing the cached Program/catalog to be reused. Per-mode catalogs are bounded at 100,000 candidates with partial-coverage disclosure. Targeted Biome and `git diff --check` passed. The neighboring embedding suite reached only its two intentionally red T-004 batching/diversity assertions (8/10 passed).
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Improve bounded semantic recall and network batching

- Status: done
- Owner: coordinator
- Objective: Reduce lexical-prefix blind spots and remove one avoidable embedding round trip without increasing privacy or cost ceilings.
- Inputs and prerequisites: T-003 stable semantic document snapshots and T-001 semantic baselines.
- Scope or files: OpenAI-compatible embedding provider and local fake-endpoint tests.
- Expected output: Deterministically diversified bounded candidates, truthful partial reporting, combined query/document batches, and unchanged cache/budget/cancellation behavior.
- Dependencies: T-003.
- Execution steps:
  1. Preserve high lexical/path-prior candidates and fill a bounded reserve from the full deterministic corpus.
  2. Batch the query with the first missing document group and map vectors safely.
  3. Revalidate byte/request/token/cost breakers and dimensions.
- Acceptance criteria:
  - A zero-overlap target beyond the lexical prefix can enter the bounded semantic set.
  - One query plus documents fitting one batch performs one fetch, not two.
- Verification method:
  - Fake embedding endpoint request/body/count assertions and semantic ranking fixtures.
- Validation evidence: The fake-endpoint embedding suite passed 10/10 and the combined TypeScript-index/embedding pair passed 21/21. With `maxDocuments:4`, the bounded selector retains three lexical leaders plus a deterministic full-corpus reserve and makes the zero-overlap tail target eligible while reporting `provider_limit`. With `batchSize:3`, one query plus two missing documents now produces one fetch/request. Request-count, byte, cost, cancellation, cache, malformed-vector, and cross-batch dimension gates remain covered. Targeted Biome and `git diff --check` passed; no external endpoint was contacted.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Preserve aborted evaluator accounting and hard turn boundaries

- Status: done
- Owner: coordinator
- Objective: Make every attempted session auditable and prove the turn cap before another provider request.
- Inputs and prerequisites: T-001 evaluator red oracles; no real-run authorization.
- Scope or files: Full real-eval pure runner/gated adapter and credential-free tests.
- Expected output: Sanitized completed/aborted records, exact attempted usage propagation, and faux Agent turn-boundary integration.
- Dependencies: T-001.
- Execution steps:
  1. Capture stats/trace/embedding usage before propagating systemic stop.
  2. Represent aborted outcome without content-bearing fields and count it against global usage.
  3. Drive a faux tool loop to prove no provider call beyond turn 18.
- Acceptance criteria:
  - An aborted attempt has content-free usage and stop category; sequential execution stops immediately afterward.
  - Tests count exactly 18 provider turns in the forced-continuation case.
- Verification method:
  - Credential-free evaluator and faux Agent tests only.
- Validation evidence: Credential-free evaluator contracts passed 9/9. A `SystemicEvaluationError` carrying finalized output now yields one `status:"aborted"` record, stop category, exact chat/embedding usage and cost, and an immediate sequential stop; systemic errors without finalized output still propagate. The real executor now snapshots session stats, sanitized trace, embedding usage, grade/oracles, and hashes before rethrowing the categorized stop. A registered faux provider with 19 scripted tool-use responses drove the real `Agent` loop; exactly 18 provider calls and tool executions occurred, leaving the nineteenth response unconsumed. Targeted Biome, `git diff --check`, and root `npx tsgo --noEmit` passed without real provider calls.
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Integrate, measure, document, validate, and commit

- Status: done
- Owner: coordinator
- Objective: Prove the combined optimization preserves all safety/privacy/default contracts and deliver only task-owned changes.
- Inputs and prerequisites: T-002, T-004, and T-005 complete.
- Scope or files: Focused integration tests, deterministic metrics/docs, task document, explicit Git commit.
- Expected output: Evidence-backed optimization summary with limitations and clean committed implementation.
- Dependencies: T-007.
- Execution steps:
  1. Run focused neighboring suites and the deterministic 16-scenario aggregate.
  2. Run root `npm run check`, audit auto-fixes, rerun focused tests, and validate diffs/task document.
  3. Review protected/unrelated paths, stage explicit files, inspect staged diff, and commit.
- Acceptance criteria:
  - All deterministic correctness, safety, privacy, and work-count gates pass.
  - No real provider call, protected file, credential, or unrelated shared-worktree change is included.
- Verification method:
  - Exact command results, metrics assertions, staged audit, commit inspection.
- Validation evidence: Final root `npm run check` passed with no rewrites, including Biome, pinned dependencies/imports, shrinkwrap/install-lock checks, `tsgo --noEmit`, and browser smoke. Post-check Agent Search/Read/Edit/Run/state suites passed 5 files / 64 tests. Post-check coding-agent evaluator/evidence/profile/provider/host/backend/compaction suites passed 17 files / 141 tests, including the deterministic 16-scenario matrix, 18-turn faux boundary, relationship/candidate-catalog work counters, diversified semantic tail, single-batch query/documents, request-bound cursors, and safety backends. Default/schema scans confirmed default `legacy`, exactly `search/read/edit/run`, and Edit default `operations`; `git diff --check`, task validation, explicit 14-path staging, staged credential scan, and protected-path review passed. No real model or embedding endpoint was called. Implementation commit `8dbe87fed` (`feat(agent): optimize v2 search pipeline`) contains only the 14 task-owned source/test paths.
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — Close integration and adversarial-review findings

- Status: done
- Owner: coordinator
- Objective: Close only the concrete correctness and safety gaps exposed by the broader host test and independent pre-commit review.
- Inputs and prerequisites: T-002 through T-005 outputs; failed `v2-host-adapters` assertion; reviewer run `74d43765-d01c-4697-bcb0-d125ef5c5663`.
- Scope or files: Capability-ranking schema merge/tests; evaluator content-free guard/tests; TypeScript node-handle materialization, snapshot coverage identity, and cursor binding; semantic cursor binding and cached-input byte accounting; focused provider tests.
- Expected output: No provider-incompatible explicit ranking values, no unknown summary fields, immediately resolvable paged node handles, request-bound provider cursors, accurate cached-input/coverage accounting, and current capability-aware host assertions.
- Dependencies: T-002, T-004, T-005.
- Execution steps:
  1. Reproduce or statically prove each reviewer finding and reject pre-existing or outer-layer-mitigated claims that do not require a task change.
  2. Add the smallest deterministic regressions for accepted findings.
  3. Implement bounded fixes without weakening output, cost, cursor, privacy, or snapshot gates.
- Acceptance criteria:
  - Model-visible explicit ranking values cannot combine capabilities that belong to different routed providers.
  - Unknown summary keys are rejected even when their values are short strings.
  - Every returned structured node ID is registered when its page is emitted; direct provider cursors reject changed request identity.
  - Cached documents do not count as new embedding input bytes, while the aggregate uncached-operation and per-request byte caps remain enforced.
  - Byte-limit versus file-limit coverage remains accurate after snapshot reuse.
- Verification method:
  - Focused schema/host/evaluator/TypeScript/embedding tests, targeted type/format/diff checks.
- Validation evidence: Accepted findings were reproduced and closed with focused regressions. Mixed base/structured sessions expose only ranking values supported by every routed provider while retaining structured `preferredPaths`; profile/host/evaluator tests passed 32/32. The summary guard now rejects every unknown key, including short-string fields. TypeScript provider tests passed 14/14, including a 1,100-match first-page node-handle resolution, direct request-bound cursor rejection, accurate byte-only disclosure, and changed skipped-metadata invalidation. Embedding tests passed 12/12, including request-bound cursors and cached-document exclusion from new aggregate input bytes while both aggregate uncached-operation and per-request caps remain. Root `npx tsgo --noEmit`, targeted Biome, and focused `git diff --check` passed. Case-insensitive comment/string offsets and replacing the aggregate byte ceiling with per-batch-only accounting were rejected as pre-existing/out-of-contract or gate-weakening changes; outer Search already binds public cursors, but direct provider binding was still added as defense in depth.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

Use red/green focused Vitest at Agent Search/Read, coding-agent profile/TypeScript/embedding/evaluator seams, deterministic work counters instead of timing gates, then the 16-scenario full-requirement matrix and neighboring backend/compaction tests. No real evaluator flag or credential-bearing environment file will be used. After code changes, run root `npm run check` with full output, audit formatter changes, rerun focused suites, `git diff --check`, task validation, explicit protected-file/secret review, explicit staging, and commit.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

Capability-specific schemas can accidentally hide a valid fallback; derive them from provider contracts and retain runtime guards. Read unions can break callers that relied on contradictory optional fields; tests must exercise each legal mode. Incremental indexing can return stale source if invalidation is weaker than current content hashing; candidate reuse must remain generation-bound and source changes must rebuild. Relationship-backed implementations can miss dynamic JavaScript or structurally typed cases; disclose exact JS/TS boundary and fail closed rather than mislabel. Semantic diversification trades lexical precision for recall; reserve only a bounded share and measure both. Combined embedding batches complicate vector indexing and reported usage; verify response indexes and dimensions. Evaluator aborted records must remain content-free. Shared worktree commits may advance independently; recheck HEAD/status and stage only this task's explicit paths.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-30: User authorized implementation of the reviewed optimization findings under best-practice constraints. New execute-mode authority document created; T-001 started. Current worktree contains only the two protected untracked harness documents; unrelated commits may advance HEAD concurrently.
- 2026-08-30: T-001 completed with five independent red seams covering capability/schema, implementation/catalog reuse, semantic recall/batching, and aborted evaluator accounting. T-002 started; no network or paid call was made.
- 2026-08-30: T-002 completed: capability-derived Search schema/guidance, four exclusive Read branches, and a true local text-v2 baseline passed 51 focused tests plus targeted formatting/diff checks. T-003 started; the only root typecheck errors belong to the intentionally red pending T-005 test.
- 2026-08-30: T-003 completed: the prefixed-generation cache miss was corrected, snapshot-bound bounded candidate catalogs now serve structured and semantic extraction, and implementation hits require overload, explicit interface, or abstract-member relationships. Eleven provider tests passed; T-004 started with its two red semantic oracles still isolated.
- 2026-08-30: T-004 completed: deterministic leader-plus-corpus-reserve selection recovered the zero-overlap tail fixture, and query plus first missing-document batch now shares one request when the batch permits. All 21 index/embedding tests passed without network egress; T-005 started.
- 2026-08-30: T-005 completed: aborted attempts now retain sanitized finalized accounting, and a faux `Agent` run consumed exactly 18 of 19 scripted tool-use responses. Nine evaluator tests plus root typecheck passed; T-006 integration started.
- 2026-08-30: Initial T-006 integration passed Agent 64/64 and primary coding-agent 50/50, then broader coverage exposed one obsolete identical-schema host assertion; its capability-aware replacement passes 4/4. Root `npm run check` passed with no rewrites. Independent read-only review then identified bounded ranking-composition, summary-guard, node-handle, cursor-binding, cached-byte, and snapshot-disclosure risks. T-006 was blocked and T-007 started to close only verified findings.
- 2026-08-30: T-007 completed with provider-compatible explicit rankings, unknown-field summary rejection, page-time node-handle materialization, direct request-bound structured/semantic cursors, cache-aware aggregate embedding bytes, and accurate/revalidated index-limit disclosure. Focused suites passed 58/58 plus root typecheck and targeted static checks; T-006 resumed.
- 2026-08-30: T-006 completed. Final root check passed without rewrites; post-check focused suites passed Agent 64/64 and coding-agent 141/141, including all 16 deterministic acceptance scenarios. Defaults, diffs, task structure, protected paths, and staged credentials were audited; implementation commit `8dbe87fed` was created with no paid/network evaluation.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 through T-007 are done; task validation, root check, 64 Agent tests, 141 coding-agent tests, the deterministic 16-scenario matrix, protected/staged audits, and implementation commit `8dbe87fed` all passed.
- Limitations: No paid calibration or held-out stage was rerun, so real-model outcome remains the previously documented partial result. Structured snapshot validation still rescans/rereads scoped source to prove generation before reusing the Program/catalog; the deterministic counter proves AST/catalog reuse, not eliminated filesystem I/O. Semantic diversity remains a bounded deterministic approximation, not a universal recall guarantee.
