# Tool profile A/B scaffold

`manifest.json` defines paired `legacy` (A) and `v2` (C) runs with fixed tasks, seeds, and budgets. `runner.ts` records profile-specific system-prompt and tool-schema SHA-256 hashes, randomizes pair order deterministically, and reports a deterministic task×seed clustered bootstrap interval.

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

It runs 2 tasks × 5 seeds × 2 profiles against reset ephemeral fixtures, grades filesystem state and local tests, records only bounded metrics, and enforces session, turn, timeout, and reported-cost breakers. Provider/model overrides are available through `PI_REAL_TOOL_PROFILE_PROVIDER` and `PI_REAL_TOOL_PROFILE_MODEL`. Real runs must follow the repository's provider authorization rules.
