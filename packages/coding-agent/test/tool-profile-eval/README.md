# Tool profile A/B/C evaluation

`manifest.json` fixes one composite repository task, seeds `[17, 41, 73, 101, 137]`, and three variants:

- **A:** complete native compatibility tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`)
- **B:** current four-tool v2 profile
- **C:** full opt-in v2 candidate with journaled mutation and minimal mutation notifications

The fixed matrix is exactly 1 task × 5 seeds × 3 variants = 15 sessions. `runner.ts` randomizes A/B/C order deterministically within each seed, records prompt/schema hashes and content-free metrics, and reports paired B−A, C−B, and C−A score deltas plus a deterministic clustered bootstrap interval for C−A.

`trace.ts` retains only tool names, status, stable error/reason categories, operation kinds, timings, and derived counts. It compares target paths only in memory to derive target-first-read and search-rank metrics; paths, commands, arguments, file content, tool output, model output, session files, and credentials are never persisted.

Run credential-free faux, grader, and deterministic FFF evidence tests:

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/tool-profile-eval/runner.test.ts \
  test/tool-profile-eval/trace.test.ts \
  test/tool-profile-eval/prompt-ablation.test.ts \
  test/tool-profile-eval/search-evidence.test.ts \
  test/tool-profile-eval/locator-safe-chain-evidence.test.ts \
  test/tool-profile-eval/full-requirement-evidence.test.ts \
  test/tool-profile-eval/full-real-eval.test.ts
```

`search-evidence.test.ts` compares actual model-visible Search outputs from `LocalSearchProviderV2` and `FffSearchProvider` without calling a model. Its paired typo/noise fixture reports Recall@5, reciprocal/first rank, scripted search and candidate-read effort, output bytes plus a chars/4 token estimate, irrelevant/duplicate hits, and retained/cumulative result-context estimates. A separate stress fixture covers a 3,000-file noisy index, a 12,000-line text file, bounded continuation, incomplete-scan approximation, and exact-semantics fallback. Wall-clock values are descriptive only.

`locator-safe-chain-evidence.test.ts` executes the actual v2 definitions through locator Search, versioned Read, view/hash/range-bound prepare, patch-ID commit, and focused verification. It compares locator bytes with the prior full-line Search format and asserts deterministic ambiguity, stale-preimage, truncation, and unsupported-language disclosure with zero wrong-location writes. It uses no provider or model API.

`full-requirement-evidence.test.ts` is the current deterministic P0/P1/P2 gate. It executes all 16 declared acceptance scenarios against synthetic temporary fixtures and the actual legacy/v2 definitions. The matrix activates JS/TS definitions, calls, qualified assignments, AST-bounded Read, path priors, query templates, a local static semantic provider, index limits, ignore rules, global/per-file overflow, long files/lines, ambiguity relocation, stale view/patch rejection, multi-file prevalidation, all three unversioned Edit dialect rejections, replace-all rejection, and syntax-failure recovery. `full-requirement-evidence.ts` refuses summaries with missing scenario IDs, safety denominators, context phases, baselines, semantic/template/path-prior activations, partial coverage, or overflow. Its output contains counts and numeric metrics only; no fixture content, paths, commands, prompts, credentials, or tool/model responses are persisted. Wall-clock p50/p95 values are descriptive per host; deterministic token estimates use UTF-8 bytes/4.

FFF text search now falls back to the direct local provider when the native index truncates a long line before preserving match coordinates. A continuation page with missing coordinates fails closed rather than returning a wrong locator.

## Current real-model evaluator

`full-real-eval.real.test.ts` is the only executor for the current P0/P1/P2 real run. Its frozen stages are:

- calibration: two task families × one seed × three variants = 6 sessions;
- held-out: seven disjoint task families × two seeds × three variants = 42 sessions;
- variants: legacy, text-v2, and structured/semantic-v2;
- hard limits: 48 combined sessions, 18 assistant turns/session, 180 seconds/session, and $5 combined reported chat plus estimated/reported embedding cost.

Exactly one stage flag must be set. Both stages also require `PI_SEMANTIC_SEARCH=1`, the four `PI_EMBEDDING_*` connection/price variables, the locally configured `openai-codex/gpt-5.6-luna` credentials, and `thinkingLevel: "max"`. Held-out execution additionally requires the content-free calibration session/cost totals through `PI_REAL_FULL_TOOLCHAIN_PRIOR_SESSIONS` and `PI_REAL_FULL_TOOLCHAIN_PRIOR_COST_USD`.

```bash
cd packages/coding-agent
PI_REAL_FULL_TOOLCHAIN_CALIBRATION=1 PI_SEMANTIC_SEARCH=1 \
  node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run test/tool-profile-eval/full-real-eval.real.test.ts --silent=false
```

Use `PI_REAL_FULL_TOOLCHAIN_HELD_OUT=1` only after calibration failures are resolved and the inputs are frozen. Calibration records are not included in held-out aggregates, and held-out records must not be rerun to improve scores. The executor writes no sessions or fixture/tool/model content. It prints only content-free records and summaries. Before each remote embedding request, an in-memory allowlist proves every input is either the exact generated fixture query or a document produced from the generated temporary fixture; a violation fails closed before `fetch`. Provider/infrastructure, turn, timeout, and cost failures abort the current session and stop the sequential matrix.

## Historical executor

The historical real executor below is pinned to `openai-codex/gpt-5.6-luna` with `thinkingLevel: "max"`. It remains skipped unless the exact opt-in is set. Do not use it for the current P0/P1/P2 run: it encodes the completed 15-session/12-turn happy-path contract rather than the current 6-calibration + 42-held-out, 18-turn, $5, synthetic-embedding contract.

```bash
cd packages/coding-agent
PI_REAL_TOOL_PROFILE_ABC=1 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run test/tool-profile-eval/real-benchmark.test.ts --silent=false
```

The executor uses reset ephemeral fixtures, hidden filesystem grading, a 12-turn/session cap, a 180-second/session timeout, a hard 15-session cap, a reported-cost breaker, and immediate stop on infrastructure/provider failure or a missing assistant turn. It prints only sanitized per-call aggregates and the final A/B/C summary.

`context-stress.test.ts` and `prompt-ablation.ts` remain development-only scaffolds and are not part of the authorized 15-session A/B/C run.
