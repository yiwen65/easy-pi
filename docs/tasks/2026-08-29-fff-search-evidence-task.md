# Task Plan: Default FFF Search and Evidence Benchmarks

- Created: 2026-08-29
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User request: “搜索走fff并完成1-6剩余测试”

<!-- task-doc-section:background-goal -->
## Background and goal

The v2 Search contract and an opt-in `FffSearchProvider` already exist, but the default local v2 runtime still selects `LocalSearchProviderV2`, and the completed 15-session model evaluation did not exercise FFF. Make the default local v2 Search backend use FFF with a correctness-preserving direct local fallback, then add deterministic evidence for the six requested dimensions: ranking quality, discovery effort, model-visible result volume, irrelevant/duplicate output, retained context load, and stress/continuation behavior.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope: default local v2 provider selection; FFF-backed file, text, and glob routes where the published API can honor the Search contract; fallback for unsupported/unavailable requests; provider lifecycle/cursor correctness; local deterministic evaluation and documented metrics; focused tests and repository checks.

Non-goals: changing the overall `legacy` default profile, changing the four model-visible v2 schemas, spending more real-model sessions beyond the exhausted 15-session authorization, claiming an OS sandbox, or claiming causal latency gains from small/noisy timing samples.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The overall profile default is `legacy`; local v2 currently constructs `LocalSearchProviderV2`. | `packages/coding-agent/src/core/sdk.ts`; `packages/coding-agent/src/core/tools/tool-profile.ts` |
| F-002 | `@ff-labs/fff-node` is pinned at 0.10.5 and `FffSearchProvider` is exported and tested, but only explicit SDK injection uses it. | `packages/coding-agent/package.json`; `src/core/tools/fff-search-provider.ts`; `test/fff-search-provider.test.ts` |
| F-003 | FFF 0.10.5 exposes fuzzy file/mixed search, glob, literal/regex grep, context lines, pagination, scan state, and watcher events. | Installed `node_modules/@ff-labs/fff-node/dist/*.d.ts` and README |
| F-004 | The prior A/B/C run used default v2 Search and therefore did not use FFF; its 15-session budget is exhausted. | `test/tool-profile-eval/real-benchmark.test.ts`; `RESULTS.md` |
| F-005 | Current aggregate evidence does not directly measure model-visible tool-result bytes/tokens, irrelevant/duplicate hits, or retained tool-result context. | `test/tool-profile-eval/runner.ts`; `trace.ts`; `RESULTS.md` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “搜索走fff” means the local `toolProfile: "v2"` default Search backend should prefer FFF; the overall profile remains `legacy` as previously required.
- Assumption: “1-6” refers to the six validation dimensions listed in the immediately preceding assistant response.
- Open question: None blocking. Requests that FFF cannot represent exactly will use the existing structured local provider and will be covered as fallback rather than silently changing semantics.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- A default local v2 runtime constructs an owned FFF-first Search provider; explicit host providers and non-Node execution environments remain unchanged.
- File, ordinary text, and glob searches use FFF when its API can preserve the request; unsupported/unavailable cases fall back to `LocalSearchProviderV2`.
- FFF continuations are request/generation-bound, bounded, stale-safe, and cleaned up with the runtime.
- Deterministic tests report Recall@K/MRR/first-rank, discovery-call proxy, model-visible result bytes/estimated tokens, irrelevant/duplicate ratios, cumulative/peak retained tool-result context, and noise/large-file/continuation/approximate/fallback behavior.
- No regression in target discovery, duplicate output, schema count, default legacy profile, or host lifecycle.
- Focused tests, root `npm run check`, `git diff --check`, task validation, and explicit status review pass; only task-owned files are committed.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003 -> T-004`.
- Parallel batches: T-001 may use parallel read-only analysis of provider correctness and metric design. Implementation and benchmark integration are serialized because they share provider behavior and expected results.
- Serialization constraints: `fff-search-provider.ts`, `tool-profile.ts`, evaluation helpers/results, task document, and generated formatting/check effects remain coordinator-owned.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Freeze FFF routing and metric contracts

- Status: done
- Owner: coordinator
- Objective: Recover exact FFF capabilities, Search invariants, fallback boundaries, and deterministic definitions for all six metrics.
- Inputs and prerequisites: F-001 through F-005; installed FFF declarations; current provider/tool tests.
- Scope or files: Read-only source/dependency inspection and this task document.
- Expected output: Implementable route matrix and benchmark contract without unsupported claims.
- Dependencies: None.
- Execution steps:
  1. Compare SearchRequest semantics with FFF file/glob/grep APIs.
  2. Define cursor/generation behavior and fallback conditions.
  3. Define content-free paired metric calculations and stress fixtures.
- Acceptance criteria:
  - Every Search request field has an FFF mapping or explicit local fallback.
  - Each of the six requested dimensions has an observable deterministic metric/test.
- Verification method:
  - Source/API review and task-document validation.
- Validation evidence: Coordinator reviewed the installed FFF 0.10.5 README/declarations plus SearchProvider/SearchRequest/SearchPage and current local/FFF providers. Route contract: FFF handles default smart-case file search without `fileGlob`, default smart-case text literal/regex/context without `fileGlob`, and glob; exact unsupported case/filter combinations fall back locally. Native page/cursor state remains Pi-owned and generation-bound; incomplete scans alone are approximate, while normal pagination is complete via continuation. Six deterministic metric definitions are fixed in the task acceptance criteria. The task-document validator passed. Two delegated read-only analyses again received empty snapshots and were rejected; no delegated claim is used as evidence.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Make local v2 Search FFF-first

- Status: done
- Owner: coordinator
- Objective: Route default local v2 Search through a contract-correct FFF-first provider.
- Inputs and prerequisites: T-001 route matrix.
- Scope or files: `packages/coding-agent/src/core/tools/fff-search-provider.ts`, `tool-profile.ts`, related exports/docs and focused tests.
- Expected output: Owned default FFF lifecycle, native routes, bounded continuations, and safe local fallback.
- Dependencies: T-001.
- Execution steps:
  1. Add failing default-route and native text/glob/continuation/fallback tests.
  2. Implement minimal provider/runtime changes.
  3. Run focused provider/profile tests and inspect lifecycle behavior.
- Acceptance criteria:
  - Default local v2 Search demonstrably uses FFF for supported requests.
  - Explicit providers, generic hosts, legacy default, and four schemas remain unchanged.
  - Native unavailability or unsupported semantics preserve behavior through fallback.
- Verification method:
  - Targeted Vitest files for FFF, local Search, profile, and runtime lifecycle.
- Validation evidence: `fff-search-provider.test.ts`, `local-search-provider-v2.test.ts`, and `tool-profile-v2.test.ts` passed 24/24 after making the default local Node v2 runtime construct `FffSearchProvider`. Native typo-resistant files, grep/context/Unicode columns, glob, file/text/glob continuation, invalid regex, generation rejection, exact-semantics fallback, and default-runtime selection are covered; legacy remains the overall default and explicit providers/generic hosts are unchanged.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Implement and run six-dimension deterministic evaluation

- Status: done
- Owner: coordinator
- Objective: Produce reproducible evidence for quality, effort, output/context load, and stress paths without additional model calls.
- Inputs and prerequisites: T-002 complete provider behavior.
- Scope or files: `packages/coding-agent/test/tool-profile-eval/` evaluation helper/tests/results/README.
- Expected output: Paired local-vs-FFF metrics and assertions across representative fixtures.
- Dependencies: T-002.
- Execution steps:
  1. Build deterministic typo/noise/content/continuation fixtures.
  2. Execute actual Search tool outputs for both providers and calculate the six metric groups.
  3. Persist aggregate non-sensitive results and limitations.
- Acceptance criteria:
  - Metrics are derived from actual provider/tool results, not hard-coded expectations.
  - Quality does not regress; duplicate paths remain zero; context/log measures are bounded and truthfully interpreted.
  - Stress coverage includes noisy directories, a large text file, bounded continuation/truncation, incomplete/approximate behavior, and fallback.
- Verification method:
  - New targeted Vitest evaluation plus repeat run for determinism where applicable.
- Validation evidence: The combined seven-file focused run passed 32/32, including `search-evidence.test.ts` 2/2. In the paired five-query typo/noise fixture, local vs FFF-first was Recall@5 0/5 vs 5/5, MRR 0 vs 1, first rank 0/5 vs 5/5, mean Search calls 2 vs 1, discovery proxy 3 vs 2, model-visible bytes 945 vs 860, estimated/peak result tokens 240 vs 215, cumulative visible result tokens 1,237 vs 651, irrelevant-hit rate 75% vs 75%, and duplicates 0 vs 0. The stress fixture passed a 3,000-file noisy index, 12,000-line target, bounded continuation, explicit approximate/partial scan, and exact-case fallback. Timing is descriptive only and actual OS scanned-file counts remain unavailable from SearchPage.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Final validation and delivery

- Status: done
- Owner: coordinator
- Objective: Validate the integrated change, document evidence/limits, and commit only task-owned files.
- Inputs and prerequisites: T-002 and T-003.
- Scope or files: All task-owned diffs, task document, final explicit commit.
- Expected output: Passing checks, truthful final status, clean protected-file boundary.
- Dependencies: T-003.
- Execution steps:
  1. Run all modified focused tests and root `npm run check`.
  2. Run `git diff --check`, task validator, and status/diff review.
  3. Record final evidence and commit explicit paths.
- Acceptance criteria:
  - All required checks pass with no unreviewed auto-fixes.
  - `docs/harness_tools/Pi Agent Tools v2.md` remains untouched and uncommitted.
- Verification method:
  - Exact commands/results recorded below and commit/status inspection.
- Validation evidence: Final combined targeted Vitest run passed 7 files / 32 tests after formatting. Root `npm run check` passed with no fixes on the final code, including pinned dependency, import, shrinkwrap/install-lock, tsgo, and browser-smoke checks. `git diff --check` passed. Static checks confirmed `toolProfile` remains `legacy`, edit dialect remains `operations`, and default local v2 Search constructs `FffSearchProvider`. Status/diff review confirmed the protected user-owned `docs/harness_tools/Pi Agent Tools v2.md` is not in the diff.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

Use targeted Vitest only: FFF provider, local provider, v2 profile/lifecycle, and the deterministic six-dimension evaluation. Do not run paid/real-provider tests. After code changes run root `npm run check` with full output, immediately inspect status/diff for auto-fixes, then run `git diff --check` and the task validator.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

FFF native scan completion and wall-clock timing can be environment-sensitive; correctness assertions will avoid latency gates and report timing only as descriptive data. FFF lacks exact representations for some case/fileGlob combinations, so those requests must fall back rather than drift semantically. Native cursors and watcher generations must not be exposed directly or reused after changes. The protected user-owned roadmap document remains out of scope.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-29: User authorized default FFF-backed v2 Search and completion of the six remaining evidence dimensions.
- 2026-08-29: Task document created; T-001 started after confirming the prior real-model budget is exhausted and current v2 defaults to the direct local provider.
- 2026-08-29: T-001 completed from coordinator-owned real-worktree evidence. Two read-only delegated analyses again received empty snapshots and were discarded. Route matrix and six metric groups frozen; T-002 started.
- 2026-08-29: T-002 completed: default local v2 Search is FFF-first with native file/text/glob routes, bounded generation-bound cursors, and structured local fallback; focused provider/profile tests passed 24/24.
- 2026-08-29: T-003 completed: seven-file focused run passed 32/32 and deterministic quality/effort/log/context plus stress evidence was recorded in `RESULTS.md`; T-004 started.
- 2026-08-29: The first root check found six test-only ExtensionContext type errors after formatting three task files; explicit typed test contexts fixed them. The second root check passed with no fixes.
- 2026-08-29: T-004 completed after the final 7-file/32-test run, root check, diff check, default-contract scan, task validation, and protected-file review passed.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 through T-004 are done. Default local v2 Search is FFF-first with native file/text/glob routes and exact-semantics fallback; the deterministic six-dimension benchmark and stress paths passed; focused tests passed 32/32; root `npm run check`, `git diff --check`, static defaults, task validation, and protected-file review passed.
- Limitations: No additional real-model sessions were run; the five-query typo benchmark is synthetic, actual OS scanned-file counts are not exposed by SearchPage, chars/4 is only a token estimate, irrelevant-hit rate remained 75%, and wall-clock measurements are descriptive rather than causal. The overall default profile remains `legacy`.
