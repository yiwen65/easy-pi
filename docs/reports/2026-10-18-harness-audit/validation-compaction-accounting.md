# 实施与验证回执快照

历史回执；最终接受状态见任务计划与 root 复查。

T-154 implemented and verified; T-080 remains explicitly incomplete pending the announced T-156 journal seam. No task-recovery.ts edits or polling. Previous fixes and the retained cold-queue red remain intact.

T-154:
- Reproduced real-adapter manual/automatic failed, locally aborted, rejected and exhausted-retry compactions: full Usage existed in pi-compaction-diagnostics but session totals, footer, cost breakdown and stats scan reported zero, including after reopen. Red: 9 failed / 4 passed in the new 13-case regression.
- Added one narrow shared extractor for version-1 diagnostics with outcome failed/aborted. It returns only structurally valid, finite, nonnegative full Usage records; malformed/absent records and unknown versions/outcomes are ignored. Activated diagnostics are ignored because their checkpoint already accounts for those attempts.
- Wired AgentSession totals, footer/Grok shared totals, Tools/summaries cost breakdown, and JSONL stats scan. Scan records retain the existing compaction kind and unknown summary model attribution; no DTO/schema changes or new storage records.
- Known synthetic unsuccessful usage now counts 100 tokens/$1 once, or 200/$2 across two exhausted attempts; activated usage remains once and no-usage remains zero. Live/reopened stats, rendered footer, breakdown and scan agree in the regressions.

Files changed THIS followup, all under packages/coding-agent:
- src/core/usage-totals.ts
- src/core/agent-session.ts (usage import + totals ingestion only in this turn)
- src/modes/interactive/components/footer.ts
- src/core/stats/scan.ts
- test/suite/regressions/harness-audit-compaction-accounting.test.ts (new)

Checks from packages/coding-agent:
`node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/regressions/harness-audit-compaction-accounting.test.ts`
Red log: /tmp/pi-session-execution-followup/red-accounting.log (9 failed/4 passed).
Final green command used the same CLI with these named files: test/suite/regressions/harness-audit-compaction-accounting.test.ts, test/suite/regressions/harness-audit-compaction-usage.test.ts, test/agent-session-stats.test.ts, test/footer-width.test.ts, test/cache-stats.test.ts, test/stats-core.test.ts, test/stats-command.test.ts, test/stats-server.test.ts. Result: 8 files / 98 tests passed, twice. Latest log: /tmp/pi-session-execution-followup/green-accounting-final.log.
Scoped Biome over the five files passed (formatted two); focused diff check passed and diff was reviewed. Root check/build not run; no real APIs, credentials, commits, docs/task/report or lockfile changes.

T-080 continuation required after T-156:
Persist host-controlled recovery policy on AgentSession; remove only old live queue mirrors, exclude old pendingNextTurn context BEFORE assembling the new prompt, and pass fourth `{inheritQueuedInputs:false}` argument at explicit host admission. Preserve default root behavior. Extend retained cold-queue test across steer/followUp/nextTurn and verify retained history/unknown facts plus later explicit followup. Existing red: test/pi-child-session-host.test.ts 'controller cold followup executes only its new assignment despite a retained running intent', 2 provider calls versus 1; /tmp/pi-session-execution-audit/red-cold-queue.log. No T-156 availability announcement received before this handoff.

Recommended status: T-154 implementation-verified pending root checks/review; T-080 internal dependency, not complete. Documentation should say failed/aborted/rejected summary usage is recovered from valid retained diagnostics, without double counting activated checkpoints. Limits: diagnostics writes remain best-effort; missing reports cannot be reconstructed, injected config.complete does not supply per-provider attempt diagnostics, and pre-fix activated checkpoints lacking usage are not backfilled. These are accounting checks on synthetic reported usage, not actual pricing, performance or physical-drain evidence.
