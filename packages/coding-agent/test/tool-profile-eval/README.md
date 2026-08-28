# Tool profile A/B scaffold

`manifest.json` defines paired `legacy` (A) and `v2` (C) runs with fixed tasks, seeds, and budgets. `runner.ts` records profile-specific system-prompt and tool-schema SHA-256 hashes, usage/cache and elapsed metrics, randomizes pair order deterministically, and reports a deterministic task×seed clustered bootstrap interval. `trace.ts` records only tool names, status, stable error codes, allowlisted content-free validation-reason categories, edit operation kinds, timing, and derived behavior counts; it never retains tool arguments, paths, commands, file content, or response text.

The focused test uses Pi's in-process faux provider and requires no network, credentials, or paid tokens:

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/tool-profile-eval/runner.test.ts
```

The manual real executor is pinned by default to `openai-codex/gpt-5.6-luna` with `max` thinking and remains skipped unless explicitly authorized:

```bash
cd packages/coding-agent
PI_REAL_TOOL_PROFILE_BENCHMARK=1 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run test/tool-profile-eval/real-benchmark.test.ts --silent=false
```

It runs 2 tasks × 5 seeds × 2 profiles against reset ephemeral fixtures, grades filesystem state and local tests, records only bounded metrics, and enforces session, turn, timeout, and reported-cost breakers. `modelElapsedMs` is residual wall time after subtracting the union of tool-active intervals; `peakContextTokens` is the maximum provider-reported assistant usage total.

The narrower diagnostic mode runs only the five v2 `move-edit-test` seeds with a 12-turn/session cap (the paired benchmark remains at its manifest-defined 10-turn cap):

```bash
cd packages/coding-agent
PI_REAL_TOOL_PROFILE_DIAGNOSTIC=1 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run test/tool-profile-eval/real-benchmark.test.ts --silent=false
```

The isolated prompt ablation pairs only the candidate move+update batching guidance against the pre-change v2 guidance on both manifest tasks × five seeds. It uses an 18-turn/session cap to accommodate observed control variance without changing the normal benchmark cap:

```bash
cd packages/coding-agent
PI_REAL_TOOL_PROFILE_ABLATION=1 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run test/tool-profile-eval/real-benchmark.test.ts --silent=false
```

Held-out validation uses five independent stress layers (large directory, large file, long output, ambiguous edit, and multi-file operation), two new seeds, hidden filesystem grading, and the same paired prompt variants:

```bash
cd packages/coding-agent
PI_REAL_TOOL_PROFILE_CONTEXT_STRESS=1 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run test/tool-profile-eval/context-stress.test.ts --silent=false
```

All real modes are explicit opt-ins. The three modes in `real-benchmark.test.ts` are mutually exclusive. Provider/model overrides are available through `PI_REAL_TOOL_PROFILE_PROVIDER` and `PI_REAL_TOOL_PROFILE_MODEL`. Real runs must follow the repository's provider authorization rules.
