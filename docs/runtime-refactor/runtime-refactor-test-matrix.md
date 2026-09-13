# Runtime Refactor Test Matrix

Results use `pass`, `fail`, `baseline_fail`, `not_run`, or `not_applicable`; a local pass is not a cross-platform claim.

| Test ID | Invariant | Actual test file + test name | Baseline | After change | Command / log | Platform |
|---|---|---|---|---|---|---|
| C01 | I01 | `packages/agent/test/agent-loop.test.ts` — `does not execute prepared tools after parallel preflight is cancelled`; `packages/coding-agent/test/suite/runtime-tool-cancellation.test.ts` — `does not start a prepared tool after the real AgentSession loop is cancelled` | `fail`: before the guard, A executed after abort while B was held at the barrier | `pass` | `cd packages/agent && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/agent-loop.test.ts -t 'does not execute prepared tools after parallel preflight is cancelled'` | Darwin arm64 |
| C02 | I01 | `packages/agent/test/agent-loop.test.ts` — `does not start a later sequential tool after cancellation and preserves the started signal` | `not_run` before this regression | `pass` | Same focused command below | Darwin arm64 |
| C03 | I01/I09 | `packages/agent/test/agent-loop.test.ts` — `should emit tool_execution_end in completion order but persist tool results in source order`; `should allow parallel execution when all tools have executionMode=parallel` | `pass` (existing) | `pass` (29 focused tests) | `cd packages/agent && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/agent-loop.test.ts` | Darwin arm64 |
| C04 | I02 | `packages/agent/test/agent-loop.test.ts` — `does not start a later sequential tool after cancellation and preserves the started signal` (started-tool signal/known-result neighbor) | `not_run` before this regression | `pass` | `cd packages/agent && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/agent-loop.test.ts -t 'does not start a later sequential tool'` | Darwin arm64 |
| C05 | I01 | `packages/coding-agent/test/suite/runtime-tool-cancellation.test.ts` — `does not start a prepared tool after the real AgentSession loop is cancelled` | `fail` before the final admission guard (same late-start window) | `pass` | `cd packages/coding-agent && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/runtime-tool-cancellation.test.ts test/suite/agent-session-runtime.test.ts test/suite/agent-session-tool-gateway.test.ts test/suite/regressions/6363-agent-settled-event.test.ts` | Darwin arm64 |
| C06 | I02 | Existing AgentSession tool-result cancellation characterization | `not_run` | `not_run` | No dedicated P01 test; deferred to P02 lifecycle work | Darwin arm64 |
| C07 | I02 | Existing postprocess/persistence failure characterization | `not_run` | `not_run` | Out of P01 scope | Darwin arm64 |
| C08 | I01 | Existing session generation replacement late callback characterization | `not_run` | `not_run` | Out of P01 scope | Darwin arm64 |
| C09 | I01/I05 | `packages/coding-agent/test/pi-child-session-host.test.ts` and native child contract tests | `not_run`: not required for P01 patch | `not_run` | Existing path untouched; deferred | Darwin arm64 |
| C10 | I02 | Existing abort/finish rejection characterization | `not_run` | `not_run` | Out of P01 scope | Darwin arm64 |
| P00-AGENT | baseline | `packages/agent/test/agent-loop.test.ts` | 27 passed before P01 test/fix | 29 passed | Focused Vitest command | Darwin arm64 |
| P00-SESSION | baseline | `packages/coding-agent/test/suite/runtime-tool-cancellation.test.ts`, `agent-session-runtime.test.ts`, `agent-session-tool-gateway.test.ts`, `regressions/6363-agent-settled-event.test.ts` | not_run before P01 | 17 passed across 4 files | `cd packages/coding-agent && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/agent-session-runtime.test.ts test/suite/agent-session-tool-gateway.test.ts test/suite/regressions/6363-agent-settled-event.test.ts` | Darwin arm64 |
| P00-LOAD | baseline | `packages/agent/test/agent.test.ts` | `not_run` before P01; current source has ignored generated provider data | `pass` (26 tests; 55 across both Agent files) | `cd packages/agent && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/agent-loop.test.ts test/agent.test.ts` | Darwin arm64 |
| CHECK | I12 | Repository type/format check | baseline not recorded before P01 | `baseline_fail`: check reaches TypeScript and fails only on existing stale `gpt-5.2-codex` model-catalog references at `packages/ai/test/tool-call-id-normalization.test.ts:48,118`; no P01 file is listed | `npm run check` (owned worktree only; formatter output reviewed and unrelated change reverted) | Darwin arm64 |
| SUITE | I12 | Isolated `./test.sh` | not_run | not_run | Not run: P08 integration scope; targeted faux-provider Session tests below pass | Darwin arm64 |

## Existing characterization anchors inspected

- `packages/coding-agent/test/suite/agent-session-prompt.test.ts`: prompt acceptance/preflight and prompt behavior.
- `packages/coding-agent/test/suite/agent-session-queue.test.ts`: steering/follow-up delivery.
- `packages/coding-agent/test/suite/regressions/6363-agent-settled-event.test.ts`: `agent_end`/`agent_settled` ordering and retry settlement.
- `packages/coding-agent/test/suite/agent-session-runtime.test.ts`: runtime replacement behavior.
- `packages/agent/test/agent.test.ts`: active signal and listener settlement behavior.
