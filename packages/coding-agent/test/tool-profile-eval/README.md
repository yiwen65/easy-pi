# Tool profile A/B scaffold

`manifest.json` defines paired `legacy` (A) and `v2` (C) runs with fixed tasks, seeds, and budgets. `runner.ts` records profile-specific system-prompt and tool-schema SHA-256 hashes, randomizes pair order deterministically, and reports a deterministic task×seed clustered bootstrap interval.

The focused test uses Pi's in-process faux provider and requires no network, credentials, or paid tokens:

```bash
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/tool-profile-eval/runner.test.ts
```

A real-model executor may be supplied to `runToolProfileEvaluation`, but it must be gated by an explicit opt-in such as `PI_REAL_MODEL_EVAL=1`, use fresh fixtures, preserve manifest budgets and seeds, and follow the repository's real-provider rules. No real-model executor or result claim is included in this MVP.
