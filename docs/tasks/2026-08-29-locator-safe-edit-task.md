# Task Plan: Locator Read Safe Edit Toolchain

- Created: 2026-08-29
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: `docs/harness_tools/Agent 代码检索与安全编辑工具改造方案.md`

<!-- task-doc-section:background-goal -->
## Background and goal

Implement the source design's P0 locator-first `search → read → edit → verify` safety chain on the existing opt-in four-tool v2 profile. Search should return bounded locators and truthful coverage rather than full lines; Read should consume locators or explicit ranges, return numbered bounded views with file-version evidence; Edit should bind updates to a view/hash/range, support prepare/dry-run and commit with stale/ambiguity rejection, and return minimal diffs. Preserve the exactly four model-visible v2 tools, the overall `legacy` default, the operations edit default, and existing host/provider abstractions.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope: P0 Search scope/budget/coverage and locator output; bounded session locator/view/patch state; Read line/byte/locator ranges, output budgets, hashes/views and progressive metadata; Edit view/range/hash CAS, unique-match policy, prepare/commit, minimal feedback and deterministic errors; concise Agent prompt rules; acceptance tests for repeated fields, overflow, large files/long lines, ambiguity/staleness and context volume; docs and focused validation.

Non-goals for this run: embedding/semantic retrieval; production LSP/AST language-server integrations where no repository backend exists; pretending unsupported symbol modes are text search; cross-file atomic visibility beyond the existing opt-in journal/overlay guarantees; changing legacy tools/default profile; adding model-visible tools; modifying or committing either user-owned file under `docs/harness_tools/`.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The user design prioritizes locator-only Search, explicit scope/budgets/coverage, bounded Read with hash/snapshot, and view-bound dry-run Edit as P0. | Source design sections 1-17, especially 4-7, 15-16 |
| F-002 | Current v2 Search defaults to context 0 and global limit 20 with opaque generation-bound cursors, but model-visible text still includes full matched lines and lacks include/exclude, per-file/file/output budgets, locator IDs and skipped/truncation relations. | `packages/agent/src/harness/tools/search-v2.ts`; `search-provider.ts` |
| F-003 | Current Read is range/byte bounded and large-directory safe, but lacks locator input, caller byte/token budgets, numbered output, view IDs, file hashes and stale search-to-read checks. | `read-v2.ts`; `read-provider.ts`; `NodeReadProviderV2` |
| F-004 | Current Edit already rejects non-unique whole-file replacements, observes file identity/hash/mtime/mode, rechecks before commit, budgets plans and returns diffs, but has no view/range binding or explicit prepare/patch-ID commit. | `edit-v2.ts`; `mutation-core.ts` |
| F-005 | Existing v2 defaults are `legacy` overall, four tools for v2, and operations edit dialect; FFF is now the default local v2 Search provider with local fallback. | `sdk.ts`; `tool-profile.ts`; commit `ea6c0ac37` |
| F-006 | Symbol/AST/LSP and semantic backends do not exist in the current SearchProvider contract. Unsupported structured intent must therefore fail closed with an explicit fallback action rather than claim implementation. | `search-provider.ts`; provider implementations |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “根据改造方案制定实施计划并执行” authorizes implementation of the staged P0 foundation and repository-supported P1 handles/state in this run; absent external language-index infrastructure is represented as explicit unsupported capability.
- Assumption: Existing v2 compatibility inputs remain accepted where they are already safe, while new view/range fields provide the stronger default workflow promoted in prompts.
- Open question: None blocking. Unsupported symbol/semantic modes are an explicit outcome, not a hidden fallback.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- The model still sees exactly `search`, `read`, `edit`, and `run`; overall default remains `legacy`; operations remains the edit dialect default.
- Search defaults to locator-only, context 0, stable order, max 20 results, max 3 per file, max 20 files and a bounded model-visible byte budget; it accepts root/path plus include/exclude controls, exposes status/coverage/hasMore/truncated/skipped semantics, de-duplicates locators, and never supports absence claims from incomplete results.
- Explicit symbol/assignment/reference/call intents are either verified by an available backend or return a stable unsupported error with an exact fallback action; they never silently become broad text search.
- Read accepts a locator or path/range/byte request, enforces line/byte/token budgets, returns numbered content, a bounded view ID, file version/hash when safely obtainable, snapshot linkage and truncation/continuation metadata; stale locators fail closed.
- Edit update operations can bind to view ID, expected hash and line range; exactly-one-in-range is enforced, stale/preimage/range mismatch is rejected, replace-all is never implicit, prepare returns patch ID/minimal diff without mutation, and commit rechecks the prepared observations.
- Existing direct commit inputs remain safe and tested; multi-file partial failures remain explicit unless an opt-in durable backend supplies rollback.
- Agent prompt guidance enforces narrow Search, progressive Read, prepare/commit Edit and focused verification without adding a fifth tool.
- Acceptance/evidence tests cover the source document's P0 failure classes and measure locator/search/read/edit output volume without paid model calls.
- Targeted tests, root `npm run check`, `git diff --check`, task validation, explicit staging and protected-file review pass.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003 -> T-004 -> T-005 -> T-006 -> T-007 -> T-008`.
- Parallel batches: No writer batch is safe because Search/Read/Edit schemas share the same state contract, exports, profile definitions and tests. Read-only delegation is avoided because this workspace's prior delegated snapshots repeatedly omitted all target paths.
- Serialization constraints: agent-core contract/state first; provider changes before coding-agent integration; prompts/docs/evaluation after schemas stabilize; authority document remains coordinator-owned.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Freeze gap analysis and executable contracts

- Status: done
- Owner: coordinator
- Objective: Map the source design to current capabilities and freeze minimal P0/P1-compatible schemas, state lifetimes, errors and fallback boundaries.
- Inputs and prerequisites: Source design; F-001 through F-006; current source/tests.
- Scope or files: Read-only analysis plus this task document.
- Expected output: Traceable contracts for T-002 through T-007 without speculative backend claims.
- Dependencies: None.
- Execution steps:
  1. Audit Search, Read, Edit, provider, mutation and prompt contracts.
  2. Classify requirements as already satisfied, implementation delta, explicit unsupported, or out of scope.
  3. Freeze IDs, TTL/quotas, schema compatibility, coverage semantics and validation matrix.
- Acceptance criteria:
  - Every P0 item has an implementation task or current evidence.
  - Missing symbol/semantic infrastructure has a fail-closed contract.
- Verification method:
  - Source/test inspection and task-document validation.
- Validation evidence: Full source design and current Search/Read/Edit/provider/mutation contracts/tests were inspected. Gap classification is recorded in F-001 through F-006 and task scopes: existing cursor/range/observation/diff foundations are retained; missing locator/scope-budget/view/prepare contracts are implementation deltas; symbol/semantic engines are explicit unsupported capabilities; cross-file atomic visibility remains out of scope. State is runtime/context-bound with TTL/quotas, view hashes are bounded to editable files, and existing safe operations inputs remain compatible. Task-document validation passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Add bounded locator/view state and unified safety errors

- Status: done
- Owner: coordinator
- Objective: Provide shared short-lived locator and view records across Search and Read, with stable IDs, quotas, expiry and version metadata.
- Inputs and prerequisites: T-001 contracts.
- Scope or files: `packages/agent/src/harness/tools/` state/context/errors/exports and focused tests.
- Expected output: Shared state ledger and stable recovery codes without model-visible tool-count changes.
- Dependencies: T-001.
- Execution steps:
  1. Add bounded locator/view records and version comparison helpers.
  2. Add exact structured error codes/recovery actions.
  3. Wire one ledger into each v2 runtime while retaining generic harness fallback.
- Acceptance criteria:
  - IDs are opaque, bounded, scope-bound and expire safely.
  - Missing/stale IDs cannot resolve across incompatible contexts.
- Verification method:
  - Focused agent state/error/runtime tests.
- Validation evidence: `packages/agent/test/harness/tool-state.test.ts` passed 3/3, including scope isolation, TTL/quota eviction and per-environment fallback sharing. The owned coding-agent runtime constructs and closes one `ToolStateLedger`; `packages/coding-agent/test/tool-profile-v2.test.ts` passed in the focused profile run. Opaque IDs and stable error/recovery codes are exported without changing the model-visible tool set.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Implement locator-first Search P0

- Status: done
- Owner: coordinator
- Objective: Return compact locators with explicit scope, budgets, de-duplication and truthful coverage.
- Inputs and prerequisites: T-002 ledger.
- Scope or files: Search contracts/tool/providers and focused agent/coding-agent tests.
- Expected output: Locator-only model content, include/exclude filters, global/per-file/file/byte limits, coverage status, long-line slices and explicit unsupported structured modes.
- Dependencies: T-002.
- Execution steps:
  1. Extend request/page contracts without adding a tool.
  2. Enforce filters/budgets/de-duplication at the tool boundary and provider where required for correctness.
  3. Register locators with file-version evidence and bind cursors to the expanded request.
  4. Add repeated-field, overflow, skipped/incomplete, long-line and unsupported-mode tests.
- Acceptance criteria:
  - Search output cannot silently exceed any configured budget.
  - Zero results distinguish complete from incomplete coverage.
  - Model-visible content contains locators/match slices, never whole matching lines by default.
- Verification method:
  - Targeted Search/provider/tool-profile tests and output-size assertions.
- Validation evidence: Agent Search/state tests passed 14/14. Coding-agent FFF/local/profile tests passed 24/24. Coverage includes locator-only content, complete-zero versus incomplete-zero, unsupported structured modes, scope forwarding, de-duplication, global/per-file/file/output-byte budgets, long-line match slices, and request/provider/generation/scope-bound cursors. Actual rg/fd and FFF provider tests cover byte offsets, stable continuation, invalid regex and exact-filter fallback.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Implement bounded locator-aware Read views

- Status: done
- Owner: coordinator
- Objective: Turn a locator or explicit range into a numbered, budgeted, versioned view suitable for safe editing.
- Inputs and prerequisites: T-003 locators.
- Scope or files: Read schema/tool/provider integration and tests.
- Expected output: Locator/path modes, line/byte/token budgets, match-centered long-line reads, view/hash/snapshot metadata and stale rejection.
- Dependencies: T-003.
- Execution steps:
  1. Add mutually validated locator/path/range/byte inputs.
  2. Enforce combined output budgets and numbered formatting.
  3. Capture before/after file versions, bounded hashes and view records.
  4. Add progressive/large-file/long-line/stale-locator tests.
- Acceptance criteria:
  - Read never silently returns an unbounded large file or long line.
  - A safely editable view exposes sufficient version/preimage evidence.
- Verification method:
  - Targeted agent Read and Node provider tests.
- Validation evidence: The combined Agent Search/Read/Edit/state run passed 45/45; Read-specific cases cover path and locator modes, numbered lines, byte/token budgets, hash/view/snapshot evidence, stale and cross-scope locators, overlong match-centered lines, byte-offset labels, non-editable oversized files, stable directories, resources, images and unsupported binaries. Coding-agent profile and Node Read provider tests passed 31/31 across their latest focused runs.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Implement view-bound prepare/commit Edit

- Status: done
- Owner: coordinator
- Objective: Add range/hash/view CAS and two-phase mutation while preserving safe existing operations.
- Inputs and prerequisites: T-004 views; current mutation backend observations.
- Scope or files: Edit schema/planner/state/details/rendering and focused mutation/backend tests.
- Expected output: Exactly-one-in-range, stale/preimage/range rejection, dry-run patch IDs, commit revalidation and minimal feedback.
- Dependencies: T-004.
- Execution steps:
  1. Extend update operations with optional view/hash/range/match policy and add prepare/commit request branches.
  2. Restrict matching to the validated range and compare view/hash before planning.
  3. Store bounded prepared plans and commit them through existing backends so observations are rechecked.
  4. Cover ambiguous, stale, changed-line, multi-file prevalidation and validation-failure-state cases.
- Acceptance criteria:
  - Prepare causes zero mutations and returns only bounded diff evidence.
  - Commit of changed preimages fails before mutation.
  - No first-match or implicit replace-all behavior exists.
- Verification method:
  - Agent Edit/mutation/journal/overlay focused tests.
- Validation evidence: The combined Agent chain run passed 45/45, including view/hash/range prepare with zero mutations, patch-ID commit, exactly-one-in-range selection among repeated file text, ambiguity/preimage/range/stale-view/stale-patch rejection, patch replay rejection, and multi-file prevalidation before writes. Journal, overlay and mutation queue tests passed 29/29, preserving their opt-in guarantees and explicit partial-failure boundaries.
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Wire Agent policy, TUI and SDK guidance

- Status: done
- Owner: coordinator
- Objective: Teach the Agent and hosts to use locator → view → prepare → commit → verify while keeping output compact.
- Inputs and prerequisites: T-003 through T-005 stable schemas.
- Scope or files: `tool-profile.ts`, renderers, SDK docs, relevant profile/TUI tests.
- Expected output: Concise prompt rules, compact coverage/view/prepared renderers and host documentation.
- Dependencies: T-005.
- Execution steps:
  1. Update per-tool prompt contributions and descriptions.
  2. Render coverage, numbered views, minimal diffs and recovery states without duplicating full payloads.
  3. Document compatibility, lifetimes and unsupported structured search.
- Acceptance criteria:
  - Prompt tells the model to narrow, read locators, prepare, commit and verify.
  - Collapsed TUI remains bounded and control-sequence safe.
- Verification method:
  - Tool-profile and component/TUI tests.
- Validation evidence: `tool-profile-v2.test.ts` passed 14/14 with prompt assertions and compact locator/view/prepared-patch renderer checks, including DEC private-mode sanitization. `packages/coding-agent/docs/sdk.md` now documents the locator→view→prepare→commit→verify flow, handle lifetime/scope, non-editable hash limits, unsupported structured modes and non-atomic default backend boundary.
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — Add acceptance and context/safety evidence

- Status: done
- Owner: coordinator
- Objective: Validate the source design's representative retrieval/context/edit safety cases without more real-model sessions.
- Inputs and prerequisites: T-006 integrated chain.
- Scope or files: Deterministic fixtures/evaluation under agent/coding-agent tests and aggregate results docs.
- Expected output: Search precision/coverage, model-visible bytes/tokens/repetition, calls-to-safe-edit proxy, ambiguity/stale/truncation rejection rates and limitations.
- Dependencies: T-006.
- Execution steps:
  1. Build fixed production/test/vendor/generated/repetition/large-file/long-line fixtures.
  2. Execute the actual four-tool definitions through locator/read/prepare/commit.
  3. Assert 100% ambiguity/stale/truncation disclosure and zero wrong-location writes.
  4. Record aggregate content-free evidence and limits.
- Acceptance criteria:
  - All P0 safety gates pass deterministically.
  - Context evidence compares locator flow with the prior line-output baseline truthfully.
- Verification method:
  - Targeted deterministic tests; no real provider calls.
- Validation evidence: `search-evidence.test.ts` passed 2/2 and `locator-safe-chain-evidence.test.ts` passed 1/1 without model/provider APIs. The actual v2 chain produced 270 locator bytes versus a 12,259-byte prior full-line baseline (97.8% lower in the overlong-line fixture), 1,045 bytes/262 estimated tokens through verification, four calls to prepared-safe-edit, no duplicate locators, 1/1 ambiguity/stale/truncation/unsupported disclosure and zero wrong-location writes. Aggregate results and synthetic limitations are recorded in `test/tool-profile-eval/RESULTS.md`.
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — Final validation and delivery

- Status: done
- Owner: coordinator
- Objective: Validate all dependency paths, document unsupported P1/P2 capabilities and commit only task-owned files.
- Inputs and prerequisites: T-007.
- Scope or files: Task-owned implementation/tests/docs/task document, final commit.
- Expected output: Passed or truthfully partial result with exact remaining limits.
- Dependencies: T-007.
- Execution steps:
  1. Run modified focused tests and cross-stage Search/Read/Edit/profile/runtime checks.
  2. Run root `npm run check`, `git diff --check`, task validator and explicit status/default review.
  3. Commit explicit paths, excluding both user-owned harness documents.
- Acceptance criteria:
  - All non-blocked tasks meet their criteria with current evidence.
  - Protected harness documents remain unmodified/uncommitted.
- Verification method:
  - Exact command results, staged diff review, commit/status inspection.
- Validation evidence: Final focused validation passed: Agent 4 files / 45 tests; coding-agent 9 files / 61 tests, including FFF/local Search, Node Read, profile/TUI, journal, overlay, mutation queue and both deterministic evidence suites. Root `npm run check` passed with no fixes on the final run; `tsgo --noEmit`, `git diff --check` and task-document validation passed. Static/default review confirmed exactly four v2 tools, overall `legacy` default and operations edit default. Both untracked user-owned `docs/harness_tools/` source files remain unmodified and are excluded from the explicit commit path list.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

Use focused Vitest only. Agent: Search/Read/Edit/foundations and new chain regressions. Coding-agent: FFF/local Search, Node Read, profile/runtime, edit renderers, journal/overlay where Edit contracts touch them, and deterministic evaluation. After code changes run root `npm run check` with full output and immediately inspect auto-fixes, then `git diff --check`, task validation, default-contract scans and explicit staging. No paid model sessions, full `npm test`, or full build.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

Schema growth can itself increase prompt tokens; keep fields outcome-focused and measure schema/output cost. Shared state can leak across sessions if keyed globally; bind records to the runtime/context, scope and TTL. Hashing whole large files would violate bounded Read; only hash within the editable limit and return version-only/non-editable evidence above it. Provider filtering after ranking can create false completeness; unsupported exact filters must run in capable providers or mark coverage incomplete. Two-phase patches must re-use immutable plans and backend observation checks, not rebuild from stale text. Symbol/semantic search remains unavailable until an actual backend exists and will fail closed. Existing journal/overlay guarantees remain opt-in and do not become cross-file atomic visibility claims.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-29: User requested analysis and execution of the user-owned search/read/edit redesign document.
- 2026-08-29: Source document read in full and treated as read-only. Current Search/Read/Edit/provider/mutation contracts and tests audited; T-001 started.
- 2026-08-29: T-001 completed with a P0 implementation matrix, explicit unsupported symbol/semantic boundary, bounded state/hash policy and compatibility constraints; T-002 started.
- 2026-08-29: T-002 completed after 3/3 state tests and the focused v2 profile test passed; T-003 started. Search now emits bounded locator-only model content, explicit coverage and fail-closed structured-mode errors; focused Search/provider regressions are being completed.
- 2026-08-29: T-003 completed after 14/14 Agent Search/state tests and 24/24 coding-agent Search/profile/provider tests passed; T-004 started with locator/path range schemas, numbered bounded views, hashes and snapshot linkage.
- 2026-08-29: T-004 completed with bounded locator/path/byte views, hashes and stale rejection; T-005 started and completed with view/range/hash prepare/commit plus backend observation rechecks.
- 2026-08-29: T-006 completed with locator-safe prompt policy, compact sanitized TUI renderers and SDK guidance. T-007 deterministic evidence passed and was recorded without additional model sessions; T-008 final validation started.
- 2026-08-29: T-008 completed after 45 Agent tests, 61 coding-agent tests, root `npm run check`, type/static/default/protected-file review, `git diff --check` and task validation passed. A verified addressed-vs-canonical mutation-path regression lesson was added to `LEARNS.md`.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 through T-008 are done. The locator-only Search → numbered/hash-bound Read → range-unique Edit prepare → observation-rechecked commit → focused verification chain passed deterministic acceptance and repository checks. Exact validation commands/results are recorded in T-002 through T-008.
- Limitations: Production LSP/AST/semantic backends remain absent and fail closed; files above the editable hash limit return non-editable views; token metrics use chars/4; deterministic fixtures are synthetic; no additional paid model sessions were run; the default mutation backend does not claim cross-file atomic visibility or an OS sandbox.
