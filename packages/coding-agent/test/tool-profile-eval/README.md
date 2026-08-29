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
  test/tool-profile-eval/locator-safe-chain-evidence.test.ts
```

`search-evidence.test.ts` compares actual model-visible Search outputs from `LocalSearchProviderV2` and `FffSearchProvider` without calling a model. Its paired typo/noise fixture reports Recall@5, reciprocal/first rank, scripted search and candidate-read effort, output bytes plus a chars/4 token estimate, irrelevant/duplicate hits, and retained/cumulative result-context estimates. A separate stress fixture covers a 3,000-file noisy index, a 12,000-line text file, bounded continuation, incomplete-scan approximation, and exact-semantics fallback. Wall-clock values are descriptive only.

`locator-safe-chain-evidence.test.ts` executes the actual v2 definitions through locator Search, versioned Read, view/hash/range-bound prepare, patch-ID commit, and focused verification. It compares locator bytes with the prior full-line Search format and asserts deterministic ambiguity, stale-preimage, truncation, and unsupported-structure disclosure with zero wrong-location writes. It uses no provider or model API.

The real executor is pinned to `openai-codex/gpt-5.6-luna` with `thinkingLevel: "max"`. It remains skipped unless the exact opt-in is set:

```bash
cd packages/coding-agent
PI_REAL_TOOL_PROFILE_ABC=1 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run test/tool-profile-eval/real-benchmark.test.ts --silent=false
```

The executor uses reset ephemeral fixtures, hidden filesystem grading, a 12-turn/session cap, a 180-second/session timeout, a hard 15-session cap, a reported-cost breaker, and immediate stop on infrastructure/provider failure or a missing assistant turn. It prints only sanitized per-call aggregates and the final A/B/C summary.

`context-stress.test.ts` and `prompt-ablation.ts` remain development-only scaffolds and are not part of the authorized 15-session A/B/C run.
