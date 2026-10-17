# 实施与验证回执快照

实现方回执，最终接受状态见任务计划与 root 复查。

T-085 / audit session finding 6 — bounded shared-contract support completed; recommended ready for root integration review, not independent T-085 acceptance.

Base revision: f7606c3df763e4dcbc75261211346e67124ee628; shared dirty worktree. Only these five files changed (paths relative to packages/coding-agent):
- src/core/extensions/types.ts:697–702 — preparation is explicitly CompactionPreparation | undefined, documented as legacy cut metadata; branchEntries remains required. Event description now accurately says observation/cancellation.
- examples/extensions/compaction-control.ts:8,23–25 — guard unavailable legacy preparation; policy permits the modern subsystem to decide rather than inventing tokens/cut data. This additional source path was reported before editing.
- test/compaction-extensions-example.test.ts — preserves legacy fixture assertions with narrowing and adds missing-preparation regression.
- test/compaction-extensions.test.ts — asserts/narrows expected legacy preparation, guards deprecated summary callbacks, and requires PI_REAL_MODEL_EVAL=1 before real-provider tests can run.
- test/suite/regressions/5217-compaction-reason.test.ts:31 — records event metadata even without preparation, then skips constructing the deprecated custom summary.

Evidence/checks:
- Offline red: example throws TypeError reading tokensBefore when preparation is undefined, at compaction-control.ts:24. Run produced 1 failed / 6 passed / 8 skipped; /tmp/T-085-contract-red.log.
- Final command, cwd packages/coding-agent: PI_REAL_MODEL_EVAL=0 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/compaction-extensions.test.ts test/compaction-extensions-example.test.ts test/suite/regressions/5217-compaction-reason.test.ts test/compaction-subsystem/default-on.test.ts
- Final result: 14 passed, 8 skipped; 3 test files passed, 1 skipped. /tmp/T-085-contract-green.log. The skipped real-provider tests are NOT passed.
- A temporary faux short-history cancellation probe also passed: one hook with undefined preparation and nonempty branchEntries, no summary-response consumption, no checkpoint. AgentSession worker's concurrent fix landed before this run; I did NOT observe the original product hook path fail pre-fix. Probe removed afterward to keep durable product coverage with its owning worker.
- Scoped git diff --check passed; reviewed complete owned source files and final diff. No APIs, commits, dependency changes, root check/build, or shared docs edits.

Root follow-up / compatibility recommendation:
- Update extensions.md compaction event section and compaction.md observation boundary: hooks also occur without a legacy cut (short/checkpoint histories); preparation must be guarded, while branchEntries/reason/willRetry/signal remain available. Do not synthesize legacy firstKeptEntryId or token metadata. Explain the example deliberately permits compaction when its legacy token policy cannot be evaluated.
- Root final tsc/check remains required; Vitest transpilation is not type-check evidence. Reported the execution worker's preparation dereferences in suite/agent-session-compaction.test.ts for its own guards.
- Existing skipped real-provider tests still assert deprecated custom-summary acceptance (two cases). I preserved those assertions per bounded scope; recommend a separate authorized migration to faux/current ignored-summary semantics, not enabling them unchanged.
