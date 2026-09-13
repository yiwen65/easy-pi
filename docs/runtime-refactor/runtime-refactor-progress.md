# Runtime Refactor Progress

## Workspace

- Easy-pi root: `/Users/w/Projects/easy-pi/pi`
- Implementation worktree: `/Users/w/Projects/easy-pi/pi-runtime-p00-p01`
- Easy-pi starting HEAD: `dba1626064e8fd5339c18d7430355c985e2956e9`
- Current HEAD / branch: `dba1626064e8fd5339c18d7430355c985e2956e9` / `runtime-p00-p01` (changes uncommitted until validation)
- Codex reference root / HEAD: `/Users/w/Projects/easy-pi/codex` / `36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564`
- Execution scope: `P00-P01`
- Working tree ownership: this worktree is owned by this task; the original `my-pi` worktree and its untracked plan files were left untouched.

## Stages

| Phase | Status | Owned files | Evidence | Commit / diff | Next action |
|---|---|---|---|---|---|
| P00 | passed | `docs/runtime-refactor/runtime-refactor-baseline.md`, `runtime-refactor-progress.md`, `runtime-refactor-test-matrix.md` | Current HEAD/worktrees/call chain/source ownership recorded. Existing agent-loop baseline: 27 passed; final focused Agent tests: 55 passed across 2 files. Repository-wide check has two pre-existing stale model-catalog type errors. | Pending stage commit | Preserve documents and review staged paths before commit. |
| P01 | partial | `packages/agent/src/agent-loop.ts`, `packages/agent/test/agent-loop.test.ts`, `packages/coding-agent/test/suite/runtime-tool-cancellation.test.ts` | Barrier regression is RED before the guard (`first` executed), GREEN after it (29 agent-loop tests pass); real AgentSession/faux-provider barrier regression and neighbors pass 17/17. Repository `npm run check` remains blocked by two pre-existing model-catalog errors, so the normal pre-commit gate cannot pass. | No commit: blocked by repository baseline check | Do not bypass the hook; resolve the pre-existing catalog baseline or obtain explicit authorization before committing. P02 is not started. |
| P02 | deferred | none | Out of execution scope. | none | Start only with an explicit P02 request and re-check P01 commit. |
| P03 | deferred | none | Out of execution scope. | none | Start only with an explicit P03 request. |
| P04 | deferred | none | Out of execution scope. | none | Start only with an explicit P04 request. |
| P05 | deferred | none | Out of execution scope. | none | Start only with an explicit P05 request. |
| P06 | deferred | none | Out of execution scope. | none | Start only with an explicit P06 request. |
| P07 | deferred | none | Out of execution scope. | none | Start only with an explicit P07 request. |
| P08 | deferred | none | Out of execution scope. | none | Start only with an explicit P08 request. |

## Current blocker / limitation

- `npm run check` is not green because existing model-catalog test references `gpt-5.2-codex` at `packages/ai/test/tool-call-id-normalization.test.ts:48,118` are absent from the current generated catalog. P01 files are not named in the failure output.
- Ignored generated provider data and workspace build artifacts were copied into this owned worktree for offline tests only; they are not staged or committed.
- No real API, credentials, network call, dependency change, lockfile change, Codex edit, or push was performed.

## P01 change

`executePreparedToolCall()` now performs a synchronous abort check immediately before invoking the handler. The check is before the first `await`, so a prepared call cannot start after cancellation; already-started handlers still receive the original signal and settle through the existing result protocol. No public event/API union changed.

## Next agent entry

- First read the P01 diff and the matrix.
- First command: `cd packages/agent && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/agent-loop.test.ts` in an isolated checkout.
- Preserve the guard, barrier regression, and the three P00 documents.
- Exact next phase: `P02` only after an explicit request; do not add RunScope or alter session lifecycle in this delivery.
- Commit gate: use normal repository commit after `npm run check` is green. Do not use `--no-verify` or an equivalent hook bypass.
